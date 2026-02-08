import type { RecallResult, RecallProcedureMatch } from './types.ts';
import type { GraphApiClient } from './api-client.ts';

type HybridSearchCallbacks = {
  onNodeSelect: (id: string) => void;
  onHighlight: (nodeIds: string[]) => void;
  onClear: () => void;
};

type RecallResponse = {
  results: RecallResult[];
  procedures: RecallProcedureMatch[];
};

const TYPE_COLORS: Record<string, string> = {
  person: '#e6a333',
  project: '#33b5a6',
  tool: '#a8a8b8',
  concept: '#9b6dff',
  decision: '#e65c5c',
  event: '#5ca8e6',
  lesson: '#e6a85c',
};

const THEME = {
  panelBg: 'rgba(10, 10, 26, 0.92)',
  border: 'rgba(120, 120, 180, 0.25)',
  text: '#d4d4d8',
  muted: 'rgba(180, 180, 220, 0.7)',
  accent: '#8b5cf6',
  highlight: '#f59e0b',
  typeColors: TYPE_COLORS,
} as const;

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function escapeHtml(text: string): string {
  // Proper escaping: assign to textContent then read innerHTML.
  const el = document.createElement('div');
  el.textContent = text;
  return el.innerHTML;
}

function setSafeHtml(el: HTMLElement, text: string): void {
  el.innerHTML = escapeHtml(text);
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncate(text: string, maxChars: number): string {
  const t = normalizeText(text);
  if (t.length <= maxChars) return t;
  if (maxChars <= 3) return t.slice(0, maxChars);
  return `${t.slice(0, maxChars - 3)}...`;
}

function typeColor(type: string): string {
  return THEME.typeColors[type] ?? THEME.typeColors.concept;
}

export class HybridSearch {
  private readonly container: HTMLElement;
  private readonly apiClient: GraphApiClient;
  private readonly callbacks: HybridSearchCallbacks;

  private readonly panel: HTMLDivElement;
  private debounceTimer: number | undefined;
  private abortController: AbortController | null = null;
  private latestQuery: string = '';

  constructor(container: HTMLElement, apiClient: GraphApiClient, callbacks: HybridSearchCallbacks) {
    this.container = container;
    this.apiClient = apiClient;
    this.callbacks = callbacks;

    this.panel = this.ensurePanel();
    this.hidePanel();
  }

  search(query: string): void {
    const q = query.trim();
    this.latestQuery = q;

    if (this.debounceTimer !== undefined) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }

    // Any new keystroke cancels the previous in-flight request.
    this.abortInFlight();

    if (q.length === 0) {
      this.clear();
      return;
    }

    this.debounceTimer = window.setTimeout(() => {
      void this.performSearch(q);
    }, 300);
  }

  clear(): void {
    if (this.debounceTimer !== undefined) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.abortInFlight();
    this.hidePanel();
    this.callbacks.onClear();
  }

  private abortInFlight(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  private async performSearch(query: string): Promise<void> {
    if (query !== this.latestQuery) return;

    this.abortInFlight();
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    this.renderStatus(`Searching for "${query}"...`);
    this.showPanel();

    let data: RecallResponse;
    try {
      data = await this.apiClient.fetchRecall(query, 10, signal);
    } catch (err) {
      if (signal.aborted) return;
      this.callbacks.onHighlight([]);
      this.renderStatus('Search failed.');
      this.showPanel();
      return;
    }

    if (signal.aborted) return;
    if (query !== this.latestQuery) return;

    const ids = data.results.map((r) => r.id);
    this.callbacks.onHighlight(ids);
    this.renderResults(data.results, data.procedures);
    this.showPanel();
  }

  private ensurePanel(): HTMLDivElement {
    const container = this.container;
    const existing = container.querySelector<HTMLDivElement>('#recall-results');
    if (existing) {
      if (!existing.classList.contains('recall-results')) existing.classList.add('recall-results');
      return existing;
    }

    const computed = window.getComputedStyle(container);
    if (computed.position === 'static') {
      container.style.position = 'relative';
    }

    const panel = document.createElement('div');
    panel.id = 'recall-results';
    panel.className = 'recall-results';
    panel.setAttribute('role', 'listbox');
    panel.setAttribute('aria-label', 'Recall search results');

    // Minimal inline styles to guarantee placement/scrolling; detailed styling lives in CSS.
    panel.style.position = 'absolute';
    panel.style.top = 'calc(100% + 8px)';
    panel.style.left = '50%';
    panel.style.transform = 'translateX(-50%)';
    panel.style.width = 'min(720px, calc(100vw - 32px))';
    panel.style.maxHeight = '400px';
    panel.style.overflowY = 'auto';
    panel.style.zIndex = '60';
    panel.style.background = THEME.panelBg;
    panel.style.border = `1px solid ${THEME.border}`;
    panel.style.borderRadius = '12px';
    panel.style.boxShadow = '0 20px 45px rgba(0,0,0,0.45)';
    panel.style.backdropFilter = 'blur(10px)';
    panel.style.padding = '10px';
    panel.style.color = THEME.text;

    container.appendChild(panel);
    return panel;
  }

  private showPanel(): void {
    this.panel.style.display = 'block';
  }

  private hidePanel(): void {
    this.panel.style.display = 'none';
    this.panel.replaceChildren();
  }

  private renderStatus(message: string): void {
    this.panel.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'recall-empty';
    empty.style.padding = '12px 10px';
    empty.style.color = THEME.muted;
    setSafeHtml(empty, message);
    this.panel.appendChild(empty);
  }

  private renderResults(results: RecallResult[], procedures: RecallProcedureMatch[]): void {
    this.panel.replaceChildren();

    if (results.length === 0 && procedures.length === 0) {
      this.renderStatus('No matches.');
      return;
    }

    for (const result of results) {
      this.panel.appendChild(this.renderResultItem(result));
    }

    if (procedures.length > 0) {
      this.panel.appendChild(this.renderProcedures(procedures));
    }
  }

  private renderResultItem(result: RecallResult): HTMLElement {
    const item = document.createElement('div');
    item.className = 'recall-result-item';
    item.setAttribute('role', 'option');
    item.tabIndex = 0;
    item.style.padding = '10px 10px';
    item.style.borderRadius = '10px';
    item.style.cursor = 'pointer';
    item.style.userSelect = 'none';
    item.style.outline = 'none';

    item.addEventListener('mouseenter', () => {
      item.style.background = 'rgba(255,255,255,0.04)';
      item.style.borderColor = THEME.border;
    });
    item.addEventListener('mouseleave', () => {
      item.style.background = 'transparent';
    });

    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.alignItems = 'center';
    header.style.gap = '8px';
    header.style.justifyContent = 'space-between';

    const left = document.createElement('div');
    left.style.display = 'flex';
    left.style.alignItems = 'baseline';
    left.style.gap = '8px';
    left.style.minWidth = '0';
    left.style.flex = '1';

    const label = document.createElement('div');
    label.style.fontWeight = '700';
    label.style.letterSpacing = '0.2px';
    label.style.whiteSpace = 'nowrap';
    label.style.overflow = 'hidden';
    label.style.textOverflow = 'ellipsis';
    setSafeHtml(label, result.label);

    const badge = document.createElement('span');
    badge.style.flex = '0 0 auto';
    badge.style.padding = '2px 8px';
    badge.style.borderRadius = '999px';
    badge.style.fontSize = '12px';
    badge.style.lineHeight = '18px';
    badge.style.color = '#0b0b14';
    badge.style.background = typeColor(result.type);
    badge.style.textTransform = 'uppercase';
    badge.style.letterSpacing = '0.08em';
    setSafeHtml(badge, result.type);

    left.appendChild(label);
    left.appendChild(badge);

    const right = document.createElement('div');
    right.style.flex = '0 0 auto';
    right.style.display = 'flex';
    right.style.alignItems = 'center';
    right.style.gap = '8px';

    const pct = document.createElement('div');
    pct.style.fontSize = '12px';
    pct.style.color = THEME.muted;
    const score = clamp01(result.score);
    setSafeHtml(pct, `${Math.round(score * 100)}%`);

    right.appendChild(pct);

    header.appendChild(left);
    header.appendChild(right);

    const bar = document.createElement('div');
    bar.className = 'recall-score-bar';
    bar.style.height = '4px';
    bar.style.borderRadius = '999px';
    bar.style.background = 'rgba(255,255,255,0.08)';
    bar.style.marginTop = '6px';
    bar.style.overflow = 'hidden';

    const fill = document.createElement('div');
    fill.style.height = '100%';
    fill.style.width = `${score * 100}%`;
    fill.style.background = THEME.accent;
    fill.style.borderRadius = '999px';
    bar.appendChild(fill);

    const excerptText = result.excerpts?.[0] ?? '';
    const excerpt = document.createElement('div');
    excerpt.style.marginTop = '8px';
    excerpt.style.fontStyle = 'italic';
    excerpt.style.color = THEME.muted;
    excerpt.style.fontSize = '13px';
    excerpt.style.lineHeight = '1.35';
    setSafeHtml(excerpt, truncate(excerptText, 80));

    item.appendChild(header);
    item.appendChild(bar);
    if (normalizeText(excerptText).length > 0) item.appendChild(excerpt);

    const select = (): void => {
      this.callbacks.onNodeSelect(result.id);
    };

    item.addEventListener('click', (e) => {
      e.preventDefault();
      select();
    });
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        select();
      }
    });

    return item;
  }

  private renderProcedures(procedures: RecallProcedureMatch[]): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'recall-procedures';
    wrapper.style.marginTop = '10px';
    wrapper.style.paddingTop = '10px';
    wrapper.style.borderTop = `1px solid ${THEME.border}`;

    const title = document.createElement('div');
    title.style.fontSize = '12px';
    title.style.textTransform = 'uppercase';
    title.style.letterSpacing = '0.12em';
    title.style.color = THEME.muted;
    setSafeHtml(title, 'Matched Procedures');
    wrapper.appendChild(title);

    for (const proc of procedures) {
      const item = document.createElement('div');
      item.className = 'recall-procedure-item';
      item.style.marginTop = '8px';
      item.style.padding = '8px 10px';
      item.style.borderRadius = '10px';
      item.style.background = 'rgba(255,255,255,0.03)';
      item.style.border = `1px solid ${THEME.border}`;

      const statement = document.createElement('div');
      statement.style.color = THEME.text;
      statement.style.fontSize = '13px';
      statement.style.lineHeight = '1.35';
      setSafeHtml(statement, truncate(proc.statement, 140));

      const meta = document.createElement('div');
      meta.style.marginTop = '6px';
      meta.style.display = 'flex';
      meta.style.alignItems = 'center';
      meta.style.gap = '10px';

      const type = document.createElement('span');
      type.style.fontSize = '12px';
      type.style.color = THEME.highlight;
      type.style.textTransform = 'uppercase';
      type.style.letterSpacing = '0.08em';
      setSafeHtml(type, proc.type);

      const confidence = document.createElement('span');
      confidence.style.fontSize = '12px';
      confidence.style.color = THEME.muted;
      setSafeHtml(confidence, `confidence ${Math.round(clamp01(proc.confidence) * 100)}%`);

      meta.appendChild(type);
      meta.appendChild(confidence);

      item.appendChild(statement);
      item.appendChild(meta);
      wrapper.appendChild(item);
    }

    return wrapper;
  }
}
