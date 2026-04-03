const chunks = [];

/** Returns true only when a string value refers explicitly to the main branch. */
function isMainBranch(value) {
  if (typeof value !== 'string') return false;
  return value === 'main' || value === 'refs/heads/main' || value === 'origin/main';
}

process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  let payload = {};
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    payload = {};
  }

  const toolName = String(payload.toolName || payload.tool_name || '');
  const toolInput = payload.toolInput || payload.tool_input || {};

  let targetsMain = false;
  let context = '';

  // Check structured fields for PR tools whose base branch is main.
  if (/pull_request|create_pull_request/i.test(toolName)) {
    const base = String(toolInput.base || toolInput.base_branch || '').slice(0, 100);
    if (isMainBranch(base)) {
      targetsMain = true;
      context = `PR base branch: ${base}`;
    }
  }

  // Check bash/shell commands for git operations explicitly targeting main.
  if (!targetsMain && /bash|shell|run_command/i.test(toolName)) {
    const command = String(toolInput.command || toolInput.cmd || '');
    if (/\bgit\s+push\b[^|&;]*\bmain\b/.test(command)) {
      targetsMain = true;
      context = 'git push to main';
    } else if (/\bgit\s+(?:merge|rebase|checkout)\b[^|&;]*\bmain\b/.test(command)) {
      targetsMain = true;
      context = `git operation targeting main`;
    }
  }

  if (!targetsMain) {
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
      permissionDecisionReason: `This repo normally integrates through development, not main. Confirm before targeting main (${context}).`
    },
    systemMessage: 'Branch policy reminder: development is the normal merge target; main is reserved for release flow unless the user explicitly says otherwise.'
  }));
});
