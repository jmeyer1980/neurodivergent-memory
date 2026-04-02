const chunks = [];

function extractText(payload) {
  try {
    return JSON.stringify(payload).toLowerCase();
  } catch {
    return '';
  }
}

process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  let payload = {};
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    payload = {};
  }

  const text = extractText(payload);
  const mentionsMain = text.includes('main');
  const mentionsPr = text.includes('pull_request') || text.includes('pull request') || text.includes('create_pull_request');
  const mentionsPush = text.includes('git push') || text.includes('push');

  if (!mentionsMain || (!mentionsPr && !mentionsPush)) {
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
      permissionDecisionReason: 'This repo normally integrates through development, not main. Confirm before targeting main.'
    },
    systemMessage: 'Branch policy reminder: development is the normal merge target; main is reserved for release flow unless the user explicitly says otherwise.'
  }));
});
