'use client';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';

export interface ScoreViewHandle {
  /** Move the cursor + bar highlight to quarter-note position q. */
  setPosition: (q: number, measure: number) => void;
}

interface Props {
  xml: string;
  onSeekMeasure: (measure: number) => void;
  onReady?: (info: { measureCount: number }) => void;
  onError?: (msg: string) => void;
}

interface Step { q: number; measure: number }
interface Box { x: number; y: number; w: number; h: number }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Osmd = any;

const UNIT = 10; // OSMD units are 10px at zoom 1

const ScoreView = forwardRef<ScoreViewHandle, Props>(function ScoreView({ xml, onSeekMeasure, onReady, onError }, ref) {
  const wrap = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const hl = useRef<HTMLDivElement>(null);
  const osmdRef = useRef<Osmd>(null);
  const steps = useRef<Step[]>([]);
  const boxes = useRef<Box[]>([]);
  const cur = useRef(-1);
  const lastPos = useRef<{ q: number; measure: number }>({ q: 0, measure: 1 });
  const lastSystemY = useRef(-1);
  const [busy, setBusy] = useState(true);
  const seekRef = useRef(onSeekMeasure);
  seekRef.current = onSeekMeasure;

  function collect(osmd: Osmd) {
    const c = osmd.cursor;
    c.show();
    c.reset();
    const out: Step[] = [];
    let guard = 0;
    while (!c.iterator.EndReached && guard++ < 200000) {
      const q = c.iterator.currentTimeStamp.RealValue * 4;
      const measure = c.iterator.CurrentMeasureIndex + 1;
      const prev = out[out.length - 1];
      if (prev && q <= prev.q + 1e-9) break; // repeat jump or duplicate: stop at first pass
      out.push({ q, measure });
      c.next();
    }
    c.reset();
    steps.current = out;
    cur.current = 0;
  }

  function measureBoxes(osmd: Osmd) {
    const list: Box[] = [];
    const zoom = osmd.zoom ?? 1;
    const ml = osmd.GraphicSheet.MeasureList as Array<Array<{ PositionAndShape: { AbsolutePosition: { x: number; y: number }; BorderLeft: number; BorderRight: number; BorderTop: number; BorderBottom: number } } | undefined>>;
    ml.forEach((staves, i) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const gm of staves) {
        if (!gm) continue;
        const p = gm.PositionAndShape;
        x0 = Math.min(x0, p.AbsolutePosition.x + p.BorderLeft);
        x1 = Math.max(x1, p.AbsolutePosition.x + p.BorderRight);
        y0 = Math.min(y0, p.AbsolutePosition.y + p.BorderTop);
        y1 = Math.max(y1, p.AbsolutePosition.y + p.BorderBottom);
      }
      if (x0 === Infinity) { list[i] = { x: 0, y: 0, w: 0, h: 0 }; return; }
      list[i] = { x: x0 * UNIT * zoom, y: y0 * UNIT * zoom, w: (x1 - x0) * UNIT * zoom, h: (y1 - y0) * UNIT * zoom };
    });
    boxes.current = list;
  }

  function place(q: number, measure: number, scroll: boolean) {
    lastPos.current = { q, measure };
    const osmd = osmdRef.current;
    if (!osmd || !steps.current.length) return;
    const s = steps.current;
    // last step with q <= target
    let lo = 0, hi = s.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (s[mid].q <= q + 1e-6) lo = mid; else hi = mid - 1; }
    const c = osmd.cursor;
    if (lo !== cur.current) {
      if (lo < cur.current) { c.reset(); cur.current = 0; }
      while (cur.current < lo) { c.next(); cur.current++; }
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
    if (scroll) autoScroll(c.cursorElement as HTMLElement | undefined);
  }

  function autoScroll(el?: HTMLElement) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (!r.height) return;
    const top = r.top + window.scrollY;
    const vh = window.innerHeight;
    const bottomBand = vh - 190; // keep clear of the sticky transport
    const sysChanged = Math.abs(top - lastSystemY.current) > 20;
    lastSystemY.current = top;
    if (r.top < 70 || r.bottom > bottomBand || sysChanged && (r.top > vh * 0.55)) {
      window.scrollTo({ top: Math.max(0, top - vh * 0.28), behavior: 'smooth' });
    }
  }

  useImperativeHandle(ref, () => ({ setPosition: (q, m) => place(q, m, true) }), []);

  useEffect(() => {
    let cancelled = false;
    let ro: ResizeObserver | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastW = 0;

    async function renderAll(loadXml: boolean) {
      const osmd = osmdRef.current;
      if (!osmd || cancelled) return;
      const w = wrap.current?.clientWidth ?? 360;
      osmd.zoom = w < 520 ? 0.62 : w < 900 ? 0.8 : 1;
      if (loadXml) await osmd.load(xml);
      if (cancelled) return;
      osmd.render();
      measureBoxes(osmd);
      collect(osmd);
      lastW = w;
      const { q, measure } = lastPos.current;
      cur.current = 0;
      place(q, measure, false);
    }

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
          });
        }
        await renderAll(true);
        if (cancelled) return;
        setBusy(false);
        onReady?.({ measureCount: steps.current.length ? Math.max(...steps.current.map((s) => s.measure)) : 0 });
        if (!ro && wrap.current) {
          ro = new ResizeObserver(() => {
            const w = wrap.current?.clientWidth ?? 0;
            if (Math.abs(w - lastW) < 8) return;
            clearTimeout(timer);
            timer = setTimeout(() => { renderAll(false).catch(() => {}); }, 200);
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
      {busy && <div className="score-busy">Drawing score…</div>}
      <div className="score-inner" onClick={onClick}>
        <div className="score-host" ref={host} />
        <div className="bar-hl" ref={hl} data-testid="bar-highlight" />
      </div>
    </div>
  );
});

export default ScoreView;
