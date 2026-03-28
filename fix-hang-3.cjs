const fs = require('fs');

// Read the file
let lines = fs.readFileSync('test-memory-graph.ts', 'utf-8').split('\n');

// Find and mark lines to modify
let result = [];
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  
  // Fix 1: Add return statement after "All test commands sent"
  if (line.includes("log('\\nAll test commands sent. Waiting for responses...');") && lines[i+1].includes('}')) {
    result.push(line);
    result.push('  return totalRequestsExpected;');
    continue;
  }
  
  // Fix 2: Add completion check after logging response
  if (line.includes("log(`← Response id=${response.id}:") && line.includes("'ERROR'}`);")) {
    result.push(line);
    result.push('      ');
    result.push('      if (checkCompletion()) {');
    result.push("        log(`\\nAll ${totalRequestsExpected} responses received!`);");
    result.push('        writeResultsAndExit();');
    result.push('      } else {');
    result.push('        resetCompletionTimeout();');
    result.push('      }');
    // Skip the next closing brace line if it exists
    if (lines[i+1].trim() === '}') {
      i++;
    }
    continue;
  }
  
  // Fix 3: Update runTests call
  if (line.includes('// Run tests') && !line.includes('and initialize')) {
    result.push('// Run tests and initialize timeout');
    i++; // skip current line
    if (lines[i].includes('runTests().catch')) {
      result.push('runTests().then(expected => {');
      result.push('  log(`Waiting for ${expected} responses...`);');
      result.push('  resetCompletionTimeout();');
      result.push('}).catch(err => {');
      i++; // skip the original catch line
      continue;
    }
  }
  
  result.push(line);
}

fs.writeFileSync('test-memory-graph.ts', result.join('\n'));
console.log('✓ Applied all fixes');
