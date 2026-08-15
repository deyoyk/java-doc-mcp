import { JavadocClient, JavadocError } from './client.js';
import { Indexer } from './indexer.js';
import { findMemberByAnchor, parseClassPage, summarizePage } from './classParser.js';
import { ClassDoc, MemberDetail, MemberSummary, PackageEntry, SearchResult, TypeEntry, TypeKind } from '../types.js';

export class ClassNotFoundError extends Error {
  readonly candidates: SearchResult[];
  constructor(message: string, candidates: SearchResult[] = []) {
    super(message);
    this.name = 'ClassNotFoundError';
    this.candidates = candidates;
  }
}

export interface SearchOptions {
  query: string;
  packageFilter?: string;
  limit?: number;
}

function subsequence(haystack: string, needle: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return i === needle.length;
}

function camelHumps(label: string): string {
  // Keep upper-case letters that start a camel-case segment.
  return label.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
}

export function scoreType(entry: TypeEntry, query: string, packageFilter?: string): number {
  const tokens = query.toLowerCase().split(/[\s._-]+/).filter(Boolean);
  if (tokens.length === 0) return 0;
  const label = entry.label.toLowerCase();
  const fq = `${entry.package}.${entry.label}`.toLowerCase();
  const pkg = entry.package.toLowerCase();
  let score = 0;

  for (const token of tokens) {
    if (label === token) score += 100;
    else if (label.startsWith(token)) score += 60;
    else if (label.includes(token)) score += 30;
    else if (subsequence(label, token)) score += 18;
    if (fq.includes(token)) score += 8;
    if (pkg.includes(token)) score += 4;
  }

  // Whole-label subsequence match on camel-hump words ("cmap" -> ConcurrentMap).
  const labelWords = camelHumps(entry.label).split(' ');
  const allQuery = tokens.join('');
  if (labelWords.join('').startsWith(allQuery)) score += 40;
  else if (subsequence(labelWords.join(''), allQuery)) score += 15;

  if (packageFilter) {
    const pf = packageFilter.toLowerCase();
    if (pkg === pf) score += 50;
    else if (pkg.startsWith(pf + '.')) score += 25;
    else if (pkg.includes(pf)) score += 5;
  }
  return score;
}

export class JavadocService {
  private readonly indexer: Indexer;
  private classPageCache = new Map<string, { url: string; html: string }>();

  constructor(private readonly client: JavadocClient) {
    this.indexer = new Indexer(client);
  }

  private async index() {
    return this.indexer.load();
  }

  async getStats(): Promise<{ baseUrl: string; packages: number; types: number; members: number; format: string }> {
    const idx = await this.index();
    return {
      baseUrl: this.client.baseUrl,
      packages: idx.packages.length,
      types: idx.types.length,
      members: idx.members.length,
      format: this.indexer.getFormat() ?? 'unknown',
    };
  }

  private classUrlCandidates(entry: TypeEntry): string[] {
    const base = this.client.baseUrl;
    const dir = entry.package.replace(/\./g, '/');
    const file = encodeURI(entry.label) + '.html';
    const candidates: string[] = [];
    if (entry.module) {
      candidates.push(`${base}${entry.module}/${dir}/${file}`);
    }
    if (dir) {
      candidates.push(`${base}${dir}/${file}`);
    } else {
      candidates.push(`${base}${file}`);
    }
    return candidates;
  }

  async listPackages(query?: string, limit = 200): Promise<PackageEntry[]> {
    const idx = await this.index();
    let packages = idx.packages;
    if (query) {
      const q = query.toLowerCase();
      packages = packages.filter(
        (p) => p.name.toLowerCase().includes(q) || p.name.toLowerCase().split('.').pop()?.startsWith(q),
      );
    }
    packages = [...packages].sort((a, b) => a.name.localeCompare(b.name));
    return packages.slice(0, limit);
  }

  async listClasses(packageName: string): Promise<TypeEntry[]> {
    const idx = await this.index();
    const pkg = packageName.trim();
    const out = idx.types.filter((t) => t.package === pkg).sort((a, b) => a.label.localeCompare(b.label));
    return out;
  }

