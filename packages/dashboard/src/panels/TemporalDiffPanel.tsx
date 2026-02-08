import { useEffect, useMemo, useState } from 'react';
import type { GraphDiff, Snapshot } from '../api/types.ts';

export function TemporalDiffPanel(props: {
  apiOnline: boolean;
  loadSnapshots: () => Promise<Snapshot[]>;
  loadSnapshotGraph: (id: string) => Promise<unknown>;
  diff: (fromId: string, toId: string) => Promise<GraphDiff>;
  onApply: (fromGraph: unknown, toGraph: unknown, diff: GraphDiff) => Promise<void>;
}) {
  const [snaps, setSnaps] = useState<Snapshot[]>([]);
  const [fromId, setFromId] = useState<string>('');
  const [toId, setToId] = useState<string>('');
  const [diff, setDiff] = useState<GraphDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!props.apiOnline) {
      setSnaps([]);
      setFromId('');
      setToId('');
      setDiff(null);
      return;
    }
    props.loadSnapshots()
      .then((s) => {
        if (cancelled) return;
        setSnaps(s);
        if (s.length >= 2) {
          setFromId(s[s.length - 2].id);
          setToId(s[s.length - 1].id);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [props]);

  const summary = useMemo(() => {
    if (!diff) return null;
    return {
      nodes: (diff.nodes.added.length + diff.nodes.removed.length + diff.nodes.changed.length),
      edges: (diff.edges.added.length + diff.edges.removed.length + diff.edges.strengthened.length + diff.edges.weakened.length),
    };
  }, [diff]);

  async function loadDiff() {
    if (!fromId || !toId) return;
    setLoading(true);
    setError(null);
    try {
      const d = await props.diff(fromId, toId);
      setDiff(d);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function animate() {
    if (!fromId || !toId) return;
    setLoading(true);
    setError(null);
    try {
      const [fromGraph, toGraph, d] = await Promise.all([
        props.loadSnapshotGraph(fromId),
        props.loadSnapshotGraph(toId),
        props.diff(fromId, toId),
      ]);
      setDiff(d);
      await props.onApply(fromGraph, toGraph, d);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="panel panel-temporal">
      <div className="panel-header">
        <h3>Diff</h3>
        {loading && <div className="tiny">working</div>}
      </div>

      {!props.apiOnline && <div className="panel-note">API offline.</div>}
      {error && <div className="panel-error">{error}</div>}

      {props.apiOnline && (
        <>
          <div className="diff-controls">
            <select value={fromId} onChange={(e) => setFromId(e.target.value)}>
              {snaps.map((s) => (
                <option key={s.id} value={s.id}>{new Date(s.createdAt).toLocaleString()}</option>
              ))}
            </select>
            <select value={toId} onChange={(e) => setToId(e.target.value)}>
              {snaps.map((s) => (
                <option key={s.id} value={s.id}>{new Date(s.createdAt).toLocaleString()}</option>
              ))}
            </select>
          </div>
          <div className="diff-actions">
            <button className="btn" onClick={loadDiff} disabled={!fromId || !toId || loading}>Load</button>
            <button className="btn" onClick={animate} disabled={!fromId || !toId || loading}>Animate</button>
          </div>

          {diff && summary && (
            <div className="panel-note">
              Nodes: +{diff.nodes.added.length} -{diff.nodes.removed.length} ~{diff.nodes.changed.length} | Edges: +{diff.edges.added.length} -{diff.edges.removed.length} ^{diff.edges.strengthened.length} v{diff.edges.weakened.length}
            </div>
          )}
        </>
      )}
    </div>
  );
}
