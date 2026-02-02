import ForceGraph3D from '3d-force-graph';
import * as THREE from 'three';
import type { ForceNode, ForceLink, AppState, GraphConfig } from './types.ts';
import {
  createNodeObject,
  edgeWidth,
  edgeColor,
  edgeOpacity,
  createNacreMaterial,
} from './materials.ts';
import { createTemporalForce } from './forces.ts';
import { showNodeDetails, hideDetails } from './details.ts';
import { BG_COLOR, NACRE_THRESHOLD, VISIBILITY_THRESHOLD } from './theme.ts';
import {
  computeWeightAtDate,
  isNodeVisibleAtDate,
  isEdgeVisibleAtDate,
} from './time-scrub.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Graph = any;

export function createGraphView(
  container: HTMLElement,
  nodes: ForceNode[],
  links: ForceLink[],
  state: AppState,
  config: GraphConfig,
): Graph {
  const nodeMap = new Map<string, ForceNode>();
  for (const n of nodes) nodeMap.set(n.id, n);

  const now = new Date().toISOString();

  function getEffectiveWeight(link: ForceLink): number {
    if (!state.scrubDate) return link.weight;
    return computeWeightAtDate(link, state.scrubDate, config);
  }

  const graph: Graph = new ForceGraph3D(container);

  graph
    .graphData({ nodes, links })
    .backgroundColor(BG_COLOR)
    .showNavInfo(false)
    .nodeThreeObject((node: ForceNode) => createNodeObject(node))
    .nodeThreeObjectExtend(false)
    .nodeLabel('')
    .nodeVisibility((node: ForceNode) => {
      if (!state.visibleTypes.has(node.type)) return false;
      if (state.scrubDate && !isNodeVisibleAtDate(node.firstSeen, state.scrubDate)) return false;
      return true;
    })
    .linkWidth((link: ForceLink) => edgeWidth(link, getEffectiveWeight(link)))
    .linkColor((link: ForceLink) => edgeColor(link))
    .linkOpacity(0.6)
    .linkVisibility((link: ForceLink) => {
      if (!state.visibleEdgeTypes.has(link.type)) return false;
      if (state.scrubDate && !isEdgeVisibleAtDate(link.firstFormed, state.scrubDate)) return false;
      const w = getEffectiveWeight(link);
      if (w < state.minWeight) return false;
      if (w < VISIBILITY_THRESHOLD) return false;
      return true;
    })
    .linkDirectionalArrowLength((link: ForceLink) => link.directed ? 4 : 0)
    .linkDirectionalArrowRelPos(0.85)
    .linkDirectionalArrowColor((link: ForceLink) => edgeColor(link))
    .linkDirectionalParticles((link: ForceLink) => {
      const w = getEffectiveWeight(link);
      if (w >= NACRE_THRESHOLD && link.type === 'explicit') return 2;
      return 0;
    })
    .linkDirectionalParticleWidth(1.5)
    .linkDirectionalParticleSpeed(0.004)
    .linkDirectionalParticleColor((link: ForceLink) => edgeColor(link))
    .linkThreeObjectExtend(true)
    .linkThreeObject((link: ForceLink) => {
      const w = getEffectiveWeight(link);
      if (w < NACRE_THRESHOLD) return false;

      const radius = edgeWidth(link, w) * 0.6;
      const geometry = new THREE.CylinderGeometry(radius, radius, 1, 8, 1, true);
      geometry.rotateX(Math.PI / 2); // default Y-axis → Z-axis for lookAt
      const material = createNacreMaterial(w, graph.camera());
      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData.isNacre = true;
      return mesh;
    })
    .linkPositionUpdate((obj: THREE.Object3D | undefined, coords: { start: { x: number; y: number; z: number }; end: { x: number; y: number; z: number } }) => {
      if (!obj?.userData?.isNacre) return false;

      const { start, end } = coords;
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const dz = end.z - start.z;
      const length = Math.sqrt(dx * dx + dy * dy + dz * dz);

      obj.position.set(
        (start.x + end.x) / 2,
        (start.y + end.y) / 2,
        (start.z + end.z) / 2,
      );
      obj.scale.set(1, 1, length);
      obj.lookAt(end.x, end.y, end.z);

      return true;
    });

  graph.d3Force('temporal', createTemporalForce(nodes, now));

  const chargeForce = graph.d3Force('charge');
  if (chargeForce) {
    chargeForce.strength(-80).distanceMax(300);
  }

  const linkForce = graph.d3Force('link');
  if (linkForce) {
    linkForce
      .distance((link: ForceLink) => {
        const base = 40;
        const w = getEffectiveWeight(link);
        const weightFactor = 1 - Math.min(w, 1);
        return base + weightFactor * 80;
      })
      .strength((link: ForceLink) => 0.1 + getEffectiveWeight(link) * 0.3);
  }

  graph.warmupTicks(80);
  graph.cooldownTicks(300);

  setupLighting(graph);
  setupInteraction(graph, state, links, nodeMap);
  startLabelVisibilityLoop(graph, nodes);

  return graph;
}

