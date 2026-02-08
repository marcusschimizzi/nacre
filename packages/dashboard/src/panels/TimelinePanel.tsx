import { useEffect, useState } from 'react';
import type { Episode } from '../api/types.ts';

export function TimelinePanel(props: {
  apiOnline: boolean;
  loadEpisodes: () => Promise<Episode[]>;
  onSelectEpisode: (id: string) => void;
}) {
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!props.apiOnline) {
      setEpisodes([]);
      return;
    }

    setLoading(true);
    setError(null);
    props.loadEpisodes()
      .then((eps) => {
        if (cancelled) return;
        setEpisodes(eps);
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
  }, [props]);

  return (
    <div className="panel panel-timeline">
      <div className="panel-header">
        <h3>Episodes</h3>
        {loading && <div className="tiny">loading</div>}
      </div>

      {!props.apiOnline && <div className="panel-note">API offline.</div>}
      {error && <div className="panel-error">{error}</div>}

      <div className="timeline-scroll">
        {episodes.map((ep) => (
          <button key={ep.id} className="episode-item" onClick={() => props.onSelectEpisode(ep.id)}>
            <div className="timestamp">{new Date(ep.timestamp).toLocaleString()}</div>
            <div className="title">{ep.title}</div>
            {ep.summary && <div className="summary">{ep.summary}</div>}
            <div className="meta">{ep.type}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
