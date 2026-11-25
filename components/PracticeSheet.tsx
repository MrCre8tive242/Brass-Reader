'use client';
import { useEffect, useRef, type ReactNode } from 'react';
import { CloseIcon } from './Icons';
import { useModal } from './useModal';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Section shortcuts shown above the list (the Loop section first). */
  tabs?: { id: string; label: string; /** The tool is doing something right now (a loop is set, the drums are on, ...). */ on?: boolean }[];
  children: ReactNode;
}

/**
 * The practice drawer: a bottom sheet above the transport on a tall screen, a full-height side panel on a short
 * (landscape) one. A real dialog: focus moves in, Tab stays in it (and the transport), Escape closes it, the page behind is inert.
 */
export default function PracticeSheet({ open, onClose, tabs, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useModal({ open, ref, onClose, inert: ['.topbar', 'main.page'], also: ['.transport'], returnTo: '.practice-btn' });

  // tell the page how tall the bottom sheet is, so the score can be scrolled up above it
  useEffect(() => {
    const el = ref.current;
    const root = document.documentElement;
    if (!el || !open) { root.style.removeProperty('--sheet-h'); return; }
    const set = () => root.style.setProperty('--sheet-h', el.offsetWidth >= window.innerWidth - 2 ? `${el.offsetHeight}px` : '0px');
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    window.addEventListener('resize', set);
    return () => { ro.disconnect(); window.removeEventListener('resize', set); root.style.removeProperty('--sheet-h'); };
  }, [open]);

  const jump = (id: string) => {
    const sec = document.querySelector<HTMLDetailsElement>(`[data-testid="sec-${id}"]`);
    if (!sec) return;
    closeOthers(sec);
    sec.open = true;
    sec.scrollIntoView({ block: 'start', behavior: 'smooth' });
    sec.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true });
  };

  // stays mounted when closed: the pitch check and the recorder keep running while the score is in view
  return (
    <div className="sheet" id="practice-sheet" ref={ref} role="dialog" aria-modal="true" aria-labelledby="practice-title" data-testid="practice-sheet" hidden={!open}>
      <div className="sheet-head">
        <h2 id="practice-title" tabIndex={-1} data-autofocus>Practice</h2>
        <button type="button" className="tbtn sm" onClick={onClose} aria-label="Close practice tools"><CloseIcon size={20} /></button>
      </div>
      {tabs && tabs.length > 0 && (
        <nav className="sheet-nav" aria-label="Practice sections">
          {tabs.map((t) => (
            <a key={t.id} href={`#sec-${t.id}`} className={`chip${t.on ? ' live' : ''}`} onClick={(e) => { e.preventDefault(); jump(t.id); }}>
              {t.label}{t.on && <span className="sr-only"> (on)</span>}
            </a>
          ))}
        </nav>
      )}
      <div className="sheet-body">{children}</div>
    </div>
  );
}

/** One tool is open at a time: opening a section folds the others away (their headers still say what they are doing). */
function closeOthers(keep: HTMLDetailsElement) {
  keep.closest('.sheet-body')?.querySelectorAll<HTMLDetailsElement>('details.psec[open]').forEach((d) => { if (d !== keep) d.open = false; });
}

/**
 * A tool of the practice drawer. `status` is a few words on the header saying what the tool is doing now
 * ("bars 3 to 6", "Starter A", "on"), so the folded drawer reads as one panel; `live` lights it up.
 */
export function Section({ id, title, children, open, status, live }: { id: string; title: string; children: ReactNode; open?: boolean; status?: string; live?: boolean }) {
  return (
    <details className={`psec${live ? ' live' : ''}`} data-testid={`sec-${id}`} open={open}>
      <summary onClick={(e) => { const d = e.currentTarget.parentElement as HTMLDetailsElement; if (!d.open) closeOthers(d); }}>
        <span className="psec-title">{title}</span>{' '}
        {status && <span className="psec-status" data-testid={`status-${id}`}>{status}</span>}
      </summary>
      <div className="psec-body">{children}</div>
    </details>
  );
}
