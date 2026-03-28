const fs = require('fs');
const code = fs.readFileSync('test-memory-graph.ts', 'utf-8');

// Find where "Response id=" occurs
const pos = code.indexOf('Response id=');
if (pos > 0) {
  console.log('Found Response id at position:',  pos);
  const around = code.substring(Math.max(0, pos - 50), pos + 300);
  console.log('Context around Response id:');
  console.log(JSON.stringify(around));
}

// Find runTests call
const runPos = code.indexOf('runTests()');
if (runPos > 0) {
  console.log('\nFound runTests() at position:', runPos);
  const around2 = code.substring(Math.max(0, runPos - 50), runPos + 150);
  console.log('Context around runTests():');
  console.log(JSON.stringify(around2));
}
