import { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { JavadocClient } from './javadoc/client.js';
import { ClassNotFoundError, JavadocService } from './javadoc/service.js';
import {
  formatClassDoc,
  formatClasses,
  formatMember,
  formatMemberList,
  formatPackages,
  formatSearchResults,
} from './format.js';

function ok(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

function fail(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  let body = `⚠️ ${message}`;
  if (err instanceof ClassNotFoundError && err.candidates.length > 0) {
    body += '\n\nPossible matches:\n' + formatSearchResults(err.candidates, '');
  }
  return { content: [{ type: 'text', text: body }], isError: true };
}

/** Run a tool body, converting any thrown error into an MCP error result. */
async function run(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    return fail(err);
  }
}

export function registerTools(server: McpServer, service: JavadocService, _client: JavadocClient): void {
  server.registerTool(
    'search_classes',
    {
      title: 'Search classes',
      description:
        'Search the JavaDoc index for classes, interfaces, enums, annotations and records by name. ' +
        'Returns fully qualified names with a short type kind hint. Use this to discover the exact spelling ' +
        'before calling get_class.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Class name or partial name, e.g. "ConcurrentHashMap", "stream", "StringBuilder"'),
        package: z
          .string()
          .optional()
          .describe('Optional package filter (exact or prefix), e.g. "java.util" or "com.google.common.collect".'),
        limit: z.number().int().min(1).max(50).optional().describe('Maximum number of results (default 15).'),
      }),
    },
    async ({ query, package: packageFilter, limit }) =>
      run(async () => {
        const results = await service.searchTypes({ query, packageFilter, limit: limit ?? 15 });
        return ok(formatSearchResults(results, query));
      }),
  );

  server.registerTool(
    'get_class',
    {
      title: 'Get class documentation',
      description:
        'Fetch the full documentation page for a class, interface, enum, annotation or record: declaration, ' +
        'description, inheritance, and all declared fields, constructors and methods (signatures with one-line ' +
        'descriptions). Accepts a fully qualified name (java.lang.String) or a unique simple name (String).',
      inputSchema: z.object({
        name: z
          .string()
          .min(1)
          .describe('Class name: fully qualified (java.util.List) or simple (List, ConcurrentHashMap).'),
        memberLimit: z
          .number()
          .int()
          .min(1)
          .max(300)
          .optional()
          .describe('Maximum number of members to list per section (default 120).'),
      }),
    },
    async ({ name, memberLimit }) =>
      run(async () => {
        const doc = await service.getClassDoc(name);
        return ok(formatClassDoc(doc));
      }),
  );

  server.registerTool(
    'get_member',
    {
      title: 'Get member documentation',
      description:
        'Fetch the full documentation for a single method, field or constructor of a class: complete signature, ' +
        'parameters, return type, exceptions thrown, since-version and deprecation notes. If the class has ' +
        'overloaded members with the same name, all matching overloads are returned.',
      inputSchema: z.object({
        className: z
          .string()
          .min(1)
          .describe('Fully qualified or simple class name containing the member, e.g. "java.lang.String".'),
        memberName: z.string().min(1).describe('Member name, e.g. "substring", "CASE_INSENSITIVE_ORDER", "equals".'),
        anchor: z
          .string()
          .optional()
          .describe('Exact page anchor (e.g. "substring(int,int)") to disambiguate overloads; usually not required.'),
      }),
    },
    async ({ className, memberName, anchor }) =>
      run(async () => {
        const members = await service.getMember(className, memberName, anchor);
        if (members.length === 0) {
          throw new ClassNotFoundError(`No member named "${memberName}" found in ${className}.`);
        }
        return ok(members.map((m) => formatMember(m, className)).join('\n\n---\n\n'));
      }),
  );

  server.registerTool(
    'search_members',
    {
      title: 'Search members',
      description:
        'Search for methods, fields and constructors. When className is provided, searches the members declared ' +
        'in that class. Without a className, searches the whole site-wide member index (modern javadoc only) and ' +
        'returns the classes that declare matching members.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Member name or partial name, e.g. "of", "getBytes", "put".'),
        className: z
          .string()
          .optional()
          .describe('Optional class name to restrict the search to a single class, e.g. "java.util.List".'),
        limit: z.number().int().min(1).max(50).optional().describe('Maximum number of results (default 20).'),
      }),
    },
    async ({ query, className, limit }) =>
      run(async () => {
        const members = await service.searchMembers(query, className, limit ?? 20);
        if (className) {
          return ok(formatMemberList(members, className, query));
        }
        if (members.length === 0) {
          return ok(`No members found matching "${query}". Try search_classes to locate the right class first.`);
        }
        const lines = [`### Classes declaring members matching "${query}"`, ''];
        for (const m of members.slice(0, 40)) {
          lines.push(`- \`${m.name}\` — in \`${m.qualifiedName}\``);
        }
        if (members.length > 40) lines.push(`*…and ${members.length - 40} more*`);
        lines.push('', 'Use `get_class` on a class above, then `get_member` for details.');
        return ok(lines.join('\n'));
      }),
  );

  server.registerTool(
    'list_packages',
    {
      title: 'List packages',
      description:
        'List the packages documented on the JavaDoc site, optionally filtered by a query string. ' +
        'Useful for discovering which packages/libraries are documented.',
      inputSchema: z.object({
        query: z.string().optional().describe('Optional filter: packages whose name contains this text.'),
        limit: z.number().int().min(1).max(500).optional().describe('Maximum number of results (default 200).'),
      }),
    },
    async ({ query, limit }) =>
      run(async () => {
        const packages = await service.listPackages(query, limit ?? 200);
        return ok(formatPackages(packages));
      }),
  );

  server.registerTool(
    'list_classes',
    {
      title: 'List classes in a package',
      description:
        'List every class, interface, enum and annotation declared in a package. Returns fully qualified names.',
      inputSchema: z.object({
        packageName: z.string().min(1).describe('Package name, e.g. "java.util" or "com.google.common.collect".'),
      }),
    },
    async ({ packageName }) =>
      run(async () => {
        const types = await service.listClasses(packageName);
        return ok(formatClasses(packageName, types.map((t) => ({ label: t.label, package: t.package, kind: t.kind }))));
      }),
  );

  server.registerTool(
    'site_info',
    {
      title: 'Site information',
      description:
        'Return information about the configured JavaDoc site: base URL, index format, and the number of indexed ' +
        'packages, types and members.',
      inputSchema: z.object({}),
    },
    async () =>
      run(async () => {
        const stats = await service.getStats();
        return ok(
          `## JavaDoc site\n\n- **Base URL:** ${stats.baseUrl}\n- **Index format:** ${stats.format}\n- **Packages:** ${stats.packages}\n- **Types:** ${stats.types}\n- **Indexed members:** ${stats.members}`,
        );
      }),
  );
}
