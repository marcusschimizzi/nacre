import { useEffect, useMemo, useState } from 'react';
import type { AlertResult, GraphStatsData, Procedure } from '../api/types.ts';
import type { ForceLink, ForceNode } from '../graph/types.ts';
import { formatAgeStats, formatNumber } from './healthMetrics.ts';

export function HealthPanel(props: {
  apiOnline: boolean;
  graph?: { nodes: ForceNode[]; links: ForceLink[] };
  load: () => Promise<{ stats: GraphStatsData | null; alerts: AlertResult | null; procedures: Procedure[] | null }>;
}) {
  const [stats, setStats] = useState<GraphStatsData | null>(null);
  const [alerts, setAlerts] = useState<AlertResult | null>(null);
  const [procedures, setProcedures] = useState<Procedure[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const density = useMemo(() => {
    const n = props.graph?.nodes.length ?? 0;
    const e = props.graph?.links.length ?? 0;
    const avgDegree = n > 0 ? (2 * e) / n : 0;
    return { n, e, avgDegree };
  }, [props.graph]);

  const age = useMemo(() => {
    if (!props.graph) return null;
    return formatAgeStats(props.graph.nodes);
  }, [props.graph]);

  const procHealth = useMemo(() => {
    if (!procedures) return null;
    const total = procedures.length;
    const flagged = procedures.filter((p) => p.flaggedForReview).length;
    const avgConfidence = total ? procedures.reduce((s, p) => s + p.confidence, 0) / total : 0;
    const lowConfidence = procedures.filter((p) => p.confidence < 0.3).length;
    return { total, flagged, avgConfidence, lowConfidence };
  }, [procedures]);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const res = await props.load();
      setStats(res.stats);
      setAlerts(res.alerts);
      setProcedures(res.procedures);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.apiOnline]);

  return (
    <div className="panel panel-health">
      <div className="panel-header">
        <h3>Health</h3>
        <button className="btn" onClick={refresh} disabled={loading}>
          {loading ? '...' : 'Refresh'}
        </button>
      </div>

      {!props.apiOnline && (
        <div className="panel-note">API offline. Showing static graph-only metrics where available.</div>
      )}

      {error && <div className="panel-error">{error}</div>}

      <div className="metric-grid">
        <div className="metric-card">
          <div className="label">Nodes</div>
          <div className="value">{stats?.nodeCount ?? density.n}</div>
        </div>
        <div className="metric-card">
          <div className="label">Edges</div>
          <div className="value">{stats?.edgeCount ?? density.e}</div>
        </div>
        <div className="metric-card">
          <div className="label">Avg Degree</div>
          <div className="value">{density.avgDegree.toFixed(1)}</div>
        </div>
        <div className="metric-card">
          <div className="label">Avg Weight</div>
          <div className="value">{stats ? stats.avgWeight.toFixed(2) : '—'}</div>
        </div>
      </div>

      <div className="metric-grid" style={{ marginTop: 10 }}>
        <div className="metric-card">
          <div className="label">Health Score</div>
          <div className="value">{alerts ? formatNumber(alerts.healthScore, 2) : '—'}</div>
        </div>
        <div className="metric-card">
          <div className="label">Fading Edges</div>
          <div className="value">{alerts ? alerts.fadingEdges.length : '—'}</div>
        </div>
        <div className="metric-card">
          <div className="label">Orphans</div>
          <div className="value">{alerts ? alerts.orphanNodes.length : '—'}</div>
        </div>
        <div className="metric-card">
          <div className="label">Embeddings</div>
          <div className="value">{stats ? stats.embeddingCount : '—'}</div>
        </div>
      </div>

      {age && (
        <div className="panel-subsection">
          <div className="subheader">Memory Age</div>
          <div className="subrow">Average: <strong>{age.avgDays.toFixed(1)}d</strong></div>
          <div className="subrow">Median: <strong>{age.medianDays.toFixed(1)}d</strong></div>
          <div className="subrow">Oldest: <strong>{age.oldestLabel}</strong></div>
        </div>
      )}

      {procHealth && (
        <div className="panel-subsection">
          <div className="subheader">Procedures</div>
          <div className="subrow">Total: <strong>{procHealth.total}</strong></div>
          <div className="subrow">Avg confidence: <strong>{(procHealth.avgConfidence * 100).toFixed(0)}%</strong></div>
          <div className="subrow">Low confidence: <strong>{procHealth.lowConfidence}</strong></div>
          <div className="subrow">Flagged: <strong>{procHealth.flagged}</strong></div>
        </div>
      )}
    </div>
  );
}
