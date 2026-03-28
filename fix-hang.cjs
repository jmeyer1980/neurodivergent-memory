const fs = require('fs');

let code = fs.readFileSync('test-memory-graph.ts', 'utf-8');

// 1. Add global state after testLog declaration
code = code.replace(
  'const testLog: string[] = [];',
  'const testLog: string[] = [];\nlet totalRequestsExpected = 0;\nlet completionTimeout: NodeJS.Timeout | null = null;'
);

// 2. Add three new helper functions after sendRequest
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
}`;

code = code.replace(
  'function sendRequest(req: MCPRequest): void {',
  'function sendRequest(req: MCPRequest): void {'
);

code = code.replace(
  /(\})\s+async function runTests/,
  helpers + '\n\nasync function runTests'
);

// 3. Change async function runTests() signature
code = code.replace(
  'async function runTests(): Promise<void> {',
  'async function runTests(): Promise<number> {'
);

// 4. Add totalRequestsExpected assignment
code = code.replace(
  'log(`\\nSending ${requests.length} test commands to MCP server...`);',
  'log(`\\nSending ${requests.length} test commands to MCP server...`);\n  totalRequestsExpected = requests.length;'
);

// 5. Return from runTests
code = code.replace(
  "log('\\nAll test commands sent. Waiting for responses...');\n}",
  "log('\\nAll test commands sent. Waiting for responses...');\n  return totalRequestsExpected;\n}"
);

// 6. Update rl.on('line') with completion check
code = code.replace(
  "log(`← Response id=${response.id}: ${response.result ? 'SUCCESS' : response.error?.message || 'ERROR'}`);\n    }",
  "log(`← Response id=${response.id}: ${response.result ? 'SUCCESS' : response.error?.message || 'ERROR'}`);\n      \n      if (checkCompletion()) {\n        log(`\\nAll ${totalRequestsExpected} responses received!`);\n        writeResultsAndExit();\n      } else {\n        resetCompletionTimeout();\n      }\n    }"
);

// 7. Replace rl.on('close') block to just call writeResultsAndExit
const closeHandlerPattern = "rl.on('close', \\(\\) => {[^}]*}\\);";
const closeHandlerReplacement = "rl.on('close', () => {\n  log('\\nReadline interface closed.');\n  writeResultsAndExit();\n});";
code = code.replace(/rl\.on\('close', \(\) => \{[\s\S]*?\}\);/, closeHandlerReplacement);

// 8. Update runTests() call to initialize timeout
code = code.replace(
  'runTests().catch(err => {',
  'runTests().then(expected => {\n  log(`Waiting for ${expected} responses...`);\n  resetCompletionTimeout();\n}).catch(err => {'
);

fs.writeFileSync('test-memory-graph.ts', code);
console.log('✓ test-memory-graph.ts updated with completion handler and timeout logic');
