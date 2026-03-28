#!/usr/bin/env node
/**
 * Comprehensive MCP Server Smoke Test
 * 
 * Scenario: "Executive Function Support Network"
 * Tests all 5 memory districts, canonical tagging, search, listing, and summary statistics
 * 
 * This creates a realistic memory graph for managing executive dysfunction,
 * exercising core MCP server capabilities related to memory storage and retrieval.
 */

import * as readline from 'readline';
import * as fs from 'fs';

interface MCPRequest {
  jsonrpc: string;
  id: number;
  method: string;
  params: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: string;
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

const results: Map<number, MCPResponse> = new Map();
const testLog: string[] = [];
let totalRequestsExpected = 0;
let completionTimeout: NodeJS.Timeout | null = null;

function log(msg: string) {
  console.error(`[${new Date().toISOString()}] ${msg}`);
  testLog.push(msg);
}

function sendRequest(req: MCPRequest): void {
  const json = JSON.stringify(req);
  console.log(json);
  log(`→ Sent: ${req.method} (id=${req.id})`);
}


function checkCompletion(): boolean {
  return results.size >= totalRequestsExpected;
}

function resetCompletionTimeout(): void {
  if (completionTimeout) {
    clearTimeout(completionTimeout);
  }
  completionTimeout = setTimeout(() => {
    log('\nCompletion timeout reached. Writing results...');
    writeResultsAndExit();
  }, 10000);
}

function writeResultsAndExit(): void {
  if (completionTimeout) {
    clearTimeout(completionTimeout);
    completionTimeout = null;
  }
  
  log('\nTest completed. Writing results to test-results.txt...');

  const summary = `
=============================================================================
SMOKE TEST RESULTS: "Executive Function Support Network" Memory Graph
=============================================================================

Total Requests Sent: ${totalRequestsExpected}
Total Responses Received: ${results.size}

Response Summary:
${Array.from(results.values())
  .map(r => `  ID ${r.id}: ${r.result ? '✓ SUCCESS' : '✗ ERROR: ' + r.error?.message}`)
  .join('\n')}

${testLog.join('\n')}
=============================================================================
`;

  fs.writeFileSync('test-results.txt', summary);
  console.error('\nResults written to test-results.txt');
  process.exit(0);
}

async function runTests(): Promise<number> {
  const requests: MCPRequest[] = [];

  log('=== PHASE 1: Creating Memory Graph (All 5 Districts) ===');

  // ========================================================================
  // District 1: logical_analysis - Root Cause Analysis
  // ========================================================================
  requests.push({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'store_memory',
      arguments: {
        content: `Executive dysfunction manifests as task initiation paralysis due to amygdala hyperactivity in response to task ambiguity. Works via time blindness (no dopamine gradient) + perfectionism (fear-based goal setting) + working memory load.`,
        district: 'logical_analysis',
        tags: ['topic:adhd-executive-function', 'scope:concept', 'kind:insight', 'layer:research'],
        emotional_valence: 0,
        intensity: 0.8,
      },
    },
  });

