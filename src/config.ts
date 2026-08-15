import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

export const DEFAULT_URL = 'https://docs.oracle.com/en/java/javase/21/docs/api/';

export interface Config {
  /** Root URL of the JavaDoc site (must end with a slash). */
  baseUrl: string;
  /** Directory used for the on-disk HTTP cache. */
  cacheDir: string;
  /** Cache time-to-live in milliseconds. */
  cacheTtlMs: number;
  /** Per-request timeout in milliseconds. */
  requestTimeoutMs: number;
  /** Max number of HTTP retries on transient failures. */
  maxRetries: number;
  /** Custom User-Agent header. */
  userAgent: string;
  /** Whether the disk cache is enabled. */
  useCache: boolean;
}

function parseKeyValue(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          out[a.slice(2)] = next;
          i++;
        } else {
          out[a.slice(2)] = 'true';
        }
      }
    } else if (a === '-h' || a === '--help') {
      out['help'] = 'true';
    }
  }
  return out;
}

function env(key: string): string | undefined {
  const v = process.env[key];
  return v && v.trim() !== '' ? v.trim() : undefined;
}

/** Normalise a base URL so it always points at the documentation directory root. */
export function normalizeBaseUrl(raw: string): string {
  let url = raw.trim();
  if (!url) throw new Error('JavaDoc URL must not be empty');
  // Strip any file suffix pointing into the docs.
  url = url.replace(/(index|overview-summary|allclasses-index)\.html?$/i, '');
  url = url.replace(/[?#].*$/, '');
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }
  if (!url.endsWith('/')) url += '/';
  return url;
}

function defaultCacheDir(): string {
  const base = env('JAVA_DOC_CACHE_DIR') || process.env.LOCALAPPDATA || process.env.XDG_CACHE_HOME || os.tmpdir();
  return path.join(base, 'java-doc-mcp', 'http-cache');
}

function parseMs(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

export function resolveConfig(argv: string[]): Config {
  const flags = parseKeyValue(argv);

  const rawUrl = flags['url'] || env('JAVA_DOC_URL') || env('JAVADOC_URL') || DEFAULT_URL;
  const baseUrl = normalizeBaseUrl(rawUrl);

  const cacheDir = flags['cache-dir'] || defaultCacheDir();
  const useCache = flags['no-cache'] !== 'true';
  const cacheTtlMs = parseMs(flags['ttl'] || env('JAVA_DOC_TTL'), 24 * 60 * 60 * 1000);
  const requestTimeoutMs = parseMs(flags['timeout'] || env('JAVA_DOC_TIMEOUT'), 20_000);
  const maxRetries = Math.max(0, Number(flags['retries'] || env('JAVA_DOC_RETRIES') || '2') || 0);

  return {
    baseUrl,
    cacheDir,
    cacheTtlMs,
    requestTimeoutMs,
    maxRetries,
    useCache,
    userAgent: 'java-doc-mcp/0.1.0 (+https://github.com/deyoyk/java-doc-mcp)',
  };
}

export function ensureCacheDir(cfg: Config): void {
  if (!cfg.useCache) return;
  try {
    fs.mkdirSync(cfg.cacheDir, { recursive: true });
  } catch {
    // If we cannot create the cache dir, fall back to in-memory caching only.
  }
}

export const HELP_TEXT = `java-doc-mcp - MCP server for any public JavaDoc website

Usage:
  java-doc-mcp [options]

Options:
  --url <url>         Root URL of the JavaDoc site (default: Java SE 21 API docs)
                      e.g. --url https://docs.oracle.com/en/java/javase/21/docs/api/
                      e.g. --url https://javadoc.io/doc/com.google.guava/guava/latest/
                      Env: JAVA_DOC_URL
  --cache-dir <path>  Directory for the on-disk HTTP cache (default: platform cache dir)
                      Env: JAVA_DOC_CACHE_DIR
  --ttl <seconds>     Cache TTL in seconds (default: 86400)
                      Env: JAVA_DOC_TTL
  --timeout <ms>      Per-request timeout in milliseconds (default: 20000)
                      Env: JAVA_DOC_TIMEOUT
  --retries <n>       Max retries on transient HTTP errors (default: 2)
                      Env: JAVA_DOC_RETRIES
  --no-cache          Disable the on-disk cache
  --help              Show this help

Examples (claude_desktop_config.json / .mcp.json / opencode.json):
  {
    "mcpServers": {
      "java-doc": {
        "command": "npx",
        "args": ["-y", "java-doc-mcp", "--url", "https://docs.oracle.com/en/java/javase/21/docs/api/"]
      }
    }
  }
`;
