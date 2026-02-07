# Temporal Queries

Nacre captures graph snapshots over time, enabling point-in-time queries, entity history tracking, and diff views between any two snapshots.

## Concepts

**Snapshot** — A frozen copy of the graph (all nodes and edges) at a specific moment. Created automatically after each consolidation, or manually via CLI/API.

**Point-in-Time Recall** — Query the graph as it existed at a historical date by loading the nearest snapshot.

**Entity History** — Track how a single node or edge evolved across snapshots (e.g., growing mention count, shifting edge weights).

**Graph Diff** — Compare two snapshots to see what was added, removed, strengthened, or weakened.

## CLI Usage

### Snapshots

```bash
# List all snapshots
nacre snapshots --graph ./data/my-graph.db

# Filter by date range
nacre snapshots --graph ./data/my-graph.db --since 2026-01-01 --until 2026-02-01

# Create a manual snapshot
nacre snapshots create --graph ./data/my-graph.db

# View snapshot details
nacre snapshots show --id <snapshot-id> --graph ./data/my-graph.db

# Diff two snapshots
nacre snapshots diff --from <id-1> --to <id-2> --graph ./data/my-graph.db
```

### Point-in-Time Recall

```bash
# Recall as of a specific date (uses nearest snapshot)
nacre recall "typescript projects" --graph ./data/my-graph.db --as-of 2026-01-15
```

### Entity History

```bash
# Node history
nacre history node:<node-id> --graph ./data/my-graph.db

# Edge history
nacre history edge:<edge-id> --graph ./data/my-graph.db
```

## REST API

All endpoints are under `/api/v1/`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/snapshots` | List snapshots (query: `since`, `until`, `limit`) |
| POST | `/snapshots` | Create manual snapshot |
| GET | `/snapshots/:id` | Get snapshot details |
| GET | `/snapshots/:id/graph` | Get full graph from snapshot |
| DELETE | `/snapshots/:id` | Delete a snapshot |
| GET | `/diff/:from/:to` | Diff two snapshots |
| GET | `/history/node/:id` | Node history across snapshots |
| GET | `/history/edge/:id` | Edge history across snapshots |

## Configuration

Add to `nacre.config.json`:

```json
{
  "snapshots": {
    "enabled": true,
    "retention": "30d",
    "triggers": ["consolidation"]
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Enable/disable automatic snapshots |
| `retention` | none | Auto-delete snapshots older than this (e.g., `30d`, `24h`) |
| `triggers` | `["consolidation"]` | When to auto-snapshot: `consolidation`, `manual`, `scheduled` |

## Storage

Snapshots are stored in three SQLite tables:

- `snapshots` — metadata (id, trigger, counts, timestamp)
- `snapshot_nodes` — full node JSON per snapshot
- `snapshot_edges` — full edge JSON per snapshot

Each snapshot stores the complete graph state. For large graphs, configure retention to limit storage growth.

## Schema Version

Temporal queries require schema version 4+. Existing databases are automatically migrated when opened.