  // ========================================================================
  // District 2: emotional_processing - Emotional Impact
  // ========================================================================
  requests.push({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'store_memory',
      arguments: {
        content: `Cycle of shame: task avoidance → guilt accumulation → identity damage ('I'm lazy') → more amygdala activation → deeper avoidance. Breaks trust in self-efficacy. Recovery requires self-compassion checkpoint.`,
        district: 'emotional_processing',
        tags: ['topic:adhd-shame-cycles', 'scope:concept', 'kind:pattern', 'layer:implementation'],
        emotional_valence: -1,
        intensity: 0.9,
      },
    },
  });

  // ========================================================================
  // District 3: practical_execution - Action Strategy
  // ========================================================================
  requests.push({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'store_memory',
      arguments: {
        content: `Proven intervention: time-box planning (10 min chunks max) → break into micro-tasks → external deadline (accountability partner/calendar block) → dopamine reward (celebration) → build momentum habit.`,
        district: 'practical_execution',
        tags: ['topic:adhd-strategies', 'scope:project', 'kind:pattern', 'layer:implementation'],
        emotional_valence: 1,
        intensity: 0.7,
      },
    },
  });

  // ========================================================================
  // District 4: vigilant_monitoring - Risk Assessment
  // ========================================================================
  requests.push({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'store_memory',
      arguments: {
        content: `RISKS: (1) Perfectionism trap - settings unrealistic standards = paralysis renewal; (2) Dependency on external deadlines leads to crisis mode; (3) Shame spiral if setback occurs; (4) Over-commitment from hyperfocus enthusiasm.`,
        district: 'vigilant_monitoring',
        tags: ['topic:adhd-risks', 'scope:project', 'kind:pattern', 'layer:architecture'],
        emotional_valence: -1,
        intensity: 0.8,
      },
    },
  });

  // ========================================================================
  // District 5: creative_synthesis - Cross-Domain Insight
  // ========================================================================
  requests.push({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'store_memory',
      arguments: {
        content: `INSIGHT: ADHD executive dysfunction mirrors complex systems failure modes - insufficient feedback loops (time blindness = no state feedback), emergent unpredictability (task ambiguity = system chaos), and control cascade failure (perfectionism = over-regulation). Solutions: add external feedback, decompose chaos, enable iteration.`,
        district: 'creative_synthesis',
        tags: ['topic:adhd-systems-thinking', 'scope:concept', 'kind:insight', 'layer:architecture'],
        emotional_valence: 1,
        intensity: 0.9,
      },
    },
  });

  // ========================================================================
  // Practical Memories (Implementation Details)
  // ========================================================================
  log('\nAdding project-scoped working memories...');

  requests.push({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: {
      name: 'store_memory',
      arguments: {
        content: `CURRENT TASK: Ship neurodivergent-memory v0.1.1. Status: Release tests in progress. Dependencies: TypeScript build ✓, Docker image ✓, npm attestation ✓. Blocker: None. Deadline: EOD today. Next: PR merge + tag push.`,
        district: 'practical_execution',
        tags: ['topic:project-neurodivergent-memory', 'scope:session', 'kind:task', 'layer:implementation'],
        emotional_valence: 1,
        intensity: 0.6,
      },
    },
  });

  requests.push({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: {
      name: 'store_memory',
      arguments: {
        content: `DEPENDENCY CHAIN: MCP protocol (stdio newline-delimited JSON) → Node.js runtime (v20 LTS) → TypeScript compilation → Docker containerization. Each layer has critical path implications.`,
        district: 'vigilant_monitoring',
        tags: ['topic:project-neurodivergent-memory', 'scope:project', 'kind:decision', 'layer:architecture'],
        emotional_valence: 0,
        intensity: 0.7,
      },
    },
  });

  requests.push({
    jsonrpc: '2.0',
    id: 8,
    method: 'tools/call',
    params: {
      name: 'store_memory',
      arguments: {
        content: `DEBUGGING: Previous session - GitHub PAT auth issue resolved by moving token to Windows User env scope (not terminal session var). Lesson: persistent env vars must be machine/user scoped, not process-local.`,
        district: 'logical_analysis',
        tags: ['topic:devops-github-mcp', 'scope:session', 'kind:decision', 'layer:debugging'],
        emotional_valence: 0,
        intensity: 0.5,
      },
    },
  });

  // ========================================================================
  // Memory Statistics
  // ========================================================================
  log('\n=== PHASE 2: Memory Statistics & Validation ===');

  requests.push({
    jsonrpc: '2.0',
    id: 98,
    method: 'tools/call',
    params: {
      name: 'memory_stats',
      arguments: {},
    },
  });

  // ========================================================================
  // Search Operations
  // ========================================================================
  log('\n=== PHASE 3: Testing Search & Retrieval ===');

  requests.push({
    jsonrpc: '2.0',
    id: 99,
    method: 'tools/call',
    params: {
      name: 'search_memories',
      arguments: {
        query: 'time blindness dopamine task initiation',
        min_score: 0.1,
      },
    },
  });

  requests.push({
    jsonrpc: '2.0',
    id: 100,
    method: 'tools/call',
    params: {
      name: 'search_memories',
      arguments: {
        query: 'perfectionism risk',
        tags: ['topic:adhd-risks'],
        min_score: 0.05,
      },
    },
  });

  // ========================================================================
  // List All Memories
  // ========================================================================
  log('\n=== PHASE 4: Memory Enumeration ===');

  requests.push({
    jsonrpc: '2.0',
    id: 101,
    method: 'tools/call',
    params: {
      name: 'list_memories',
      arguments: {
        page: 1,
        page_size: 50,
      },
    },
  });

  // ========================================================================
  // Send all requests
  // ========================================================================
  log(`\nSending ${requests.length} test commands to MCP server...`);
  totalRequestsExpected = requests.length;

  for (const req of requests) {
    sendRequest(req);
    await new Promise(resolve => setTimeout(resolve, 100)); // Small delay between requests
  }

  log('\nAll test commands sent. Waiting for responses...');
  return totalRequestsExpected;
}

// Start test
rl.on('line', (line: string) => {
  try {
    const response: MCPResponse = JSON.parse(line);
    if (response.id !== undefined) {
      results.set(response.id, response);
      log(`← Response id=${response.id}: ${response.result ? 'SUCCESS' : response.error?.message || 'ERROR'}`);
      
          if (checkCompletion()) {
            log(`\nAll ${totalRequestsExpected} responses received!`);
            writeResultsAndExit();
          } else {
            resetCompletionTimeout();
          }
    }
  } catch (e) {
    log(`Error parsing response: ${e}`);
  }
});

rl.on('close', () => {
  log('\nReadline interface closed.');
  writeResultsAndExit();
});

// Run tests
runTests().then(expected => {
  log(`Waiting for ${expected} responses...`);
  resetCompletionTimeout();
}).catch(err => {
  log(`Test error: ${err}`);
  process.exit(1);
});
