import { useCallback, useEffect, useRef, useState } from 'react';
import { detectApi, createApiClient, type ApiStatus } from './api/data-source.ts';
import type { RecallResult } from './api/types.ts';
import { loadGraph, transformGraph, getEntityTypes, getEdgeTypes } from './graph/loader.ts';
import type { AppState, ForceNode, LoadResult, NacreGraphData } from './graph/types.ts';
import { NODE_COLORS } from './graph/theme.ts';
import { GraphCanvas, type GraphCanvasController } from './graph/GraphCanvas.tsx';
import { SearchPanel } from './panels/SearchPanel.tsx';
import { HealthPanel } from './panels/HealthPanel.tsx';
import { TimelinePanel } from './panels/TimelinePanel.tsx';
import { ProceduresPanel } from './panels/ProceduresPanel.tsx';
import { TemporalDiffPanel } from './panels/TemporalDiffPanel.tsx';
import { NodeDetailsPanel } from './panels/NodeDetailsPanel.tsx';
import { linkIdSet, carryOverPositions, diffToPinnedIds } from './graph/transition.ts';

const STATIC_GRAPH_URL = '/graph.json';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function coerceGraphData(value: unknown): NacreGraphData {
  if (!isRecord(value)) {
    throw new Error('Invalid graph: not an object');
  }
  const nodes = (value as Record<string, unknown>).nodes;
  const edges = (value as Record<string, unknown>).edges;
  const config = (value as Record<string, unknown>).config;
  if (!isRecord(nodes) || !isRecord(edges) || !isRecord(config)) {
    throw new Error('Invalid graph: missing nodes/edges/config');
  }
  const decayRate = (config as Record<string, unknown>).decayRate;
  const reinforcementBoost = (config as Record<string, unknown>).reinforcementBoost;
  const visibilityThreshold = (config as Record<string, unknown>).visibilityThreshold;
  if (typeof decayRate !== 'number' || typeof reinforcementBoost !== 'number' || typeof visibilityThreshold !== 'number') {
    throw new Error('Invalid graph: config missing decayRate/reinforcementBoost/visibilityThreshold');
  }
  return value as unknown as NacreGraphData;
}

function createInitialState(): AppState {
  return {
    selectedNode: null,
    hoveredNode: null,
    highlightNodes: new Set(),
    highlightLinks: new Set(),
    pinnedNodes: new Set(),
    pinnedLinks: new Set(),
    visibleTypes: new Set(),
    visibleEdgeTypes: new Set(),
    minWeight: 0,
    scrubDate: null,
  };
}

