import type { Procedure, ProcedureType } from './types.ts';
import type { GraphApiClient } from './api-client.ts';

type ProceduresFilter = 'all' | ProcedureType;

const FILTERS: Array<{ label: string; value: ProceduresFilter }> = [
  { label: 'All', value: 'all' },
  { label: 'Preference', value: 'preference' },
  { label: 'Skill', value: 'skill' },
  { label: 'Anti-pattern', value: 'antipattern' },
  { label: 'Insight', value: 'insight' },
  { label: 'Heuristic', value: 'heuristic' },
];

const TYPE_COLORS: Record<ProcedureType, string> = {
  preference: '#33b5a6',
  skill: '#5ca8e6',
  antipattern: '#e65c5c',
  insight: '#9b6dff',
  heuristic: '#e6a85c',
};

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function titleCaseType(t: ProcedureType): string {
  switch (t) {
    case 'antipattern':
      return 'Anti-pattern';
    case 'preference':
      return 'Preference';
    case 'skill':
      return 'Skill';
    case 'insight':
      return 'Insight';
    case 'heuristic':
      return 'Heuristic';
    default: {
      const _exhaustive: never = t;
      return String(_exhaustive);
    }
  }
}

function safeParseDate(value: string): Date | null {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatRelativeTime(d: Date): string {
  const now = Date.now();
  const diffMs = Math.max(0, now - d.getTime());
  const s = Math.floor(diffMs / 1000);
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 14) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 8) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 18) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

function formatDateShort(d: Date): string {
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  });
}

