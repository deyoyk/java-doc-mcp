import { createServer, Server } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface MockServer {
  url: string;
  close(): Promise<void>;
  requests: string[];
}

/** Serve a fixture directory over HTTP so the javadoc client can fetch it. */
export async function startFixtureServer(fixtureDir: string, opts: { notFound?: string[] } = {}): Promise<MockServer> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    requests.push(url);
    if (opts.notFound?.some((p) => url.includes(p))) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const clean = decodeURIComponent(url.split('?')[0]);
    const filePath = path.join(fixtureDir, clean.replace(/^\/+/, ''));
    try {
      const body = fs.readFileSync(filePath);
      const ext = path.extname(filePath);
      const type =
        ext === '.js'
          ? 'application/javascript'
          : ext === '.html'
            ? 'text/html'
            : ext === '.json'
              ? 'application/json'
              : 'text/plain';
      res.writeHead(200, { 'content-type': type });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server did not bind');
  return {
    url: `http://127.0.0.1:${address.port}/`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
