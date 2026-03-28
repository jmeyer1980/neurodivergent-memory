const fs = require('fs');
let code = fs.readFileSync('test-memory-graph.ts', 'utf-8');

// Fix 1: Add return statement after log
code = code.replace(
  "  log('\\nAll test commands sent. Waiting for responses...');\\n}",
  "  log('\\nAll test commands sent. Waiting for responses...');\\n  return totalRequestsExpected;\\n}"
);

// Fix 2: Add completion checks in rl.on('line')  
code = code.replace(
  "log(`← Response id=${response.id}: ${response.result ? 'SUCCESS' : response.error?.message || 'ERROR'}`);\\n    }",
  "log(`← Response id=${response.id}: ${response.result ? 'SUCCESS' : response.error?.message || 'ERROR'}`);\\n      \\n      if (checkCompletion()) {\\n        log(`\\nAll ${totalRequestsExpected} responses received!`);\\n        writeResultsAndExit();\\n      } else {\\n        resetCompletionTimeout();\\n      }\\n    }"
);

// Fix 3: Update runTests() call
code = code.replace(
  "// Run tests\\nrunTests().catch(err => {",
  "// Run tests and initialize timeout\\nrunTests().then(expected => {\\n  log(`Waiting for ${expected} responses...`);\\n  resetCompletionTimeout();\\n}).catch(err => {"
);

fs.writeFileSync('test-memory-graph.ts', code);
console.log('Applied remaining fixes');
