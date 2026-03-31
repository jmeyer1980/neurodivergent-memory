import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";

const DATASET_SIZES = [1000, 5000, 10000];
const DISTRICTS = [
  "logical_analysis",
  "emotional_processing",
  "practical_execution",
  "vigilant_monitoring",
  "creative_synthesis",
];
const AGENTS = ["alpha", "beta", "gamma", "delta"];
const TOPICS = [
  "benchmarking",
  "retrieval",
  "planning",
  "observability",
  "persistence",
  "stability",
  "throughput",
  "telemetry",
];
const SEARCH_ITERATIONS = 25;
const LIST_ITERATIONS = 15;
const RELATED_ITERATIONS = 20;
const CONNECTED_SAMPLE_LIMIT = 1000;
const PAGE_SIZE = 50;
const OUTPUT_DIR = path.join(process.cwd(), "benchmark-results");

function nowNs() {
  return process.hrtime.bigint();
}

function nsToMs(value) {
  return Number(value) / 1_000_000;
}

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function summarizeLatencies(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    iterations: sorted.length,
    average_ms: sorted.length > 0 ? total / sorted.length : 0,
    p50_ms: percentile(sorted, 0.5),
    p95_ms: percentile(sorted, 0.95),
    min_ms: sorted[0] ?? 0,
    max_ms: sorted[sorted.length - 1] ?? 0,
  };
}

function formatMs(value) {
  return value.toFixed(2);
}

function formatOps(value) {
  return value.toFixed(1);
}

function extractText(response) {
  return response?.result?.content?.[0]?.text ?? response?.error?.message ?? "";
}

function extractMemoryId(responseText) {
  const match = responseText.match(/ID: (memory_\d+)/);
  if (!match) {
    throw new Error(`Unable to extract memory ID from response: ${responseText}`);
  }
  return match[1];
}

function assertSuccess(response, toolName) {
  if (response?.error) {
    throw new Error(`${toolName} returned error: ${JSON.stringify(response.error)}`);
  }
}

function createMemoryPayload(index) {
  const district = DISTRICTS[index % DISTRICTS.length];
  const topic = TOPICS[index % TOPICS.length];
  const agentId = AGENTS[index % AGENTS.length];
  const group = Math.floor(index / 25);

  return {
    content: [
      `benchmark memory ${index}`,
      `topic ${topic}`,
      `district ${district}`,
      `group ${group}`,
      `agent ${agentId}`,
      `baseline reference document for issue 19`,
    ].join(" | "),
    district,
    tags: [
      `topic:${topic}`,
      "scope:benchmark",
      "kind:reference",
      "layer:implementation",
    ],
    agent_id: agentId,
    intensity: (index % 10) / 10,
  };
}

function createSearchQuery(iteration) {
  const topic = TOPICS[iteration % TOPICS.length];
  const district = DISTRICTS[iteration % DISTRICTS.length];
  return `topic ${topic} district ${district}`;
}

function getGitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

