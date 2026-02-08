import type {
  NacreGraphData, GraphNode, GraphEdge,
  RecallResult, RecallProcedureMatch, Procedure, Episode,
} from './types.ts';

export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  embeddingCount: number;
  avgWeight: number;
  lastConsolidated: string;
  nodesByType: Record<string, number>;
}

export interface FetchOptions {
  limit?: number;
  offset?: number;
  type?: string;
  signal?: AbortSignal;
}

export interface LoadProgress {
  totalNodes: number;
  loadedNodes: number;
  totalEdges: number;
  loadedEdges: number;
  stage: 'fetching' | 'processing' | 'complete';
}

export type ProgressCallback = (progress: LoadProgress) => void;

/**
 * GraphApiClient - Fetches graph data from the Nacre API.
 * Falls back to static JSON if API is unavailable.
 */
export class GraphApiClient {
  private readonly baseUrl: string;
  private readonly enableFallback: boolean;

  constructor(baseUrl: string = 'http://localhost:3200', enableFallback: boolean = true) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.enableFallback = enableFallback;
  }

  /**
   * Check if the API is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/graph/stats`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Fetch nodes with optional filtering and pagination
   */
  async fetchNodes(options: FetchOptions = {}): Promise<GraphNode[]> {
    const params = new URLSearchParams();
    if (options.limit) params.append('limit', options.limit.toString());
    if (options.offset) params.append('offset', options.offset.toString());
    if (options.type) params.append('type', options.type);

    const url = `${this.baseUrl}/api/v1/nodes?${params.toString()}`;
    const res = await fetch(url, { signal: options.signal });
    if (!res.ok) throw new Error(`Failed to fetch nodes: ${res.status}`);

    const data = await res.json();
    return data.data || data.nodes || data;
  }

  /**
   * Fetch edges with optional filtering and pagination
   */
  async fetchEdges(options: FetchOptions = {}): Promise<GraphEdge[]> {
    const params = new URLSearchParams();
    if (options.limit) params.append('limit', options.limit.toString());
    if (options.offset) params.append('offset', options.offset.toString());
    if (options.type) params.append('type', options.type);

    const url = `${this.baseUrl}/api/v1/edges?${params.toString()}`;
    const res = await fetch(url, { signal: options.signal });
    if (!res.ok) throw new Error(`Failed to fetch edges: ${res.status}`);

    const data = await res.json();
    return data.data || data.edges || data;
  }

  /**
   * Fetch graph statistics
   */
  async fetchStats(): Promise<GraphStats> {
    const url = `${this.baseUrl}/api/v1/graph/stats`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch stats: ${res.status}`);

    const json = await res.json();
    return (json?.data ?? json) as GraphStats;
  }

  /**
   * Fetch complete graph data (nodes + edges + config)
   * Implements batch fetching for large graphs.
   */
  async fetchGraph(
    onProgress?: ProgressCallback,
    options: { nodeLimit?: number; edgeLimit?: number } = {}
  ): Promise<NacreGraphData> {
    const signal = AbortSignal.timeout(60000); // 60 second timeout

    // First, fetch stats to know total counts
    onProgress?.({
      totalNodes: 0,
      loadedNodes: 0,
      totalEdges: 0,
      loadedEdges: 0,
      stage: 'fetching',
    });

    let stats: GraphStats;
    try {
      stats = await this.fetchStats();
    } catch (e) {
      throw new Error(`Failed to fetch graph stats: ${e}`);
    }

    onProgress?.({
      totalNodes: stats.nodeCount,
      loadedNodes: 0,
      totalEdges: stats.edgeCount,
      loadedEdges: 0,
      stage: 'fetching',
    });

    // Determine batch sizes
    const nodeLimit = options.nodeLimit || 5000;
    const edgeLimit = options.edgeLimit || 10000;

    // Fetch nodes in parallel batches
    const allNodes: GraphNode[] = [];
    const nodeBatches = Math.ceil(Math.min(stats.nodeCount, nodeLimit) / 1000);

    for (let i = 0; i < nodeBatches; i++) {
      const batch = await this.fetchNodes({
        limit: 1000,
        offset: i * 1000,
        signal,
      });
      allNodes.push(...batch);

      onProgress?.({
        totalNodes: stats.nodeCount,
        loadedNodes: allNodes.length,
        totalEdges: stats.edgeCount,
        loadedEdges: 0,
        stage: 'fetching',
      });
    }

    // Fetch edges in parallel batches
    const allEdges: GraphEdge[] = [];
    const edgeBatches = Math.ceil(Math.min(stats.edgeCount, edgeLimit) / 1000);

    for (let i = 0; i < edgeBatches; i++) {
      const batch = await this.fetchEdges({
        limit: 1000,
        offset: i * 1000,
        signal,
      });
      allEdges.push(...batch);

      onProgress?.({
        totalNodes: stats.nodeCount,
        loadedNodes: allNodes.length,
        totalEdges: stats.edgeCount,
        loadedEdges: allEdges.length,
        stage: 'fetching',
      });
    }

    onProgress?.({
      totalNodes: stats.nodeCount,
      loadedNodes: allNodes.length,
      totalEdges: stats.edgeCount,
      loadedEdges: allEdges.length,
      stage: 'processing',
    });

    // Convert arrays to record format to match NacreGraphData
    const nodes: Record<string, GraphNode> = {};
    for (const node of allNodes) {
      nodes[node.id] = node;
    }

    const edges: Record<string, GraphEdge> = {};
    for (const edge of allEdges) {
      edges[edge.id] = edge;
    }

    onProgress?.({
      totalNodes: stats.nodeCount,
      loadedNodes: allNodes.length,
      totalEdges: stats.edgeCount,
      loadedEdges: allEdges.length,
      stage: 'complete',
    });

    return {
      version: 1,
      lastConsolidated: stats.lastConsolidated,
      nodes,
      edges,
      config: {
        decayRate: 0.01,
        reinforcementBoost: 1.5,
        visibilityThreshold: 0.1,
        coOccurrenceThreshold: 2,
        baseWeights: {},
      },
    };
  }

  async fetchRecall(
    query: string,
    limit: number = 10,
    signal?: AbortSignal,
  ): Promise<{ results: RecallResult[]; procedures: RecallProcedureMatch[] }> {
    const params = new URLSearchParams({ q: query, limit: limit.toString() });
    const url = `${this.baseUrl}/api/v1/recall?${params.toString()}`;
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`Failed to fetch recall: ${res.status}`);

    const json = await res.json();
    return {
      results: json?.data ?? json?.results ?? [],
      procedures: json?.procedures ?? [],
    };
  }

  async fetchProcedures(type?: string, signal?: AbortSignal): Promise<Procedure[]> {
    const params = new URLSearchParams();
    if (type) params.append('type', type);

    const url = `${this.baseUrl}/api/v1/procedures?${params.toString()}`;
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`Failed to fetch procedures: ${res.status}`);

    const json = await res.json();
    return json?.data ?? json ?? [];
  }

  async fetchEpisodes(
    options: { since?: string; until?: string; limit?: number; offset?: number; signal?: AbortSignal } = {},
  ): Promise<Episode[]> {
    const params = new URLSearchParams();
    if (options.since) params.append('since', options.since);
    if (options.until) params.append('until', options.until);
    if (options.limit) params.append('limit', options.limit.toString());
    if (options.offset) params.append('offset', options.offset.toString());

    const url = `${this.baseUrl}/api/v1/episodes?${params.toString()}`;
    const res = await fetch(url, { signal: options.signal });
    if (!res.ok) throw new Error(`Failed to fetch episodes: ${res.status}`);

    const json = await res.json();
    return json?.data ?? json ?? [];
  }

  /**
   * Load graph with graceful fallback to static JSON
   */
  async loadGraphWithFallback(
    staticJsonUrl: string,
    onProgress?: ProgressCallback,
    options?: { nodeLimit?: number; edgeLimit?: number }
  ): Promise<{ data: NacreGraphData; source: 'api' | 'static' }> {
    // Check if API is available
    const apiAvailable = await this.isAvailable();

    if (apiAvailable) {
      try {
        const data = await this.fetchGraph(onProgress, options);
        return { data, source: 'api' };
      } catch (e) {
        console.warn('API fetch failed, falling back to static JSON:', e);
      }
    }

    if (!this.enableFallback) {
      throw new Error('API unavailable and fallback disabled');
    }

    // Fallback to static JSON
    onProgress?.({
      totalNodes: 0,
      loadedNodes: 0,
      totalEdges: 0,
      loadedEdges: 0,
      stage: 'fetching',
    });

    const res = await fetch(staticJsonUrl);
    if (!res.ok) throw new Error(`Failed to load static JSON: ${res.status}`);

    const data: NacreGraphData = await res.json();

    const nodeCount = Object.keys(data.nodes).length;
    const edgeCount = Object.keys(data.edges).length;

    onProgress?.({
      totalNodes: nodeCount,
      loadedNodes: nodeCount,
      totalEdges: edgeCount,
      loadedEdges: edgeCount,
      stage: 'complete',
    });

    return { data, source: 'static' };
  }
}
