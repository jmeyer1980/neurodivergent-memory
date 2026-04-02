const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const systemMessage = [
    'Repository guardrails:',
    '- Merge work into development; do not assume main is the active integration branch.',
    '- For issue and PR work, verify the actual target branch before inferring issue status.',
    '- For memory-driven work, pull relevant memories before acting and store material decisions/findings afterward.',
    '- Do not silently install or reconfigure MCP servers; ask first unless the user explicitly requested setup.'
  ].join('\n');

  process.stdout.write(JSON.stringify({ systemMessage }));
});
