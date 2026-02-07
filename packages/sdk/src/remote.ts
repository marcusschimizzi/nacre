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

export class RemoteBackend implements Backend {
  private baseUrl: string;
  private apiKey?: string;

  constructor(opts: NacreOptions) {
    if (!opts.url) throw new Error('Remote mode requires url');
    this.baseUrl = opts.url.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
    };
    const res = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`API error ${res.status}: ${body}`);
    }
    return res.json() as Promise<T>;
  }

  async remember(content: string, opts?: RememberOptions): Promise<Memory> {
    const { data } = await this.request<{ data: Memory }>('/api/v1/memories', {
      method: 'POST',
      body: JSON.stringify({
        content,
        type: opts?.type === 'fact' ? 'concept' : opts?.type || 'concept',
        label: content.slice(0, 100),
      }),
    });
    return data;
  }

  async recall(query: string, opts?: RecallOptions): Promise<Memory[]> {
    const params = new URLSearchParams({ q: query, provider: 'mock' });
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.types) params.set('types', opts.types.join(','));
    if (opts?.since) params.set('since', opts.since);
    if (opts?.until) params.set('until', opts.until);

    const { data } = await this.request<{ data: Memory[] }>(`/api/v1/recall?${params}`);
    return data;
  }

  async brief(opts?: BriefOptions): Promise<string> {
    const params = new URLSearchParams();
    if (opts?.top) params.set('top', String(opts.top));
    params.set('format', 'json');

    const { data } = await this.request<{ data: { summary: string } }>(
      `/api/v1/brief?${params}`,
    );
    return data.summary;
  }

  async lesson(lesson: string, opts?: LessonOptions): Promise<SdkProcedure> {
    const { data } = await this.request<{ data: SdkProcedure }>('/api/v1/procedures', {
      method: 'POST',
      body: JSON.stringify({
        statement: lesson,
        type: opts?.category ?? 'insight',
        keywords: opts?.keywords,
        contexts: opts?.contexts,
        context: opts?.context,
      }),
    });
    return data;
  }

  async feedback(memoryId: string, opts: FeedbackOptions): Promise<void> {
    await this.request('/api/v1/feedback', {
      method: 'POST',
      body: JSON.stringify({ memoryId, rating: opts.rating }),
    });
  }

  async forget(memoryId: string): Promise<void> {
    await this.request(`/api/v1/memories/${encodeURIComponent(memoryId)}`, {
      method: 'DELETE',
    });
  }

  async nodes(filter?: { type?: string }): Promise<Memory[]> {
    const params = new URLSearchParams();
    if (filter?.type) params.set('type', filter.type);

    const { data } = await this.request<{ data: Memory[] }>(
      `/api/v1/nodes?${params}`,
    );
    return data.map((n) => ({
      id: n.id,
      label: n.label,
      type: n.type,
      excerpts: n.excerpts,
    }));
  }

  async stats(): Promise<GraphStats> {
    const { data } = await this.request<{ data: GraphStats }>('/api/v1/graph/stats');
    return {
      nodeCount: data.nodeCount,
      edgeCount: data.edgeCount,
      embeddingCount: data.embeddingCount,
    };
  }

  async procedures(filter?: { type?: string; flagged?: boolean }): Promise<SdkProcedure[]> {
    const params = new URLSearchParams();
    if (filter?.type) params.set('type', filter.type);
    if (filter?.flagged) params.set('flagged', 'true');

    const { data } = await this.request<{ data: SdkProcedure[] }>(
      `/api/v1/procedures?${params}`,
    );
    return data;
  }

  async applyProcedure(id: string, feedback: 'positive' | 'negative' | 'neutral'): Promise<void> {
    await this.request(`/api/v1/procedures/${encodeURIComponent(id)}/apply`, {
      method: 'POST',
      body: JSON.stringify({ feedback }),
    });
  }

  async close(): Promise<void> {
    return;
  }
}
