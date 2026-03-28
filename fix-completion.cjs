const fs = require('fs');

let code = fs.readFileSync('test-memory-graph.ts', 'utf-8');

// Use simpler approach - find and replace just the closing of the if block
const oldIfBlock = `      results.set(response.id, response);
      log(\`← Response id=\${response.id}: \${response.result ? 'SUCCESS' : response.error?.message || 'ERROR'}\`);
    }`;

const newIfBlock = `      results.set(response.id, response);
      log(\`← Response id=\${response.id}: \${response.result ? 'SUCCESS' : response.error?.message || 'ERROR'}\`);
      
      if (checkCompletion()) {
        log(\`\\nAll \${totalRequestsExpected} responses received!\`);
        writeResultsAndExit();
      } else {
        resetCompletionTimeout();
      }
    }`;

if (code.includes(oldIfBlock)) {
  code = code.replace(oldIfBlock, newIfBlock);
  console.log('✓ Added completion check');
  fs.writeFileSync('test-memory-graph.ts', code);
} else {
  console.log('✗ Pattern not found');
}
