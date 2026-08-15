# java-doc-mcp

An [MCP](https://modelcontextprotocol.io) server that lets AI agents **search, fetch and explore any publicly hosted JavaDoc website** — with nothing more than an `npx` command in your MCP client config.

**One server, any javadoc site.** The AI picks the site on every call by passing its root URL as the `url` argument. No site is hardcoded at startup — a single MCP server works against Oracle JDK docs, javadoc.io, Minecraft/Spigot/Bukkit API javadocs, Spring, Guava, Netty, your project's hosted javadoc, and everything else that ships a standard javadoc `type-search-index.js` / `allclasses-noframe.html`.

```json
{
  "mcpServers": {
    "java-doc": {
      "command": "npx",
      "args": ["-y", "java-doc-mcp"]
    }
  }
}
```

## Features

- **Search classes** across any site's index (fuzzy, camel-case aware, optional package filter).
- **Fetch full class docs** — declaration, description, hierarchy, and every declared field, constructor and method (signature + one-line description).
- **Fetch member docs** — complete signature, parameters, return type, `@throws`, `@since`, deprecation notes; overloads returned together.
- **Search members** inside a class or across the entire site.
- **List packages and classes** for exploration/discovery.
- **Works on any javadoc**: modern HTML5 (JDK 9+) via `type-search-index.js`/`member-search-index.js`, *and* legacy JDK 8 / HTML4 frames sites via `allclasses-noframe.html`.
- **javadoc.io aware** — automatically unwraps javadoc.io's HTML viewer pages and reads the real files under `/static/`.
- **Multi-site from one server** — indexes and caches are kept per URL, so one running server can serve as many different javadoc sites as the conversation needs.
- **Caching** — in-memory LRU + on-disk cache (configurable TTL) so repeated queries are instant and you are polite to the host site.
- **Resilient** — retries with backoff, per-request timeouts, 404-safe probing across module/non-module URL layouts.
- **Self-contained** — runs locally over stdio, no servers to deploy, no API keys.

## Tools

Every tool takes the javadoc site's root URL as its **`url`** argument.

| Tool | Description |
| --- | --- |
| `search_classes` | `{ url, query, package?, limit? }` — search the class index. Returns fully-qualified names + kind hint. |
| `get_class` | `{ url, name, memberLimit? }` — full documentation page for a class/interface/enum/annotation/record. |
| `get_member` | `{ url, className, memberName, anchor? }` — full documentation for one method/field/constructor (all overloads). |
| `search_members` | `{ url, query, className?, limit? }` — search members within a class, or site-wide. |
| `list_packages` | `{ url, query?, limit? }` — list packages (optional name filter). |
| `list_classes` | `{ url, packageName }` — list every type in a package. |
| `site_info` | `{ url }` — confirm a URL is a javadoc site and report its size/format. |

## Installation & usage

Run it directly with `npx` — no global install needed:

```bash
npx -y java-doc-mcp
```

Or install it globally:

```bash
npm install -g java-doc-mcp
java-doc-mcp
```

The server starts with no site configured. The AI supplies the site per call.

### How the AI uses it

When someone asks, e.g. *"how do I register a subcommand with the mbedwars API?"*, the agent calls:

```json
{ "name": "search_classes", "arguments": { "url": "https://javadocs.mbedwars.com/", "query": "CommandHandler" } }
```

then follows up with `get_class` / `get_member` using the same `url`. Switching topics to the JDK, it just passes `"url": "https://docs.oracle.com/en/java/javase/21/docs/api/"`.

### Optional configuration

All flags are optional:

| Flag | Env | Default | Description |
| --- | --- | --- | --- |
| `--url <url>` | `JAVA_DOC_URL` | JDK 21 API docs | Default javadoc root used when a tool call omits `url` |
| `--cache-dir <path>` | `JAVA_DOC_CACHE_DIR` | platform cache dir | Where the HTTP cache lives on disk |
| `--ttl <seconds>` | `JAVA_DOC_TTL` | `86400` | Cache TTL |
| `--timeout <ms>` | `JAVA_DOC_TIMEOUT` | `20000` | Per-request timeout |
| `--retries <n>` | `JAVA_DOC_RETRIES` | `2` | HTTP retries on transient errors |
| `--no-cache` | — | off | Disable the on-disk cache |
| `--help` | — | — | Print help |

### Client config snippets

Add a server entry to your MCP client. All standard `mcpServers`-style configs are supported.

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "java-doc": {
      "command": "npx",
      "args": ["-y", "java-doc-mcp"]
    }
  }
}
```

**VS Code / Cursor / other `mcpServers`-based clients** — same shape, e.g. `.mcp.json`:

```json
{
  "mcpServers": {
    "java-doc": {
      "command": "npx",
      "args": ["-y", "java-doc-mcp"]
    }
  }
}
```

**opencode** (`opencode.json`):

```json
{
  "mcp": {
    "java-doc": {
      "type": "local",
      "command": ["npx", "-y", "java-doc-mcp"]
    }
  }
}
```

> On Windows, `npx` resolves fine as long as Node is on `PATH`. If your client does not spawn `npx` reliably, use the full path: `"command": "C:\\Program Files\\nodejs\\npx.cmd"`.

### Example URLs the AI can pass

```text
https://docs.oracle.com/en/java/javase/21/docs/api/          # Oracle JDK 21
https://docs.oracle.com/javase/8/docs/api/                   # legacy JDK 8 (frames) docs
https://javadoc.io/doc/com.google.guava/guava/latest/        # any library on javadoc.io
https://javadoc.io/doc/org.apache.kafka/kafka-clients/3.7.0/
https://javadocs.mbedwars.com/                               # any project-hosted javadoc
```

## How it works

1. On first use of a site it downloads that site's search indexes (`type-search-index.js`, `package-search-index.js`, `member-search-index.js`).
2. Class/member queries are answered by fetching the individual javadoc HTML pages and parsing them into structured markdown.
3. Results are cached in memory and on disk (`JAVA_DOC_CACHE_DIR`), keyed by URL with a TTL. Indexes are cached per site.
4. URL layout is resolved robustly: modular JDK docs (`java.base/java/lang/String.html`) and flat docs (`com/google/common/collect/ImmutableList.html`) are both handled, and failed candidates are cached so resolution stays cheap.

## Development

```bash
npm install
npm run build       # compile TypeScript to build/
npm test            # unit + parser + e2e tests (46 tests, no network required)
npm run dev         # run from source
```

### Repository layout

```
src/
  index.ts              # entry point: CLI args, stdio bootstrap
  config.ts             # config resolution (flags/env/defaults)
  tools.ts              # MCP tool definitions (url argument on every tool)
  format.ts             # markdown renderers
  javadoc/
    client.ts           # HTTP client, caching, retries, javadoc.io unwrapping
    indexer.ts          # search-index parsing (modern + legacy), per-site caches
    classParser.ts      # class/member HTML parser (JDK 11+ and JDK 8 layouts)
    service.ts          # multi-site search scoring, name resolution, URL probing
  types.ts
test/                   # fixtures + vitest suites
```

## License

MIT
