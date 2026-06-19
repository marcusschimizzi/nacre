import { useCallback, useEffect, useRef, useState } from 'react';
import { sliderValueToDate, formatDateLabel } from '../graph/time-scrub.ts';

const STEP_MS = 150;

/**
 * Time scrubber — a range slider over the graph's date span, with play/pause
 * auto-animation so you can watch the graph form and decay over time.
 *
 * The 0–100 slider position maps to a Date via the shared time-scrub helpers.
 * The far-right position means "no scrub": it reports `null` so the graph
 * restores the live view, matching the `scrubDate === null` semantics in
 * graph-view.ts. Markup/ids match the existing #time-scrub CSS.
 */
export function TimeScrubber(props: {
  earliest: Date;
  latest: Date;
  onChange: (date: Date | null) => void;
}) {
  const { earliest, latest, onChange } = props;
  const [value, setValue] = useState(100);
  const [playing, setPlaying] = useState(false);
  const atLive = value >= 100;

  // Keep the latest onChange in a ref so playback/effects don't churn on the
  // new inline closure App passes each render.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const report = useCallback(
    (v: number) => onChangeRef.current(v >= 100 ? null : sliderValueToDate(v, earliest, latest)),
    [earliest, latest],
  );

  // Single reporting path: every position change (drag or playback) flows up here.
  useEffect(() => {
    report(value);
  }, [value, report]);

  // Auto-advance one step per tick while playing.
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setValue((v) => Math.min(100, v + 1)), STEP_MS);
    return () => clearInterval(id);
  }, [playing]);

  // Stop when it reaches the live end.
  useEffect(() => {
    if (playing && value >= 100) setPlaying(false);
  }, [playing, value]);

  const togglePlay = () => {
    if (playing) {
      setPlaying(false);
    } else {
      if (value >= 100) setValue(0); // replay from the start
      setPlaying(true);
    }
  };

  return (
    <div id="time-scrub">
      <div id="time-scrub-header">
        <button
          id="time-play-btn"
          type="button"
          aria-label={playing ? 'Pause time-lapse' : 'Play time-lapse'}
          aria-pressed={playing}
          onClick={togglePlay}
        >
          {playing ? '⏸' : '▶'}
        </button>
        <span id="time-scrub-date">
          {atLive ? 'now' : formatDateLabel(sliderValueToDate(value, earliest, latest))}
        </span>
      </div>
      <input
        id="time-slider"
        type="range"
        min={0}
        max={100}
        value={value}
        aria-label="Scrub through time"
        onChange={(e) => {
          setPlaying(false); // a manual drag pauses playback
          setValue(Number(e.target.value));
        }}
      />
      <div id="time-scrub-range">
        <span id="time-scrub-start">{formatDateLabel(earliest)}</span>
        <span id="time-scrub-end">{formatDateLabel(latest)}</span>
      </div>
    </div>
  );
}
