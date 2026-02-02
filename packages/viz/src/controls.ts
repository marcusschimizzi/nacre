import type { AppState } from './types.ts';
import { NODE_COLORS, EDGE_STYLES } from './theme.ts';
import {
  sliderValueToDate,
  formatDateLabel,
} from './time-scrub.ts';

export function initControls(
  state: AppState,
  entityTypes: string[],
  edgeTypes: string[],
  onFilterChange: () => void,
): void {
  initEntityTypeFilters(state, entityTypes, onFilterChange);
  initEdgeTypeFilters(state, edgeTypes, onFilterChange);
  initWeightSlider(state, onFilterChange);
  initLegend(entityTypes);
}

export function initTimeScrub(
  state: AppState,
  earliest: Date,
  latest: Date,
  onScrubChange: () => void,
): void {
  const slider = document.getElementById('time-slider') as HTMLInputElement;
  const dateLabel = document.getElementById('time-scrub-date')!;
  const startLabel = document.getElementById('time-scrub-start')!;
  const endLabel = document.getElementById('time-scrub-end')!;

  startLabel.textContent = formatDateLabel(earliest);
  endLabel.textContent = formatDateLabel(latest);
  dateLabel.textContent = formatDateLabel(latest);

  slider.addEventListener('input', () => {
    const value = parseInt(slider.value, 10);
    const date = sliderValueToDate(value, earliest, latest);

    state.scrubDate = value >= 100 ? null : date;
    dateLabel.textContent = state.scrubDate
      ? formatDateLabel(date)
      : formatDateLabel(latest);

    onScrubChange();
  });
}

function initEntityTypeFilters(
  state: AppState,
  types: string[],
  onChange: () => void,
): void {
  const container = document.getElementById('filter-types')!;
  container.innerHTML = '';

  for (const type of types) {
    const btn = document.createElement('button');
    btn.className = 'filter-btn active';
    const color = NODE_COLORS[type] ?? '#888';
    btn.innerHTML = `<span class="dot" style="background:${color}"></span>${type}`;
    state.visibleTypes.add(type);

    btn.addEventListener('click', () => {
      if (state.visibleTypes.has(type)) {
        state.visibleTypes.delete(type);
        btn.classList.remove('active');
      } else {
        state.visibleTypes.add(type);
        btn.classList.add('active');
      }
      onChange();
    });

    container.appendChild(btn);
  }
}

function initEdgeTypeFilters(
  state: AppState,
  types: string[],
  onChange: () => void,
): void {
  const container = document.getElementById('filter-edges')!;
  container.innerHTML = '';

  for (const type of types) {
    const btn = document.createElement('button');
    btn.className = 'filter-btn active';
    const style = EDGE_STYLES[type];
    const label = style?.arrow ? `${type} →` : type;
    btn.textContent = label;
    state.visibleEdgeTypes.add(type);

    btn.addEventListener('click', () => {
      if (state.visibleEdgeTypes.has(type)) {
        state.visibleEdgeTypes.delete(type);
        btn.classList.remove('active');
      } else {
        state.visibleEdgeTypes.add(type);
        btn.classList.add('active');
      }
      onChange();
    });

    container.appendChild(btn);
  }
}

function initWeightSlider(state: AppState, onChange: () => void): void {
  const slider = document.getElementById('weight-slider') as HTMLInputElement;
  const display = document.getElementById('weight-value')!;

  slider.addEventListener('input', () => {
    state.minWeight = parseInt(slider.value, 10) / 100;
    display.textContent = state.minWeight.toFixed(2);
    onChange();
  });
}

function initLegend(entityTypes: string[]): void {
  const el = document.getElementById('legend')!;
  el.innerHTML = entityTypes
    .map((type) => {
      const color = NODE_COLORS[type] ?? '#888';
      return `<div class="legend-item"><span class="legend-dot" style="background:${color}"></span>${type}</div>`;
    })
    .join('');
}
