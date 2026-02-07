export interface NacreOptions {
  path?: string;
  embedder?: 'ollama' | 'mock';

  url?: string;
  apiKey?: string;
}

export interface RememberOptions {
  type?: 'fact' | 'event' | 'observation' | 'decision';
  importance?: number;
  entities?: string[];
}

export interface RecallOptions {
  limit?: number;
  types?: string[];
  since?: string;
  until?: string;
}

export interface BriefOptions {
  focus?: string;
  top?: number;
}

export interface FeedbackOptions {
  rating: number;
  reason?: string;
}

export interface LessonOptions {
  context?: string;
  category?: 'preference' | 'skill' | 'antipattern' | 'insight';
}

export interface Memory {
  id: string;
  label: string;
  type: string;
  score?: number;
  excerpts?: string[];
  connections?: Array<{ label: string; type: string; relationship: string; weight: number }>;
  episodes?: Array<{ id: string; title: string; type: string }>;
}

export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  embeddingCount: number;
}

export interface Backend {
  remember(content: string, opts?: RememberOptions): Promise<Memory>;
  recall(query: string, opts?: RecallOptions): Promise<Memory[]>;
  brief(opts?: BriefOptions): Promise<string>;
  lesson(lesson: string, opts?: LessonOptions): Promise<Memory>;
  feedback(memoryId: string, opts: FeedbackOptions): Promise<void>;
  forget(memoryId: string): Promise<void>;
  nodes(filter?: { type?: string }): Promise<Memory[]>;
  stats(): Promise<GraphStats>;
  close(): Promise<void>;
}
