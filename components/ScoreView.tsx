'use client';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';

export interface ScoreViewHandle {
  /** Move the cursor + bar highlight to quarter-note position q. */
  setPosition: (q: number, measure: number, offsetQ?: number) => void;
}

interface Props {
  xml: string;
  /** User zoom multiplier on top of the width-based default (1 = automatic size). */
  zoom?: number;
  /** Written bars (1-based) to mark as "check this bar". */
  flagged?: number[];
  onSeekMeasure: (measure: number) => void;
  onReady?: (info: { measureCount: number }) => void;
  onError?: (msg: string) => void;
}

/** First time OSMD's cursor visits a position: `idx` = how many iterator steps from the start. */
interface Step { off: number; idx: number }
interface Box { x: number; y: number; w: number; h: number }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Osmd = any;

const UNIT = 10; // OSMD units are 10px at zoom 1

const ScoreView = forwardRef<ScoreViewHandle, Props>(function ScoreView({ xml, zoom = 1, flagged, onSeekMeasure, onReady, onError }, ref) {
  const wrap = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const hl = useRef<HTMLDivElement>(null);
  const osmdRef = useRef<Osmd>(null);
  const steps = useRef<Step[][]>([]); // per written bar (1-based), sorted by offset
  const stepCount = useRef(0);
  const boxes = useRef<Box[]>([]);
  const cur = useRef(-1);
  const lastPos = useRef<{ q: number; measure: number; off: number }>({ q: 0, measure: 1, off: 0 });
  const lastSystemY = useRef(-1);
  const [busy, setBusy] = useState(true);
  const [layout, setLayout] = useState(0); // bumps after every (re)draw so the bar marks are placed again
  const placed = useRef<{ step: number; measure: number }>({ step: -1, measure: -1 });
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const rerender = useRef<((scroll: boolean) => void) | null>(null);
  const seekRef = useRef(onSeekMeasure);
  seekRef.current = onSeekMeasure;

  function collect(osmd: Osmd) {
    const c = osmd.cursor;
    c.show();
    c.reset();
    const byBar: Step[][] = [];
    const seen = new Set<string>();
    let guard = 0;
    let idx = 0;
    // OSMD's iterator follows repeats itself; keep only the first visit of every position
    // (the player decides the play order, we only need "where is bar m at offset o").
    while (!c.iterator.EndReached && guard++ < 200000) {
      const m = c.iterator.CurrentMeasureIndex + 1;
      const startQ = (c.iterator.CurrentMeasure?.AbsoluteTimestamp?.RealValue ?? 0) * 4;
      const off = Math.max(0, c.iterator.currentTimeStamp.RealValue * 4 - startQ);
      const key = `${m}:${Math.round(off * 1000)}`;
      if (!seen.has(key)) {
        seen.add(key);
        (byBar[m] ??= []).push({ off, idx });
      }
      c.iterator.moveToNext();
      idx++;
    }
    for (const list of byBar) list?.sort((a, b) => a.off - b.off);
    c.reset();
    steps.current = byBar;
    stepCount.current = idx;
    cur.current = 0;
  }

  /**
   * Full-height box per written bar: x/width from the bar's own bounds, y/height from the staff
   * itself (top line .. bottom line of every staff in the system, plus room for ledger lines), so the
   * box never depends on where the notes happen to sit.
   */
  function measureBoxes(osmd: Osmd) {
    const list: Box[] = [];
    const zoom = osmd.zoom ?? 1;
    const staffH = osmd.EngravingRules?.StaffHeight ?? 4;
    const padY = 2.2; // staff spaces above and below, for ledger lines
    type GM = { PositionAndShape: { AbsolutePosition: { x: number; y: number }; BorderLeft: number; BorderRight: number } } | undefined;
    const ml = osmd.GraphicSheet.MeasureList as GM[][];
    ml.forEach((staves, i) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const gm of staves) {
        if (!gm) continue;
        const p = gm.PositionAndShape;
        x0 = Math.min(x0, p.AbsolutePosition.x + p.BorderLeft);
        x1 = Math.max(x1, p.AbsolutePosition.x + p.BorderRight);
        y0 = Math.min(y0, p.AbsolutePosition.y);
        y1 = Math.max(y1, p.AbsolutePosition.y + staffH);
      }
      if (x0 === Infinity) { list[i] = { x: 0, y: 0, w: 0, h: 0 }; return; }
      const k = UNIT * zoom;
      list[i] = { x: x0 * k, y: (y0 - padY) * k, w: (x1 - x0) * k, h: (y1 - y0 + 2 * padY) * k };
    });
    boxes.current = list;
  }

  /** Cursor iterator index for written bar `measure` at `offsetQ` into it. */
  function stepFor(measure: number, offsetQ: number): number {
    const by = steps.current;
    for (let m = Math.min(measure, by.length - 1); m >= 1; m--) {
      const list = by[m];
      if (!list?.length) continue;
      if (m !== measure) return list[list.length - 1].idx; // empty bar: stay on the last step before it
      let pick = list[0];
      for (const st of list) if (st.off <= offsetQ + 1e-6) pick = st; else break;
      return pick.idx;
    }
    return 0;
  }

  function place(q: number, measure: number, scroll: boolean, offsetQ = 0, forceScroll = false) {
    lastPos.current = { q, measure, off: offsetQ };
    const osmd = osmdRef.current;
    if (!osmd || !stepCount.current) return;
    const target = stepFor(measure, offsetQ);
    // called on every animation frame while playing: do nothing unless the cursor actually moves
    if (!forceScroll && placed.current.step === target && placed.current.measure === measure) return;
    placed.current = { step: target, measure };
    const c = osmd.cursor;
    if (target !== cur.current) {
      if (target < cur.current) { c.reset(); cur.current = 0; }
      while (cur.current < target) { c.iterator.moveToNext(); cur.current++; }
      c.update();
    }
    // highlight the current bar
    const b = boxes.current[measure - 1];
    const el = hl.current;
    if (el && b && b.w > 0) {
      el.style.display = 'block';
      el.style.transform = `translate(${b.x}px, ${b.y}px)`;
      el.style.width = `${b.w}px`;
      el.style.height = `${b.h}px`;
    } else if (el) el.style.display = 'none';
    if (scroll) autoScroll(c.cursorElement as HTMLElement | undefined, forceScroll);
  }

  function autoScroll(el?: HTMLElement, force = false) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (!r.height) return;
    const top = r.top + window.scrollY;
    const vh = window.innerHeight;
    // keep the cursor between the sticky header and the (measured) transport
    const header = (document.querySelector('.topbar') as HTMLElement | null)?.offsetHeight ?? 60;
    const transport = (document.querySelector('.transport') as HTMLElement | null)?.offsetHeight ?? 150;
    const topLimit = header + 10;
    const bottomBand = vh - transport - 10;
    const sysChanged = Math.abs(top - lastSystemY.current) > 20;
    lastSystemY.current = top;
    if (force || r.top < topLimit || r.bottom > bottomBand || sysChanged && (r.top > topLimit + (bottomBand - topLimit) * 0.55)) {
      const room = Math.max(0, bottomBand - topLimit);
      window.scrollTo({ top: Math.max(0, top - topLimit - room * 0.2), behavior: force ? 'auto' : 'smooth' });
    }
  }

  useImperativeHandle(ref, () => ({ setPosition: (q, m, off) => place(q, m, true, off ?? 0) }), []);

  useEffect(() => {
    let cancelled = false;
    let ro: ResizeObserver | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastW = 0;

    async function renderAll(loadXml: boolean, scrollAfter = false) {
      const osmd = osmdRef.current;
      if (!osmd || cancelled) return;
      const w = wrap.current?.clientWidth ?? 360;
      osmd.zoom = (w < 520 ? 0.62 : w < 900 ? 0.8 : 1) * zoomRef.current;
      if (loadXml) {
        // readings come without beams: let the engraver group eighths and sixteenths by beat
        osmd.setOptions({ autoBeam: !xml.includes('<beam') });
        await osmd.load(xml);
      }
      if (cancelled) return;
      osmd.render();
      measureBoxes(osmd);
      collect(osmd);
      lastW = w;
      const { q, measure, off } = lastPos.current;
      cur.current = 0;
      placed.current = { step: -1, measure: -1 };
      place(q, measure, false, off);
      setLayout((n) => n + 1);
      if (scrollAfter) {
        // after rotate / zoom the layout moved: put the cursor back in view once it has settled
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (!cancelled) autoScroll(osmd.cursor.cursorElement as HTMLElement | undefined, true);
        }));
      }
    }
    rerender.current = (scroll) => { renderAll(false, scroll).catch(() => {}); };

    (async () => {
      setBusy(true);
      try {
        if (!osmdRef.current) {
          const { OpenSheetMusicDisplay } = await import('opensheetmusicdisplay');
          if (cancelled || !host.current) return;
          osmdRef.current = new OpenSheetMusicDisplay(host.current, {
            autoResize: false,
            backend: 'svg',
            drawTitle: true,
            drawPartNames: false,
            followCursor: false,
            drawingParameters: 'compact',
            cursorsOptions: [{ type: 0, color: '#ff7a00', alpha: 0.75, follow: false }],
            // every written bar must stay visible (bar counter, highlight, cursor): no merged multi-bar rests
            autoGenerateMultipleRestMeasuresFromRestMeasures: false,
          });
          osmdRef.current.EngravingRules.RenderMultipleRestMeasures = false;
        }
        await renderAll(true);
        if (cancelled) return;
        setBusy(false);
        onReady?.({ measureCount: Math.max(0, steps.current.length - 1) });
        if (!ro && wrap.current) {
          ro = new ResizeObserver(() => {
            const w = wrap.current?.clientWidth ?? 0;
            if (Math.abs(w - lastW) < 8) return;
            clearTimeout(timer);
            timer = setTimeout(() => { renderAll(false, true).catch(() => {}); }, 200);
          });
          ro.observe(wrap.current);
        }
      } catch (e) {
        if (!cancelled) { setBusy(false); onError?.(`Could not draw this score: ${(e as Error).message}`); }
      }
    })();

    return () => { cancelled = true; clearTimeout(timer); ro?.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xml]);

  // zoom -/+: redraw at the new size and keep the cursor in view
  const firstZoom = useRef(true);
  useEffect(() => {
    if (firstZoom.current) { firstZoom.current = false; return; }
    const t = setTimeout(() => rerender.current?.(true), 120);
    return () => clearTimeout(t);
  }, [zoom]);

  function onClick(e: React.MouseEvent) {
    const h = host.current;
    if (!h || !boxes.current.length) return;
    const rect = h.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    let best = -1, bestD = Infinity;
    boxes.current.forEach((b, i) => {
      if (!b.w) return;
      const dx = x < b.x ? b.x - x : x > b.x + b.w ? x - (b.x + b.w) : 0;
      const dy = y < b.y ? b.y - y : y > b.y + b.h ? y - (b.y + b.h) : 0;
      const d = dx * dx + dy * dy * 4;
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best >= 0) seekRef.current(best + 1);
  }

  useEffect(() => {
    const unmount = () => { try { osmdRef.current?.clear?.(); } catch { /* ignore */ } };
    return unmount;
  }, []);

  return (
    <div className="score" ref={wrap} data-testid="score" data-busy={busy ? '1' : '0'}>
      {busy && <div className="score-busy"><span className="spinner" aria-hidden /> Drawing score…</div>}
      <div className="score-inner" onClick={onClick}>
        <div className="score-host" ref={host} />
        <div className="bar-hl" ref={hl} data-testid="bar-highlight" />
        {layout > 0 && (flagged ?? []).map((m) => {
          const b = boxes.current[m - 1];
          return b && b.w > 0 ? <div key={m} className="bar-flag" data-testid="bar-flag" style={{ transform: `translate(${b.x}px, ${b.y}px)`, width: b.w, height: b.h }} /> : null;
        })}
      </div>
    </div>
  );
});

export default ScoreView;
