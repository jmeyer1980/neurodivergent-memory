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
  assert.match(workflow, /durable principle/i);
  assert.match(prompt, /durable principle behind the work/i);
  assert.match(prompt, /Do not leave execution-only logs/i);
});