# Conversation Ingestion

Nacre can ingest agent conversations directly, turning chat sessions into memories in the knowledge graph.

## Quick Start

```bash
# Ingest a conversation file
nacre ingest conversation.json --graph ./memory.db

# Specify format
nacre ingest session.jsonl --graph ./memory.db --format jsonl

# Ingest from stdin
cat messages.json | nacre ingest - --graph ./memory.db --format openai

# With embedding generation
nacre ingest chat.json --graph ./memory.db --embed --provider ollama
```

## Supported Formats

| Format | Flag | Description |
|--------|------|-------------|
| `auto` | `--format auto` | Auto-detect from content structure (default) |
| `nacre` | `--format nacre` | Native nacre format (`{ messages, metadata }`) |
| `openai` | `--format openai` | OpenAI/ChatGPT message format |
| `anthropic` | `--format anthropic` | Anthropic Claude message format |
| `clawdbot` | `--format clawdbot` | Clawdbot session export format |
| `jsonl` | `--format jsonl` | One JSON message per line |

## Native Format

```json
{
  "messages": [
    { "role": "user", "content": "How do I set up TypeScript?", "timestamp": "2026-01-15T10:00:00Z", "name": "Marcus" },
    { "role": "assistant", "content": "First, install TypeScript with npm..." },
    { "role": "user", "content": "What about strict mode?" },
    { "role": "assistant", "content": "Enable strict mode in tsconfig.json..." }
  ],
  "metadata": {
    "sessionId": "session-001",
    "platform": "cli",
    "topic": "TypeScript Setup",
    "source": "chat-export.json"
  }
}
```

## CLI Options

| Option | Description | Default |
|--------|-------------|---------|
| `--graph` | Path to graph database (.db) | Required |
| `--format` | Input format | `auto` |
| `--embed` | Generate embeddings for episodes | `false` |
| `--provider` | Embedding provider (ollama, openai, onnx) | auto-detect |
| `--session-id` | Override session ID for deduplication | from file |
| `--deduplicate` | Strategy: sessionId, contentHash, none | `sessionId` |
| `--max-messages` | Max messages per chunk | `20` |
| `--json` | Output result as JSON | `false` |

## REST API

```
POST /api/v1/ingest
Content-Type: application/json

{
  "messages": [...],
  "metadata": { "sessionId": "..." },
  "options": {
    "embed": true,
    "deduplicateBy": "sessionId",
    "maxMessages": 20,
    "provider": "ollama"
  }
}
```

Response:

```json
{
  "data": {
    "chunksProcessed": 3,
    "episodesCreated": 3,
    "nodesCreated": 12,
    "nodesReinforced": 5,
    "edgesCreated": 18,
    "duplicatesSkipped": 0
  }
}
```

## How It Works

### Pipeline

1. **Parse** — detect format and normalize to `ConversationInput`
2. **Deduplicate** — skip if session or content hash already ingested
3. **Chunk** — split into segments by time gaps (30min), message count, or token budget
4. **Extract** — find entities (people, tools, concepts) and relationships in each chunk
5. **Persist** — create episodes, nodes, edges, and optionally embeddings

### Chunking

Long conversations are split into manageable chunks:

- Messages within 30 minutes of each other stay together
- User-assistant pairs are kept intact at boundaries
- Default max: 20 messages or ~4000 tokens per chunk
- Each chunk becomes one episode in the graph

### Entity Extraction

The conversation extractor runs three layers on message content:

- **NLP** — people, organizations via compromise.js
- **Structural** — wikilinks, bold text, backtick code
- **Custom** — known tools (TypeScript, Docker, etc.), GitHub URLs, scoped packages

Extracted entities become nodes; co-occurring entities get edges.

### Deduplication

Two strategies prevent duplicate ingestion:

- **sessionId** — conversations with the same session ID are ingested only once
- **contentHash** — SHA-256 hash of message content prevents identical re-ingestion

## Programmatic Usage

```typescript
import { SqliteStore, ingestConversation, parseConversationFile } from '@nacre/core';
import { extractFromConversation } from '@nacre/parser';

const store = SqliteStore.open('./memory.db');

const input = parseConversationFile(jsonString, 'auto');

const result = await ingestConversation(input, {
  store,
  extractEntities: extractFromConversation,
  deduplicateBy: 'sessionId',
});

console.log(`Created ${result.episodesCreated} episodes, ${result.nodesCreated} nodes`);
store.close();
```
