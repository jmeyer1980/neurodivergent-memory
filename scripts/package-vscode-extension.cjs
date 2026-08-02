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

/**
 * The extension host require()s the entry point, so it must be CommonJS. The
 * root tsconfig emits ESM (module Node16 under "type": "module"), and this
 * script's staged manifest deliberately omits "type" — so an ESM entry ships
 * as a .js the host parses as CommonJS and activation dies with
 * "Cannot use import statement outside a module", killing every command.
 * tsconfig.vscode.json recompiles this one file to CommonJS; verify it landed
 * rather than trusting the build order, because the failure is invisible until
 * a user installs the extension and CI only checks that a .vsix exists.
 */
function assertCommonJsEntry(relPath) {
  const source = fs.readFileSync(path.join(rootDir, relPath), 'utf8');
  const esmSignature = /^\s*(?:import\s|export\s)/m;
  if (esmSignature.test(source)) {
    throw new Error(
      `${relPath} is ESM, but the VS Code extension host requires CommonJS.\n` +
      'Run `tsc -p tsconfig.vscode.json` after the main build (npm run package:vscode does this).\n' +
      'Shipping this would throw "Cannot use import statement outside a module" at activation.'
    );
  }
}

try {
  assertCommonJsEntry('build/vscode/extension.js');
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