function startServer() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ndm-benchmark-"));
  const child = spawn(process.execPath, ["build/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NEURODIVERGENT_MEMORY_DIR: tempDir,
      NEURODIVERGENT_MEMORY_LOG_LEVEL: "error",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let stdoutBuffer = "";
  let stderrBuffer = "";
  let nextId = 1;
  const pending = new Map();

  child.stdout.on("data", chunk => {
    stdoutBuffer += chunk;
    let newline = stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      newline = stdoutBuffer.indexOf("\n");

      if (!line) continue;

      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      if (parsed.id !== undefined && pending.has(parsed.id)) {
        const { resolve } = pending.get(parsed.id);
        pending.delete(parsed.id);
        resolve(parsed);
      }
    }
  });

  child.stderr.on("data", chunk => {
    stderrBuffer += chunk;
  });

  function callTool(name, args) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for response to request ${id} (${name})\n${stderrBuffer}`));
      }, 30000);

      pending.set(id, {
        resolve: response => {
          clearTimeout(timeout);
          resolve(response);
        },
      });

      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name,
          arguments: args,
        },
      })}\n`);
    });
  }

  async function stop() {
    child.kill();
    await new Promise(resolve => child.once("exit", resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  return { callTool, stop, tempDir };
}

async function benchmarkDataset(size) {
  const server = startServer();
  const ids = [];
  const searchLatencies = [];
  const listLatencies = [];
  const relatedLatencies = [];

  try {
    const storeStart = nowNs();
    for (let index = 0; index < size; index += 1) {
      const response = await server.callTool("store_memory", createMemoryPayload(index));
      assertSuccess(response, "store_memory");
      ids.push(extractMemoryId(extractText(response)));
    }
    const storeDurationMs = nsToMs(nowNs() - storeStart);

    const connectLimit = Math.min(Math.max(1, size - 1), CONNECTED_SAMPLE_LIMIT);
    for (let index = 1; index <= connectLimit; index += 1) {
      const response = await server.callTool("connect_memories", {
        memory_id_1: ids[index - 1],
        memory_id_2: ids[index],
        bidirectional: true,
        agent_id: AGENTS[index % AGENTS.length],
      });
      assertSuccess(response, "connect_memories");
    }

    const warmupSearch = await server.callTool("search_memories", { query: createSearchQuery(0) });
    assertSuccess(warmupSearch, "search_memories");
    const warmupList = await server.callTool("list_memories", { page: 1, page_size: PAGE_SIZE });
    assertSuccess(warmupList, "list_memories");
    const warmupRelated = await server.callTool("related_to", { memory_id: ids[Math.min(connectLimit, ids.length - 1)] });
    assertSuccess(warmupRelated, "related_to");

    for (let iteration = 0; iteration < SEARCH_ITERATIONS; iteration += 1) {
      const start = nowNs();
      const response = await server.callTool("search_memories", {
        query: createSearchQuery(iteration),
        min_score: 0,
      });
      const durationMs = nsToMs(nowNs() - start);
      assertSuccess(response, "search_memories");
      searchLatencies.push(durationMs);
    }

    const totalPages = Math.max(1, Math.ceil(size / PAGE_SIZE));
    for (let iteration = 0; iteration < LIST_ITERATIONS; iteration += 1) {
      const page = (iteration % totalPages) + 1;
      const start = nowNs();
      const response = await server.callTool("list_memories", {
        page,
        page_size: PAGE_SIZE,
      });
      const durationMs = nsToMs(nowNs() - start);
      assertSuccess(response, "list_memories");
      listLatencies.push(durationMs);
    }

    for (let iteration = 0; iteration < RELATED_ITERATIONS; iteration += 1) {
      const sourceId = ids[iteration % (connectLimit + 1)];
      const start = nowNs();
      const response = await server.callTool("related_to", {
        memory_id: sourceId,
        query: createSearchQuery(iteration),
      });
      const durationMs = nsToMs(nowNs() - start);
      assertSuccess(response, "related_to");
      relatedLatencies.push(durationMs);
    }

    const statsResponse = await server.callTool("memory_stats", {});
    assertSuccess(statsResponse, "memory_stats");

    return {
      dataset_size: size,
      connected_sample_size: connectLimit + 1,
      store: {
        total_duration_ms: storeDurationMs,
        avg_ms_per_memory: storeDurationMs / size,
        throughput_ops_per_sec: size / (storeDurationMs / 1000),
      },
      search_memories: summarizeLatencies(searchLatencies),
      list_memories: summarizeLatencies(listLatencies),
      related_to: summarizeLatencies(relatedLatencies),
      memory_stats_excerpt: extractText(statsResponse).split("\n").slice(0, 6),
    };
  } finally {
    await server.stop();
  }
}

function buildMarkdownReport(results, environment) {
  const lines = [
    "# Memory Benchmark Baseline",
    "",
    `Date: ${environment.date}`,
    `Commit: ${environment.git_commit}`,
    `Node: ${environment.node}`,
    `Platform: ${environment.platform}`,
    `CPU: ${environment.cpu_model} (${environment.cpu_count} logical cores)`,
    `Memory: ${environment.total_memory_gb.toFixed(2)} GB`,
    "",
    "These measurements are end-to-end MCP stdio timings against the built server in an isolated temp persistence directory.",
    "",
    "| Dataset | Store Avg ms | Store Throughput ops/s | Search p95 ms | List p95 ms | Related p95 ms |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
  ];

  for (const result of results) {
    lines.push(
      `| ${result.dataset_size} | ${formatMs(result.store.avg_ms_per_memory)} | ${formatOps(result.store.throughput_ops_per_sec)} | ${formatMs(result.search_memories.p95_ms)} | ${formatMs(result.list_memories.p95_ms)} | ${formatMs(result.related_to.p95_ms)} |`,
    );
  }

  lines.push("", "## Detailed Metrics", "");

  for (const result of results) {
    lines.push(`### ${result.dataset_size} memories`, "");
    lines.push(`- Store total duration: ${formatMs(result.store.total_duration_ms)} ms`);
    lines.push(`- Store average per memory: ${formatMs(result.store.avg_ms_per_memory)} ms`);
    lines.push(`- Store throughput: ${formatOps(result.store.throughput_ops_per_sec)} ops/s`);
    lines.push(`- Search avg/p50/p95/max: ${formatMs(result.search_memories.average_ms)} / ${formatMs(result.search_memories.p50_ms)} / ${formatMs(result.search_memories.p95_ms)} / ${formatMs(result.search_memories.max_ms)} ms`);
    lines.push(`- List avg/p50/p95/max: ${formatMs(result.list_memories.average_ms)} / ${formatMs(result.list_memories.p50_ms)} / ${formatMs(result.list_memories.p95_ms)} / ${formatMs(result.list_memories.max_ms)} ms`);
    lines.push(`- Related avg/p50/p95/max: ${formatMs(result.related_to.average_ms)} / ${formatMs(result.related_to.p50_ms)} / ${formatMs(result.related_to.p95_ms)} / ${formatMs(result.related_to.max_ms)} ms`);
    lines.push(`- Connected sample size for graph benchmark: ${result.connected_sample_size}`);
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const environment = {
    date: new Date().toISOString(),
    git_commit: getGitCommit(),
    node: process.version,
    platform: `${process.platform} ${os.release()} (${process.arch})`,
    cpu_model: os.cpus()[0]?.model ?? "unknown",
    cpu_count: os.cpus().length,
    total_memory_gb: os.totalmem() / (1024 ** 3),
  };

  const results = [];
  for (const size of DATASET_SIZES) {
    process.stdout.write(`Running benchmark for ${size} memories...\n`);
    results.push(await benchmarkDataset(size));
  }

  const payload = {
    environment,
    results,
  };
  const markdown = buildMarkdownReport(results, environment);
  const jsonPath = path.join(OUTPUT_DIR, "memory-benchmark-baseline.json");
  const markdownPath = path.join(OUTPUT_DIR, "memory-benchmark-baseline.md");

  fs.writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.writeFileSync(markdownPath, markdown, "utf8");

  process.stdout.write(`Benchmark JSON written to ${path.relative(process.cwd(), jsonPath)}\n`);
  process.stdout.write(`Benchmark Markdown written to ${path.relative(process.cwd(), markdownPath)}\n\n`);
  process.stdout.write(markdown);
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});