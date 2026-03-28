const fs = require('fs');

let code = fs.readFileSync('test-memory-graph.ts', 'utf-8');

// Find the rl.on('line') handler and add completion check
const targetString = `log(\`← Response id=\${response.id}: \${response.result ? 'SUCCESS' : response.error?.message || 'ERROR'}\`);
    }`;

const replacement = `log(\`← Response id=\${response.id}: \${response.result ? 'SUCCESS' : response.error?.message || 'ERROR'}\`);
      
      if (checkCompletion()) {
        log(\`\\nAll \${totalRequestsExpected} responses received!\`);
        writeResultsAndExit();
      } else {
        resetCompletionTimeout();
      }
    }`;

if (code.includes(targetString)) {
  code = code.replace(targetString, replacement);
  console.log('✓ Added completion check to rl.on(line)');
} else {
  console.log('✗ Could not find target string in rl.on(line)');
}

// Update runTests() call
if (code.includes('// Run tests\nrunTests().catch(err => {')) {
  code = code.replace(
    '// Run tests\nrunTests().catch(err => {',
    '// Run tests and initialize timeout\nrunTests().then(expected => {\n  log(`Waiting for ${expected} responses...`);\n  resetCompletionTimeout();\n}).catch(err => {'
  );
  console.log('✓ Updated runTests() call');
} else {
  console.log('✗ Could not find runTests() call');
}

fs.writeFileSync('test-memory-graph.ts', code);
