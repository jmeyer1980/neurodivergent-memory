#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { spawnSync } = require("child_process");


const repoRoot = path.resolve(__dirname, "..");
const cliEntrypoint = path.join(repoRoot, "build", "index.js");
const defaultTarget = process.cwd();

function promptUser(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function promptBrand() {
  const answer = (await promptUser("Install for which brand? [auto/copilot/claude] (default: auto): "))
    .trim()
    .toLowerCase();

  if (!answer) return "auto";
  if (answer === "auto" || answer === "copilot" || answer === "claude") return answer;
  throw new Error("Unsupported brand. Use auto, copilot, or claude.");
}

async function main() {
  if (!fs.existsSync(cliEntrypoint)) {
    console.error(
      `ERROR: Could not find built CLI entrypoint at ${cliEntrypoint}.\n` +
      `Run \"npm run build\" first, then rerun this helper.`
    );
    process.exit(1);
  }

  const passthroughArgs = process.argv.slice(2);
  let targetDir = null;
  let brand = null;

  for (let index = 0; index < passthroughArgs.length; index += 1) {
    const arg = passthroughArgs[index];
    if (arg === "--target") {
      targetDir = passthroughArgs[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === "--brand") {
      brand = passthroughArgs[index + 1] ?? null;
      index += 1;
    }
  }

  if (!brand) {
    brand = await promptBrand();
  }

  if (!targetDir) {
    targetDir = await promptUser(
      `Enter target repository root or brand folder (default: ${defaultTarget}): `
    );
    if (!targetDir) targetDir = defaultTarget;
  }

  const normalizedArgs = [];
  let skipNext = false;
  for (let index = 0; index < passthroughArgs.length; index += 1) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    const arg = passthroughArgs[index];
    if (arg === "--target" || arg === "--brand") {
      skipNext = true;
      continue;
    }
    normalizedArgs.push(arg);
  }

  normalizedArgs.push("--brand", brand, "--target", targetDir);

  const result = spawnSync(process.execPath, [cliEntrypoint, "init-agent-kit", ...normalizedArgs], {
    cwd: repoRoot,
    stdio: "inherit",
  });

  process.exit(result.status ?? 1);
}

main();
