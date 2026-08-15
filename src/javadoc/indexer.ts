import { parse } from 'node-html-parser';
import { JavadocClient } from './client.js';
import { DocIndex, MemberEntry, PackageEntry, TypeEntry, TypeKind } from '../types.js';

export type IndexFormat = 'modern' | 'legacy';

/**
 * Extract a JavaScript array literal assigned to `varName` and parse it as JSON.
 * Works for `typeSearchIndex = [...];`, `packageSearchIndex = [...];` and friends.
 */
export function parseJsArray(text: string, varName: string): unknown[] | null {
  const re = new RegExp(`\\b${varName}\\s*=\\s*\\[`);
  const m = re.exec(text);
  if (!m) return null;
  const openBracketIndex = m.index + m[0].length - 1;
  let depth = 0;
  let inStr = false;
  let end = -1;
  for (let i = openBracketIndex; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;
  const json = text.slice(openBracketIndex, end + 1);
  try {
    return JSON.parse(json) as unknown[];
  } catch {
    return null;
  }
}

const kindFromCategory = (c?: string): TypeKind | undefined => {
  switch ((c || '').toLowerCase()) {
    case 'class':
      return 'class';
    case 'interface':
      return 'interface';
    case 'enum':
      return 'enum';
    case 'annotation':
      return 'annotation';
    case 'record':
      return 'record';
    case 'exception':
      return 'exception';
    default:
      return undefined;
  }
};

export function normalizeBase(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

export class Indexer {
  private cached = new Map<string, DocIndex>();
  private formats = new Map<string, IndexFormat>();
  private pending = new Map<string, Promise<DocIndex>>();

  constructor(private readonly client: JavadocClient) {}

  getFormat(baseUrl: string): IndexFormat | null {
    return this.formats.get(normalizeBase(baseUrl)) ?? null;
  }

  load(baseUrl: string): Promise<DocIndex> {
    const base = normalizeBase(baseUrl);
    const cached = this.cached.get(base);
    if (cached) return Promise.resolve(cached);
    const inFlight = this.pending.get(base);
    if (inFlight) return inFlight;
    const promise = this.buildIndex(base).then((idx) => {
      this.cached.set(base, idx);
      this.pending.delete(base);
      this.trimCache();
      return idx;
    });
    this.pending.set(base, promise);
    return promise;
  }

  /** Keep the per-site index cache bounded so long-running servers don't grow forever. */
  private trimCache(): void {
    const MAX_SITES = 32;
    if (this.cached.size <= MAX_SITES) return;
    for (const base of this.cached.keys()) {
      this.cached.delete(base);
      this.formats.delete(base);
      if (this.cached.size <= MAX_SITES) break;
    }
  }

  private async buildIndex(base: string): Promise<DocIndex> {
    const modern = await this.tryModernIndex(base);
    if (modern) {
      this.formats.set(base, 'modern');
      return modern;
    }
    const legacy = await this.tryLegacyIndex(base);
    if (legacy) {
      this.formats.set(base, 'legacy');
      return legacy;
    }
    throw new Error(
      `Could not locate any JavaDoc index files at ${base}. ` +
        'Make sure the URL points at the root of a generated javadoc site (the folder containing ' +
        'type-search-index.js or allclasses-noframe.html).',
    );
  }

  private async tryModernIndex(base: string): Promise<DocIndex | null> {
    const typeNames = ['type-search-index.js', 'typeindex.js'];
    let typesRaw: string | null = null;
    for (const name of typeNames) {
      typesRaw = await this.client.fetchJs(this.client.resolve(name, base));
      if (typesRaw !== null) break;
    }
    if (typesRaw === null) return null;

    let types = parseJsArray(typesRaw, 'typeSearchIndex');
    let packagesRaw: string | null = null;
    let membersRaw: string | null = null;

    if (types === null) types = parseJsArray(typesRaw, 'typeIndex');
    if (types === null) return null;

    for (const name of ['package-search-index.js', 'packageindex.js', 'packages.js']) {
      packagesRaw = await this.client.fetchJs(this.client.resolve(name, base));
      if (packagesRaw !== null) break;
    }
    membersRaw = await this.client.fetchJs(this.client.resolve('member-search-index.js', base));

    const packages = this.parsePackages(packagesRaw);
    const memberEntries = membersRaw !== null ? parseJsArray(membersRaw, 'memberSearchIndex') : null;
    const moduleByPackage = new Map<string, string>();
    for (const p of packages) {
      if (p.module) moduleByPackage.set(p.name, p.module);
    }

    const typeEntries: TypeEntry[] = [];
    for (const raw of types) {
      if (typeof raw !== 'object' || raw === null) continue;
      const p = (raw as Record<string, unknown>)['p'];
      const l = (raw as Record<string, unknown>)['l'];
      if (typeof p !== 'string' || typeof l !== 'string') continue;
      const c = (raw as Record<string, unknown>)['c'];
      typeEntries.push({
        label: l,
        package: p,
        kind: typeof c === 'string' ? kindFromCategory(c) : undefined,
        module: moduleByPackage.get(p),
      });
    }

    const members: MemberEntry[] = [];
    if (memberEntries) {
      for (const raw of memberEntries) {
        if (typeof raw !== 'object' || raw === null) continue;
        const p = (raw as Record<string, unknown>)['p'];
        const c = (raw as Record<string, unknown>)['c'];
        const l = (raw as Record<string, unknown>)['l'];
        if (typeof p === 'string' && typeof c === 'string' && typeof l === 'string') {
          members.push({ package: p, className: c, name: l });
        }
      }
    }

    return { types: typeEntries, packages, members, loadedAt: Date.now() };
  }

  private parsePackages(raw: string | null): PackageEntry[] {
    if (raw !== null) {
      const arr = parseJsArray(raw, 'packageSearchIndex');
      if (arr) {
        const out: PackageEntry[] = [];
        for (const entry of arr) {
          if (typeof entry !== 'object' || entry === null) continue;
          const e = entry as Record<string, unknown>;
          const l = e['l'];
          if (typeof l !== 'string') continue;
          // Skip pseudo-entries javadoc emits for the navigation links.
          if (e['u'] !== undefined) continue;
          if (/^(All Packages|All Classes|overview)$/i.test(l)) continue;
          const m = e['m'];
          out.push({ name: l, module: typeof m === 'string' ? m : undefined });
        }
        if (out.length > 0) return out;
      }
    }
    // Fallback: newline separated package list.
    return [];
  }

  private async tryLegacyIndex(base: string): Promise<DocIndex | null> {
    const html = await this.client.getHtml(this.client.resolve('allclasses-noframe.html', base));
    if (html === null) return null;

    const root = parse(html.text);
    const types: TypeEntry[] = [];
    const seen = new Set<string>();
    const links = root.querySelectorAll('a[href]');
    for (const a of links) {
      const href = a.getAttribute('href') ?? '';
      if (!href.toLowerCase().endsWith('.html')) continue;
      if (/^(index|overview-summary|allclasses-index|allpackages-index|help-doc|constant-values)/i.test(href)) continue;
      if (/^(package-|.*-frame\.html)/i.test(href)) continue;
      const clean = href.replace(/^\.\.\//g, '');
      const segments = clean.split('/');
      const fileName = segments[segments.length - 1] ?? '';
      const label = fileName.replace(/\.html?$/i, '');
      const pkg = segments.length > 1 ? segments.slice(0, -1).join('.').replace(/\.$/, '') : '';
      if (!label || seen.has(clean)) continue;
      seen.add(clean);
      types.push({ label, package: pkg, kind: undefined });
    }

    // Legacy package list: newline separated file, or allpackages-index.html.
    const packages: PackageEntry[] = [];
    const listRaw = await this.client.getHtml(this.client.resolve('element-list', base));
    const listRaw2 = listRaw === null ? await this.client.getHtml(this.client.resolve('package-list', base)) : null;
    const listText = (listRaw?.text ?? null) ?? (listRaw2?.text ?? null);
    if (listText !== null) {
      for (const line of listText.split(/\r?\n/)) {
        const name = line.trim();
        if (name && !name.startsWith('//')) packages.push({ name });
      }
    }
    if (packages.length === 0) {
      const allPkgs = await this.client.getHtml(this.client.resolve('allpackages-index.html', base));
      if (allPkgs !== null) {
        const proot = parse(allPkgs.text);
        for (const a of proot.querySelectorAll('a[href]')) {
          const href = a.getAttribute('href') ?? '';
          const m = href.match(/([^/]+)\/package-summary\.html/);
          if (m) packages.push({ name: m[1] });
        }
      }
    }
    // Derive packages from the class list as a last resort.
    if (packages.length === 0) {
      const pkgSet = new Set(types.map((t) => t.package).filter(Boolean));
      for (const name of pkgSet) packages.push({ name });
    }

    return { types, packages, members: [], loadedAt: Date.now() };
  }
}
