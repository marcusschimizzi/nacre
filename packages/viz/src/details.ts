import type { ForceNode, ForceLink } from './types.ts';
import { nodeColor } from './theme.ts';

const panel = () => document.getElementById('details')!;

export function showNodeDetails(
  node: ForceNode,
  links: ForceLink[],
  allNodes: Map<string, ForceNode>,
  onClickNeighbor: (id: string) => void,
): void {
  const el = panel();
  el.classList.remove('hidden');

  const neighbors = links
    .filter((l) => {
      const src = typeof l.source === 'string' ? l.source : l.source.id;
      const tgt = typeof l.target === 'string' ? l.target : l.target.id;
      return src === node.id || tgt === node.id;
    })
    .map((l) => {
      const src = typeof l.source === 'string' ? l.source : l.source.id;
      const tgt = typeof l.target === 'string' ? l.target : l.target.id;
      const neighborId = src === node.id ? tgt : src;
      const neighborNode = allNodes.get(neighborId);
      return { id: neighborId, label: neighborNode?.label ?? neighborId, type: l.type, weight: l.weight };
    })
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 20);

  const color = nodeColor(node.type);
  const dateRange = node.firstSeen === node.lastReinforced
    ? node.firstSeen
    : `${node.firstSeen} — ${node.lastReinforced}`;

  el.innerHTML = `
    <h3>${escapeHtml(node.label)}</h3>
    <span class="type-badge" style="background:${color}33;color:${color}">${escapeHtml(node.type)}</span>
    <div class="stat">Mentions: <strong>${node.mentionCount}</strong> &middot; Reinforced: <strong>${node.reinforcementCount}</strong></div>
    <div class="stat">Dates: <strong>${dateRange}</strong></div>
    <div class="stat">Sources: <strong>${node.sourceFiles.length} files</strong> &middot; Edges: <strong>${node.edgeCount}</strong></div>
    ${node.excerpts.length > 0 ? `<div class="stat" style="margin-top:6px;font-style:italic;opacity:0.7">"${escapeHtml(node.excerpts[0].text)}"</div>` : ''}
    <div class="neighbors">
      <div class="stat" style="margin-bottom:4px">Connected to:</div>
      ${neighbors.map((n) => `<span class="neighbor" data-id="${n.id}">${escapeHtml(n.label)} <span style="opacity:0.5">${n.type.slice(0, 3)}</span></span>`).join('')}
    </div>
  `;

  el.querySelectorAll('.neighbor').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = (btn as HTMLElement).dataset.id;
      if (id) onClickNeighbor(id);
    });
  });
}

export function hideDetails(): void {
  panel().classList.add('hidden');
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
