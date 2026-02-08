import { useEffect, useMemo, useState } from 'react';
import type { Procedure } from '../api/types.ts';

type SortBy = 'recency' | 'confidence' | 'stability';

export function ProceduresPanel(props: {
  apiOnline: boolean;
  load: (opts: { type?: string; flagged?: boolean }) => Promise<Procedure[]>;
  apply: (id: string, feedback: 'positive' | 'negative') => Promise<Procedure>;
}) {
  const [procedures, setProcedures] = useState<Procedure[]>([]);
  const [filterType, setFilterType] = useState<string>('all');
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [sortBy, setSortBy] = useState<SortBy>('recency');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    if (!props.apiOnline) return;
    setLoading(true);
    setError(null);
    try {
      const list = await props.load({
        type: filterType === 'all' ? undefined : filterType,
        flagged: flaggedOnly ? true : undefined,
      });
      setProcedures(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.apiOnline, filterType, flaggedOnly]);

  const sorted = useMemo(() => {
    const list = [...procedures];
    list.sort((a, b) => {
      if (sortBy === 'confidence') return b.confidence - a.confidence;
      if (sortBy === 'stability') return b.stability - a.stability;
      const ad = a.lastApplied ? new Date(a.lastApplied).getTime() : 0;
      const bd = b.lastApplied ? new Date(b.lastApplied).getTime() : 0;
      return bd - ad;
    });
    return list;
  }, [procedures, sortBy]);

  async function apply(id: string, feedback: 'positive' | 'negative') {
    try {
      const updated = await props.apply(id, feedback);
      setProcedures((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="panel panel-procedures">
      <div className="panel-header">
        <h3>Procedures</h3>
        {loading && <div className="tiny">loading</div>}
      </div>

      {!props.apiOnline && <div className="panel-note">API offline.</div>}
      {error && <div className="panel-error">{error}</div>}

      <div className="proc-controls">
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)}>
          <option value="recency">Recency</option>
          <option value="confidence">Confidence</option>
          <option value="stability">Stability</option>
        </select>
        <select value={filterType} onChange={(e) => setFilterType(e.target.value)}>
          <option value="all">All types</option>
          <option value="lesson">lesson</option>
          <option value="preference">preference</option>
          <option value="skill">skill</option>
          <option value="antipattern">antipattern</option>
          <option value="insight">insight</option>
        </select>
        <label className="checkbox">
          <input type="checkbox" checked={flaggedOnly} onChange={(e) => setFlaggedOnly(e.target.checked)} />
          flagged
        </label>
        <button className="btn" onClick={refresh} disabled={!props.apiOnline || loading}>Refresh</button>
      </div>

      <div className="procedures-list">
        {sorted.slice(0, 40).map((p) => (
          <div key={p.id} className="procedure-card">
            <div className="confidence-meter">
              <div className="meter-fill" style={{ width: `${Math.max(0, Math.min(1, p.confidence)) * 100}%` }} />
              <span className="value">{(p.confidence * 100).toFixed(0)}%</span>
            </div>
            <div className="content">
              <div className="title">{p.statement}</div>
              <div className="meta">
                <span className="type">{p.type}</span>
                <span className="last">{p.lastApplied ? `Applied ${new Date(p.lastApplied).toLocaleDateString()}` : 'Never applied'}</span>
                {p.flaggedForReview && <span className="flag">flagged</span>}
              </div>
            </div>
            <div className="actions">
              <button className="btn" onClick={() => apply(p.id, 'positive')} disabled={!props.apiOnline}>Teach</button>
              <button className="btn danger" onClick={() => apply(p.id, 'negative')} disabled={!props.apiOnline}>Contradict</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
