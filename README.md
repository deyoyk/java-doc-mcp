# java-doc-mcp

An [MCP](https://modelcontextprotocol.io) server that lets AI agents **search, fetch and explore any publicly hosted JavaDoc website** — with nothing more than an `npx` command in your MCP client config.

Works against any javadoc site out of the box: **Oracle JDK docs, javadoc.io, any library published as javadoc, Minecraft/Spigot/Bukkit API javadocs, Spring, Guava, Netty, and everything else** that ships a standard javadoc `type-search-index.js` / `allclasses-noframe.html`.

```json
{
  "mcpServers": {
    "java-doc": {
      "command": "npx",
      "args": ["-y", "java-doc-mcp", "--url", "https://javadocs.mbedwars.com/"]
    }
  }
}
```

## Features

- **Search classes** across the whole site index (fuzzy, camel-case aware, optional package filter).
- **Fetch full class docs** — declaration, description, hierarchy, and every declared field, constructor and method (signature + one-line description).
- **Fetch member docs** — complete signature, parameters, return type, `@throws`, `@since`, deprecation notes; overloads returned together.
- **Search members** inside a class or across the entire site.
- **List packages and classes** for exploration/discovery.
- **Works on any javadoc**: modern HTML5 (JDK 9+) via `type-search-index.js`/`member-search-index.js`, *and* legacy JDK 8 / HTML4 frames sites via `allclasses-noframe.html`.
- **javadoc.io aware** — automatically unwraps javadoc.io's HTML viewer pages and reads the real files under `/static/`.
- **Caching** — in-memory LRU + on-disk cache (configurable TTL) so repeated queries are instant and you are polite to the host site.
- **Resilient** — retries with backoff, per-request timeouts, 404-safe probing across module/non-module URL layouts.
- **Self-contained** — runs locally over stdio, no servers to deploy, no API keys.

## Tools

| Tool | Description |
| --- | --- |
| `search_classes` | Search the class index. Returns fully-qualified names + kind hint. |
| `get_class` | Full documentation page for a class/interface/enum/annotation/record. |
| `get_member` | Full documentation for one method/field/constructor (all overloads). |
| `search_members` | Search members within a class, or site-wide. |
| `list_packages` | List packages (optional name filter). |
| `list_classes` | List every type in a package. |
| `site_info` | Report the configured site, index format and index sizes. |

## Installation & usage

Run it directly with `npx` — no global install needed:

```bash
npx -y java-doc-mcp --url https://docs.oracle.com/en/java/javase/21/docs/api/
```

Or install it globally:

```bash
npm install -g java-doc-mcp
java-doc-mcp --url https://javadocs.mbedwars.com/
```

### Configuration

The JavaDoc site URL is the only thing you must set. Pass it as a CLI flag or environment variable:

- CLI: `--url <url>` (e.g. `--url https://docs.oracle.com/en/java/javase/21/docs/api/`)
- Env: `JAVA_DOC_URL` (defaults to the Java SE 21 API docs)

Optional settings:

| Flag | Env | Default | Description |
| --- | --- | --- | --- |
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
      "args": ["-y", "java-doc-mcp", "--url", "https://javadocs.mbedwars.com/"]
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
      "args": ["-y", "java-doc-mcp", "--url", "https://docs.oracle.com/en/java/javase/21/docs/api/"]
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
      "command": ["npx", "-y", "java-doc-mcp", "--url", "https://javadocs.mbedwars.com/"]
    }
  }
}
```

> On Windows, `npx` resolves fine as long as Node is on `PATH`. If your client does not spawn `npx` reliably, use the full path: `"command": "C:\\Program Files\\nodejs\\npx.cmd"`.

### Example targets

```bash
# Oracle JDK 21 (default)
java-doc-mcp --url https://docs.oracle.com/en/java/javase/21/docs/api/

# Any library on javadoc.io (stable or "latest" URL)
java-doc-mcp --url https://javadoc.io/doc/com.google.guava/guava/latest/
java-doc-mcp --url https://javadoc.io/doc/org.apache.kafka/kafka-clients/3.7.0/

# A project's hosted javadoc (e.g. a Minecraft plugin API)
java-doc-mcp --url https://javadocs.mbedwars.com/

# Legacy / frames javadoc (JDK 8 style) works too
java-doc-mcp --url https://docs.oracle.com/javase/8/docs/api/
```

## How it works

1. On first use it downloads the site's search indexes (`type-search-index.js`, `package-search-index.js`, `member-search-index.js`).
2. Class/member queries are answered by fetching the individual javadoc HTML pages and parsing them into structured markdown.
3. Results are cached in memory and on disk (`JAVA_DOC_CACHE_DIR`), keyed by URL with a TTL.
4. URL layout is resolved robustly: modular JDK docs (`java.base/java/lang/String.html`) and flat docs (`com/google/common/collect/ImmutableList.html`) are both handled, and failed candidates are cached so resolution stays cheap.

## Development

```bash
npm install
npm run build       # compile TypeScript to build/
npm test            # unit + parser + e2e tests (38 tests, no network required)
npm run dev         # run from source
```

### Repository layout

```
src/
  index.ts              # entry point: CLI args, stdio bootstrap
  config.ts             # config resolution (flags/env/defaults)
  tools.ts              # MCP tool definitions
  format.ts             # markdown renderers
  javadoc/
    client.ts           # HTTP client, caching, retries, javadoc.io unwrapping
    indexer.ts          # search-index parsing (modern + legacy)
    classParser.ts      # class/member HTML parser (JDK 11+ and JDK 8 layouts)
    service.ts          # search scoring, name resolution, URL probing
  types.ts
test/                   # fixtures + vitest suites
```

## License

MIT
