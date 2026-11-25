'use client';
import { FINGER_STYLES, type FingerStyle } from '@/lib/fingerStyle';

interface Props {
  value: FingerStyle;
  onChange: (v: FingerStyle) => void;
  /** Words for what is being chosen, e.g. "Fingerings". */
  label?: string;
  /** Trombone has no valves: the dots become a slide icon. */
  slide?: boolean;
  testId?: string;
}

/** Numbers / valve dots / both / off. */
export default function FingerStylePicker({ value, onChange, label = 'Fingerings', slide, testId = 'finger-style' }: Props) {
  return (
    <div className="seg-wrap">
      <span className="seg-label">{label}</span>
      <div className="seg" role="radiogroup" aria-label={`${label} style`} data-testid={testId}>
        {FINGER_STYLES.map((s) => (
          <button key={s.id} type="button" role="radio" aria-checked={value === s.id} className={value === s.id ? 'on' : ''} onClick={() => onChange(s.id)}>
            {s.id === 'dots' && slide ? 'Slide icon' : s.label}
          </button>
        ))}
      </div>
    </div>
  );
}
