import type { Episode, EpisodeType } from './types.ts';
import type { GraphApiClient } from './api-client.ts';

type EpisodeWithLayout = {
  episode: Episode;
  startMs: number;
  endMs: number;
  startPct: number;
  endPct: number;
  xStart: number;
  xEnd: number;
  stackIndex: number;
};

const TYPE_COLORS: Record<EpisodeType, string> = {
  conversation: '#5ca8e6',
  event: '#e6a85c',
  decision: '#e65c5c',
  observation: '#9b6dff',
};

const THEME = {
  panelBg: 'rgba(10, 10, 26, 0.9)',
  headerBg: 'rgba(20, 20, 40, 0.6)',
  border: 'rgba(120, 120, 180, 0.2)',
  text: '#d4d4d8',
  muted: 'rgba(180, 180, 220, 0.7)',
  accent: '#b4a0ff',
};

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function safeDate(iso: string): Date | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatTimestamp(iso: string): string {
  const d = safeDate(iso);
  if (!d) return iso;

  const datePart = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(d);

  const timePart = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d);

  return `${datePart} ${timePart}`;
}

function summarizeEpisode(ep: Episode): string {
  const raw = (ep.summary && ep.summary.trim().length > 0) ? ep.summary : ep.content;
  const trimmed = raw.trim();
  if (trimmed.length <= 100) return trimmed;
  return trimmed.slice(0, 100) + '…';
}

function buildTypeBadge(type: EpisodeType): HTMLElement {
  const badge = document.createElement('span');
  badge.textContent = type;
  badge.style.display = 'inline-flex';
  badge.style.alignItems = 'center';
  badge.style.gap = '6px';
  badge.style.padding = '2px 8px';
  badge.style.borderRadius = '999px';
  badge.style.fontSize = '12px';
  badge.style.lineHeight = '16px';
  badge.style.border = `1px solid ${THEME.border}`;
  badge.style.background = 'rgba(0,0,0,0.18)';
  badge.style.color = THEME.text;

  const dot = document.createElement('span');
  dot.style.width = '8px';
  dot.style.height = '8px';
  dot.style.borderRadius = '999px';
  dot.style.background = TYPE_COLORS[type];
  dot.style.boxShadow = `0 0 0 2px rgba(0,0,0,0.25)`;
  badge.prepend(dot);

  return badge;
}

