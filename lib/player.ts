import { INSTRUMENTS, type InstrumentId } from './instruments';
import { measureAt, slotAt, firstQ, type Timeline } from './timeline';

export interface Click { timeQ: number; accent: boolean }

/** Metronome clicks for every beat of the score (beat unit follows the time signature). */
export function buildClicks(tl: Timeline): Click[] {
  const out: Click[] = [];
  let sigIdx = -1;
  for (let m = 0; m < tl.measureStartsQ.length; m++) {
    const written = tl.order[m] ?? m + 1;
    sigIdx = -1;
    while (sigIdx + 1 < tl.timeSigs.length && tl.timeSigs[sigIdx + 1].measure <= written) sigIdx++;
    const sig = sigIdx >= 0 ? tl.timeSigs[sigIdx] : { beats: 4, beatType: 4 };
    const beatQ = 4 / sig.beatType;
    const start = tl.measureStartsQ[m];
    const end = m + 1 < tl.measureStartsQ.length ? tl.measureStartsQ[m + 1] : tl.totalQ;
    for (let k = 0; start + k * beatQ < end - 1e-6; k++) out.push({ timeQ: start + k * beatQ, accent: k === 0 });
  }
  return out;
}

/** Length in quarters of written bar `measure` (used for the count-in). */
export function barLengthQ(tl: Timeline, measure: number): number {
  const slot = tl.order.indexOf(Math.max(1, Math.min(tl.measureCount, measure)));
  const i = Math.max(0, slot);
  const end = i + 1 < tl.measureStartsQ.length ? tl.measureStartsQ[i + 1] : tl.totalQ;
  return end - tl.measureStartsQ[i];
}

interface Voice {
  start(note: { note: number; time: number; duration: number; velocity: number }): void;
  stop(): void;
}

/** Small oscillator synth used when the sample soundfont cannot be loaded. */
class SynthVoice implements Voice {
  private active = new Set<{ osc: OscillatorNode; gain: GainNode }>();
  constructor(private ctx: AudioContext, private out: AudioNode) {}
  start({ note, time, duration, velocity }: { note: number; time: number; duration: number; velocity: number }) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.value = 440 * Math.pow(2, (note - 69) / 12);
    filter.type = 'lowpass';
    filter.frequency.value = 1800;
    const peak = 0.18 * velocity;
    const end = time + Math.max(0.05, duration);
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(peak, time + 0.03);
    gain.gain.setValueAtTime(peak * 0.8, Math.max(time + 0.03, end - 0.05));
    gain.gain.linearRampToValueAtTime(0, end + 0.06);
    osc.connect(filter); filter.connect(gain); gain.connect(this.out);
    osc.start(time);
    osc.stop(end + 0.08);
    const h = { osc, gain };
    this.active.add(h);
    osc.onended = () => { this.active.delete(h); try { gain.disconnect(); } catch { /* ignore */ } };
  }
  stop() {
    for (const h of this.active) {
      try {
        h.gain.gain.cancelScheduledValues(0);
        h.gain.gain.setValueAtTime(0, this.ctx.currentTime);
        h.osc.stop(this.ctx.currentTime + 0.01);
      } catch { /* ignore */ }
    }
    this.active.clear();
  }
}

const LOOKAHEAD_S = 0.25;
const TICK_MS = 25;
const LOAD_TIMEOUT_MS = 12000;

export class Player {
  metronome = false;
  countIn = false;
  /** `measure` is the WRITTEN bar; `offsetQ` the distance in quarters from the start of the bar being played. */
  onPosition: (q: number, measure: number, offsetQ: number) => void = () => {};
  onEnd: () => void = () => {};
  onState: (playing: boolean) => void = () => {};
  /** Which sound engine is active after load(). */
  engine: 'soundfont' | 'synth' | 'none' = 'none';

  private voice: Voice | null = null;
  private tl: Timeline | null = null;
  private clicks: Click[] = [];
  private bpm = 100;
  private playing = false;
  private posQ = 0; // position when paused
  private anchorQ = 0; // quarters at anchorTime
  private anchorTime = 0; // ctx time when q == anchorQ
  private startQ = 0; // first q that sounds notes (after count-in)
  private nextEvent = 0;
  private nextClick = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private raf = 0;
  private loadToken = 0;
  private master: GainNode;
  private clickBus: GainNode;

