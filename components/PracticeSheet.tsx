'use client';
import { useEffect, useRef, type ReactNode } from 'react';
import { CloseIcon } from './Icons';
import { useModal } from './useModal';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Section shortcuts shown above the list (the Loop section first). */
  tabs?: { id: string; label: string }[];
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
            <a key={t.id} href={`#sec-${t.id}`} className="chip" onClick={(e) => { e.preventDefault(); jump(t.id); }}>{t.label}</a>
          ))}
        </nav>
      )}
      <div className="sheet-body">{children}</div>
    </div>
  );
}

export function Section({ id, title, children, open }: { id: string; title: string; children: ReactNode; open?: boolean }) {
  return (
    <details className="psec" data-testid={`sec-${id}`} open={open}>
      <summary>{title}</summary>
      <div className="psec-body">{children}</div>
    </details>
  );
}
