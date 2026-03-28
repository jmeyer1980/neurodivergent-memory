const fs = require('fs');

let code = fs.readFileSync('test-memory-graph.ts', 'utf-8');

// Split at the problematic section
const beforeLine = 'rl.on(\'line\', (line: string) => {\n  try {\n    const response: MCPResponse = JSON.parse(line);\n    if (response.id !== undefined) {\n      results.set(response.id, response);\n      log(`← Response id=${response.id}: ${response.result ? \'SUCCESS\' : response.error?.message || \'ERROR'}`);\n    }\n  } catch (e) {\n    log(`Error parsing response: ${e}`);\n  }\n});';

const afterLine = 'rl.on(\'close\', () => {\n  log(\'\\nReadline interface closed.\');\n  writeResultsAndExit();\n});';

const fixedLine = `rl.on('line', (line: string) => {
  try {
    const response: MCPResponse = JSON.parse(line);
    if (response.id !== undefined) {
      results.set(response.id, response);
      log(\`← Response id=\${response.id}: \${response.result ? 'SUCCESS' : response.error?.message || 'ERROR'}\`);
      
      if (checkCompletion()) {
        log(\`\\nAll \${totalRequestsExpected} responses received!\`);
        writeResultsAndExit();
      } else {
        resetCompletionTimeout();
      }
    }
  } catch (e) {
    log(\`Error parsing response: \${e}\`);
  }
});`;

if (code.includes(beforeLine)) {
  code = code.replace(beforeLine, fixedLine);
  console.log('✓ Fixed rl.on(line) with completion check');
} else {
  console.log('✗ Could not find exact rl.on(line) block');
}

fs.writeFileSync('test-memory-graph.ts', code);