  constructor(private ctx: AudioContext) {
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(ctx.destination);
    this.clickBus = ctx.createGain();
    this.clickBus.gain.value = 0.5;
    this.clickBus.connect(ctx.destination);
    this.voice = new SynthVoice(ctx, this.master); // placeholder until samples arrive
  }

  get isPlaying() { return this.playing; }
  get currentBpm() { return this.bpm; }

  /** Load the instrument's samples; falls back to a synth if the CDN is unreachable. */
  async load(id: InstrumentId): Promise<'soundfont' | 'synth'> {
    const token = ++this.loadToken;
    const wasPlaying = this.playing;
    let voice: Voice | null = null;
    let engine: 'soundfont' | 'synth' = 'synth';
    try {
      const { Soundfont } = await import('smplr');
      const inst = Soundfont(this.ctx, { instrument: INSTRUMENTS[id].sample, kit: 'MusyngKite', destination: this.master });
      await Promise.race([
        inst.ready,
        new Promise((_, rej) => setTimeout(() => rej(new Error('soundfont load timeout')), LOAD_TIMEOUT_MS)),
      ]);
      voice = {
        start: ({ note, time, duration, velocity }) => { inst.start({ note, time, duration, velocity: Math.round(velocity * 127) }); },
        stop: () => inst.stop(),
      };
      engine = 'soundfont';
    } catch {
      voice = new SynthVoice(this.ctx, this.master);
    }
    if (token !== this.loadToken) return engine; // a newer load superseded this one
    this.voice?.stop();
    this.voice = voice;
    this.engine = engine;
    if (wasPlaying) this.restartFrom(this.currentQ());
    return engine;
  }

  setTimeline(tl: Timeline) {
    const q = this.tl ? this.currentQ() : 0;
    const m = this.tl ? measureAt(this.tl, q) : 1;
    const wasPlaying = this.playing;
    this.stopSound();
    this.tl = tl;
    this.clicks = buildClicks(tl);
    // keep the user's place by bar number when the score is re-derived (instrument switch)
    this.posQ = firstQ(tl, m);
    if (wasPlaying) this.restartFrom(this.posQ, false);
    else this.emit(this.posQ);
  }

  get measure(): number { return this.tl ? measureAt(this.tl, this.currentQ()) : 1; }
  /** Number of written bars. */
  get measureCount(): number { return this.tl?.measureCount ?? 0; }

  /** Current position in quarter notes, derived from the audio clock while playing. */
  currentQ(): number {
    if (!this.playing) return this.posQ;
    const q = this.anchorQ + ((this.ctx.currentTime - this.anchorTime) * this.bpm) / 60;
    return Math.max(this.startQ, Math.min(q, this.tl?.totalQ ?? q));
  }

  async play(fromMeasure?: number) {
    if (!this.tl) return;
    if (this.ctx.state !== 'running') { try { await this.ctx.resume(); } catch { /* ignore */ } }
    let q = fromMeasure ? firstQ(this.tl, fromMeasure) : this.posQ;
    if (q >= this.tl.totalQ - 1e-6) q = 0;
    this.restartFrom(q, this.countIn);
  }

  pause() {
    if (!this.playing) return;
    this.posQ = this.currentQ();
    this.stopSound();
    this.setPlaying(false);
    this.emit(this.posQ);
  }

  /** Jump to the first time written bar `measure` is played. */
  seek(measure: number) {
    if (!this.tl) return;
    this.seekQ(firstQ(this.tl, measure));
  }

  /** Move by played bars (follows repeats): -1 previous, +1 next. */
  stepBar(delta: number) {
    if (!this.tl) return;
    const slot = Math.max(0, Math.min(this.tl.measureStartsQ.length - 1, slotAt(this.tl, this.currentQ()) + delta));
    this.seekQ(this.tl.measureStartsQ[slot]);
  }

  private seekQ(q: number) {
    if (this.playing) this.restartFrom(q, false);
    else { this.posQ = q; this.emit(q); }
  }

  setBpm(n: number) {
    const bpm = Math.max(30, Math.min(240, Math.round(n)));
    if (bpm === this.bpm) return;
    if (this.playing) {
      const q = this.currentQ();
      this.bpm = bpm;
      // re-anchor so position is unchanged; already-scheduled lookahead notes are re-issued
      this.restartFrom(q, false);
    } else this.bpm = bpm;
  }