function removeAllChildren(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/**
 * ProceduresPanel - Collapsible left sidebar for procedural memory.
 */
export class ProceduresPanel {
  private readonly container: HTMLElement;
  private readonly apiClient: GraphApiClient;

  private collapsed = false;
  private activeFilter: ProceduresFilter = 'all';
  private readonly expandedIds = new Set<string>();

  private rootEl: HTMLElement | null = null;
  private contentEl: HTMLElement | null = null;
  private filtersEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private toggleBtn: HTMLButtonElement | null = null;

  private fetchAbort: AbortController | null = null;
  private fetchSeq = 0;

  constructor(container: HTMLElement, apiClient: GraphApiClient) {
    this.container = container;
    this.apiClient = apiClient;

    ProceduresPanel.ensureStyles();
    this.render();
    this.refresh().catch((e) => {
      console.error('[ProceduresPanel] Initial refresh failed:', e);
    });
  }

  /**
   * Toggle the collapsed state of the panel.
   */
  toggle(): void {
    this.collapsed = !this.collapsed;
    this.updateCollapsedState();
  }

  /**
   * Re-fetch procedures and re-render the list.
   */
  async refresh(): Promise<void> {
    const listEl = this.listEl;
    const statusEl = this.statusEl;
    if (!listEl || !statusEl) return;

    this.fetchAbort?.abort();
    const abort = new AbortController();
    this.fetchAbort = abort;
    const seq = ++this.fetchSeq;

    statusEl.textContent = 'Loading...';
    statusEl.style.display = 'block';

    try {
      const typeParam = this.activeFilter === 'all' ? undefined : this.activeFilter;
      const procedures = await this.apiClient.fetchProcedures(typeParam, abort.signal);
      if (abort.signal.aborted || seq !== this.fetchSeq) return;

      this.renderProcedures(procedures);
      statusEl.style.display = procedures.length === 0 ? 'block' : 'none';
      statusEl.textContent = procedures.length === 0 ? 'No procedures found.' : '';
    } catch (e) {
      if (abort.signal.aborted) return;
      console.error('[ProceduresPanel] Failed to fetch procedures:', e);
      statusEl.style.display = 'block';
      statusEl.textContent = 'Failed to load procedures.';
    }
  }

  private render(): void {
    removeAllChildren(this.container);

    const root = document.createElement('div');
    root.className = 'procedures-panel';
    this.rootEl = root;

    const header = document.createElement('div');
    header.className = 'procedures-header';

    const title = document.createElement('h3');
    title.textContent = 'Procedures';

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'health-dashboard-toggle procedures-toggle';
    toggleBtn.type = 'button';
    toggleBtn.title = 'Toggle panel';
    toggleBtn.textContent = '▶';
    toggleBtn.addEventListener('click', () => this.toggle());
    this.toggleBtn = toggleBtn;

    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'health-dashboard-refresh procedures-refresh';
    refreshBtn.type = 'button';
    refreshBtn.title = 'Refresh';
    refreshBtn.textContent = '⟳';
    refreshBtn.addEventListener('click', () => {
      this.refresh().catch((e) => console.error('[ProceduresPanel] Refresh failed:', e));
    });

    header.appendChild(title);
    header.appendChild(toggleBtn);
    header.appendChild(refreshBtn);

    const content = document.createElement('div');
    content.className = 'procedures-content';
    this.contentEl = content;

    const filters = document.createElement('div');
    filters.className = 'procedures-filters';
    this.filtersEl = filters;
    this.renderFilters();

    const status = document.createElement('div');
    status.className = 'procedures-status';
    status.textContent = 'Loading...';
    status.style.display = 'none';
    this.statusEl = status;

    const list = document.createElement('div');
    list.className = 'procedures-list';
    this.listEl = list;

    content.appendChild(filters);
    content.appendChild(status);
    content.appendChild(list);

    root.appendChild(header);
    root.appendChild(content);
    this.container.appendChild(root);
  }

  private renderFilters(): void {
    const filtersEl = this.filtersEl;
    if (!filtersEl) return;

    removeAllChildren(filtersEl);

    for (const f of FILTERS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'procedure-chip';
      btn.textContent = f.label;
      btn.dataset.value = f.value;
      btn.title = `Filter: ${f.label}`;
      if (f.value === this.activeFilter) {
        btn.classList.add('active');
      }

      btn.addEventListener('click', () => {
        if (this.activeFilter === f.value) return;
        this.activeFilter = f.value;
        this.expandedIds.clear();
        this.renderFilters();
        this.refresh().catch((e) => console.error('[ProceduresPanel] Filter refresh failed:', e));
      });

      filtersEl.appendChild(btn);
    }
  }

  private updateCollapsedState(): void {
    const content = this.contentEl;
    const toggleBtn = this.toggleBtn;
    const rootEl = this.rootEl;

    if (content) {
      content.style.display = this.collapsed ? 'none' : 'block';
    }
    if (toggleBtn) {
      toggleBtn.textContent = this.collapsed ? '◀' : '▶';
    }
    if (rootEl) {
      rootEl.classList.toggle('collapsed', this.collapsed);
    }
  }

  private renderProcedures(procedures: Procedure[]): void {
    const listEl = this.listEl;
    if (!listEl) return;

    removeAllChildren(listEl);

    const sorted = [...procedures].sort((a, b) => {
      if (a.flaggedForReview !== b.flaggedForReview) return a.flaggedForReview ? -1 : 1;
      if (a.type !== b.type) return a.type.localeCompare(b.type);
      return clamp01(b.confidence) - clamp01(a.confidence);
    });

    for (const p of sorted) {
      listEl.appendChild(this.createProcedureItem(p));
    }
  }

  private createProcedureItem(p: Procedure): HTMLElement {
    const item = document.createElement('div');
    item.className = 'procedure-item';
    item.tabIndex = 0;
    item.role = 'button';
    item.setAttribute('aria-expanded', 'false');
    item.dataset.id = p.id;

    const statement = document.createElement('div');
    statement.className = 'procedure-statement';
    statement.textContent = p.statement;

    const meta = document.createElement('div');
    meta.className = 'procedure-meta';

    const badge = document.createElement('span');
    badge.className = 'procedure-type-badge';
    badge.textContent = titleCaseType(p.type);
    badge.style.background = TYPE_COLORS[p.type];

    const confidenceBar = document.createElement('div');
    confidenceBar.className = 'procedure-confidence-bar';
    const confidenceFill = document.createElement('div');
    confidenceFill.className = 'procedure-confidence-fill';
    const conf = clamp01(p.confidence);
    confidenceFill.style.width = `${Math.round(conf * 100)}%`;
    confidenceBar.title = `Confidence: ${(conf * 100).toFixed(0)}%`;
    confidenceBar.appendChild(confidenceFill);

    const lastApplied = document.createElement('span');
    lastApplied.className = 'procedure-last-applied';
    if (p.lastApplied) {
      const d = safeParseDate(p.lastApplied);
      lastApplied.textContent = d ? formatRelativeTime(d) : 'Unknown';
      lastApplied.title = p.lastApplied;
    } else {
      lastApplied.textContent = 'Never';
    }

    const flagged = document.createElement('span');
    flagged.className = 'procedure-flagged';
    if (p.flaggedForReview) {
      flagged.textContent = '!';
      flagged.title = 'Flagged for review';
      flagged.setAttribute('aria-label', 'Flagged for review');
      flagged.style.display = 'inline-flex';
    } else {
      flagged.style.display = 'none';
    }

    meta.appendChild(badge);
    meta.appendChild(confidenceBar);
    meta.appendChild(lastApplied);
    meta.appendChild(flagged);

    const details = document.createElement('div');
    details.className = 'procedure-details';
    details.style.display = 'none';

    const counts = document.createElement('div');
    counts.className = 'procedure-details-row';
    counts.textContent = `Applications: ${p.applications.toLocaleString()} | Contradictions: ${p.contradictions.toLocaleString()}`;

    const stability = document.createElement('div');
    stability.className = 'procedure-details-row';
    stability.textContent = `Stability: ${Number.isFinite(p.stability) ? p.stability.toFixed(2) : '-'}`;

    const created = document.createElement('div');
    created.className = 'procedure-details-row';
    const createdDate = safeParseDate(p.createdAt);
    created.textContent = createdDate ? `Created: ${formatDateShort(createdDate)}` : 'Created: -';
    created.title = p.createdAt;

    const keywordsWrap = document.createElement('div');
    keywordsWrap.className = 'procedure-details-row';
    const keywordsLabel = document.createElement('span');
    keywordsLabel.className = 'procedure-details-label';
    keywordsLabel.textContent = 'Triggers:';
    keywordsWrap.appendChild(keywordsLabel);

    const keywords = document.createElement('div');
    keywords.className = 'procedure-keywords';
    if (p.triggerKeywords.length === 0) {
      const none = document.createElement('span');
      none.className = 'procedure-keyword-empty';
      none.textContent = 'None';
      keywords.appendChild(none);
    } else {
      for (const kw of p.triggerKeywords.slice(0, 24)) {
        const chip = document.createElement('span');
        chip.className = 'procedure-keyword';
        chip.textContent = kw;
        keywords.appendChild(chip);
      }
      if (p.triggerKeywords.length > 24) {
        const more = document.createElement('span');
        more.className = 'procedure-keyword';
        more.textContent = `+${p.triggerKeywords.length - 24}`;
        keywords.appendChild(more);
      }
    }
    keywordsWrap.appendChild(keywords);

    details.appendChild(counts);
    details.appendChild(keywordsWrap);
    details.appendChild(stability);
    details.appendChild(created);

    item.appendChild(statement);
    item.appendChild(meta);
    item.appendChild(details);

    const applyExpandedState = (expanded: boolean): void => {
      item.classList.toggle('expanded', expanded);
      item.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      details.style.display = expanded ? 'block' : 'none';
    };

    const toggleExpanded = (): void => {
      const isExpanded = this.expandedIds.has(p.id);
      if (isExpanded) this.expandedIds.delete(p.id);
      else this.expandedIds.add(p.id);
      applyExpandedState(!isExpanded);
    };

    item.addEventListener('click', (ev) => {
      // Avoid toggling when selecting text.
      const sel = window.getSelection();
      if (sel && sel.type === 'Range') return;
      ev.preventDefault();
      toggleExpanded();
    });

    item.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        toggleExpanded();
      }
    });

    applyExpandedState(this.expandedIds.has(p.id));
    return item;
  }

  private static ensureStyles(): void {
    const id = 'nacre-procedures-panel-styles';
    if (document.getElementById(id)) return;

    const style = document.createElement('style');
    style.id = id;
    style.textContent = `
.procedures-panel {
  background: rgba(10, 10, 26, 0.9);
  border: 1px solid rgba(120, 120, 180, 0.2);
  border-radius: 8px;
  overflow: hidden;
  backdrop-filter: blur(8px);
  color: #d4d4d8;
}

.procedures-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  background: rgba(20, 20, 40, 0.6);
  border-bottom: 1px solid rgba(120, 120, 180, 0.15);
}

.procedures-header h3 {
  font-size: 13px;
  font-weight: 600;
  color: #e4e4e8;
  flex: 1;
  margin: 0;
}

.procedures-content {
  padding: 12px;
  max-height: calc(100vh - 200px);
  overflow-y: auto;
}

.procedures-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}

.procedure-chip {
  background: rgba(60, 60, 100, 0.25);
  border: 1px solid rgba(120, 120, 180, 0.18);
  border-radius: 999px;
  padding: 4px 9px;
  color: rgba(180, 180, 220, 0.85);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s ease;
  line-height: 1;
}

.procedure-chip:hover {
  background: rgba(120, 100, 200, 0.22);
  border-color: rgba(120, 120, 180, 0.28);
}

.procedure-chip.active {
  color: #d4d4d8;
  background: rgba(120, 100, 200, 0.28);
  border-color: rgba(180, 160, 255, 0.45);
}

.procedures-status {
  color: rgba(180, 180, 220, 0.7);
  font-size: 12px;
  padding: 8px 2px 10px;
}

.procedures-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.procedure-item {
  border: 1px solid rgba(120, 120, 180, 0.12);
  border-radius: 8px;
  padding: 10px 10px 9px;
  background: rgba(12, 12, 30, 0.55);
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
  outline: none;
}

.procedure-item:hover {
  border-color: rgba(180, 160, 255, 0.35);
  background: rgba(14, 14, 34, 0.7);
}

.procedure-item:focus {
  border-color: rgba(180, 160, 255, 0.55);
  box-shadow: 0 0 0 2px rgba(180, 160, 255, 0.15);
}

.procedure-item.expanded {
  border-color: rgba(180, 160, 255, 0.45);
}

.procedure-statement {
  font-size: 12px;
  line-height: 1.35;
  color: #d4d4d8;
  margin-bottom: 8px;
  white-space: pre-wrap;
}

.procedure-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: rgba(180, 180, 220, 0.7);
}

.procedure-type-badge {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 8px;
  border-radius: 999px;
  color: rgba(10, 10, 26, 0.95);
  font-weight: 700;
  font-size: 10px;
  letter-spacing: 0.2px;
}

.procedure-confidence-bar {
  flex: 1;
  height: 7px;
  background: rgba(60, 60, 100, 0.3);
  border-radius: 999px;
  overflow: hidden;
  border: 1px solid rgba(120, 120, 180, 0.12);
}

.procedure-confidence-fill {
  height: 100%;
  background: linear-gradient(90deg, rgba(180, 160, 255, 0.55) 0%, rgba(180, 160, 255, 0.95) 100%);
  border-radius: 999px;
  transition: width 0.25s ease;
}

.procedure-last-applied {
  font-variant-numeric: tabular-nums;
  color: rgba(180, 180, 220, 0.7);
}

.procedure-flagged {
  width: 16px;
  height: 16px;
  border-radius: 999px;
  border: 1px solid rgba(230, 92, 92, 0.55);
  color: #e65c5c;
  font-weight: 800;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}

.procedure-details {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid rgba(120, 120, 180, 0.12);
  color: rgba(180, 180, 220, 0.7);
  font-size: 11px;
}

.procedure-details-row {
  margin-top: 6px;
}

.procedure-details-row:first-child {
  margin-top: 0;
}

.procedure-details-label {
  margin-right: 8px;
  color: rgba(180, 180, 220, 0.75);
}

.procedure-keywords {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 6px;
  vertical-align: middle;
}

.procedure-keyword {
  display: inline-flex;
  align-items: center;
  padding: 2px 7px;
  border-radius: 999px;
  border: 1px solid rgba(120, 120, 180, 0.18);
  background: rgba(60, 60, 100, 0.2);
  color: rgba(180, 180, 220, 0.85);
  font-size: 10px;
  line-height: 1.2;
}

.procedure-keyword-empty {
  color: rgba(180, 180, 220, 0.55);
}
`;

    document.head.appendChild(style);
  }
}
