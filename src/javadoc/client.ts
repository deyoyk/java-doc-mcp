import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Config } from '../config.js';

export class JavadocError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'JavadocError';
    this.status = status;
  }
}

interface CacheEntry {
  url: string;
  status: number;
  text: string;
  fetchedAt: number;
}

const MAX_MEM_ENTRIES = 400;

/** Per-URL cache that writes to memory (LRU) and optionally to disk. */
class HttpCache {
  private mem = new Map<string, CacheEntry>();

  constructor(private readonly dir: string | null, private readonly ttlMs: number) {}

  private diskPath(url: string): string {
    const hash = crypto.createHash('sha1').update(url).digest('hex');
    return path.join(this.dir as string, hash + '.json');
  }

  private isFresh(e: CacheEntry): boolean {
    return Date.now() - e.fetchedAt < this.ttlMs;
  }

  get(url: string): CacheEntry | undefined {
    const hit = this.mem.get(url);
    if (hit) {
      if (this.isFresh(hit)) return hit;
      this.mem.delete(url);
      return undefined;
    }
    if (!this.dir) return undefined;
    try {
      const raw = fs.readFileSync(this.diskPath(url), 'utf8');
      const e = JSON.parse(raw) as CacheEntry;
      if (this.isFresh(e)) {
        this.touchMem(e);
        return e;
      }
    } catch {
      // ignore corrupt / missing cache files
    }
    return undefined;
  }

  set(url: string, entry: CacheEntry): void {
    this.touchMem(entry);
    if (!this.dir) return;
    try {
      fs.writeFileSync(this.diskPath(url), JSON.stringify(entry));
    } catch {
      // disk caching is best-effort
    }
  }

  private touchMem(entry: CacheEntry): void {
    this.mem.delete(entry.url);
    this.mem.set(entry.url, entry);
    if (this.mem.size > MAX_MEM_ENTRIES) {
      const oldest = this.mem.keys().next().value;
      if (oldest !== undefined) this.mem.delete(oldest);
    }
  }
}

export class JavadocClient {
  private cache: HttpCache;
  private readonly base: URL;

  constructor(private readonly config: Config) {
    this.cache = new HttpCache(config.useCache ? config.cacheDir : null, config.cacheTtlMs);
    this.base = new URL(config.baseUrl);
  }

  get baseUrl(): string {
    return this.config.baseUrl;
  }

  /** Resolve a path fragment relative to the docs root. */
  resolve(rel: string): string {
    return new URL(rel, this.base).toString();
  }

