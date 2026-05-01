const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execSync } = require('node:child_process');

const rootDir = path.resolve(__dirname, '..');
const sourcePackagePath = path.join(rootDir, 'package.json');
const sourcePackage = JSON.parse(fs.readFileSync(sourcePackagePath, 'utf8'));

const stagedPackage = {
  name: sourcePackage.name,
  displayName: sourcePackage.displayName,
  version: sourcePackage.version,
  publisher: sourcePackage.publisher,
  description: sourcePackage.description,
  license: sourcePackage.license,
  engines: sourcePackage.engines,
  categories: sourcePackage.categories,
  main: sourcePackage.main,
  activationEvents: sourcePackage.activationEvents,
  contributes: sourcePackage.contributes,
  icon: sourcePackage.icon,
  repository: sourcePackage.repository,
  homepage: sourcePackage.homepage,
  bugs: sourcePackage.bugs
};

const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndm-vscode-stage-'));
const outputVsixPath = path.join(rootDir, 'neurodivergent-memory-vscode.vsix');

function copyRelative(relPath) {
  const src = path.join(rootDir, relPath);
  const dst = path.join(stageDir, relPath);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

try {
  copyRelative('build/vscode/extension.js');
  copyRelative('assets/marketplace-icon.png');
  copyRelative('README.md');
  copyRelative('LICENSE');

  fs.writeFileSync(path.join(stageDir, 'package.json'), `${JSON.stringify(stagedPackage, null, 2)}\n`);

  execSync(`npm exec --yes -- @vscode/vsce package -o "${outputVsixPath}"`, {
    cwd: stageDir,
    stdio: 'inherit'
  });

  console.log(`Packaged VS Code extension VSIX: ${outputVsixPath}`);
} finally {
  fs.rmSync(stageDir, { recursive: true, force: true });
}
