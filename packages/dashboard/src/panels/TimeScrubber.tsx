import { useState } from 'react';
import { sliderValueToDate, formatDateLabel } from '../graph/time-scrub.ts';

/**
 * Time scrubber — a range slider over the graph's date span. Maps the 0–100
 * slider position to a Date via the shared time-scrub helpers and reports it
 * upward so the graph can re-render its state "as of" that moment.
 */
export function TimeScrubber(props: {
  earliest: Date;
  latest: Date;
  onChange: (date: Date) => void;
}) {
  const [value, setValue] = useState(100);
  const current = sliderValueToDate(value, props.earliest, props.latest);

  return (
    <label className="time-scrubber">
      <span>Time: {formatDateLabel(current)}</span>
      <input
        type="range"
        min={0}
        max={100}
        value={value}
        onChange={(e) => {
          const v = Number(e.target.value);
          setValue(v);
          props.onChange(sliderValueToDate(v, props.earliest, props.latest));
        }}
      />
    </label>
  );
}
