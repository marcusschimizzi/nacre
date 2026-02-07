# @nacre/sdk

TypeScript SDK for Nacre — biological memory for AI agents.

Provides a unified `Nacre` class that works in two modes:

- **Local mode** — reads/writes directly to a SQLite graph (no server needed)
- **Remote mode** — connects to a running `nacre api` server over HTTP

## Install

```bash
npm install @nacre/sdk
```

## Quick Start

### Local mode (embedded)

```typescript
import { Nacre } from '@nacre/sdk';

const nacre = new Nacre({ path: './memory.db' });

// Store a memory
const mem = await nacre.remember('TypeScript is a typed superset of JavaScript');

// Recall related memories
const results = await nacre.recall('TypeScript');

// Get a briefing of the graph
const brief = await nacre.brief();

// Record a lesson
await nacre.lesson('Always validate input before processing');

// Reinforce useful memories
await nacre.feedback(mem.id, { rating: 1 });

// Clean up
await nacre.close();
```

### Remote mode (HTTP)

```typescript
import { Nacre } from '@nacre/sdk';

// Connect to a running nacre api server
const nacre = new Nacre({ url: 'http://localhost:3000' });

const results = await nacre.recall('project architecture');
console.log(results);

await nacre.close();
```

## API

### `new Nacre(options)`

| Option | Type | Description |
|--------|------|-------------|
| `path` | `string` | Path to SQLite database file (local mode) |
| `url` | `string` | URL of nacre API server (remote mode) |
| `embedder` | `'ollama' \| 'mock'` | Embedding provider for local mode |
| `apiKey` | `string` | API key for remote mode (optional) |

Provide either `path` (local) or `url` (remote), not both.

### Methods

#### `remember(content, options?): Promise<Memory>`

Store a new memory in the graph.

```typescript
await nacre.remember('Deployed v2 to production', {
  type: 'event',
  importance: 0.9,
  entities: ['production', 'v2'],
});
```

Options: `type` (`fact | event | observation | decision`), `importance` (0-1), `entities` (link to existing nodes).

#### `recall(query, options?): Promise<Memory[]>`

Search memories by text. Uses embeddings when available, falls back to graph-only search.

```typescript
const results = await nacre.recall('deployment', { limit: 5 });
```

Options: `limit`, `types`, `since`, `until`.

#### `brief(options?): Promise<string>`

Generate a briefing summarizing the current state of the memory graph.

```typescript
const text = await nacre.brief({ focus: 'TypeScript', top: 5 });
```

Options: `focus` (filter by topic), `top` (number of items).

#### `lesson(content, options?): Promise<Memory>`

Record a lesson learned. Lessons have higher initial reinforcement so they decay slower.

```typescript
await nacre.lesson('Use strict mode in TypeScript configs', {
  context: 'project setup',
  category: 'preference',
});
```

Options: `context`, `category` (`preference | skill | antipattern | insight`).

#### `feedback(memoryId, options): Promise<void>`

Reinforce or weaken a memory.

```typescript
await nacre.feedback('n-abc123', { rating: 1, reason: 'very useful' });
await nacre.feedback('n-xyz789', { rating: -1 });
```

#### `forget(memoryId): Promise<void>`

Remove a memory from the graph.

#### `nodes(filter?): Promise<Memory[]>`

List all nodes, optionally filtered by type.

```typescript
const lessons = await nacre.nodes({ type: 'lesson' });
```

#### `stats(): Promise<GraphStats>`

Get graph statistics (node count, edge count, embedding count).

#### `close(): Promise<void>`

Release resources. Always call when done.

## Advanced: Direct Backend Access

For fine-grained control, use `LocalBackend` or `RemoteBackend` directly:

```typescript
import { LocalBackend, RemoteBackend } from '@nacre/sdk';

const local = new LocalBackend({ path: './memory.db', embedder: 'mock' });
const remote = new RemoteBackend({ url: 'http://localhost:3000' });
```

Both implement the `Backend` interface.

## License

Apache-2.0
