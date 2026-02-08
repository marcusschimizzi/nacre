import type { ForceLink, ForceNode } from '../graph/types.ts';
import { nodeColor } from '../graph/theme.ts';

export function NodeDetailsPanel(props: {
  node: ForceNode | null;
  links: ForceLink[];
  nodeMap: Map<string, ForceNode>;
  onClickNeighbor: (id: string) => void;
  onClose: () => void;
}) {
  if (!props.node) {
    return <div id="details" className="hidden" />;
  }

  const node = props.node;
  const color = nodeColor(node.type);
  const dateRange = node.firstSeen === node.lastReinforced ? node.firstSeen : `${node.firstSeen} — ${node.lastReinforced}`;

  const neighbors = props.links
    .filter((l) => {
      const src = typeof l.source === 'string' ? l.source : l.source.id;
      const tgt = typeof l.target === 'string' ? l.target : l.target.id;
      return src === node.id || tgt === node.id;
    })
    .map((l) => {
      const src = typeof l.source === 'string' ? l.source : l.source.id;
      const tgt = typeof l.target === 'string' ? l.target : l.target.id;
      const neighborId = src === node.id ? tgt : src;
      const neighborNode = props.nodeMap.get(neighborId);
      return { id: neighborId, label: neighborNode?.label ?? neighborId, type: l.type, weight: l.weight };
    })
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 20);

  return (
    <div id="details">
      <div className="panel-header" style={{ marginBottom: 6 }}>
        <h3 style={{ marginBottom: 0 }}>{node.label}</h3>
        <button className="btn" onClick={props.onClose}>Close</button>
      </div>
      <span className="type-badge" style={{ background: `${color}33`, color }}>{node.type}</span>
      <div className="stat">Mentions: <strong>{node.mentionCount}</strong> · Reinforced: <strong>{node.reinforcementCount}</strong></div>
      <div className="stat">Dates: <strong>{dateRange}</strong></div>
      <div className="stat">Sources: <strong>{node.sourceFiles.length} files</strong> · Edges: <strong>{node.edgeCount}</strong></div>
      {node.excerpts.length > 0 && (
        <div className="stat" style={{ marginTop: 6, fontStyle: 'italic', opacity: 0.7 }}>
          "{node.excerpts[0].text}"
        </div>
      )}

      <div className="neighbors">
        <div className="stat" style={{ marginBottom: 4 }}>Connected to:</div>
        {neighbors.map((n) => (
          <span key={n.id} className="neighbor" onClick={() => props.onClickNeighbor(n.id)}>
            {n.label} <span style={{ opacity: 0.5 }}>{n.type.slice(0, 3)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