function removeAllChildren(el: HTMLElement): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function injectEpisodesTimelineStyles(): void {
  const styleId = 'nacre-episodes-timeline-styles';
  if (document.getElementById(styleId)) return;

  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    .episodes-timeline {
      color: ${THEME.text};
      background: ${THEME.panelBg};
      border-top: 1px solid ${THEME.border};
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Arial, sans-serif;
      box-sizing: border-box;
    }
    .episodes-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      background: ${THEME.headerBg};
      border-bottom: 1px solid ${THEME.border};
      user-select: none;
    }
    .episodes-header h3 {
      margin: 0;
      font-size: 14px;
      font-weight: 650;
      letter-spacing: 0.01em;
      flex: 1;
    }
    .episodes-content {
      padding: 10px 12px 12px;
      box-sizing: border-box;
    }
    .episodes-track {
      position: relative;
      overflow-x: auto;
      overflow-y: hidden;
      border: 1px solid ${THEME.border};
      border-radius: 12px;
      background: rgba(0,0,0,0.12);
      scrollbar-color: rgba(180, 180, 220, 0.35) transparent;
    }
    .episodes-track-inner {
      position: relative;
      min-width: 100%;
    }
    .episodes-axis {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 32px;
      border-top: 1px solid ${THEME.border};
      background: rgba(0,0,0,0.10);
    }
    .episode-dot {
      position: absolute;
      width: 10px;
      height: 10px;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.08);
      box-shadow: 0 0 0 2px rgba(0,0,0,0.25);
      cursor: pointer;
    }
    .episode-hover-card {
      position: absolute;
      z-index: 50;
      max-width: 320px;
      padding: 10px 10px;
      border-radius: 12px;
      background: rgba(12, 12, 26, 0.96);
      border: 1px solid ${THEME.border};
      box-shadow: 0 10px 30px rgba(0,0,0,0.45);
      pointer-events: none;
    }
    .episode-detail {
      border: 1px solid ${THEME.border};
      border-radius: 12px;
      background: rgba(0,0,0,0.12);
      padding: 12px;
    }
    .episode-topic {
      display: inline-flex;
      align-items: center;
      padding: 4px 8px;
      border-radius: 999px;
      border: 1px solid ${THEME.border};
      background: rgba(0,0,0,0.18);
      font-size: 12px;
      color: ${THEME.text};
    }
    .episode-close-btn {
      border: 1px solid ${THEME.border};
      background: rgba(0,0,0,0.16);
      color: ${THEME.text};
      border-radius: 10px;
      padding: 6px 10px;
      cursor: pointer;
    }
    .episode-close-btn:hover {
      border-color: rgba(180, 180, 220, 0.35);
    }
    .episodes-btn {
      border: 1px solid ${THEME.border};
      background: rgba(0,0,0,0.16);
      color: ${THEME.text};
      border-radius: 10px;
      width: 34px;
      height: 30px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
    }
    .episodes-btn:hover {
      border-color: rgba(180, 180, 220, 0.35);
      color: ${THEME.accent};
    }
    .episodes-muted {
      color: ${THEME.muted};
    }
  `;

  document.head.appendChild(style);
}

export class EpisodesTimeline {
  private readonly container: HTMLElement;
  private readonly apiClient: GraphApiClient;

  private collapsed: boolean = false;
  private episodes: Episode[] = [];
  private selectedEpisodeId: string | null = null;

  private rootEl: HTMLDivElement | null = null;
  private headerToggleBtn: HTMLButtonElement | null = null;
  private headerRefreshBtn: HTMLButtonElement | null = null;
  private contentEl: HTMLDivElement | null = null;
  private trackEl: HTMLDivElement | null = null;
  private trackInnerEl: HTMLDivElement | null = null;
  private axisEl: HTMLDivElement | null = null;
  private markersLayerEl: HTMLDivElement | null = null;
  private detailEl: HTMLDivElement | null = null;
  private tooltipEl: HTMLDivElement | null = null;
  private baselineEl: HTMLDivElement | null = null;

  private resizeObserver: ResizeObserver | null = null;
  private abortController: AbortController | null = null;

  constructor(container: HTMLElement, apiClient: GraphApiClient) {
    this.container = container;
    this.apiClient = apiClient;

    injectEpisodesTimelineStyles();
    this.renderShell();
    this.refresh().catch((e) => {
      console.error('[EpisodesTimeline] Failed initial refresh:', e);
    });
  }

  /**
   * Re-fetch and re-render episodes.
   */
  async refresh(): Promise<void> {
    if (this.headerRefreshBtn) this.headerRefreshBtn.disabled = true;

    this.abortController?.abort();
    this.abortController = new AbortController();

    this.renderLoadingState();
    try {
      const episodes = await this.apiClient.fetchEpisodes({
        limit: 200,
        signal: this.abortController.signal,
      });

      this.episodes = [...episodes].sort((a, b) => {
        const ta = safeDate(a.timestamp)?.getTime() ?? 0;
        const tb = safeDate(b.timestamp)?.getTime() ?? 0;
        if (ta !== tb) return ta - tb;
        return a.sequence - b.sequence;
      });

      if (this.selectedEpisodeId) {
        const stillThere = this.episodes.find((e) => e.id === this.selectedEpisodeId);
        if (!stillThere) this.selectedEpisodeId = null;
      }

      this.renderCurrentView();
    } catch (e) {
      if (this.abortController.signal.aborted) return;
      console.error('[EpisodesTimeline] Failed to fetch episodes:', e);
      this.renderErrorState('Failed to fetch episodes.');
    } finally {
      if (this.headerRefreshBtn) this.headerRefreshBtn.disabled = false;
    }
  }

  /**
   * Collapse/expand the panel.
   */
  toggle(): void {
    this.collapsed = !this.collapsed;
    this.updateCollapsedState();
  }

  private renderShell(): void {
    this.container.classList.add('episodes-timeline');

    const root = document.createElement('div');
    root.classList.add('episodes-timeline');
    root.style.width = '100%';
    root.style.boxSizing = 'border-box';

    const header = document.createElement('div');
    header.classList.add('episodes-header');

    const title = document.createElement('h3');
    title.textContent = 'Episodes';
    header.appendChild(title);

    const toggleBtn = document.createElement('button');
    toggleBtn.classList.add('episodes-btn', 'health-dashboard-toggle');
    toggleBtn.type = 'button';
    toggleBtn.title = 'Toggle panel';
    toggleBtn.textContent = '▶';
    toggleBtn.addEventListener('click', () => this.toggle());
    header.appendChild(toggleBtn);

    const refreshBtn = document.createElement('button');
    refreshBtn.classList.add('episodes-btn', 'health-dashboard-refresh');
    refreshBtn.type = 'button';
    refreshBtn.title = 'Refresh';
    refreshBtn.textContent = '⟳';
    refreshBtn.addEventListener('click', () => {
      this.refresh().catch((e) => console.error('[EpisodesTimeline] Refresh failed:', e));
    });
    header.appendChild(refreshBtn);

    const content = document.createElement('div');
    content.classList.add('episodes-content');

    const track = document.createElement('div');
    track.classList.add('episodes-track');
    track.style.height = '152px';
    track.addEventListener('scroll', () => this.hideHoverCard());

    const inner = document.createElement('div');
    inner.classList.add('episodes-track-inner');
    inner.style.height = '184px';

    const markersLayer = document.createElement('div');
    markersLayer.style.position = 'relative';
    markersLayer.style.height = '120px';

    const baseline = document.createElement('div');
    baseline.style.position = 'absolute';
    baseline.style.left = '0';
    baseline.style.right = '0';
    baseline.style.top = '72px';
    baseline.style.height = '1px';
    baseline.style.background = THEME.border;
    baseline.style.pointerEvents = 'none';

    const axis = document.createElement('div');
    axis.classList.add('episodes-axis');

    inner.appendChild(markersLayer);
    inner.appendChild(baseline);
    inner.appendChild(axis);
    track.appendChild(inner);
    content.appendChild(track);

    const detail = document.createElement('div');
    detail.classList.add('episode-detail');
    detail.style.display = 'none';
    content.appendChild(detail);

    root.appendChild(header);
    root.appendChild(content);

    removeAllChildren(this.container);
    this.container.appendChild(root);

    this.rootEl = root;
    this.headerToggleBtn = toggleBtn;
    this.headerRefreshBtn = refreshBtn;
    this.contentEl = content;
    this.trackEl = track;
    this.trackInnerEl = inner;
    this.axisEl = axis;
    this.markersLayerEl = markersLayer;
    this.detailEl = detail;
    this.baselineEl = baseline;

    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => {
      if (!this.selectedEpisodeId) this.renderTimeline();
    });
    this.resizeObserver.observe(track);
    this.updateCollapsedState();
  }

  private updateCollapsedState(): void {
    if (!this.contentEl || !this.headerToggleBtn) return;
    this.contentEl.style.display = this.collapsed ? 'none' : 'block';
    this.headerToggleBtn.textContent = this.collapsed ? '◀' : '▶';
  }

  private renderCurrentView(): void {
    if (this.selectedEpisodeId) {
      const ep = this.episodes.find((e) => e.id === this.selectedEpisodeId);
      if (ep) {
        this.renderDetail(ep);
        return;
      }
    }

    this.renderTimeline();
  }

  private renderLoadingState(): void {
    if (!this.markersLayerEl || !this.detailEl) return;
    this.selectedEpisodeId = null;
    this.detailEl.style.display = 'none';
    if (this.trackEl) this.trackEl.style.display = 'block';
    removeAllChildren(this.markersLayerEl);

    const msg = document.createElement('div');
    msg.classList.add('episodes-muted');
    msg.style.padding = '14px';
    msg.textContent = 'Loading episodes…';
    this.markersLayerEl.appendChild(msg);

    this.renderAxis([], 1200, 0, 1);
  }

  private renderErrorState(message: string): void {
    if (!this.markersLayerEl || !this.detailEl) return;
    this.selectedEpisodeId = null;
    this.detailEl.style.display = 'none';
    if (this.trackEl) this.trackEl.style.display = 'block';
    removeAllChildren(this.markersLayerEl);

    const msg = document.createElement('div');
    msg.classList.add('episodes-muted');
    msg.style.padding = '14px';
    msg.textContent = message;
    this.markersLayerEl.appendChild(msg);
  }

  private renderTimeline(): void {
    if (!this.trackEl || !this.trackInnerEl || !this.markersLayerEl || !this.axisEl || !this.baselineEl) return;
    this.hideHoverCard();

    if (this.detailEl) this.detailEl.style.display = 'none';
    this.trackEl.style.display = 'block';
    removeAllChildren(this.markersLayerEl);

    if (this.episodes.length === 0) {
      const msg = document.createElement('div');
      msg.classList.add('episodes-muted');
      msg.style.padding = '14px';
      msg.textContent = 'No episodes found.';
      this.markersLayerEl.appendChild(msg);
      this.renderAxis([], 1200, 0, 1);
      return;
    }

    const parsed = this.buildLayout(this.episodes);
    if (parsed.length === 0) {
      const msg = document.createElement('div');
      msg.classList.add('episodes-muted');
      msg.style.padding = '14px';
      msg.textContent = 'No episodes with valid timestamps.';
      this.markersLayerEl.appendChild(msg);
      this.renderAxis([], 1200, 0, 1);
      return;
    }
    const maxStack = parsed.reduce((m, p) => Math.max(m, p.stackIndex), 0);
    const stackSpacing = 14;
    const markerAreaHeight = 84 + maxStack * stackSpacing;
    const axisHeight = 32;
    const innerHeight = markerAreaHeight + axisHeight;
    const baselineY = markerAreaHeight - 22;

    this.markersLayerEl.style.height = `${markerAreaHeight}px`;
    this.trackInnerEl.style.height = `${innerHeight}px`;
    this.trackEl.style.height = `${innerHeight + 10}px`;
    this.baselineEl.style.top = `${baselineY + 5}px`;

    // Baseline label ends
    const baselineLabelLeft = document.createElement('div');
    baselineLabelLeft.classList.add('episodes-muted');
    baselineLabelLeft.style.position = 'absolute';
    baselineLabelLeft.style.left = '10px';
    baselineLabelLeft.style.top = `${baselineY - 28}px`;
    baselineLabelLeft.style.fontSize = '12px';
    baselineLabelLeft.style.pointerEvents = 'none';
    baselineLabelLeft.textContent = formatTimestamp(this.episodes[0].timestamp).split(' ')[0] ?? '';
    this.markersLayerEl.appendChild(baselineLabelLeft);

    const minMs = parsed.reduce((m, p) => Math.min(m, p.startMs), Number.POSITIVE_INFINITY);
    const maxMs = parsed.reduce((m, p) => Math.max(m, p.endMs), Number.NEGATIVE_INFINITY);
    const width = this.trackInnerEl.getBoundingClientRect().width;

    this.renderAxis(parsed, width, minMs, maxMs);

    // Markers
    for (const p of parsed) {
      const ep = p.episode;
      const top = baselineY - p.stackIndex * stackSpacing;

      if (p.xEnd - p.xStart > 12) {
        const bar = document.createElement('div');
        bar.classList.add('episode-dot');
        bar.style.width = `${Math.max(10, p.xEnd - p.xStart)}px`;
        bar.style.height = '6px';
        bar.style.borderRadius = '999px';
        bar.style.left = `${p.xStart}px`;
        bar.style.top = `${top + 2}px`;
        bar.style.background = TYPE_COLORS[ep.type];
        bar.style.opacity = '0.75';
        bar.addEventListener('mouseenter', (ev) => this.showHoverCard(ep, ev));
        bar.addEventListener('mousemove', (ev) => this.positionHoverCard(ev));
        bar.addEventListener('mouseleave', () => this.hideHoverCard());
        bar.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          this.openEpisode(ep);
        });
        this.markersLayerEl.appendChild(bar);
      }

      const dot = document.createElement('div');
      dot.classList.add('episode-dot');
      dot.style.left = `${p.xStart - 5}px`;
      dot.style.top = `${top - 5}px`;
      dot.style.background = TYPE_COLORS[ep.type];

      dot.addEventListener('mouseenter', (ev) => this.showHoverCard(ep, ev));
      dot.addEventListener('mousemove', (ev) => this.positionHoverCard(ev));
      dot.addEventListener('mouseleave', () => this.hideHoverCard());
      dot.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.openEpisode(ep);
      });

      this.markersLayerEl.appendChild(dot);
    }
  }

  private buildLayout(episodes: Episode[]): EpisodeWithLayout[] {
    if (!this.trackInnerEl) return [];

    const parsedTimes = episodes
      .map((e) => {
        const start = safeDate(e.timestamp)?.getTime();
        const end = safeDate(e.endTimestamp ?? e.timestamp)?.getTime();
        return {
          episode: e,
          startMs: start ?? 0,
          endMs: end ?? (start ?? 0),
        };
      })
      .filter((p) => p.startMs > 0);

    const minMs = parsedTimes.reduce((m, p) => Math.min(m, p.startMs), Number.POSITIVE_INFINITY);
    const maxMs = parsedTimes.reduce((m, p) => Math.max(m, p.endMs), Number.NEGATIVE_INFINITY);
    const range = Math.max(1, maxMs - minMs);

    const viewportW = this.trackEl?.clientWidth ?? 900;
    const timelineW = Math.max(viewportW * 2, episodes.length * 22, 1200);
    const padding = 16;

    this.trackInnerEl.style.width = `${timelineW}px`;

    const layout: EpisodeWithLayout[] = parsedTimes.map((p) => {
      const startPct = clamp((p.startMs - minMs) / range, 0, 1);
      const endPct = clamp((p.endMs - minMs) / range, 0, 1);
      const xStart = padding + startPct * (timelineW - padding * 2);
      const xEnd = padding + endPct * (timelineW - padding * 2);
      return {
        ...p,
        startPct,
        endPct,
        xStart,
        xEnd,
        stackIndex: 0,
      };
    });

    layout.sort((a, b) => a.startPct - b.startPct);

    // Clustering: episodes within 2% of timeline get stacked.
    const threshold = 0.02;
    let clusterStartPct = layout[0]?.startPct ?? 0;
    let stack = 0;
    for (const p of layout) {
      if (p.startPct - clusterStartPct <= threshold) {
        p.stackIndex = stack;
        stack++;
      } else {
        clusterStartPct = p.startPct;
        stack = 0;
        p.stackIndex = stack;
        stack++;
      }
    }

    return layout;
  }

  private renderAxis(layout: EpisodeWithLayout[], timelineW: number, minMs: number, maxMs: number): void {
    if (!this.axisEl) return;
    removeAllChildren(this.axisEl);

    // Always render a base line; ticks/labels are optional.
    const tickLayer = document.createElement('div');
    tickLayer.style.position = 'relative';
    tickLayer.style.height = '100%';
    tickLayer.style.width = `${Math.max(1200, timelineW)}px`;
    this.axisEl.appendChild(tickLayer);

    const range = Math.max(1, maxMs - minMs);
    const padding = 16;
    const usableW = Math.max(1, (Math.max(1200, timelineW) - padding * 2));

    const addTick = (ms: number, label: string, strong: boolean): void => {
      const pct = clamp((ms - minMs) / range, 0, 1);
      const x = padding + pct * usableW;

      const line = document.createElement('div');
      line.style.position = 'absolute';
      line.style.left = `${x}px`;
      line.style.top = '0';
      line.style.width = '1px';
      line.style.height = strong ? '12px' : '8px';
      line.style.background = strong ? 'rgba(180, 180, 220, 0.55)' : 'rgba(180, 180, 220, 0.25)';
      tickLayer.appendChild(line);

      const text = document.createElement('div');
      text.classList.add('episodes-muted');
      text.style.position = 'absolute';
      text.style.left = `${x + 6}px`;
      text.style.top = '12px';
      text.style.fontSize = '12px';
      text.style.whiteSpace = 'nowrap';
      text.textContent = label;
      tickLayer.appendChild(text);
    };

    if (layout.length === 0 || minMs <= 0 || maxMs <= 0) return;

    // Month ticks (or coarser) depending on span.
    const spanDays = (maxMs - minMs) / (1000 * 60 * 60 * 24);
    const approxTicks = Math.max(2, Math.floor((Math.max(1200, timelineW)) / 160));
    const monthStep = (() => {
      if (spanDays < 45) return 1;
      if (spanDays < 120) return 2;
      if (spanDays < 260) return 3;
      if (spanDays < 550) return 6;
      return 12;
    })();

    const minD = new Date(minMs);
    const start = new Date(minD.getFullYear(), minD.getMonth(), 1);
    const end = new Date(maxMs);

    const monthLabelFmt = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' });
    const dayLabelFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

    // Always show ends.
    addTick(minMs, dayLabelFmt.format(new Date(minMs)), true);
    addTick(maxMs, dayLabelFmt.format(new Date(maxMs)), true);

    // Internal ticks.
    let tickCount = 0;
    for (let y = start.getFullYear(), m = start.getMonth();; ) {
      const tickDate = new Date(y, m, 1);
      const ms = tickDate.getTime();
      if (ms > maxMs) break;

      if (ms >= minMs && ms <= maxMs) {
        // Avoid spam on very long spans.
        if (tickCount < approxTicks + 3) {
          addTick(ms, monthLabelFmt.format(tickDate), false);
          tickCount++;
        }
      }

      m += monthStep;
      while (m >= 12) {
        y++;
        m -= 12;
      }

      // Safety break.
      if (y > end.getFullYear() + 5) break;
    }
  }

  private showHoverCard(ep: Episode, ev: MouseEvent): void {
    if (!this.rootEl) return;
    if (!this.tooltipEl) {
      const card = document.createElement('div');
      card.classList.add('episode-hover-card');
      card.style.display = 'none';
      this.rootEl.appendChild(card);
      this.tooltipEl = card;
    }

    const card = this.tooltipEl;
    removeAllChildren(card);

    const title = document.createElement('div');
    title.style.fontWeight = '700';
    title.style.marginBottom = '6px';
    title.textContent = ep.title;
    card.appendChild(title);

    const meta = document.createElement('div');
    meta.style.display = 'flex';
    meta.style.flexWrap = 'wrap';
    meta.style.gap = '8px';
    meta.style.alignItems = 'center';
    meta.style.marginBottom = '8px';
    meta.appendChild(buildTypeBadge(ep.type));

    const ts = document.createElement('span');
    ts.classList.add('episodes-muted');
    ts.style.fontSize = '12px';
    ts.textContent = formatTimestamp(ep.timestamp);
    meta.appendChild(ts);
    card.appendChild(meta);

    const summary = document.createElement('div');
    summary.style.fontSize = '12px';
    summary.style.lineHeight = '1.35';
    summary.textContent = summarizeEpisode(ep);
    card.appendChild(summary);

    const parts = document.createElement('div');
    parts.classList.add('episodes-muted');
    parts.style.marginTop = '8px';
    parts.style.fontSize = '12px';
    parts.textContent = (ep.participants?.length ?? 0) > 0
      ? `Participants: ${ep.participants.join(', ')}`
      : 'Participants: —';
    card.appendChild(parts);

    card.style.display = 'block';
    this.positionHoverCard(ev);
  }

  private positionHoverCard(ev: MouseEvent): void {
    if (!this.rootEl || !this.tooltipEl) return;
    const card = this.tooltipEl;
    if (card.style.display === 'none') return;

    const rootRect = this.rootEl.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const padding = 12;

    const x = clamp(ev.clientX - rootRect.left + 12, padding, rootRect.width - cardRect.width - padding);
    const y = clamp(ev.clientY - rootRect.top + 12, padding, rootRect.height - cardRect.height - padding);

    card.style.left = `${Math.round(x)}px`;
    card.style.top = `${Math.round(y)}px`;
  }

  private hideHoverCard(): void {
    if (this.tooltipEl) this.tooltipEl.style.display = 'none';
  }

  private openEpisode(ep: Episode): void {
    this.selectedEpisodeId = ep.id;
    this.hideHoverCard();
    this.renderDetail(ep);
  }

  private renderDetail(ep: Episode): void {
    if (!this.detailEl || !this.trackEl) return;
    this.trackEl.style.display = 'none';
    this.detailEl.style.display = 'block';
    removeAllChildren(this.detailEl);

    const topRow = document.createElement('div');
    topRow.style.display = 'flex';
    topRow.style.alignItems = 'center';
    topRow.style.gap = '10px';
    topRow.style.marginBottom = '10px';

    const titleWrap = document.createElement('div');
    titleWrap.style.flex = '1';
    const title = document.createElement('div');
    title.style.fontSize = '16px';
    title.style.fontWeight = '750';
    title.textContent = ep.title;
    titleWrap.appendChild(title);

    const meta = document.createElement('div');
    meta.style.display = 'flex';
    meta.style.flexWrap = 'wrap';
    meta.style.alignItems = 'center';
    meta.style.gap = '10px';
    meta.style.marginTop = '6px';
    meta.appendChild(buildTypeBadge(ep.type));

    const ts = document.createElement('div');
    ts.classList.add('episodes-muted');
    ts.style.fontSize = '12px';
    ts.textContent = formatTimestamp(ep.timestamp);
    meta.appendChild(ts);
    titleWrap.appendChild(meta);

    topRow.appendChild(titleWrap);

    const closeBtn = document.createElement('button');
    closeBtn.classList.add('episode-close-btn');
    closeBtn.type = 'button';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', () => {
      this.selectedEpisodeId = null;
      this.renderTimeline();
    });
    topRow.appendChild(closeBtn);
    this.detailEl.appendChild(topRow);

    const importance = document.createElement('div');
    importance.style.display = 'flex';
    importance.style.alignItems = 'center';
    importance.style.gap = '10px';
    importance.style.marginBottom = '10px';

    const impLabel = document.createElement('div');
    impLabel.classList.add('episodes-muted');
    impLabel.style.fontSize = '12px';
    impLabel.textContent = 'Importance';
    importance.appendChild(impLabel);

    const stars = document.createElement('div');
    const filled = clamp(Math.round(ep.importance / 2), 0, 5);
    for (let i = 0; i < 5; i++) {
      const s = document.createElement('span');
      s.textContent = i < filled ? '★' : '☆';
      s.style.color = i < filled ? THEME.accent : THEME.muted;
      s.style.fontSize = '14px';
      s.style.marginRight = '2px';
      stars.appendChild(s);
    }
    importance.appendChild(stars);

    const impNum = document.createElement('div');
    impNum.classList.add('episodes-muted');
    impNum.style.fontSize = '12px';
    impNum.textContent = `${ep.importance.toFixed(1)}/10`;
    importance.appendChild(impNum);

    this.detailEl.appendChild(importance);

    const parts = document.createElement('div');
    parts.classList.add('episodes-muted');
    parts.style.fontSize = '12px';
    parts.style.marginBottom = '10px';
    parts.textContent = (ep.participants?.length ?? 0) > 0
      ? `Participants: ${ep.participants.join(', ')}`
      : 'Participants: —';
    this.detailEl.appendChild(parts);

    if ((ep.topics?.length ?? 0) > 0) {
      const topicsWrap = document.createElement('div');
      topicsWrap.style.display = 'flex';
      topicsWrap.style.flexWrap = 'wrap';
      topicsWrap.style.gap = '8px';
      topicsWrap.style.marginBottom = '12px';

      for (const t of ep.topics) {
        const chip = document.createElement('span');
        chip.classList.add('episode-topic');
        chip.textContent = t;
        topicsWrap.appendChild(chip);
      }
      this.detailEl.appendChild(topicsWrap);
    }

    const body = document.createElement('div');
    body.style.maxHeight = '220px';
    body.style.overflow = 'auto';
    body.style.paddingRight = '6px';
    body.style.borderTop = `1px solid ${THEME.border}`;
    body.style.paddingTop = '10px';

    if (ep.summary && ep.summary.trim().length > 0) {
      const summary = document.createElement('div');
      summary.style.fontSize = '13px';
      summary.style.lineHeight = '1.4';
      summary.style.marginBottom = '10px';
      summary.textContent = ep.summary;
      body.appendChild(summary);
    }

    const content = document.createElement('div');
    content.style.whiteSpace = 'pre-wrap';
    content.style.fontSize = '12px';
    content.style.lineHeight = '1.5';
    content.textContent = ep.content;
    body.appendChild(content);

    this.detailEl.appendChild(body);
  }
}
