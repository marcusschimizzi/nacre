import { loadGraph, getEntityTypes, getEdgeTypes } from './loader.ts';
import { createGraphView, refreshGraph, searchAndFocus } from './graph-view.ts';
import { initControls, initTimeScrub } from './controls.ts';
import { GraphApiClient } from './api-client.ts';
import { HealthDashboard } from './health-dashboard.ts';
import { HybridSearch } from './hybrid-search.ts';
import { ProceduresPanel } from './procedures-panel.ts';
import { EpisodesTimeline } from './episodes-timeline.ts';
import type { AppState, ForceNode } from './types.ts';

const GRAPH_URL = '/graph.json';
const RELOAD_COOLDOWN_MS = 10_000;

const state: AppState = {
  selectedNode: null,
  hoveredNode: null,
  highlightNodes: new Set(),
  highlightLinks: new Set(),
  recallHighlightNodes: new Set(),
  visibleTypes: new Set(),
  visibleEdgeTypes: new Set(),
  minWeight: 0,
  scrubDate: null,
};

function getApiUrl(): string | undefined {
  const urlParams = new URLSearchParams(window.location.search);
  const apiUrl = urlParams.get('api');
  if (apiUrl) return apiUrl;

  const stored = localStorage.getItem('nacre_api_url');
  if (stored) return stored;

  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    const vizPort = window.location.port;
    const apiPorts = ['3200', vizPort].filter(Boolean);

    for (const port of apiPorts) {
      return `http://localhost:${port}`;
    }
  }

  return undefined;
}