  private async rawFetch(url: string, attempt: number): Promise<CacheEntry> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'user-agent': this.config.userAgent,
          accept: 'text/html,text/plain,application/javascript,application/json,*/*;q=0.8',
          'accept-encoding': 'gzip, deflate, br',
        },
        redirect: 'follow',
      });
      const text = await res.text();
      return { url, status: res.status, text, fetchedAt: Date.now() };
    } catch (err) {
      if (attempt < this.config.maxRetries) {
        const backoff = 300 * 2 ** attempt;
        await new Promise((r) => setTimeout(r, backoff));
        return this.rawFetch(url, attempt + 1);
      }
      throw new JavadocError(
        `Failed to fetch ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fetch a URL returning its text on 2xx, or `null` on 4xx.
   * Throws a `JavadocError` on network errors after retries.
   */
  async getText(url: string): Promise<string | null> {
    const cached = this.cache.get(url);
    if (cached) return cached.status >= 200 && cached.status < 300 ? cached.text : null;

    const entry = await this.rawFetch(url, 0);
    this.cache.set(url, entry);
    if (entry.status >= 200 && entry.status < 300) return entry.text;
    if (entry.status >= 400 && entry.status < 500) return null;
    throw new JavadocError(`Unexpected HTTP ${entry.status} for ${url}`, entry.status);
  }

  /**
   * Fetch a documentation page (HTML or plain text), unwrapping javadoc.io's
   * viewer pages by re-fetching the real file from the `/static/` path.
   */
  async getHtml(url: string): Promise<{ url: string; text: string } | null> {
    const text = await this.getText(url);
    if (text === null) return null;
    if (looksLikeJavadocIoViewer(url, text)) {
      const staticUrl = deriveJavadocIoStaticUrl(url);
      if (staticUrl) {
        const real = await this.getText(staticUrl);
        if (real !== null) return { url: staticUrl, text: real };
      }
    }
    return { url, text };
  }

  /**
   * Fetch the first URL in the list that returns a 2xx.
   * Used to resolve class pages across possible module prefixes.
   * Failed candidates are cached so later resolutions are cheap.
   */
  async fetchFirst(urls: string[]): Promise<{ url: string; text: string } | null> {
    for (const url of urls) {
      const cached = this.cache.get(url);
      if (cached) {
        if (cached.status >= 200 && cached.status < 300) {
          return this.unwrapCached(url, cached);
        }
        continue;
      }
      const entry = await this.rawFetch(url, 0);
      this.cache.set(url, entry);
      if (entry.status >= 200 && entry.status < 300) {
        const unwrapped = await this.unwrapCached(url, entry);
        if (unwrapped) return unwrapped;
      }
    }
    return null;
  }

  private async unwrapCached(url: string, entry: CacheEntry): Promise<{ url: string; text: string } | null> {
    const unwrapped = await this.getHtml(url);
    if (unwrapped) return unwrapped;
    return { url: entry.url, text: entry.text };
  }

  /**
   * javadoc.io (and a few mirrors) serve `.js` index files as an HTML wrapper
   * page that points at the real file under `/static/...`. Detect that and
   * fetch the real script.
   */
  async fetchJs(url: string): Promise<string | null> {
    const text = await this.getText(url);
    if (text === null) return null;
    if (!isHtml(text)) return text;
    const baseName = path.basename(new URL(url).pathname);

    // Candidates gathered from any src/href pointing at the same file name.
    const candidates: string[] = [];
    const seen = new Set<string>();
    const attrRe = new RegExp(`(?:src|href)=["']([^"']*${escapeRegExp(baseName)}[^"']*?)["']`, 'ig');
    let m = attrRe.exec(text);
    while (m !== null) {
      const abs = new URL(m[1], url).toString();
      if (abs !== url && !seen.has(abs)) {
        seen.add(abs);
        candidates.push(abs);
      }
      m = attrRe.exec(text);
    }

    // Prefer javadoc.io-style `/static/{group}/{artifact}/{version}/` paths.
    const staticUrl = deriveJavadocIoStaticUrl(url);
    const ordered = [
      ...(staticUrl && !seen.has(staticUrl) ? [staticUrl] : []),
      ...candidates.filter((c) => c.includes('/static/')),
      ...candidates,
    ];
    for (const abs of ordered.slice(0, 8)) {
      const real = await this.getText(abs);
      if (real !== null && !isHtml(real)) return real;
    }
    return null;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * javadoc.io serves the real doc files under `/static/{group}/{artifact}/{version}/`
 * while `/doc/{group}/{artifact}/{version}/...` returns an HTML viewer wrapper.
 */
function deriveJavadocIoStaticUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/^\/doc\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
    if (!m) return null;
    const [, group, artifact, version, rest] = m;
    return `https://javadoc.io/static/${group}/${artifact}/${version}/${rest}`;
  } catch {
    return null;
  }
}

/**
 * Heuristic: a javadoc.io `/doc/` response is a viewer shell (bootstrap nav,
 * modals) rather than the real javadoc page when it lacks the markers javadoc
 * emits on every real page (`contentContainer`, `member-signature`, `<main`).
 */
function looksLikeJavadocIoViewer(url: string, text: string): boolean {
  if (!/^https:\/\/javadoc\.io\/doc\//i.test(url)) return false;
  const head = text.slice(0, 40_000);
  if (/(class="[^"]*contentContainer|class="[^"]*member-signature|class="[^"]*type-signature|<main|class="title")/.test(head)) {
    return false;
  }
  return /(navbar-collapse|dropdown-menu|class="modal"|javadoc\.io)/i.test(text);
}

export function isHtml(text: string): boolean {
  const head = text.trimStart().slice(0, 500).toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html') || /<script/i.test(head) && /<body/i.test(head);
}
