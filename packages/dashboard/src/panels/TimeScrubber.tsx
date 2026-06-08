import { useState } from 'react';
import { sliderValueToDate, formatDateLabel } from '../graph/time-scrub.ts';

/**
 * Time scrubber — a range slider over the graph's date span. Maps the 0–100
 * slider position to a Date via the shared time-scrub helpers and reports it
 * upward so the graph can re-render its state "as of" that moment.
 *
 * The maximum position means "no scrub": it reports `null` so the graph
 * restores the live view (stored edge weights, all nodes visible), matching
 * the `scrubDate === null` semantics in graph-view.ts.
 */
export function TimeScrubber(props: {
  earliest: Date;
  latest: Date;
  onChange: (date: Date | null) => void;
}) {
  const [value, setValue] = useState(100);
  const atLive = value >= 100;
  const current = sliderValueToDate(value, props.earliest, props.latest);

  return (
    <label className="time-scrubber">
      <span>Time: {atLive ? 'now' : formatDateLabel(current)}</span>
      <input
        type="range"
        min={0}
        max={100}
        value={value}
        onChange={(e) => {
          const v = Number(e.target.value);
          setValue(v);
          props.onChange(v >= 100 ? null : sliderValueToDate(v, props.earliest, props.latest));
        }}
      />
    </label>
  );
}
