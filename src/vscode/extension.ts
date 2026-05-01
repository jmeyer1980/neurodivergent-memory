import * as vscode from 'vscode';

const DOCS_URL = 'https://github.com/jmeyer1980/neurodivergent-memory#quick-start';

function buildMcpConfigSnippet(): string {
  return JSON.stringify(
    {
      mcpServers: {
        'neurodivergent-memory': {
          command: 'npx',
          args: ['-y', 'neurodivergent-memory@latest']
        }
      }
    },
    null,
    2
  );
}

export function activate(context: vscode.ExtensionContext): void {
  const copyConfig = vscode.commands.registerCommand('neurodivergentMemory.copyMcpConfig', async () => {
    await vscode.env.clipboard.writeText(buildMcpConfigSnippet());

    const action = 'Open Setup Docs';
    const selected = await vscode.window.showInformationMessage(
      'Neurodivergent Memory MCP config copied to clipboard.',
      action
    );

    if (selected === action) {
      await vscode.env.openExternal(vscode.Uri.parse(DOCS_URL));
    }
  });

  const openDocs = vscode.commands.registerCommand('neurodivergentMemory.openDocs', async () => {
    await vscode.env.openExternal(vscode.Uri.parse(DOCS_URL));
  });

  context.subscriptions.push(copyConfig, openDocs);
}

export function deactivate(): void {
  // no-op
}