  dispose() {
    this.stopSound();
    this.setPlaying(false);
    try { this.master.disconnect(); this.clickBus.disconnect(); } catch { /* ignore */ }
  }

  // --- internals ---

  private setPlaying(p: boolean) {
    if (this.playing !== p) { this.playing = p; this.onState(p); }
  }

  private emit(q: number) {
    if (!this.tl) return;
    const slot = slotAt(this.tl, q);
    this.onPosition(q, this.tl.order[slot] ?? 1, Math.max(0, q - (this.tl.measureStartsQ[slot] ?? 0)));
  }

  private stopSound() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
    this.voice?.stop();
  }

  private restartFrom(q: number, withCountIn = false) {
    if (!this.tl) return;
    this.stopSound();
    const now = this.ctx.currentTime;
    const lead = 0.06;
    const m = measureAt(this.tl, q);
    const countQ = withCountIn ? barLengthQ(this.tl, m) : 0;
    this.startQ = q;
    this.anchorQ = q - countQ;
    this.anchorTime = now + lead;
    this.posQ = q;
    this.nextEvent = this.tl.events.findIndex((e) => e.timeQ >= q - 1e-6);
    if (this.nextEvent < 0) this.nextEvent = this.tl.events.length;
    this.nextClick = this.clicks.findIndex((c) => c.timeQ >= q - 1e-6);
    if (this.nextClick < 0) this.nextClick = this.clicks.length;
    this.countInQ = countQ;
    this.countInPending = countQ > 0;
    this.countInNext = 0;
    this.setPlaying(true);
    this.tick();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    const frame = () => {
      if (!this.playing) return;
      const cq = this.currentQ();
      this.emit(cq);
      if (this.tl && cq >= this.tl.totalQ - 1e-6 && this.nextEvent >= this.tl.events.length) {
        this.finish();
        return;
      }
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  private countInQ = 0;
  private countInPending = false;
  private countInNext = 0;

  private finish() {
    const end = this.tl?.totalQ ?? 0;
    this.stopSound();
    this.posQ = 0;
    this.setPlaying(false);
    this.emit(this.posQ);
    void end;
    this.onEnd();
  }

  private timeOf(q: number) { return this.anchorTime + ((q - this.anchorQ) * 60) / this.bpm; }

  private tick() {
    if (!this.tl || !this.playing) return;
    const horizon = this.ctx.currentTime + LOOKAHEAD_S;
    const spq = 60 / this.bpm;
    // count-in clicks (always audible) before the start position
    if (this.countInPending) {
      const beatQ = this.tl.timeSigs.length ? 4 / (this.tl.timeSigs.filter((s) => s.measure <= measureAt(this.tl!, this.startQ)).pop()?.beatType ?? 4) : 1;
      while (this.countInNext * beatQ < this.countInQ - 1e-6) {
        const t = this.anchorTime + this.countInNext * beatQ * spq;
        if (t > horizon) return;
        this.click(t, this.countInNext === 0);
        this.countInNext++;
      }
      this.countInPending = false;
    }
    const ev = this.tl.events;
    while (this.nextEvent < ev.length) {
      const e = ev[this.nextEvent];
      const t = this.timeOf(e.timeQ);
      if (t > horizon) break;
      const when = Math.max(t, this.ctx.currentTime);
      this.voice?.start({ note: e.midi, time: when, duration: Math.max(0.05, e.durQ * spq * 0.97), velocity: 0.8 });
      this.nextEvent++;
    }
    if (this.metronome) {
      while (this.nextClick < this.clicks.length) {
        const c = this.clicks[this.nextClick];
        const t = this.timeOf(c.timeQ);
        if (t > horizon) break;
        this.click(Math.max(t, this.ctx.currentTime), c.accent);
        this.nextClick++;
      }
    } else {
      // keep the pointer moving so enabling the metronome mid-play doesn't burst old clicks
      while (this.nextClick < this.clicks.length && this.timeOf(this.clicks[this.nextClick].timeQ) < this.ctx.currentTime) this.nextClick++;
    }
  }

  private click(time: number, accent: boolean) {
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.frequency.value = accent ? 1500 : 1000;
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(accent ? 0.9 : 0.6, time + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
    osc.connect(g); g.connect(this.clickBus);
    osc.start(time);
    osc.stop(time + 0.06);
  }
}
