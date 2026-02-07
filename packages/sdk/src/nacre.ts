import { LocalBackend } from './local.js';
import { RemoteBackend } from './remote.js';
import type {
  Backend,
  NacreOptions,
  Memory,
  RememberOptions,
  RecallOptions,
  BriefOptions,
  FeedbackOptions,
  LessonOptions,
  GraphStats,
} from './types.js';

export class Nacre {
  private backend: Backend;

  constructor(opts: NacreOptions) {
    if (opts.path) {
      this.backend = new LocalBackend(opts);
    } else if (opts.url) {
      this.backend = new RemoteBackend(opts);
    } else {
      throw new Error('Nacre requires either path (local) or url (remote)');
    }
  }

  remember(content: string, opts?: RememberOptions): Promise<Memory> {
    return this.backend.remember(content, opts);
  }

  recall(query: string, opts?: RecallOptions): Promise<Memory[]> {
    return this.backend.recall(query, opts);
  }

  brief(opts?: BriefOptions): Promise<string> {
    return this.backend.brief(opts);
  }

  lesson(lesson: string, opts?: LessonOptions): Promise<Memory> {
    return this.backend.lesson(lesson, opts);
  }

  feedback(memoryId: string, opts: FeedbackOptions): Promise<void> {
    return this.backend.feedback(memoryId, opts);
  }

  forget(memoryId: string): Promise<void> {
    return this.backend.forget(memoryId);
  }

  nodes(filter?: { type?: string }): Promise<Memory[]> {
    return this.backend.nodes(filter);
  }

  stats(): Promise<GraphStats> {
    return this.backend.stats();
  }

  close(): Promise<void> {
    return this.backend.close();
  }
}
