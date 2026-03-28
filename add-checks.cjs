const fs = require('fs');

let code = fs.readFileSync('test-memory-graph.ts', 'utf-8');

// Find the line handler - look for the exact pattern
const pattern = /log\(`← Response id=\${response\.id\}:.*?\n\s+}\n\s+} catch/s;

if (pattern.test(code)) {
  console.log('Found pattern');
  code = code.replace(
    /log\(`← Response id=\${response\.id\}:.*?\n(\s+)}\n(\s+)} catch/s,
    (match, sp1, sp2) => {
      return match.replace(
        `      }`,
        `      
      if (checkCompletion()) {
        log(\`\\nAll \${totalRequestsExpected} responses received!\`);
        writeResultsAndExit();
      } else {
        resetCompletionTimeout();
      }
    }`
      );
    }
  );
} else {
  console.log('Pattern not found, trying simpler approach');
  // Try a simpler pattern
  const findStr = "log(`← Response id=${response.id}: ${response.result ? 'SUCCESS' : response.error?.message || 'ERROR'}`);\n    }";
  if (code.includes(findStr)) {
    console.log('Found simpler pattern');
    code = code.replace(
      findStr,
      "log(`← Response id=${response.id}: ${response.result ? 'SUCCESS' : response.error?.message || 'ERROR'}`);\n      \n      if (checkCompletion()) {\n        log(`\\nAll ${totalRequestsExpected} responses received!`);\n        writeResultsAndExit();\n      } else {\n        resetCompletionTimeout();\n      }\n    }"
    );
  } else {
    console.log('Simpler pattern not found either');
  }
}

fs.writeFileSync('test-memory-graph.ts', code);
