export const NODE_COLORS: Record<string, string> = {
  person: '#e6a333',
  project: '#33b5a6',
  tool: '#a8a8b8',
  concept: '#9b6dff',
  decision: '#e65c5c',
  event: '#5ca8e6',
  lesson: '#e6a85c',
  place: '#5ce68a',
  tag: '#8888a0',
};

export const EDGE_STYLES: Record<string, { dash: number[]; arrow: boolean }> = {
  explicit: { dash: [], arrow: false },
  'co-occurrence': { dash: [4, 2], arrow: false },
  temporal: { dash: [1, 3], arrow: false },
  causal: { dash: [], arrow: true },
};

export const BG_COLOR = '#060612';

export const NODE_BASE_SIZE = 3;
export const NODE_MAX_SIZE = 18;

export const EDGE_BASE_WIDTH = 0.3;
export const EDGE_MAX_WIDTH = 2.5;

export const NACRE_THRESHOLD = 0.5;

export const NACRE_COLORS = {
  pink: [1.0, 0.75, 0.8] as const,
  gold: [1.0, 0.84, 0.0] as const,
  green: [0.0, 1.0, 0.5] as const,
  blue: [0.0, 0.5, 1.0] as const,
  violet: [0.8, 0.2, 1.0] as const,
};

export const VISIBILITY_THRESHOLD = 0.05;

export const Z_SCALE = 2;

export function nodeColor(type: string): string {
  return NODE_COLORS[type] ?? NODE_COLORS.tag;
}