export function refreshGraph(graph: Graph): void {
  graph
    .nodeVisibility(graph.nodeVisibility())
    .linkVisibility(graph.linkVisibility())
    .linkWidth(graph.linkWidth())
    .linkDirectionalParticles(graph.linkDirectionalParticles());
}

function setupLighting(graph: Graph): void {
  const scene = graph.scene();
  if (!scene) return;

  const ambient = new THREE.AmbientLight(0x8888aa, 0.6);
  scene.add(ambient);

  const dir = new THREE.DirectionalLight(0xffeedd, 0.8);
  dir.position.set(100, 200, 150);
  scene.add(dir);

  const point = new THREE.PointLight(0xb4a0ff, 0.4, 500);
  point.position.set(-50, -100, 50);
  scene.add(point);
}

const LABEL_VISIBILITY_DISTANCE = 150;

function startLabelVisibilityLoop(graph: Graph, nodes: ForceNode[]): void {
  function tick() {
    const cam = graph.camera();
    if (!cam) { requestAnimationFrame(tick); return; }
    const camPos = cam.position;

    for (const node of nodes) {
      const obj = (node as unknown as { __threeObj?: THREE.Mesh }).__threeObj;
      if (!obj) continue;
      const dist = camPos.distanceTo(obj.position);
      for (const child of obj.children) {
        if (child.userData?.isLabel) {
          child.visible = dist < LABEL_VISIBILITY_DISTANCE;
        }
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function setupInteraction(
  graph: Graph,
  state: AppState,
  links: ForceLink[],
  nodeMap: Map<string, ForceNode>,
): void {
  const tooltip = createTooltip();

  graph.onNodeHover((node: ForceNode | null) => {
    document.body.style.cursor = node ? 'pointer' : 'default';
    state.hoveredNode = node;

    state.highlightNodes.clear();
    state.highlightLinks.clear();

    if (node) {
      state.highlightNodes.add(node.id);
      for (const link of links) {
        const src = typeof link.source === 'string' ? link.source : link.source.id;
        const tgt = typeof link.target === 'string' ? link.target : link.target.id;
        if (src === node.id || tgt === node.id) {
          state.highlightLinks.add(link.id);
          state.highlightNodes.add(src);
          state.highlightNodes.add(tgt);
        }
      }

      tooltip.style.display = 'block';
      tooltip.innerHTML = `
        <div class="label">${node.label}</div>
        <div class="meta">${node.type} &middot; ${node.edgeCount} connections</div>
      `;
    } else {
      tooltip.style.display = 'none';
    }

    updateHighlights(graph, state);
  });

  graph.onLinkHover((link: ForceLink | null) => {
    if (state.hoveredNode) return;

    if (link) {
      const src = typeof link.source === 'string' ? link.source : link.source.id;
      const tgt = typeof link.target === 'string' ? link.target : link.target.id;
      const srcLabel = nodeMap.get(src)?.label ?? src;
      const tgtLabel = nodeMap.get(tgt)?.label ?? tgt;

      let html = `
        <div class="label">${escapeTooltipHtml(srcLabel)} → ${escapeTooltipHtml(tgtLabel)}</div>
        <div class="meta">${link.type} &middot; weight ${link.weight.toFixed(2)}</div>
      `;

      if (link.evidence?.length) {
        const items = link.evidence.slice(0, 3).map((e) => {
          const ctx = e.context.length > 80 ? e.context.slice(0, 77) + '…' : e.context;
          return `<div class="evidence">${escapeTooltipHtml(ctx)}</div>`;
        });
        html += items.join('');
      }

      tooltip.style.display = 'block';
      tooltip.innerHTML = html;
    } else {
      tooltip.style.display = 'none';
    }
  });

  let lastClickedNode: ForceNode | null = null;
  let lastClickTime = 0;

  graph.onNodeClick((node: ForceNode) => {
    const now = Date.now();
    const isDoubleClick = lastClickedNode?.id === node.id && (now - lastClickTime) < 350;
    lastClickedNode = node;
    lastClickTime = now;

    if (isDoubleClick) {
      flyToCluster(graph, node, links, nodeMap);
      return;
    }

    state.selectedNode = node;
    flyToNode(graph, node);
    showNodeDetails(node, links, nodeMap, (neighborId) => {
      const neighbor = nodeMap.get(neighborId);
      if (neighbor) {
        state.selectedNode = neighbor;
        flyToNode(graph, neighbor);
        showNodeDetails(neighbor, links, nodeMap, () => {});
      }
    });
  });

  graph.onBackgroundClick(() => {
    state.selectedNode = null;
    state.highlightNodes.clear();
    state.highlightLinks.clear();
    hideDetails();
    updateHighlights(graph, state);
  });

  document.addEventListener('mousemove', (e) => {
    tooltip.style.left = `${e.clientX + 12}px`;
    tooltip.style.top = `${e.clientY + 12}px`;
  });
}

function createTooltip(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'tooltip';
  el.style.display = 'none';
  document.body.appendChild(el);
  return el;
}

function flyToNode(graph: Graph, node: ForceNode): void {
  const distance = 80;
  const x = node.x ?? 0;
  const y = node.y ?? 0;
  const z = node.z ?? 0;
  const dist = Math.hypot(x, y, z) || 1;
  const ratio = 1 + distance / dist;

  graph.cameraPosition(
    { x: x * ratio, y: y * ratio, z: z * ratio },
    { x, y, z },
    1200,
  );
}

function flyToCluster(
  graph: Graph,
  node: ForceNode,
  links: ForceLink[],
  nodeMap: Map<string, ForceNode>,
): void {
  const neighborIds = new Set<string>();
  neighborIds.add(node.id);

  for (const link of links) {
    const src = typeof link.source === 'string' ? link.source : link.source.id;
    const tgt = typeof link.target === 'string' ? link.target : link.target.id;
    if (src === node.id) neighborIds.add(tgt);
    if (tgt === node.id) neighborIds.add(src);
  }

  let cx = 0, cy = 0, cz = 0;
  let count = 0;
  let maxSpread = 0;

  const centerX = node.x ?? 0;
  const centerY = node.y ?? 0;
  const centerZ = node.z ?? 0;

  for (const id of neighborIds) {
    const n = nodeMap.get(id);
    if (!n) continue;
    const nx = n.x ?? 0;
    const ny = n.y ?? 0;
    const nz = n.z ?? 0;
    cx += nx; cy += ny; cz += nz;
    count++;
    const dist = Math.hypot(nx - centerX, ny - centerY, nz - centerZ);
    if (dist > maxSpread) maxSpread = dist;
  }

  if (count === 0) return;
  cx /= count; cy /= count; cz /= count;

  const viewDist = Math.max(maxSpread * 1.5, 80);
  const dist = Math.hypot(cx, cy, cz) || 1;
  const ratio = 1 + viewDist / dist;

  graph.cameraPosition(
    { x: cx * ratio, y: cy * ratio, z: cz * ratio },
    { x: cx, y: cy, z: cz },
    1500,
  );
}

function updateHighlights(graph: Graph, state: AppState): void {
  graph
    .nodeThreeObject(graph.nodeThreeObject())
    .linkWidth((link: ForceLink) => {
      if (state.highlightLinks.size > 0) {
        return state.highlightLinks.has(link.id) ? edgeWidth(link) * 2 : edgeWidth(link) * 0.3;
      }
      return edgeWidth(link);
    })
    .linkOpacity((link: ForceLink) => {
      if (state.highlightLinks.size > 0) {
        return state.highlightLinks.has(link.id) ? 0.9 : 0.08;
      }
      return edgeOpacity(link);
    });
}

function escapeTooltipHtml(text: string): string {
  const el = document.createElement('span');
  el.textContent = text;
  return el.innerHTML;
}

export function searchAndFocus(
  graph: Graph,
  nodes: ForceNode[],
  query: string,
): ForceNode | null {
  const q = query.toLowerCase().trim();
  if (!q) return null;

  const match = nodes.find(
    (n) => n.label.toLowerCase() === q || n.label.toLowerCase().includes(q),
  );

  if (match) {
    flyToNode(graph, match);
  }

  return match ?? null;
}
