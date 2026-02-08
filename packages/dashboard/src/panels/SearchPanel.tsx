import { useEffect, useMemo, useState } from 'react';
import type { RecallResult } from '../api/types.ts';
import { useDebouncedValue } from '../hooks/useDebounce.ts';

export function SearchPanel(props: {
  apiOnline: boolean;
  onSelect: (result: RecallResult) => void;
  recall: (q: string) => Promise<RecallResult[]>;
  localSearch: (q: string) => RecallResult[];
}) {
  const [query, setQuery] = useState('');
  const debounced = useDebouncedValue(query, 250);
  const [results, setResults] = useState<RecallResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mode = props.apiOnline ? 'api' : 'local';

  useEffect(() => {
    let cancelled = false;
    const q = debounced.trim();
    setError(null);

    if (!q) {
      setResults([]);
      return;
    }

    if (mode === 'local') {
      setResults(props.localSearch(q));
      return;
    }

    setLoading(true);
    props.recall(q)
      .then((r) => {
        if (cancelled) return;
        setResults(r);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [debounced, mode, props]);

  const borderColor = useMemo(() => {
    if (!query.trim()) return '';
    if (loading) return 'rgba(180, 160, 255, 0.35)';
    return results.length > 0 ? 'rgba(100, 200, 100, 0.5)' : 'rgba(200, 100, 100, 0.5)';
  }, [query, loading, results.length]);

  return (
    <>
      <div id="search-bar">
        <input
          type="text"
          id="search-input"
          placeholder={props.apiOnline ? 'Recall memories...' : 'Search nodes...'}
          autoComplete="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ borderColor }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQuery('');
          }}
        />
      </div>

      {query.trim() && (
        <div className="panel panel-search-results">
          <div className="panel-header">
            <h3>Results</h3>
            <div className="tiny">{mode === 'api' ? 'live' : 'local'}</div>
          </div>

          {error && <div className="panel-error">{error}</div>}
          {!error && loading && <div className="panel-note">Searching...</div>}
          {!error && !loading && results.length === 0 && (
            <div className="panel-note">No matches for "{query}"</div>
          )}

          <div className="results-list">
            {results.slice(0, 8).map((r) => (
              <button
                key={r.id}
                className="result-card"
                onClick={() => props.onSelect(r)}
              >
                <div className="score">
                  <div className="score-value">{r.score.toFixed(2)}</div>
                  {r.scores && (
                    <div className="breakdown">
                      s:{(r.scores.semantic ?? 0).toFixed(2)} g:{(r.scores.graph ?? 0).toFixed(2)}
                    </div>
                  )}
                </div>
                <div className="content">
                  <div className="title">{r.label}</div>
                  <div className="meta">{r.type}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
