import {
  SqliteStore,
  OllamaEmbedder,
  MockEmbedder,
  recall as coreRecall,
  generateBrief,
  type EmbeddingProvider,
  type EntityType,
  type MemoryNode,
  type Procedure,
  type ProcedureType,
} from '@nacre/core';
import type {
  Backend,
  NacreOptions,
  Memory,
  RememberOptions,
  RecallOptions,
  BriefOptions,
  FeedbackOptions,
  LessonOptions,
  GraphStats,
  SdkProcedure,
} from './types.js';

function generateId(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const ch = content.charCodeAt(i);
    hash = ((hash << 5) - hash + ch) | 0;
  }
  return `n-${Math.abs(hash).toString(36)}`;
}

function toProcedure(proc: Procedure): SdkProcedure {
  return {
    id: proc.id,
    statement: proc.statement,
    type: proc.type,
    triggerKeywords: proc.triggerKeywords,
    triggerContexts: proc.triggerContexts,
    confidence: proc.confidence,
    applications: proc.applications,
    contradictions: proc.contradictions,
    flaggedForReview: proc.flaggedForReview,
  };
}

function toMemory(node: MemoryNode, score?: number): Memory {
  return {
    id: node.id,
    label: node.label,
    type: node.type,
    score,
    excerpts: node.excerpts.map((e) => e.text),
  };
}

export class LocalBackend implements Backend {
  private store: SqliteStore;
  private embedder: EmbeddingProvider | null;

  constructor(opts: NacreOptions) {
    if (!opts.path) throw new Error('Local mode requires path');
    this.store = SqliteStore.open(opts.path);
    this.embedder = this.createEmbedder(opts.embedder);
  }

  private createEmbedder(name?: string): EmbeddingProvider | null {
    if (this.store.embeddingCount() === 0 && name !== 'mock') return null;
    switch (name) {
      case 'ollama':
        return new OllamaEmbedder();
      case 'mock':
        return new MockEmbedder();
      default:
        return null;
    }
  }

  async remember(content: string, opts?: RememberOptions): Promise<Memory> {
    const typeMap: Record<string, EntityType> = {
      fact: 'concept',
      event: 'event',
      observation: 'concept',
      decision: 'decision',
    };

    const nodeType = typeMap[opts?.type || 'fact'] || 'concept';
    const id = generateId(content);
    const timestamp = new Date().toISOString();

    const node: MemoryNode = {
      id,
      label: content.slice(0, 100),
      type: nodeType,
      aliases: [],
      firstSeen: timestamp,
      lastReinforced: timestamp,
      mentionCount: 1,
      reinforcementCount: Math.ceil((opts?.importance ?? 0.5) * 3),
      sourceFiles: ['sdk'],
      excerpts: [{ file: 'sdk', text: content, date: timestamp }],
    };

    this.store.putNode(node);

    if (opts?.entities) {
      for (const name of opts.entities) {
        const existing = this.store.findNode(name);
        if (existing) {
          this.store.putEdge({
            id: `${id}--${existing.id}--explicit`,
            source: id,
            target: existing.id,
            type: 'explicit',
            directed: false,
            weight: 0.8,
            baseWeight: 0.8,
            reinforcementCount: 1,
            firstFormed: timestamp,
            lastReinforced: timestamp,
            stability: 1.0,
            evidence: [{ file: 'sdk', date: timestamp, context: `Linked: ${name}` }],
          });
        }
      }
    }

    return toMemory(node);
  }

  async recall(query: string, opts?: RecallOptions): Promise<Memory[]> {
    try {
      const results = await coreRecall(this.store, this.embedder, {
        query,
        limit: opts?.limit,
        types: opts?.types as EntityType[] | undefined,
        since: opts?.since,
        until: opts?.until,
      });
      return results.map((r) => ({
        id: r.id,
        label: r.label,
        type: r.type,
        score: r.score,
        excerpts: r.excerpts,
        connections: r.connections.map((c) => ({
          label: c.label,
          type: c.type,
          relationship: c.relationship,
          weight: c.weight,
        })),
        episodes: r.episodes?.map((e) => ({
          id: e.id,
          title: e.title,
          type: e.type,
        })),
      }));
    } catch {
      // Ollama unavailable — fall back to graph-only recall
      const results = await coreRecall(this.store, null, {
        query,
        limit: opts?.limit,
        types: opts?.types as EntityType[] | undefined,
        since: opts?.since,
        until: opts?.until,
      });
      return results.map((r) => ({
        id: r.id,
        label: r.label,
        type: r.type,
        score: r.score,
        excerpts: r.excerpts,
      }));
    }
  }

