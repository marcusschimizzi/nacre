import { loadGraph, getEntityTypes, getEdgeTypes } from './loader.ts';
import { createGraphView, searchAndFocus } from './graph-view.ts';
import { initControls } from './controls.ts';
import type { AppState, ForceNode } from './types.ts';

const GRAPH_URL = '/graph.json';

const state: AppState = {
  selectedNode: null,
  hoveredNode: null,
  highlightNodes: new Set(),
  highlightLinks: new Set(),
  visibleTypes: new Set(),
  visibleEdgeTypes: new Set(),
  minWeight: 0,
};

async function init(): Promise<void> {
  const container = document.getElementById('graph')!;

  let data: { nodes: ForceNode[]; links: any[] };
  try {
    data = await loadGraph(GRAPH_URL);
  } catch {
    container.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#888;font-size:16px;text-align:center;padding:20px;">
        <div>
          <p>No graph.json found.</p>
          <p style="font-size:13px;margin-top:8px;opacity:0.6">
            Run <code style="background:#1a1a2e;padding:2px 6px;border-radius:4px">nacre consolidate test/fixtures --out packages/viz/public</code> first.
          </p>
        </div>
      </div>
    `;
    return;
  }

  const entityTypes = getEntityTypes(data.nodes);
  const edgeTypes = getEdgeTypes(data.links);

  const graph = createGraphView(container, data.nodes, data.links, state);

  initControls(state, entityTypes, edgeTypes, () => {
    (graph as any).nodeVisibility((graph as any).nodeVisibility());
    (graph as any).linkVisibility((graph as any).linkVisibility());
  });

  const searchInput = document.getElementById('search-input') as HTMLInputElement;
  let debounceTimer: ReturnType<typeof setTimeout>;

  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const match = searchAndFocus(graph, data.nodes, searchInput.value);
      if (match) {
        searchInput.style.borderColor = 'rgba(100, 200, 100, 0.5)';
      } else if (searchInput.value.trim()) {
        searchInput.style.borderColor = 'rgba(200, 100, 100, 0.5)';
      } else {
        searchInput.style.borderColor = '';
      }
    }, 300);
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      searchInput.value = '';
      searchInput.style.borderColor = '';
      searchInput.blur();
    }
  });
}

init();
