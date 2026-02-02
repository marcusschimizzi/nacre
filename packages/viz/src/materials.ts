import * as THREE from 'three';
import type { ForceNode, ForceLink } from './types.ts';
import {
  nodeColor,
  NODE_BASE_SIZE,
  NODE_MAX_SIZE,
  EDGE_BASE_WIDTH,
  EDGE_MAX_WIDTH,
  NACRE_THRESHOLD,
} from './theme.ts';

export function nodeSize(node: ForceNode): number {
  const connectivity = Math.log2(node.edgeCount + 1);
  const mentions = Math.log2(node.mentionCount + 1);
  const raw = NODE_BASE_SIZE + (connectivity * 1.5 + mentions * 0.8);
  return Math.min(raw, NODE_MAX_SIZE);
}

export function nodeOpacity(node: ForceNode): number {
  const base = 0.3;
  const strength = Math.min(node.maxEdgeWeight, 1);
  return base + strength * 0.7;
}

export function isRecent(node: ForceNode, days: number = 7): boolean {
  const now = Date.now();
  const last = new Date(node.lastReinforced).getTime();
  return (now - last) / 86_400_000 <= days;
}

export function createLabelSprite(text: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const fontSize = 48;
  ctx.font = `${fontSize}px sans-serif`;
  const metrics = ctx.measureText(text);
  const textWidth = metrics.width;

  canvas.width = Math.ceil(textWidth) + 16;
  canvas.height = fontSize + 16;

  ctx.font = `${fontSize}px sans-serif`;
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 8, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  const spriteMat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(spriteMat);

  const aspect = canvas.width / canvas.height;
  sprite.scale.set(aspect * 4, 4, 1);
  sprite.visible = false;
  sprite.userData.isLabel = true;

  return sprite;
}

export function createNodeObject(node: ForceNode): THREE.Mesh {
  const size = nodeSize(node);
  const color = nodeColor(node.type);
  const opacity = nodeOpacity(node);

  const geometry = new THREE.SphereGeometry(size, 16, 12);
  const material = new THREE.MeshLambertMaterial({
    color,
    transparent: true,
    opacity,
  });

  const mesh = new THREE.Mesh(geometry, material);

  if (isRecent(node)) {
    const glowGeometry = new THREE.SphereGeometry(size * 1.6, 12, 8);
    const glowMaterial = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.08,
      side: THREE.BackSide,
    });
    const glow = new THREE.Mesh(glowGeometry, glowMaterial);
    mesh.add(glow);
  }

  const label = createLabelSprite(node.label);
  label.position.y = size + 3;
  mesh.add(label);

  return mesh;
}

export function edgeWidth(link: ForceLink, weightOverride?: number): number {
  const weight = weightOverride ?? link.weight;
  const w = link.baseWeight > 0 ? weight / link.baseWeight : 0;
  return EDGE_BASE_WIDTH + (EDGE_MAX_WIDTH - EDGE_BASE_WIDTH) * Math.min(w, 1);
}

export function edgeColor(link: ForceLink): string {
  if (link.weight >= NACRE_THRESHOLD) {
    const t = (link.weight - NACRE_THRESHOLD) / (1 - NACRE_THRESHOLD);
    const r = Math.round(180 + t * 75);
    const g = Math.round(160 + t * 60);
    const b = Math.round(200 + t * 55);
    return `rgb(${r},${g},${b})`;
  }

  const t = link.weight / NACRE_THRESHOLD;
  const v = Math.round(60 + t * 60);
  return `rgb(${v},${v},${v + 10})`;
}

export function edgeOpacity(link: ForceLink): number {
  return 0.15 + link.weight * 0.6;
}

const NACRE_VERTEX = `
  varying vec3 vWorldPos;
  void main() {
    vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const NACRE_FRAGMENT = `
  uniform vec3 uCameraPos;
  uniform float uWeight;
  varying vec3 vWorldPos;

  vec3 spectral(float t) {
    vec3 pink   = vec3(1.0, 0.75, 0.8);
    vec3 gold   = vec3(1.0, 0.84, 0.0);
    vec3 green  = vec3(0.0, 1.0, 0.5);
    vec3 blue   = vec3(0.0, 0.5, 1.0);
    vec3 violet = vec3(0.8, 0.2, 1.0);

    float s = t * 4.0;
    float i = floor(s);
    float f = fract(s);

    if (i < 1.0) return mix(pink, gold, f);
    if (i < 2.0) return mix(gold, green, f);
    if (i < 3.0) return mix(green, blue, f);
    return mix(blue, violet, f);
  }

  void main() {
    vec3 viewDir = normalize(uCameraPos - vWorldPos);
    float angle = abs(dot(normalize(vWorldPos), viewDir));
    float fresnel = pow(1.0 - angle, 2.5);

    float iriStrength = smoothstep(0.5, 0.8, uWeight) * fresnel;
    vec3 iriColor = spectral(fract(fresnel * 2.0 + uWeight * 0.3));

    float gray = mix(0.3, 0.55, uWeight);
    vec3 baseColor = vec3(gray, gray, gray + 0.05);

    vec3 color = mix(baseColor, iriColor, iriStrength);
    float alpha = 0.2 + uWeight * 0.6;

    gl_FragColor = vec4(color, alpha);
  }
`;

export function createNacreMaterial(weight: number, camera: THREE.Camera): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uCameraPos: { value: camera.position },
      uWeight: { value: weight },
    },
    vertexShader: NACRE_VERTEX,
    fragmentShader: NACRE_FRAGMENT,
    transparent: true,
    depthWrite: false,
  });
}