async function init(): Promise<void> {
  const container = document.getElementById('graph')!;

  container.innerHTML = `
    <div id="loading" style="display:flex;align-items:center;justify-content:center;height:100vh;color:#aaa;font-size:16px;text-align:center;padding:20px;flex-direction:column;gap:16px;">
      <div style="width:40px;height:40px;border:3px solid rgba(255,255,255,0.1);border-top-color:#8b5cf6;border-radius:50%;animation:spin 1s linear infinite;"></div>
      <div>
        <p id="loading-text">Loading graph...</p>
        <p id="loading-detail" style="font-size:13px;margin-top:4px;opacity:0.5"></p>
      </div>
    </div>
    <style>@keyframes spin { to { transform: rotate(360deg); } }</style>
  `;

  const apiUrl = getApiUrl();

  let data: Awaited<ReturnType<typeof loadGraph>>;
  try {
    data = await loadGraph(GRAPH_URL, {
      apiUrl,
      onProgress: updateLoadingProgress,
    });

    console.log(`[Nacre Viz] Loaded graph from ${data.source === 'api' ? 'API' : 'static JSON'}`);
    if (data.source === 'api') {
      console.log(`[Nacre Viz] API URL: ${apiUrl}`);
    }
  } catch (e) {
    container.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#888;font-size:16px;text-align:center;padding:20px;">
        <div>
          <p>Failed to load graph.</p>
          <p style="font-size:13px;margin-top:8px;opacity:0.6">${e instanceof Error ? e.message : String(e)}</p>
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

  const isLive = data.source === 'api';
  createDataSourceIndicator(isLive, apiUrl);

  const graph = createGraphView(container, data.nodes, data.links, state, data.config);

  let dashboard: HealthDashboard | null = null;
  if (isLive && apiUrl) {
    const apiClient = new GraphApiClient(apiUrl);
    const dashboardContainer = document.createElement('div');
    dashboardContainer.id = 'health-dashboard-container';
    dashboardContainer.style.cssText = `
      position: fixed;
      top: 50px;
      right: 10px;
      width: 280px;
      max-height: calc(100vh - 120px);
      overflow-y: auto;
      z-index: 999;
      font-family: system-ui, -apple-system, sans-serif;
    `;
    document.body.appendChild(dashboardContainer);

    dashboard = new HealthDashboard(dashboardContainer, apiClient);
    dashboard.startAutoRefresh();
  }

  if (isLive && apiUrl) {
    setupLiveReload(graph, apiUrl, dashboard, data);
  }

  let hybridSearch: HybridSearch | null = null;
  let proceduresPanel: ProceduresPanel | null = null;
  let episodesTimeline: EpisodesTimeline | null = null;

  if (isLive && apiUrl) {
    const liveApiClient = new GraphApiClient(apiUrl);

    const searchBar = document.getElementById('search-bar')!;
    hybridSearch = new HybridSearch(searchBar, liveApiClient, {
      onNodeSelect: (id: string) => {
        const node = data.nodes.find((n) => n.id === id);
        if (node) {
          state.selectedNode = node;
          const x = node.x ?? 0;
          const y = node.y ?? 0;
          const z = node.z ?? 0;
          const dist = Math.hypot(x, y, z) || 1;
          const ratio = 1 + 80 / dist;
          graph.cameraPosition(
            { x: x * ratio, y: y * ratio, z: z * ratio },
            { x, y, z },
            1200,
          );
        }
      },
      onHighlight: (nodeIds: string[]) => {
        state.recallHighlightNodes.clear();
        for (const id of nodeIds) state.recallHighlightNodes.add(id);
        refreshGraph(graph);
      },
      onClear: () => {
        state.recallHighlightNodes.clear();
        refreshGraph(graph);
      },
    });

    const procContainer = document.createElement('div');
    procContainer.id = 'procedures-panel-container';
    procContainer.style.cssText = `
      position: fixed;
      top: 50px;
      left: 10px;
      width: 280px;
      max-height: calc(100vh - 120px);
      overflow-y: auto;
      z-index: 999;
      font-family: system-ui, -apple-system, sans-serif;
      pointer-events: auto;
    `;
    document.body.appendChild(procContainer);
    proceduresPanel = new ProceduresPanel(procContainer, liveApiClient);

    const epContainer = document.createElement('div');
    epContainer.id = 'episodes-timeline-container';
    epContainer.style.cssText = `
      position: fixed;
      bottom: 10px;
      left: 50%;
      transform: translateX(-50%);
      width: calc(100vw - 600px);
      min-width: 400px;
      max-width: 900px;
      z-index: 999;
      font-family: system-ui, -apple-system, sans-serif;
      pointer-events: auto;
    `;
    document.body.appendChild(epContainer);
    episodesTimeline = new EpisodesTimeline(epContainer, liveApiClient);
  }

  initControls(state, entityTypes, edgeTypes, () => {
    refreshGraph(graph);
  });

  const earliest = new Date(data.dateRange.earliest);
  const latest = new Date(data.dateRange.latest);

  initTimeScrub(state, earliest, latest, () => {
    refreshGraph(graph);
  });

  const searchInput = document.getElementById('search-input') as HTMLInputElement;

  if (hybridSearch) {
    const hs = hybridSearch;
    searchInput.addEventListener('input', () => {
      const q = searchInput.value.trim();
      if (q.length < 2) {
        hs.clear();
        searchInput.style.borderColor = '';
        return;
      }
      hs.search(q);
      searchInput.style.borderColor = 'rgba(245, 158, 11, 0.5)';
    });
  } else {
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
  }

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      searchInput.value = '';
      searchInput.style.borderColor = '';
      searchInput.blur();
      hybridSearch?.clear();
    }
  });

  searchInput.placeholder = isLive ? 'Recall search...' : 'Search nodes...';
}

function updateLoadingProgress(progress: { stage: string; totalNodes: number; loadedNodes: number; totalEdges: number; loadedEdges: number }): void {
  const loadingText = document.getElementById('loading-text');
  const loadingDetail = document.getElementById('loading-detail');
  if (!loadingText || !loadingDetail) return;

  const stageText = progress.stage === 'fetching' ? 'Fetching data' :
                   progress.stage === 'processing' ? 'Processing' : 'Complete';
  loadingText.textContent = `${stageText}...`;

  if (progress.totalNodes > 0 || progress.totalEdges > 0) {
    loadingDetail.textContent =
      `Nodes: ${progress.loadedNodes}/${progress.totalNodes} | Edges: ${progress.loadedEdges}/${progress.totalEdges}`;
  }
}

