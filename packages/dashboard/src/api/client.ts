import type {
  ApiEnvelope,
  ApiError,
  AlertResult,
  Episode,
  GraphDiff,
  GraphStatsData,
  HealthData,
  Procedure,
  RecallResponse,
  Snapshot,
} from './types.ts';

export class NacreAPIClient {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private async requestJson<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
      },
    });

    const text = await res.text();
    const json = text ? JSON.parse(text) as unknown : null;

    if (!res.ok) {
      const err = (json as Partial<ApiError>)?.error;
      const msg = err?.message ?? `Request failed: ${res.status}`;
      const code = err?.code ?? 'HTTP_ERROR';
      throw new Error(`${code}: ${msg}`);
    }

    return json as T;
  }

  async health(): Promise<HealthData> {
    const res = await this.requestJson<ApiEnvelope<HealthData>>('/health');
    return res.data;
  }

  async graphStats(): Promise<GraphStatsData> {
    const res = await this.requestJson<ApiEnvelope<GraphStatsData>>('/graph/stats');
    return res.data;
  }

  async alerts(): Promise<AlertResult> {
    const res = await this.requestJson<ApiEnvelope<AlertResult>>('/alerts');
    return res.data;
  }

  async recall(opts: { q: string; limit?: number; hops?: number; types?: string[] }): Promise<RecallResponse> {
    const params = new URLSearchParams();
    params.set('q', opts.q);
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.hops) params.set('hops', String(opts.hops));
    if (opts.types?.length) params.set('types', opts.types.join(','));

    // API returns `{ data: RecallResult[], procedures: RecallProcedureMatch[] }` (not enveloped)
    const res = await this.requestJson<{ data: RecallResponse['data']; procedures: RecallResponse['procedures'] }>(
      `/recall?${params.toString()}`,
    );

    return { data: res.data, procedures: res.procedures };
  }

  async episodesList(opts?: { since?: string; until?: string; type?: string; entity?: string; limit?: number; offset?: number }): Promise<Episode[]> {
    const params = new URLSearchParams();
    if (opts?.since) params.set('since', opts.since);
    if (opts?.until) params.set('until', opts.until);
    if (opts?.type) params.set('type', opts.type);
    if (opts?.entity) params.set('entity', opts.entity);
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.offset) params.set('offset', String(opts.offset));
    const q = params.toString();

    const res = await this.requestJson<ApiEnvelope<Episode[]>>(`/episodes${q ? `?${q}` : ''}`);
    return res.data;
  }

  async episodeDetail(id: string): Promise<{ episode: Episode; entities: Array<{ id: string; label: string; type: string }> }> {
    const res = await this.requestJson<ApiEnvelope<{ episode: Episode; entities: Array<{ id: string; label: string; type: string }> }>>(
      `/episodes/${encodeURIComponent(id)}`,
    );
    return res.data;
  }

  async proceduresList(opts?: { type?: string; flagged?: boolean }): Promise<Procedure[]> {
    const params = new URLSearchParams();
    if (opts?.type) params.set('type', opts.type);
    if (opts?.flagged !== undefined) params.set('flagged', opts.flagged ? 'true' : 'false');
    const q = params.toString();

    const res = await this.requestJson<ApiEnvelope<Procedure[]>>(`/procedures${q ? `?${q}` : ''}`);
    return res.data;
  }

  async procedureApply(id: string, feedback: 'positive' | 'negative' | 'neutral' = 'neutral'): Promise<Procedure> {
    const res = await this.requestJson<ApiEnvelope<Procedure>>(`/procedures/${encodeURIComponent(id)}/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ feedback }),
    });
    return res.data;
  }

  async snapshotsList(opts?: { since?: string; until?: string; limit?: number }): Promise<Snapshot[]> {
    const params = new URLSearchParams();
    if (opts?.since) params.set('since', opts.since);
    if (opts?.until) params.set('until', opts.until);
    if (opts?.limit) params.set('limit', String(opts.limit));
    const q = params.toString();

    const res = await this.requestJson<ApiEnvelope<Snapshot[]>>(`/snapshots${q ? `?${q}` : ''}`);
    return res.data;
  }

  async snapshotGraph(id: string): Promise<{ snapshot: Snapshot; graph: unknown }> {
    const res = await this.requestJson<ApiEnvelope<{ snapshot: Snapshot; graph: unknown }>>(
      `/snapshots/${encodeURIComponent(id)}/graph`,
    );
    return res.data;
  }

  async diff(fromId: string, toId: string): Promise<GraphDiff> {
    const res = await this.requestJson<ApiEnvelope<GraphDiff>>(`/diff/${encodeURIComponent(fromId)}/${encodeURIComponent(toId)}`);
    return res.data;
  }

  async fullGraph(): Promise<unknown> {
    const res = await this.requestJson<ApiEnvelope<unknown>>('/graph');
    return res.data;
  }
}
