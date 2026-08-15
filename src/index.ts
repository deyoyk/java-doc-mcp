import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { ensureCacheDir, HELP_TEXT, resolveConfig } from './config.js';
import { JavadocClient } from './javadoc/client.js';
import { JavadocService } from './javadoc/service.js';
import { registerTools } from './tools.js';

const VERSION = '0.1.0';

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stderr.write(HELP_TEXT);
    process.exit(0);
  }

  let config;
  try {
    config = resolveConfig(argv);
    ensureCacheDir(config);
  } catch (err) {
    process.stderr.write(`java-doc-mcp: ${err instanceof Error ? err.message : String(err)}\n\n${HELP_TEXT}`);
    process.exit(1);
  }

  const client = new JavadocClient(config);
  const service = new JavadocService(client);

  serveStdio(() => {
    const server = new McpServer({ name: 'java-doc-mcp', version: VERSION });
    registerTools(server, service, client);
    return server;
  });

  process.stderr.write(`java-doc-mcp v${VERSION} started. JavaDoc base URL: ${config.baseUrl}\n`);
}

main();
