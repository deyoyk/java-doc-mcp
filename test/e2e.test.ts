import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { JavadocClient } from '../src/javadoc/client.js';
import { JavadocService } from '../src/javadoc/service.js';
import { registerTools } from '../src/tools.js';
import { startFixtureServer, MockServer } from './helpers/mockServer.js';
import type { Config } from '../src/config.js';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('');
}

describe('MCP end-to-end', () => {
  let server: MockServer;
  let mcpClient: Client;
  let mcpServer: McpServer;

  beforeEach(async () => {
    server = await startFixtureServer(path.join(fixtureDir, 'modern'));
    const config: Config = {
      baseUrl: server.url,
      cacheDir: path.join(path.dirname(fileURLToPath(import.meta.url)), '.test-cache'),
      cacheTtlMs: 60_000,
      requestTimeoutMs: 5_000,
      maxRetries: 1,
      useCache: false,
      userAgent: 'java-doc-mcp-test',
    };
    const service = new JavadocService(new JavadocClient(config));

    mcpServer = new McpServer({ name: 'java-doc-mcp', version: 'test' });
    registerTools(mcpServer, service, new JavadocClient(config));

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    mcpClient = new Client({ name: 'test-client', version: '1.0.0' });
    await Promise.all([mcpServer.connect(serverTransport), mcpClient.connect(clientTransport)]);
  });

  afterEach(async () => {
    await mcpClient.close();
    await mcpServer.close();
    await server.close();
  });

  it('advertises the expected tools', async () => {
    const { tools } = await mcpClient.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      ['get_class', 'get_member', 'list_classes', 'list_packages', 'search_classes', 'search_members', 'site_info'].sort(),
    );
  });

  it('search_classes returns matches', async () => {
    const result = await mcpClient.callTool({
      name: 'search_classes',
      arguments: { url: server.url, query: 'concurrent' },
    });
    const text = textOf(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain('ConcurrentHashMap');
  });

  it('get_class returns formatted docs', async () => {
    const result = await mcpClient.callTool({
      name: 'get_class',
      arguments: { url: server.url, name: 'java.lang.String' },
    });
    const text = textOf(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain('# java.lang.String');
    expect(text).toContain('substring');
    expect(text).toContain('CASE_INSENSITIVE_ORDER');
  });

  it('get_member returns member details', async () => {
    const result = await mcpClient.callTool({
      name: 'get_member',
      arguments: { url: server.url, className: 'String', memberName: 'charAt' },
    });
    const text = textOf(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain('char charAt');
    expect(text).toContain('index');
  });

  it('returns isError for unknown classes with suggestions', async () => {
    const result = await mcpClient.callTool({
      name: 'get_class',
      arguments: { url: server.url, name: 'ZzzzNope' },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    const text = textOf(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain('Could not find class');
  });

  it('list_classes returns package types', async () => {
    const result = await mcpClient.callTool({
      name: 'list_classes',
      arguments: { url: server.url, packageName: 'java.util' },
    });
    const text = textOf(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain('java.util.List');
  });
});

describe('MCP end-to-end (one server, many sites)', () => {
  it('switches between javadoc sites via the url argument', async () => {
    const modern = await startFixtureServer(path.join(fixtureDir, 'modern'));
    const legacy = await startFixtureServer(path.join(fixtureDir, 'legacy'));
    try {
      const config: Config = {
        baseUrl: modern.url,
        cacheDir: path.join(path.dirname(fileURLToPath(import.meta.url)), '.test-cache'),
        cacheTtlMs: 60_000,
        requestTimeoutMs: 5_000,
        maxRetries: 1,
        useCache: false,
        userAgent: 'java-doc-mcp-test',
      };
      const service = new JavadocService(new JavadocClient(config));
      const mcpServer = new McpServer({ name: 'java-doc-mcp', version: 'test' });
      registerTools(mcpServer, service, new JavadocClient(config));
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'test-client', version: '1.0.0' });
      await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);

      const modernRes = await client.callTool({
        name: 'get_class',
        arguments: { url: modern.url, name: 'java.lang.String' },
      });
      expect(textOf(modernRes as { content: Array<{ type: string; text?: string }> })).toContain('# java.lang.String');

      const legacyRes = await client.callTool({
        name: 'get_class',
        arguments: { url: legacy.url, name: 'java.lang.LegacyClass' },
      });
      expect(textOf(legacyRes as { content: Array<{ type: string; text?: string }> })).toContain('# java.lang.LegacyClass');

      await client.close();
      await mcpServer.close();
    } finally {
      await modern.close();
      await legacy.close();
    }
  });
});