function createDataSourceIndicator(isLive: boolean, apiUrl: string | undefined): void {
  const indicator = document.createElement('div');
  indicator.id = 'data-source-indicator';
  indicator.style.cssText = `
    position: fixed;
    top: 10px;
    right: 10px;
    background: rgba(20, 20, 40, 0.85);
    border: 1px solid ${isLive ? 'rgba(100, 200, 100, 0.3)' : 'rgba(200, 150, 100, 0.3)'};
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 12px;
    color: ${isLive ? '#aaddaa' : '#eeccaa'};
    z-index: 1000;
    display: flex;
    align-items: center;
    gap: 6px;
    backdrop-filter: blur(8px);
  `;
  indicator.innerHTML = `
    <span style="width:8px;height:8px;border-radius:50%;background:${isLive ? '#88cc88' : '#ddaa88'}"></span>
    <span>${isLive ? 'Live API' : 'Static JSON'}</span>
    ${isLive && apiUrl ? `<span style="opacity:0.5">(${new URL(apiUrl).port})</span>` : ''}
  `;
  document.body.appendChild(indicator);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Graph = any;

function setupLiveReload(
  graph: Graph,
  apiUrl: string,
  dashboard: HealthDashboard | null,
  currentData: Awaited<ReturnType<typeof loadGraph>>,
): void {
  let isReloading = false;
  let lastReloadAt = 0;

  async function reloadLiveGraph(): Promise<void> {
    if (isReloading) return;
    if (Date.now() - lastReloadAt < RELOAD_COOLDOWN_MS) return;

    isReloading = true;
    lastReloadAt = Date.now();

    const refreshBtn = document.getElementById('refresh-graph-btn');
    if (refreshBtn) {
      refreshBtn.textContent = '↻';
      refreshBtn.style.opacity = '0.5';
      refreshBtn.style.pointerEvents = 'none';
    }

    try {
      const freshData = await loadGraph(GRAPH_URL, { apiUrl });

      currentData.nodes = freshData.nodes;
      currentData.links = freshData.links;
      currentData.config = freshData.config;
      currentData.dateRange = freshData.dateRange;

      graph.graphData({ nodes: freshData.nodes, links: freshData.links });

      dashboard?.refreshMetrics();

      console.log(`[Nacre Viz] Reloaded: ${freshData.nodes.length} nodes, ${freshData.links.length} links`);
    } catch (e) {
      console.error('[Nacre Viz] Reload failed:', e);
    } finally {
      isReloading = false;
      if (refreshBtn) {
        refreshBtn.textContent = '⟳';
        refreshBtn.style.opacity = '1';
        refreshBtn.style.pointerEvents = 'auto';
      }
    }
  }

  const indicator = document.getElementById('data-source-indicator');
  if (indicator) {
    const btn = document.createElement('button');
    btn.id = 'refresh-graph-btn';
    btn.textContent = '⟳';
    btn.title = 'Refresh graph data';
    btn.style.cssText = `
      background: rgba(60, 60, 100, 0.4);
      border: 1px solid rgba(120, 120, 180, 0.2);
      border-radius: 4px;
      padding: 1px 6px;
      color: #aaddaa;
      font-size: 13px;
      cursor: pointer;
      transition: all 0.15s ease;
      line-height: 1;
      margin-left: 2px;
    `;
    btn.addEventListener('click', () => reloadLiveGraph());
    btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(100, 200, 100, 0.2)'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = 'rgba(60, 60, 100, 0.4)'; });
    indicator.appendChild(btn);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      reloadLiveGraph();
    }
  });
}

init();