  async brief(opts?: BriefOptions): Promise<string> {
    const graph = this.store.getFullGraph();
    const result = generateBrief(graph, {
      top: opts?.top ?? 10,
      recentDays: 7,
      now: new Date(),
    });

    let text = result.summary;
    if (opts?.focus) {
      const focusLower = opts.focus.toLowerCase();
      const lines = text.split('\n').filter(
        (line) => line.toLowerCase().includes(focusLower) || line.startsWith('#') || line.trim() === '',
      );
      if (lines.length > 2) {
        text = lines.join('\n');
      }
    }

    return text;
  }

  async lesson(lesson: string, opts?: LessonOptions): Promise<SdkProcedure> {
    const id = generateId(`proc:${lesson}`);
    const timestamp = new Date().toISOString();

    const keywords = opts?.keywords ??
      lesson.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);

    const proc: Procedure = {
      id,
      statement: lesson,
      type: (opts?.category ?? 'insight') as ProcedureType,
      triggerKeywords: [...new Set(keywords)],
      triggerContexts: opts?.contexts ?? [],
      sourceEpisodes: [],
      sourceNodes: [],
      confidence: 0.5,
      applications: 0,
      contradictions: 0,
      stability: 1.0,
      lastApplied: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      flaggedForReview: false,
    };

    this.store.putProcedure(proc);
    return toProcedure(proc);
  }

  async feedback(memoryId: string, opts: FeedbackOptions): Promise<void> {
    const existing = this.store.getNode(memoryId);
    if (!existing) throw new Error(`Memory not found: ${memoryId}`);

    const updated: MemoryNode = { ...existing };
    if (opts.rating > 0) {
      updated.reinforcementCount += 1;
      updated.lastReinforced = new Date().toISOString();
    } else if (opts.rating < 0) {
      updated.reinforcementCount = Math.max(0, updated.reinforcementCount - 1);
    }
    this.store.putNode(updated);
  }

  async forget(memoryId: string): Promise<void> {
    const existing = this.store.getNode(memoryId);
    if (!existing) throw new Error(`Memory not found: ${memoryId}`);
    this.store.deleteNode(memoryId);
  }

  async nodes(filter?: { type?: string }): Promise<Memory[]> {
    const nodeList = this.store.listNodes(
      filter?.type ? { type: filter.type as EntityType } : undefined,
    );
    return nodeList.map((n) => toMemory(n));
  }

  async stats(): Promise<GraphStats> {
    return {
      nodeCount: this.store.nodeCount(),
      edgeCount: this.store.edgeCount(),
      embeddingCount: this.store.embeddingCount(),
    };
  }

  async procedures(filter?: { type?: string; flagged?: boolean }): Promise<SdkProcedure[]> {
    const procs = this.store.listProcedures({
      type: filter?.type as ProcedureType | undefined,
      flaggedOnly: filter?.flagged,
    });
    return procs.map(toProcedure);
  }

  async applyProcedure(id: string, feedback: 'positive' | 'negative' | 'neutral'): Promise<void> {
    const proc = this.store.getProcedure(id);
    if (!proc) throw new Error(`Procedure not found: ${id}`);

    const now = new Date().toISOString();
    const updated: Procedure = { ...proc, lastApplied: now, updatedAt: now };

    if (feedback === 'positive') {
      updated.applications += 1;
      updated.confidence = Math.min(0.99, proc.confidence + 0.1 * (1 - proc.confidence));
      updated.stability = Math.min(2, proc.stability + 0.1);
    } else if (feedback === 'negative') {
      updated.contradictions += 1;
      updated.confidence = Math.max(0.01, proc.confidence * 0.8);
      if (updated.contradictions >= 3 && updated.confidence < 0.3) {
        updated.flaggedForReview = true;
      }
    }

    this.store.putProcedure(updated);
  }

  async close(): Promise<void> {
    this.store.close();
  }
}