export function App() {
  const [apiStatus, setApiStatus] = useState<ApiStatus>({ status: 'offline', baseUrl: null, error: 'not checked' });
  const apiRef = useRef<ReturnType<typeof createApiClient> | null>(null);

  const [data, setData] = useState<LoadResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stateRef = useRef<AppState>(createInitialState());
  const [selectedNode, setSelectedNode] = useState<ForceNode | null>(null);

  const [entityTypes, setEntityTypes] = useState<string[]>([]);
  const [edgeTypes, setEdgeTypes] = useState<string[]>([]);
  const graphCtrlRef = useRef<GraphCanvasController | null>(null);
  const [, forceUiRefresh] = useState(0);

  const apiOnline = apiStatus.status === 'online';

  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const loadInitial = useCallback(async () => {
    setError(null);

    // Prefer API full graph if available
    if (apiRef.current) {
      try {
        const g = await apiRef.current.fullGraph();
        const transformed = transformGraph(coerceGraphData(g));
        setData(transformed);
        return;
      } catch (err) {
        // fall through
      }
    }

    try {
      const transformed = await loadGraph(STATIC_GRAPH_URL);
      setData(transformed);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setData(null);
    }
  }, []);

  useEffect(() => {
    detectApi().then((st) => {
      setApiStatus(st);
      if (st.status === 'online') {
        apiRef.current = createApiClient(st.baseUrl);
        // Retry load with API now available.
        loadInitial().catch(() => {});
      }
    });
  }, [loadInitial]);

  // Only run loadInitial once on mount
  useEffect(() => {
    loadInitial();
  }, [loadInitial]);

  useEffect(() => {
    if (!data) return;
    const types = getEntityTypes(data.nodes);
    const edges = getEdgeTypes(data.links);
    setEntityTypes(types);
    setEdgeTypes(edges);
    stateRef.current.visibleTypes = new Set(types);
    stateRef.current.visibleEdgeTypes = new Set(edges);
  }, [data]);

  const localSearch = useMemo(() => {
    return (q: string): RecallResult[] => {
      if (!data) return [];
      const query = q.toLowerCase().trim();
      if (!query) return [];
      const hits = data.nodes
        .filter((n) => n.label.toLowerCase().includes(query))
        .slice(0, 20)
        .map((n) => ({
          id: n.id,
          label: n.label,
          type: n.type,
          score: 1.0,
          scores: { semantic: 0, graph: 0, recency: 0, importance: 0 },
          excerpts: [],
          connections: [],
        }));
      return hits;
    };
  }, [data]);

  if (!data) {
    return (
      <div className="boot">
        <div className="boot-inner">
          <div className="boot-title">Nacre Dashboard</div>
          {error ? (
            <div className="boot-error">{error} (API: {apiStatus.status})</div>
          ) : (
            <div className="boot-note">Loading...</div>
          )}
        </div>
      </div>
    );
  }

  const graph = { nodes: data.nodes, links: data.links };

  return (
    <>
      <GraphCanvas
        data={data}
        state={stateRef.current}
        onNodeSelect={(n) => {
          setSelectedNode(n);
        }}
        onReady={(ctrl) => {
          graphCtrlRef.current = ctrl;
        }}
      />

      <div id="ui">
        <SearchPanel
          apiOnline={apiOnline}
          localSearch={localSearch}
          recall={async (q) => {
            if (!apiRef.current) return [];
            const res = await apiRef.current.recall({ q, limit: 10, hops: 2 });
            return res.data;
          }}
          onSelect={(result) => {
            const pinned = new Set<string>();
            pinned.add(result.id);

            // Best-effort: map connection labels → node ids, so we can highlight neighbors.
            const nodeMap = graphCtrlRef.current?.getNodeMap();
            if (nodeMap && result.connections?.length) {
              const labelToId = new Map<string, string>();
              for (const n of nodeMap.values()) {
                labelToId.set(n.label.toLowerCase(), n.id);
              }
              for (const c of result.connections.slice(0, 8)) {
                const id = labelToId.get(c.label.toLowerCase());
                if (id) pinned.add(id);
              }
            }

            const linkIds = graphCtrlRef.current
              ? linkIdSet(graphCtrlRef.current.getLinks(), pinned)
              : new Set<string>();

            stateRef.current.pinnedNodes = pinned;
            stateRef.current.pinnedLinks = linkIds;
            graphCtrlRef.current?.setPinned(pinned, linkIds);

            graphCtrlRef.current?.focusNode(result.id);
            const node = graphCtrlRef.current?.getNodeMap().get(result.id) ?? null;
            setSelectedNode(node);
          }}
        />

        <div id="controls">
          <div className="panel-header" style={{ marginBottom: 6 }}>
            <h3 style={{ marginBottom: 0, fontSize: 12 }}>Filters</h3>
            <div className="tiny">{apiOnline ? 'api' : 'static'}</div>
          </div>

          <div id="filter-types">
            {entityTypes.map((t) => {
              const active = stateRef.current.visibleTypes.has(t);
              return (
                <button
                  key={t}
                  className={`filter-btn ${active ? 'active' : ''}`}
                  onClick={() => {
                    if (stateRef.current.visibleTypes.has(t)) stateRef.current.visibleTypes.delete(t);
                    else stateRef.current.visibleTypes.add(t);
                    graphCtrlRef.current?.refresh();
                    forceUiRefresh((v) => v + 1);
                  }}
                >
                  <span className="dot" style={{ background: NODE_COLORS[t] ?? '#888' }} />
                  {t}
                </button>
              );
            })}
          </div>

          <div id="filter-edges">
            {edgeTypes.map((t) => {
              const active = stateRef.current.visibleEdgeTypes.has(t);
              return (
                <button
                  key={t}
                  className={`filter-btn ${active ? 'active' : ''}`}
                  onClick={() => {
                    if (stateRef.current.visibleEdgeTypes.has(t)) stateRef.current.visibleEdgeTypes.delete(t);
                    else stateRef.current.visibleEdgeTypes.add(t);
                    graphCtrlRef.current?.refresh();
                    forceUiRefresh((v) => v + 1);
                  }}
                >
                  {t}
                </button>
              );
            })}
          </div>

          <label id="weight-filter">
            <span>Min weight</span>
            <input
              type="range"
              id="weight-slider"
              min="0"
              max="100"
              defaultValue="0"
              onInput={(e) => {
                const v = parseInt((e.target as HTMLInputElement).value, 10) / 100;
                stateRef.current.minWeight = v;
                const el = document.getElementById('weight-value');
                if (el) el.textContent = v.toFixed(2);
                graphCtrlRef.current?.refresh();
              }}
            />
            <span id="weight-value">0.00</span>
          </label>

          <TimeScrubber
            earliest={new Date(data.dateRange.earliest)}
            latest={new Date(data.dateRange.latest)}
            onChange={(d) => {
              stateRef.current.scrubDate = d;
              graphCtrlRef.current?.refresh();
            }}
          />
        </div>

        <NodeDetailsPanel
          node={selectedNode}
          links={graphCtrlRef.current?.getLinks() ?? data.links}
          nodeMap={graphCtrlRef.current?.getNodeMap() ?? new Map()}
          onClickNeighbor={(id) => {
            graphCtrlRef.current?.focusNode(id);
            const node = graphCtrlRef.current?.getNodeMap().get(id) ?? null;
            setSelectedNode(node);
          }}
          onClose={() => {
            setSelectedNode(null);
            stateRef.current.pinnedNodes = new Set();
            stateRef.current.pinnedLinks = new Set();
            graphCtrlRef.current?.setPinned(new Set(), new Set());
          }}
        />

        <div id="legend">
          {entityTypes.map((t) => (
            <div key={t} className="legend-item">
              <span className="legend-dot" style={{ background: NODE_COLORS[t] ?? '#888' }} />
              {t}
            </div>
          ))}
        </div>

        <div className="dashboard-panels">
          <HealthPanel
            apiOnline={apiOnline}
            graph={graph}
            load={async () => {
              if (!apiRef.current) return { stats: null, alerts: null, procedures: null };
              const [stats, alerts, procedures] = await Promise.all([
                apiRef.current.graphStats().catch(() => null),
                apiRef.current.alerts().catch(() => null),
                apiRef.current.proceduresList().catch(() => null),
              ]);
              return { stats, alerts, procedures };
            }}
          />
          <TimelinePanel
            apiOnline={apiOnline}
            loadEpisodes={async () => apiRef.current ? apiRef.current.episodesList({ limit: 50 }) : []}
            onSelectEpisode={async (id) => {
              if (!apiRef.current) return;
              const detail = await apiRef.current.episodeDetail(id);
              const ids = new Set(detail.entities.map((e) => e.id));
              const linkIds = graphCtrlRef.current ? linkIdSet(graphCtrlRef.current.getLinks(), ids) : new Set<string>();
              stateRef.current.pinnedNodes = ids;
              stateRef.current.pinnedLinks = linkIds;
              graphCtrlRef.current?.setPinned(ids, linkIds);
              const first = detail.entities[0]?.id;
              if (first) graphCtrlRef.current?.focusNode(first);
            }}
          />
          <ProceduresPanel
            apiOnline={apiOnline}
            load={async (opts) => apiRef.current ? apiRef.current.proceduresList(opts) : []}
            apply={async (id, feedback) => {
              if (!apiRef.current) throw new Error('API offline');
              return apiRef.current.procedureApply(id, feedback);
            }}
          />
          <TemporalDiffPanel
            apiOnline={apiOnline}
            loadSnapshots={async () => apiRef.current ? apiRef.current.snapshotsList({ limit: 50 }) : []}
            loadSnapshotGraph={async (id) => {
              if (!apiRef.current) throw new Error('API offline');
              const sg = await apiRef.current.snapshotGraph(id);
              return sg.graph;
            }}
            diff={async (fromId, toId) => {
              if (!apiRef.current) throw new Error('API offline');
              return apiRef.current.diff(fromId, toId);
            }}
            onApply={async (fromGraph, toGraph, diff) => {
              const fromData = transformGraph(coerceGraphData(fromGraph));
              const toData = transformGraph(coerceGraphData(toGraph));
              // Carry over positions if available
              if (graphCtrlRef.current) {
                carryOverPositions(graphCtrlRef.current.getNodes(), toData.nodes);
              }
              setData(toData);
              graphCtrlRef.current?.setData(toData);

              const pinned = diffToPinnedIds(diff);
              const nodeIds = pinned.nodes;
              const edgeIds = pinned.edges.size ? pinned.edges : linkIdSet(toData.links, nodeIds);
              stateRef.current.pinnedNodes = nodeIds;
              stateRef.current.pinnedLinks = edgeIds;
              graphCtrlRef.current?.setPinned(nodeIds, edgeIds);
            }}
          />
        </div>
      </div>
    </>
  );
}
