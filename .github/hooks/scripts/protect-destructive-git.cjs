const chunks = [];
const blockedPatterns = [
  /git\s+reset\s+--hard/i,
  /git\s+checkout\s+--/i,
  /git\s+clean\s+-fdx?\b/i,
  /git\s+restore\s+--source\b/i
];

process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  let payload = {};
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    payload = {};
  }

  const commandText = JSON.stringify(payload);
  const shouldBlock = blockedPatterns.some((pattern) => pattern.test(commandText));

  if (!shouldBlock) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow'
      }
    }));
    return;
  }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: 'Destructive git commands require explicit user approval in this repository.'
    }
  }));
});
