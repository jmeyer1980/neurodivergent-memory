import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("agent-kit copilot instructions keep rationale-first memory guardrails", () => {
  const content = read(".github/agent-kit/templates/copilot-instructions.md");

  assert.match(content, /Memory Quality Guardrails/);
  assert.match(content, /reasoning behind the action/i);
  assert.match(content, /No execution-only memory exemption/i);
  assert.match(content, /Repo notes are not a substitute/i);
  assert.match(content, /Create or update an MCP-backed plan memory/i);
  assert.match(content, /Sub-agent coordination/i);
});

test("agent-kit neurodivergent agent rejects execution-only memory logs", () => {
  const content = read(".github/agent-kit/templates/neurodivergent-agent.agent.md");

  assert.match(content, /No Execution-Only/i);
  assert.match(content, /durable principle/i);
  assert.match(content, /reasoning behind them/i);
});

test("workflow instruction and issue prompt require explicit why capture", () => {
  const workflow = read(".github/agent-kit/templates/nd-memory-workflow.instructions.md");
  const prompt = read(".github/agent-kit/templates/memory-driven-issue-execution.prompt.md");

  assert.match(workflow, /Store the why behind decisions/i);
  assert.match(workflow, /Record progress, validation, and hand-off writes on the active task thread/i);
  assert.match(workflow, /Require `connect_memories` whenever you create a new plan or task-thread node/i);
  assert.match(workflow, /continue locally and do not treat their absence as a blocker/i);
  assert.match(workflow, /durable principle/i);
  assert.match(prompt, /durable principle behind the work/i);
  assert.match(prompt, /Do not leave execution-only logs/i);
});

test("source templates stay aligned with packaged agent-kit copies", () => {
  for (const relativePath of [
    "memory-driven-template.agent.md",
    "nd-memory-workflow.instructions.md",
    "copilot-instructions.md",
  ]) {
    const source = read(path.join("templates", "agent-kit", relativePath));
    const packaged = read(path.join(".github", "agent-kit", "templates", relativePath));
    assert.equal(source, packaged, `${relativePath} drifted between source and packaged copies`);
  }
});