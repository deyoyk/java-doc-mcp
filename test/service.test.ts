import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JavadocClient } from '../src/javadoc/client.js';
import { JavadocService, ClassNotFoundError } from '../src/javadoc/service.js';
import { startFixtureServer, MockServer } from './helpers/mockServer.js';
import type { Config } from '../src/config.js';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function makeConfig(baseUrl: string): Config {
  return {
    baseUrl,
    cacheDir: path.join(path.dirname(fileURLToPath(import.meta.url)), '.test-cache'),
    cacheTtlMs: 60_000,
    requestTimeoutMs: 5_000,
    maxRetries: 1,
    useCache: false,
    userAgent: 'java-doc-mcp-test',
  };
}

describe('JavadocService (modern site)', () => {
  let server: MockServer;
  let service: JavadocService;

  beforeEach(async () => {
    server = await startFixtureServer(path.join(fixtureDir, 'modern'));
    service = new JavadocService(new JavadocClient(makeConfig(server.url)));
  });

  afterEach(async () => {
    await server.close();
  });

  it('loads the index and reports stats', async () => {
    const stats = await service.getStats(server.url);
    expect(stats.packages).toBe(6);
    expect(stats.types).toBe(11);
    expect(stats.members).toBe(7);
    expect(stats.format).toBe('modern');
  });

  it('searches classes by name', async () => {
    const results = await service.searchTypes(server.url, { query: 'concurrent' });
    const names = results.map((r) => r.name);
    expect(names).toContain('java.util.ConcurrentHashMap');
    expect(names).toContain('java.util.concurrent.ConcurrentMap');
  });

  it('searches classes with a package filter', async () => {
    const results = await service.searchTypes(server.url, { query: 'list', packageFilter: 'java.util' });
    expect(results[0].name).toBe('java.util.List');
  });

  it('lists packages', async () => {
    const packages = await service.listPackages(server.url);
    expect(packages.some((p) => p.name === 'java.lang' && p.module === 'java.base')).toBe(true);
    expect(packages.some((p) => p.name === 'com.example.lib' && p.module === undefined)).toBe(true);
  });

  it('does not leak pseudo packages like "All Packages"', async () => {
    const packages = await service.listPackages(server.url);
    expect(packages.some((p) => /^all /i.test(p.name))).toBe(false);
  });

  it('lists classes in a package', async () => {
    const classes = await service.listClasses(server.url, 'java.util');
    expect(classes.map((c) => c.label).sort()).toEqual(['ArrayList', 'ConcurrentHashMap', 'List']);
  });

  it('resolves simple and fully qualified class names', async () => {
    const a = await service.resolveClass(server.url, 'String');
    expect(a.package).toBe('java.lang');
    const b = await service.resolveClass(server.url, 'java.util.List');
    expect(b.label).toBe('List');
  });

  it('resolves nested type labels', async () => {
    const t = await service.resolveClass(server.url, 'java.lang.annotation.Deprecated');
    expect(t.package).toBe('java.lang.annotation');
  });

  it('throws with candidates for ambiguous simple names', async () => {
    await expect(service.resolveClass(server.url, 'List')).rejects.toBeInstanceOf(ClassNotFoundError);
  });

  it('throws with candidates for unknown classes', async () => {
    try {
      await service.resolveClass(server.url, 'ZzzzNonexistent');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ClassNotFoundError);
      expect((err as ClassNotFoundError).message).toContain('Could not find class');
    }
  });

  it('gets a full class doc', async () => {
    const doc = await service.getClassDoc(server.url, 'java.lang.String');
    expect(doc.qualifiedName).toBe('java.lang.String');
    expect(doc.kind).toBe('class');
    expect(doc.description).toContain('String class represents character strings');
    expect(doc.methods.some((m) => m.name === 'substring')).toBe(true);
    expect(doc.deprecated).toBe(false);
    expect(doc.url).toContain('/java/lang/String.html');
  });

  it('gets a member with full detail', async () => {
    const members = await service.getMember(server.url, 'java.lang.String', 'charAt');
    expect(members.length).toBe(1);
    const m = members[0];
    expect(m.signature).toContain('char charAt(int index)');
    expect(m.parameters![0].description).toContain('index of the char value');
    expect(m.returns).toContain('char value at the specified index');
  });

  it('returns overloads for get_member', async () => {
    const members = await service.getMember(server.url, 'java.lang.String', 'substring');
    expect(members.length).toBe(2);
    expect(members.every((m) => m.name === 'substring')).toBe(true);
  });

  it('searches members within a class', async () => {
    const members = await service.searchMembers(server.url, 'sub', 'java.lang.String');
    expect(members.map((m) => m.name)).toContain('substring');
  });

  it('searches members site-wide', async () => {
    const members = await service.searchMembers(server.url, 'length');
    const qns = members.map((m) => m.qualifiedName);
    expect(qns).toContain('java.lang.String');
  });
});

describe('JavadocService (legacy site)', () => {
  let server: MockServer;
  let service: JavadocService;

  beforeEach(async () => {
    server = await startFixtureServer(path.join(fixtureDir, 'legacy'));
    service = new JavadocService(new JavadocClient(makeConfig(server.url)));
  });

  afterEach(async () => {
    await server.close();
  });

  it('detects legacy format from allclasses-noframe.html', async () => {
    const stats = await service.getStats(server.url);
    expect(stats.format).toBe('legacy');
    expect(stats.types).toBe(1);
  });

  it('parses a legacy class page', async () => {
    const doc = await service.getClassDoc(server.url, 'java.lang.LegacyClass');
    expect(doc.qualifiedName).toBe('java.lang.LegacyClass');
    expect(doc.methods.some((m) => m.name === 'compute')).toBe(true);
  });
});

describe('JavadocService (multi-site)', () => {
  let modern: MockServer;
  let legacy: MockServer;
  let service: JavadocService;

  beforeEach(async () => {
    modern = await startFixtureServer(path.join(fixtureDir, 'modern'));
    legacy = await startFixtureServer(path.join(fixtureDir, 'legacy'));
    service = new JavadocService(new JavadocClient(makeConfig(modern.url)));
  });

  afterEach(async () => {
    await modern.close();
    await legacy.close();
  });

  it('serves different sites from the same server instance', async () => {
    const modernDoc = await service.getClassDoc(modern.url, 'java.lang.String');
    expect(modernDoc.qualifiedName).toBe('java.lang.String');

    const legacyDoc = await service.getClassDoc(legacy.url, 'java.lang.LegacyClass');
    expect(legacyDoc.qualifiedName).toBe('java.lang.LegacyClass');
    expect(legacyDoc.legacy).toBe(true);

    // Still works after switching back.
    const again = await service.getClassDoc(modern.url, 'java.util.List');
    expect(again.qualifiedName).toBe('java.util.List');
  });

  it('isolates per-site indexes', async () => {
    const modernStats = await service.getStats(modern.url);
    const legacyStats = await service.getStats(legacy.url);
    expect(modernStats.format).toBe('modern');
    expect(legacyStats.format).toBe('legacy');
    expect(modernStats.types).toBe(11);
    expect(legacyStats.types).toBe(1);
  });
});
