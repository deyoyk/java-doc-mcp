import { describe, expect, it } from 'vitest';
import { JavadocClient } from '../src/javadoc/client.js';
import type { Config } from '../src/config.js';

function client(baseUrl: string): JavadocClient {
  const cfg: Config = {
    baseUrl,
    cacheDir: 'ignored',
    cacheTtlMs: 1000,
    requestTimeoutMs: 1000,
    maxRetries: 0,
    useCache: false,
    userAgent: 'test',
  };
  return new JavadocClient(cfg);
}

describe('JavadocClient.resolve', () => {
  it('resolves against a base with a trailing slash', () => {
    const c = client('https://docs.example.com/api/');
    expect(c.resolve('type-search-index.js', 'https://docs.example.com/api/')).toBe(
      'https://docs.example.com/api/type-search-index.js',
    );
  });

  it('treats a base without trailing slash as a directory', () => {
    const c = client('https://docs.example.com/api/');
    expect(c.resolve('type-search-index.js', 'https://docs.example.com/api')).toBe(
      'https://docs.example.com/api/type-search-index.js',
    );
  });

  it('uses the configured default base when none is supplied', () => {
    const c = client('https://docs.example.com/javadoc/');
    expect(c.resolve('allclasses-noframe.html')).toBe('https://docs.example.com/javadoc/allclasses-noframe.html');
  });

  it('resolves nested paths', () => {
    const c = client('https://docs.example.com/');
    expect(c.resolve('java/base/java/lang/String.html', 'https://docs.example.com')).toBe(
      'https://docs.example.com/java/base/java/lang/String.html',
    );
  });
});
