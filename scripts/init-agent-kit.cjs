#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const readline = require("readline");


const repoRoot = path.resolve(__dirname, "..");
const possibleSources = [
  path.join(repoRoot, "templates", "agent-kit"),
  path.join(repoRoot, ".github", "agent-kit", "templates"),
];
let sourceRoot = null;
for (const src of possibleSources) {
  if (fs.existsSync(src)) {
    sourceRoot = src;
    break;
  }
}
const defaultTarget = path.join(repoRoot, "templates", "agent-kit");

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

async function main() {
  let targetDir = process.argv[2];
  if (!targetDir) {
    targetDir = await promptUser(
      `Enter preferred kit import directory (default: ${defaultTarget}): `
    );
    if (!targetDir) targetDir = defaultTarget;
  }
  if (!sourceRoot) {
    console.error(
      `ERROR: Could not find agent kit templates.\n` +
      `Checked: ${possibleSources.join("\n         ")}\n` +
      `If you installed from npm, use the default directory under templates/agent-kit.\n` +
      `If you are developing locally, run scripts/prepare-agent-kit.cjs to generate templates/agent-kit.\n` +
      `If you need help, see the README or ask for support.`
    );
    process.exit(1);
  }
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
  fs.cpSync(sourceRoot, targetDir, { recursive: true });
  console.log(`Prepared packaged agent kit from ${sourceRoot} to ${targetDir}`);
}

main();