  async searchTypes(opts: SearchOptions): Promise<SearchResult[]> {
    const idx = await this.index();
    const limit = Math.min(opts.limit ?? 15, 50);
    const query = opts.query.trim();
    if (!query) return [];

    const scored = idx.types
      .map((t) => ({ t, score: scoreType(t, query, opts.packageFilter) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.t.label.localeCompare(b.t.label));

    return scored.slice(0, limit).map(({ t, score }) => ({
      name: t.package ? `${t.package}.${t.label}` : t.label,
      package: t.package,
      kind: t.kind ?? 'class',
      module: t.module,
      score,
      url: this.classUrlCandidates(t)[0],
    }));
  }

  /**
   * Resolve a class name (simple or fully qualified, optionally with a
   * `.html` suffix) to a type index entry. Throws `ClassNotFoundError` with
   * candidates when ambiguous or unknown.
   */
  async resolveClass(name: string): Promise<TypeEntry> {
    const idx = await this.index();
    let query = name.trim();
    query = query.replace(/\.html?$/i, '');

    if (!query) throw new ClassNotFoundError('Empty class name.');

    const lq = query.toLowerCase();
    const exact = idx.types.filter((t) => `${t.package}.${t.label}`.toLowerCase() === lq);
    if (exact.length === 1) return exact[0];

    const simpleExact = idx.types.filter((t) => t.label.toLowerCase() === lq);
    if (simpleExact.length === 1) return simpleExact[0];
    if (simpleExact.length > 1) {
      const candidates = simpleExact
        .map((t) => ({ t, score: scoreType(t, query) }))
        .sort((a, b) => b.score - a.score)
        .map(({ t }) => this.toSearchResult(t, 100));
      throw new ClassNotFoundError(
        `Ambiguous class name '${name}'. Matches ${simpleExact.length} classes; specify the fully qualified name.`,
        candidates,
      );
    }

    // Best-effort fuzzy resolution with a strong-preference threshold.
    const scored = idx.types
      .map((t) => ({ t, score: scoreType(t, query) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    if (scored.length > 0 && scored[0].score >= 55) {
      return scored[0].t;
    }
    const candidates = scored.slice(0, 8).map(({ t, score }) => this.toSearchResult(t, score));
    throw new ClassNotFoundError(
      `Could not find class '${name}'. Try search_classes for exact spelling, or use the fully qualified name.`,
      candidates,
    );
  }

  private toSearchResult(t: TypeEntry, score: number): SearchResult {
    return {
      name: t.package ? `${t.package}.${t.label}` : t.label,
      package: t.package,
      kind: t.kind ?? 'class',
      module: t.module,
      score,
      url: this.classUrlCandidates(t)[0],
    };
  }

  private async fetchClassPage(entry: TypeEntry): Promise<{ url: string; html: string }> {
    const cached = this.classPageCache.get(entry.label + '|' + entry.package);
    if (cached) return cached;
    const candidates = this.classUrlCandidates(entry);
    const fetched = await this.client.fetchFirst(candidates);
    if (!fetched) {
      throw new ClassNotFoundError(
        `Class page for ${entry.package}.${entry.label} was not found (404) at ${candidates.join(' or ')}.`,
      );
    }
    const result = { url: fetched.url, html: fetched.text };
    if (this.classPageCache.size > 200) this.classPageCache.clear();
    this.classPageCache.set(entry.label + '|' + entry.package, result);
    return result;
  }

  async getClassDoc(name: string): Promise<ClassDoc> {
    const entry = await this.resolveClass(name);
    const { url, html } = await this.fetchClassPage(entry);
    const page = parseClassPage(html, url);
    const summaries = summarizePage(page);

    const qualifiedName = entry.package ? `${entry.package}.${entry.label}` : entry.label;
    const simpleName = entry.label.split('.').pop() ?? entry.label;
    const kind: TypeKind = page.kind !== 'unknown' ? page.kind : (entry.kind ?? 'class');

    return {
      qualifiedName,
      simpleName,
      packageName: entry.package,
      module: entry.module,
      kind,
      declaration: page.declaration,
      description: page.description,
      superClass: page.superClass,
      interfaces: page.interfaces,
      fields: summaries.fields,
      constructors: summaries.constructors,
      methods: summaries.methods,
      enumConstants: summaries.enumConstants,
      deprecated: page.deprecated,
      since: page.since,
      url,
      legacy: page.legacy,
    };
  }

  async getMember(className: string, memberName: string, anchor?: string): Promise<MemberDetail[]> {
    const entry = await this.resolveClass(className);
    const { url, html } = await this.fetchClassPage(entry);
    if (anchor) {
      const found = findMemberByAnchor(parseClassPage(html, url), anchor);
      if (found) return [found];
    }
    const page = parseClassPage(html, url);
    const name = memberName.trim();
    const matches = page.members.filter((m) => m.name === name);
    if (matches.length > 0) return matches;
    // Fuzzy fallback.
    const fuzzy = page.members
      .map((m) => ({ m, score: scoreType({ label: m.name, package: entry.package }, name) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    return fuzzy.slice(0, 5).map((x) => x.m);
  }

  async searchMembers(query: string, className?: string, limit = 20): Promise<MemberSummary[]> {
    if (className) {
      const entry = await this.resolveClass(className);
      const { url, html } = await this.fetchClassPage(entry);
      const page = parseClassPage(html, url);
      const scored = page.members
        .map((m) => ({ m, score: scoreType({ label: m.name, package: entry.package }, query) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);
      return scored.slice(0, limit).map((x) => x.m);
    }

    // Search across the whole member index (modern javadoc only).
    const idx = await this.index();
    if (idx.members.length > 0) {
      const q = query.toLowerCase();
      const hits = idx.members
        .map((m) => ({
          m,
          score: scoreType({ label: m.name, package: m.package }, query),
        }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || a.m.className.localeCompare(b.m.className));
      const out: MemberSummary[] = [];
      const seen = new Set<string>();
      for (const { m } of hits) {
        const key = `${m.package}.${m.className}#${m.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          kind: 'method',
          name: m.name,
          signature: '',
          description: '',
          anchor: '',
          qualifiedName: m.package ? `${m.package}.${m.className}` : m.className,
        });
        if (out.length >= limit) break;
      }
      return out;
    }
    return [];
  }
}
