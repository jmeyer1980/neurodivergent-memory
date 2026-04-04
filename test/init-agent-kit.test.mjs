import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function makeTempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ndm-init-agent-kit-"));
}

function runInitAgentKit(args = []) {
  return spawnSync(process.execPath, ["build/index.js", "init-agent-kit", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

test("init-agent-kit copies templates into standard .github targets", () => {
  const tempRepo = makeTempRepo();

  try {
    const result = runInitAgentKit(["--target", tempRepo]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(tempRepo, ".github", "agents", "neurodivergent-agent.agent.md")), true);
    assert.equal(fs.existsSync(path.join(tempRepo, ".github", "agents", "memory-driven-template.agent.md")), true);
    assert.equal(fs.existsSync(path.join(tempRepo, ".github", "instructions", "nd-memory-workflow.instructions.md")), true);
    assert.equal(fs.existsSync(path.join(tempRepo, ".github", "prompts", "setup-nd-memory.prompt.md")), true);
    assert.equal(fs.existsSync(path.join(tempRepo, ".github", "copilot-instructions.md")), true);
  } finally {
    fs.rmSync(tempRepo, { recursive: true, force: true });
  }
});

test("init-agent-kit dry-run reports copies without writing files", () => {
  const tempRepo = makeTempRepo();

  try {
    const result = runInitAgentKit(["--target", tempRepo, "--dry-run"]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /WOULD COPY/);
    assert.equal(fs.existsSync(path.join(tempRepo, ".github", "agents", "neurodivergent-agent.agent.md")), false);
  } finally {
    fs.rmSync(tempRepo, { recursive: true, force: true });
  }
});

test("init-agent-kit skips existing files unless --force is used", () => {
  const tempRepo = makeTempRepo();
  const targetFile = path.join(tempRepo, ".github", "agents", "neurodivergent-agent.agent.md");

  try {
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, "sentinel\n", "utf8");

    const skipped = runInitAgentKit(["--target", tempRepo]);
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.match(skipped.stdout, /SKIPPED/);
    assert.equal(fs.readFileSync(targetFile, "utf8"), "sentinel\n");

    const forced = runInitAgentKit(["--target", tempRepo, "--force"]);
    assert.equal(forced.status, 0, forced.stderr);
    assert.doesNotMatch(fs.readFileSync(targetFile, "utf8"), /^sentinel$/m);
  } finally {
    fs.rmSync(tempRepo, { recursive: true, force: true });
  }
});