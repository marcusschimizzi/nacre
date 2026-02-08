import { useEffect, useMemo, useRef } from 'react';
import type { AppState, ForceLink, ForceNode, GraphConfig, LoadResult } from './types.ts';
import { createGraphView, type GraphViewController } from './graph-view.ts';
import { getEdgeTypes, getEntityTypes } from './loader.ts';

export type GraphCanvasController = {
  focusNode: (id: string) => void;
  setPinned: (nodeIds: Set<string>, linkIds?: Set<string>) => void;
  setData: (data: LoadResult) => void;
  refresh: () => void;
  getNodeMap: () => Map<string, ForceNode>;
  getLinks: () => ForceLink[];
  getNodes: () => ForceNode[];
  getConfig: () => GraphConfig;
  getDateRange: () => { earliest: string; latest: string };
  getEntityTypes: () => string[];
  getEdgeTypes: () => string[];
};

export function GraphCanvas(props: {
  data: LoadResult;
  state: AppState;
  onNodeSelect: (node: ForceNode | null) => void;
  onReady: (ctrl: GraphCanvasController) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<GraphViewController | null>(null);
  const dataRef = useRef<LoadResult>(props.data);

  useEffect(() => {
    dataRef.current = props.data;
  }, [props.data]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (controllerRef.current) return;

    const ctrl = createGraphView(
      el,
      props.data.nodes,
      props.data.links,
      props.state,
      props.data.config,
      {
        onNodeClick: (node) => props.onNodeSelect(node),
        onBackgroundClick: () => props.onNodeSelect(null),
      },
    );
    controllerRef.current = ctrl;

    props.onReady({
      focusNode: (id) => {
        ctrl.focusNode(id);
      },
      setPinned: (nodeIds, linkIds) => {
        ctrl.setPinned(nodeIds, linkIds);
      },
      setData: (data) => {
        dataRef.current = data;
        ctrl.setData(data);
      },
      refresh: () => ctrl.refresh(),
      getNodeMap: () => ctrl.nodeMap,
      getLinks: () => ctrl.links,
      getNodes: () => ctrl.nodes,
      getConfig: () => dataRef.current.config,
      getDateRange: () => dataRef.current.dateRange,
      getEntityTypes: () => getEntityTypes(ctrl.nodes),
      getEdgeTypes: () => getEdgeTypes(ctrl.links),
    });
  }, [props]);

  // External refresh when filters change.
  useEffect(() => {
    controllerRef.current?.refresh();
  }, [props.state.minWeight, props.state.scrubDate, props.state.visibleEdgeTypes, props.state.visibleTypes]);

  return <div id="graph" ref={containerRef} />;
}
