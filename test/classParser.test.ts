import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsArray } from '../src/javadoc/indexer.js';
import { parseClassPage } from '../src/javadoc/classParser.js';
import * as fs from 'node:fs';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function readFixture(p: string): string {
  return fs.readFileSync(path.join(fixtureDir, p), 'utf8');
}

describe('parseJsArray', () => {
  it('parses typeSearchIndex', () => {
    const text = readFixture('modern/type-search-index.js');
    const arr = parseJsArray(text, 'typeSearchIndex');
    expect(arr).toBeTruthy();
    expect(arr!.length).toBe(11);
    expect(arr![0]).toEqual({ p: 'java.lang', l: 'String' });
  });

  it('parses packageSearchIndex with modules', () => {
    const text = readFixture('modern/package-search-index.js');
    const arr = parseJsArray(text, 'packageSearchIndex');
    expect(arr).toBeTruthy();
    expect(arr![0]).toEqual({ m: 'java.base', l: 'java.lang' });
  });

  it('handles arrays with brackets inside strings', () => {
    const arr = parseJsArray('typeSearchIndex = [{"p":"a.b","l":"Gen<T>[]"},{"p":"a.b","l":"Plain"}];x();', 'typeSearchIndex');
    expect(arr).toBeTruthy();
    expect(arr!.length).toBe(2);
  });

  it('returns null when variable is missing', () => {
    expect(parseJsArray('var other = [1,2];', 'typeSearchIndex')).toBeNull();
  });
});

describe('modern class page parser', () => {
  const html = readFixture('modern/java/lang/String.html');
  const page = parseClassPage(html, 'https://example.test/java/lang/String.html');

  it('extracts type kind and title', () => {
    expect(page.kind).toBe('class');
    expect(page.title).toContain('String');
  });

  it('extracts the declaration', () => {
    expect(page.declaration).toMatch(/public final class String/);
    expect(page.declaration).toContain('Object');
  });

  it('extracts the class description', () => {
    expect(page.description).toContain('The String class represents character strings');
  });

  it('extracts superclass and interfaces', () => {
    expect(page.superClass).toBe('java.lang.String'); // last link in inheritance chain
    expect(page.interfaces.join(',')).toContain('CharSequence');
  });

  it('extracts since version', () => {
    expect(page.since).toBe('1.0');
  });

  it('parses all members with details', () => {
    const names = page.members.map((m) => m.name);
    expect(names).toContain('length');
    expect(names).toContain('charAt');
    expect(names).toContain('substring');
    expect(names).toContain('CASE_INSENSITIVE_ORDER');
    expect(names).toContain('getBytes');
    expect(page.members.filter((m) => m.name === 'substring').length).toBe(2);
  });

  it('extracts full signatures', () => {
    const substring = page.members.find((m) => m.name === 'substring' && m.anchor === 'substring(int)');
    expect(substring).toBeDefined();
    expect(substring!.signature).toContain('String');
    expect(substring!.signature).toContain('substring');
  });

  it('parses parameters, returns and throws from dl notes', () => {
    const charAt = page.members.find((m) => m.name === 'charAt');
    expect(charAt!.parameters).toHaveLength(1);
    expect(charAt!.parameters![0].name).toBe('index');
    expect(charAt!.returns).toContain('char value at the specified index');
    expect(charAt!.throws).toHaveLength(1);
    expect(charAt!.throws![0].type).toContain('IndexOutOfBoundsException');
  });

  it('marks deprecated members', () => {
    const getBytes = page.members.find((m) => m.name === 'getBytes');
    expect(getBytes!.deprecated).toBeTruthy();
  });

  it('builds summaries with correct kinds', async () => {
    const { summarizePage } = await import('../src/javadoc/classParser.js');
    const s = summarizePage(page);
    expect(s.fields.map((f) => f.name)).toContain('CASE_INSENSITIVE_ORDER');
    expect(s.constructors.map((c) => c.name)).toContain('String');
    expect(s.methods.map((m) => m.name)).toContain('substring');
  });
});

describe('legacy class page parser', () => {
  const html = readFixture('legacy/java/lang/LegacyClass.html');
  const page = parseClassPage(html, 'https://example.test/java/lang/LegacyClass.html');

  it('extracts declaration and description', () => {
    expect(page.legacy).toBe(true);
    expect(page.declaration).toContain('public class LegacyClass');
    expect(page.description).toContain('legacy class used to exercise');
  });

  it('parses members from li.blockList', () => {
    const compute = page.members.find((m) => m.name === 'compute');
    expect(compute).toBeDefined();
    expect(compute!.signature).toContain('compute(int');
    expect(compute!.parameters).toHaveLength(1);
    expect(compute!.returns).toContain('computed result');
    const field = page.members.find((m) => m.name === 'value');
    expect(field).toBeDefined();
    expect(field!.kind).toBe('field');
  });
});
