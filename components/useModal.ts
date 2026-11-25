'use client';
import { useEffect, useRef, type RefObject } from 'react';

interface Options {
  open: boolean;
  /** The dialog element: focus moves into it and Tab stays inside it. */
  ref: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** Page areas that become inert (not focusable, not clickable, hidden from screen readers) while it is open. */
  inert: string[];
  /** Extra areas that stay usable and are part of the Tab loop (the transport under the drawer). */
  also?: string[];
  /** Where focus returns when the opener had none (Safari does not focus a button when it is tapped). */
  returnTo?: string;
}

const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex]';
const stack: symbol[] = [];
const inertCount = new WeakMap<Element, number>();

function visible(el: HTMLElement): boolean {
  if (el.hasAttribute('disabled') || el.getAttribute('tabindex') === '-1' || el.closest('[inert], [hidden]')) return false;
  if (el instanceof HTMLInputElement && el.type === 'hidden') return false;
  // content of a closed <details> is not focusable (only its summary is)
  for (let d = el.closest('details'); d; d = d.parentElement?.closest('details') ?? null) {
    if (!d.open && !(el.tagName === 'SUMMARY' && el.parentElement === d)) return false;
  }
  const s = getComputedStyle(el);
  return s.visibility !== 'hidden' && s.display !== 'none' && el.getClientRects().length > 0;
}

function focusables(roots: HTMLElement[]): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const r of roots) r.querySelectorAll<HTMLElement>(FOCUSABLE).forEach((el) => { if (visible(el)) out.push(el); });
  return out;
}

function setInert(el: Element, on: boolean) {
  const n = (inertCount.get(el) ?? 0) + (on ? 1 : -1);
  inertCount.set(el, Math.max(0, n));
  if (n > 0) el.setAttribute('inert', ''); else el.removeAttribute('inert');
}

/**
 * Makes an element a real modal dialog: focus moves in when it opens and goes back to the opener when it
 * closes, Tab stays inside, Escape closes it and the page behind it is inert.
 */
export function useModal({ open, ref, onClose, inert, also = [], returnTo }: Options) {
  const close = useRef(onClose);
  close.current = onClose;
  const cfg = useRef({ inert, also, returnTo });
  cfg.current = { inert, also, returnTo };

  useEffect(() => {
    if (!open) return;
    const root = ref.current;
    if (!root) return;
    const me = Symbol('modal');
    stack.push(me);
    const active = document.activeElement as HTMLElement | null;
    const opener = active && active !== document.body ? active : null;
    const marked: Element[] = [];
    for (const sel of cfg.current.inert) document.querySelectorAll(sel).forEach((el) => { setInert(el, true); marked.push(el); });
    // the heading (or the first control) takes focus so a screen reader starts at the top of the dialog
    const first = root.querySelector<HTMLElement>('[data-autofocus]') ?? focusables([root])[0];
    first?.focus({ preventScroll: true });

    const roots = () => [root, ...cfg.current.also.flatMap((s) => Array.from(document.querySelectorAll<HTMLElement>(s)))];
    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== me) return;
      if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); close.current(); return; }
      if (e.key !== 'Tab') return;
      const list = focusables(roots());
      if (!list.length) { e.preventDefault(); return; }
      const a = document.activeElement as HTMLElement | null;
      const i = a ? list.indexOf(a) : -1;
      if (i === -1) { e.preventDefault(); list[e.shiftKey ? list.length - 1 : 0].focus(); }
      else if (e.shiftKey && i === 0) { e.preventDefault(); list[list.length - 1].focus(); }
      else if (!e.shiftKey && i === list.length - 1) { e.preventDefault(); list[0].focus(); }
    };
    document.addEventListener('keydown', onKey, true);

    return () => {
      document.removeEventListener('keydown', onKey, true);
      const at = stack.indexOf(me);
      if (at >= 0) stack.splice(at, 1);
      for (const el of marked) setInert(el, false);
      const back = opener && opener.isConnected ? opener : cfg.current.returnTo ? document.querySelector<HTMLElement>(cfg.current.returnTo) : null;
      back?.focus({ preventScroll: true });
    };
  }, [open, ref]);
}
