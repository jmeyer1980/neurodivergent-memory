const fs = require('fs');

let code = fs.readFileSync('test-memory-graph.ts', 'utf-8');

// 1. Add global state after testLog
code = code.replace(
  'const testLog: string[] = [];',
  'const testLog: string[] = [];\nlet totalRequestsExpected = 0;\nlet completionTimeout: NodeJS.Timeout | null = null;'
);

// 2. Add helper functions - insert before the first 'async function runTests'
const helpers = `
function checkCompletion(): boolean {
  return results.size >= totalRequestsExpected;
}

function resetCompletionTimeout(): void {
  if (completionTimeout) {
    clearTimeout(completionTimeout);
  }
  completionTimeout = setTimeout(() => {
    log('\\nCompletion timeout reached. Writing results...');
    writeResultsAndExit();
  }, 10000);
}

function writeResultsAndExit(): void {
  if (completionTimeout) {
    clearTimeout(completionTimeout);
    completionTimeout = null;
  }
  
  log('\\nTest completed. Writing results to test-results.txt...');

  const summary = \`
=============================================================================
SMOKE TEST RESULTS: "Executive Function Support Network" Memory Graph
=============================================================================

Total Requests Sent: \${totalRequestsExpected}
Total Responses Received: \${results.size}

Response Summary:
\${Array.from(results.values())
  .map(r => \`  ID \${r.id}: \${r.result ? '✓ SUCCESS' : '✗ ERROR: ' + r.error?.message}\`)
  .join('\\n')}

\${testLog.join('\\n')}
=============================================================================
\`;

  fs.writeFileSync('test-results.txt', summary);
  console.error('\\nResults written to test-results.txt');
  process.exit(0);
}

`;

const runTestsPos = code.indexOf('async function runTests');
code = code.substring(0, runTestsPos) + helpers + code.substring(runTestsPos);

// 3. Change async function runTests(): Promise<void> to Promise<number>
code = code.replace(
  'async function runTests(): Promise<void> {',
  'async function runTests(): Promise<number> {'
);

// 4. Set totalRequestsExpected and add return
code = code.replace(
  'log(`\\nSending ${requests.length} test commands to MCP server...`);',
  'log(`\\nSending ${requests.length} test commands to MCP server...`);\n  totalRequestsExpected = requests.length;'
);

code = code.replace(
  "log('\\nAll test commands sent. Waiting for responses...');",
  "log('\\nAll test commands sent. Waiting for responses...');\n  return totalRequestsExpected;"
);

// 5. Update rl.on('line') handler - add completion check
code = code.replace(
  /(\s+log\(`← Response id=\${response\.id\}:.*?\)`\);)\n(\s+)\}/m,
  (match, logLine, indent) => {
    return logLine + '\n      \n      if (checkCompletion()) {\n        log(`\\nAll ${totalRequestsExpected} responses received!`);\n        writeResultsAndExit();\n      } else {\n        resetCompletionTimeout();\n      }\n    }';
  }
);

// 6. Replace the entire rl.on('close') block
code = code.replace(
  /rl\.on\('close', \(\) => \{[\s\S]*?\}\);/,
  "rl.on('close', () => {\n  log('\\nReadline interface closed.');\n  writeResultsAndExit();\n});"
);

// 7. Update runTests() call
code = code.replace(
  'runTests().catch(err => {',
  'runTests().then(expected => {\n  log(`Waiting for ${expected} responses...`);\n  resetCompletionTimeout();\n}).catch(err => {'
);

fs.writeFileSync('test-memory-graph.ts', code);
console.log('✓ All fixes applied');
