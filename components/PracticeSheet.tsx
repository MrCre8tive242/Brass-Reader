'use client';
import type { ReactNode } from 'react';
import { CloseIcon } from './Icons';

interface Props {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}

/** Bottom drawer above the transport: every practice tool lives here so the transport stays two rows. */
export default function PracticeSheet({ open, onClose, children }: Props) {
  // stays mounted when closed: the pitch check and the recorder keep running while the score is in view
  return (
    <div className="sheet" role="dialog" aria-label="Practice tools" data-testid="practice-sheet" hidden={!open}>
      <div className="sheet-head">
        <h2>Practice</h2>
        <button type="button" className="tbtn sm" onClick={onClose} aria-label="Close practice tools"><CloseIcon size={20} /></button>
      </div>
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
