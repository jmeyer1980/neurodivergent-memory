const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const sourceRoot = path.join(repoRoot, ".github", "agent-kit");
const sourceTemplates = path.join(sourceRoot, "templates");
const sourceReadme = path.join(sourceRoot, "README.md");
const targetRoot = path.join(repoRoot, "templates", "agent-kit");

if (!fs.existsSync(sourceTemplates)) {
  console.error(`Agent kit templates not found at ${sourceTemplates}`);
  process.exit(1);
}

fs.rmSync(targetRoot, { recursive: true, force: true });
fs.mkdirSync(targetRoot, { recursive: true });
fs.cpSync(sourceTemplates, targetRoot, { recursive: true });

if (fs.existsSync(sourceReadme)) {
  fs.copyFileSync(sourceReadme, path.join(targetRoot, "README.md"));
}

console.log(`Prepared packaged agent kit at ${targetRoot}`);