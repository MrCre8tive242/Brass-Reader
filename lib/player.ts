import { INSTRUMENTS, type InstrumentId } from './instruments';
import { measureAt, slotAt, firstQ, type Timeline } from './timeline';
import { unlockAudio, releaseAudio } from './audioUnlock';
import { trainerBpm, type Trainer } from './loop';

export interface Click { timeQ: number; accent: boolean }

type Sig = { beats: number; beatType: number };

function sigAt(tl: Timeline, written: number): Sig {
  let sig: Sig = { beats: 4, beatType: 4 };
  for (const s of tl.timeSigs) { if (s.measure <= written) sig = s; else break; }
  return sig;
}

/** Length of one metronome beat in quarters: the dotted quarter in 6/8, 9/8, 12/8 (felt in two, three, four). */
export function beatLengthQ(sig: Sig): number {
  return sig.beatType === 8 && sig.beats % 3 === 0 && sig.beats > 3 ? 1.5 : 4 / sig.beatType;
}

/** Metronome clicks for every beat of the score (beat unit follows the time signature). */
export function buildClicks(tl: Timeline): Click[] {
  const out: Click[] = [];
  for (let m = 0; m < tl.measureStartsQ.length; m++) {
    const sig = sigAt(tl, tl.order[m] ?? m + 1);
    const beatQ = beatLengthQ(sig);
    const nominal = (4 * sig.beats) / sig.beatType;
    const start = tl.measureStartsQ[m];
    const end = m + 1 < tl.measureStartsQ.length ? tl.measureStartsQ[m + 1] : tl.totalQ;
    // a pickup is the END of a bar: its beats line up with the next downbeat and none of them is beat one
    const lead = m === 0 && end - start < nominal - 1e-6 ? nominal - (end - start) : 0;
    for (let k = Math.ceil(lead / beatQ - 1e-6); k * beatQ - lead < end - start - 1e-6; k++) {
      out.push({ timeQ: start + k * beatQ - lead, accent: k === 0 });
    }
  }
  return out;
}

/** Length in quarters of written bar `measure` (the first time it is played). */
export function barLengthQ(tl: Timeline, measure: number): number {
  const slot = tl.order.indexOf(Math.max(1, Math.min(tl.measureCount, measure)));
  const i = Math.max(0, slot);
  const end = i + 1 < tl.measureStartsQ.length ? tl.measureStartsQ[i + 1] : tl.totalQ;
  return end - tl.measureStartsQ[i];
}

/**
 * Count-in clicks before starting at written bar `measure`, as offsets in quarters before the start (most
 * negative first). One full bar; before a pickup the count runs up to the pickup ("1 2 3" then the pickup on 4),
 * with a whole extra bar in front if that would be fewer than two clicks.
 */
export function countInClicks(tl: Timeline, measure: number): { offsetQ: number; accent: boolean }[] {
  const sig = sigAt(tl, measure);
  const beatQ = beatLengthQ(sig);
  const nominal = (4 * sig.beats) / sig.beatType;
  const len = barLengthQ(tl, measure);
  const pickup = measure === 1 && len < nominal - 1e-6;
  let total = pickup ? nominal - len : nominal;
  if (pickup && Math.round(total / beatQ) < 2) total += nominal;
  const out: { offsetQ: number; accent: boolean }[] = [];
  // beat positions are counted from the downbeat of the (first) counted bar
  const barStart = pickup ? -(Math.ceil(total / nominal - 1e-6) * nominal - len) : -nominal;
  for (let k = 0; barStart + k * beatQ < -1e-6; k++) {
    const off = barStart + k * beatQ;
    if (off < -total - 1e-6) continue;
    const inBar = ((k * beatQ) % nominal + nominal) % nominal;
    out.push({ offsetQ: off, accent: inBar < 1e-6 });
  }
  return out;
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
  /** The browser refused to start the audio (no user gesture, or the phone interrupted it). */
  onBlocked: () => void = () => {};
  /** Which sound engine is active after load(). */
  engine: 'soundfont' | 'synth' | 'none' = 'none';
  /** A loop pass became audible: pass number (1-based) and the tempo it plays at. */
  onPass: (pass: number, bpm: number) => void = () => {};

  private voice: Voice | null = null;
  private tl: Timeline | null = null;
  private clicks: Click[] = [];
  private bpm = 100;
  private playing = false;
  private posQ = 0; // position when paused
  private anchorQ = 0; // quarters at anchorTime
  private anchorTime = 0; // ctx time when q == anchorQ
  private startQ = 0; // first q that sounds notes (after count-in)
  private minQ = 0; // lowest position the clock may report (start of the current pass)
  private passStartQ = 0; // where the current pass began (held notes are re-attacked here)
  private loop: { startQ: number; endQ: number } | null = null;
  private loopActive = false;
  private trainer: Trainer | null = null;
  private pass = 1;
  private prevEndQ = 0; // end of the loop the audio is still finishing while the next pass is already scheduled
  private prevBpm = 100;
  private pendingPass: { at: number; pass: number; bpm: number }[] = [];
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
    // a phone call, Siri or the lock screen suspends the audio clock: stop cleanly instead of freezing mid-bar
    try {
      ctx.addEventListener?.('statechange', () => { if (this.playing && this.ctx.state !== 'running') this.pause(); });
    } catch { /* ignore */ }
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
      const { Soundfont, CacheStorage } = await import('smplr');
      // keep downloaded samples in the browser cache: rehearsal rooms often have no signal
      let storage: InstanceType<typeof CacheStorage> | undefined;
      try { storage = new CacheStorage('brass-reader-sounds'); } catch { storage = undefined; }
      const inst = Soundfont(this.ctx, { instrument: INSTRUMENTS[id].sample, kit: 'MusyngKite', destination: this.master, ...(storage ? { storage } : {}) });
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
    // swap sounds without losing the place: sounding notes are re-attacked on the new instrument
    if (wasPlaying || this.playing) this.restartFrom(this.currentQ(), false, 0);
    return engine;
  }

  setTimeline(tl: Timeline) {
    const q = this.tl ? this.currentQ() : 0;
    const m = this.tl ? measureAt(this.tl, q) : 1;
    const wasPlaying = this.playing;
    // same bar layout (instrument switch only changes pitches): keep the exact position
    const prev = this.tl;
    const sameLayout = !!prev && prev.measureStartsQ.length === tl.measureStartsQ.length
      && prev.measureStartsQ.every((v, i) => Math.abs(v - tl.measureStartsQ[i]) < 1e-6);
    const keepQ = sameLayout ? q : firstQ(tl, m);
    this.stopSound();
    this.tl = tl;
    this.clicks = buildClicks(tl);
    this.posQ = keepQ;
    if (wasPlaying) this.restartFrom(this.posQ, false, sameLayout ? 0 : undefined);
    else this.emit(this.posQ);
  }

  get measure(): number { return this.tl ? measureAt(this.tl, this.currentQ()) : 1; }
  /** Number of written bars. */
  get measureCount(): number { return this.tl?.measureCount ?? 0; }

  /**
   * Seconds between scheduling a sound and hearing it (audio hardware, Bluetooth speakers). The cursor is drawn
   * this much behind the scheduling clock so that it matches what is heard.
   */
  outputDelay(): number {
    const c = this.ctx as AudioContext & { outputLatency?: number; baseLatency?: number };
    const d = (Number.isFinite(c.outputLatency) ? c.outputLatency! : 0) + (Number.isFinite(c.baseLatency) ? c.baseLatency! : 0);
    return Math.max(0, Math.min(0.5, d));
  }

  /** Current position in quarter notes, derived from the audio clock while playing. */
  currentQ(): number {
    if (!this.playing) return this.posQ;
    const t = this.ctx.currentTime;
    // the next loop pass is scheduled a little ahead of the audio: until it begins we are still in the last bar of the previous pass
    if (this.loopActive && this.pendingPass.length && t < this.anchorTime) {
      return Math.max(this.minQ, this.prevEndQ - ((this.anchorTime - t) * this.prevBpm) / 60);
    }
    const q = this.anchorQ + ((t - this.anchorTime) * this.bpm) / 60;
    return Math.max(this.minQ, Math.min(q, this.tl?.totalQ ?? q));
  }

  /**
   * Start playing. Must be called from a tap/click/key handler (browsers only start audio there).
   * Returns false if the browser kept the audio blocked.
   */
  async play(fromMeasure?: number): Promise<boolean> {
    if (!this.tl) return false;
    unlockAudio(this.ctx); // synchronously, still inside the gesture
    if (this.ctx.state !== 'running') { try { await this.ctx.resume(); } catch { /* ignore */ } }
    if (this.ctx.state !== 'running') { this.onBlocked(); return false; }
    let q = fromMeasure ? firstQ(this.tl, fromMeasure) : this.posQ;
    if (q >= this.tl.totalQ - 1e-6) q = 0;
    // with a loop set, play always begins inside it
    if (this.loop && (q < this.loop.startQ - 1e-6 || q >= this.loop.endQ - 1e-6)) q = this.loop.startQ;
    this.restartFrom(q, this.countIn, 0.06, true);
    return true;
  }

  pause() {
    if (!this.playing) return;
    this.posQ = Math.max(this.minQ, this.currentQ());
    this.stopSound();
    this.setPlaying(false);
    releaseAudio();
    this.emit(this.posQ);
  }

  /** Repeat the quarter-note range seamlessly (null = no loop). The count-in only happens before the first pass. */
  setLoop(range: { startQ: number; endQ: number } | null) {
    this.loop = range && range.endQ > range.startQ ? { ...range } : null;
    if (!this.playing) return;
    const q = this.currentQ();
    this.loopActive = !!this.loop && q >= this.loop.startQ - 1e-6 && q < this.loop.endQ - 1e-6;
  }

  /** Speed trainer: with a loop running, the tempo steps up after the set number of passes. */
  setTrainer(t: Trainer | null) {
    this.trainer = t && t.enabled ? { ...t } : null;
  }

  get loopPass() { return this.pass; }

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
      // re-anchor so position is unchanged (no lead, so rapid changes do not drift); notes that are
      // sounding at q are re-attacked with their remaining length, lookahead notes are re-issued
      this.restartFrom(q, false, 0);
    } else this.bpm = bpm;
  }

  dispose() {
    this.stopSound();
    this.setPlaying(false);
    releaseAudio();
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

  private restartFrom(q: number, withCountIn = false, lead = 0.06, newRun = false) {
    if (!this.tl) return;
    this.stopSound();
    this.loopActive = !!this.loop && q >= this.loop.startQ - 1e-6 && q < this.loop.endQ - 1e-6;
    this.pendingPass = [];
    if (newRun) {
      this.pass = 1;
      if (this.loopActive && this.trainer) this.bpm = trainerBpm(this.trainer, 1);
    }
    const now = this.ctx.currentTime;
    const m = measureAt(this.tl, q);
    this.countClicks = withCountIn ? countInClicks(this.tl, m) : [];
    const countQ = this.countClicks.length ? -this.countClicks[0].offsetQ : 0;
    this.startQ = q;
    this.minQ = q;
    this.passStartQ = q;
    this.anchorQ = q - countQ;
    this.anchorTime = now + lead;
    this.posQ = q;
    this.nextEvent = this.tl.events.findIndex((e) => e.timeQ >= q - 1e-6);
    if (this.nextEvent < 0) this.nextEvent = this.tl.events.length;
    // notes already sounding at q (started earlier, still held): re-attack with the remaining length
    this.held = [];
    for (let i = 0; i < this.nextEvent; i++) {
      const e = this.tl.events[i];
      const remQ = e.timeQ + e.durQ - q;
      if (remQ > 0.02) this.held.push({ midi: e.midi, remQ });
    }
    this.nextClick = this.clicks.findIndex((c) => c.timeQ >= q - 1e-6);
    if (this.nextClick < 0) this.nextClick = this.clicks.length;
    this.countInPending = countQ > 0;
    this.countInNext = 0;
    this.setPlaying(true);
    if (newRun && this.loopActive) this.onPass(this.pass, this.bpm);
    this.tick();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    const frame = () => {
      if (!this.playing) return;
      const cq = this.currentQ();
      // a new loop pass has started to be heard: tell the screen (pass number, new tempo)
      while (this.pendingPass.length && this.ctx.currentTime >= this.pendingPass[0].at) {
        const pp = this.pendingPass.shift()!;
        this.onPass(pp.pass, pp.bpm);
      }
      // show what is being HEARD now, not what was just scheduled
      this.emit(Math.max(this.minQ, cq - (this.outputDelay() * this.bpm) / 60));
      if (!this.loopActive && this.tl && cq >= this.tl.totalQ - 1e-6 && this.nextEvent >= this.tl.events.length) {
        this.finish();
        return;
      }
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  private held: { midi: number; remQ: number }[] = [];
  private countClicks: { offsetQ: number; accent: boolean }[] = [];
  private countInPending = false;
  private countInNext = 0;

  private finish() {
    const end = this.tl?.totalQ ?? 0;
    void end;
    this.stopSound();
    this.posQ = 0;
    this.setPlaying(false);
    releaseAudio();
    this.emit(this.posQ);
    this.onEnd();
  }

  private timeOf(q: number) { return this.anchorTime + ((q - this.anchorQ) * 60) / this.bpm; }

  private tick() {
    if (!this.tl || !this.playing) return;
    const horizon = this.ctx.currentTime + LOOKAHEAD_S;
    // count-in clicks (always audible) before the start position
    if (this.countInPending) {
      while (this.countInNext < this.countClicks.length) {
        const c = this.countClicks[this.countInNext];
        const t = this.timeOf(this.startQ + c.offsetQ);
        if (t > horizon) return;
        this.click(Math.max(t, this.ctx.currentTime), c.accent);
        this.countInNext++;
      }
      this.countInPending = false;
    }
    // one pass of scheduling; with a loop, a pass ends at the loop end and the next one is anchored exactly there (no gap)
    for (let guard = 0; guard < 8; guard++) {
      this.scheduleUntil(horizon);
      if (!(this.loopActive && this.loop) || this.timeOf(this.loop.endQ) > horizon) break;
      this.wrapLoop();
    }
  }

  private scheduleUntil(horizon: number) {
    if (!this.tl) return;
    const spq = 60 / this.bpm;
    const endQ = this.loopActive && this.loop ? this.loop.endQ : Infinity;
    if (this.held.length && this.timeOf(this.passStartQ) <= horizon) {
      const when = Math.max(this.timeOf(this.passStartQ), this.ctx.currentTime);
      for (const h of this.held) this.play1(h.midi, when, Math.max(0.05, Math.min(h.remQ, endQ - this.passStartQ) * spq * 0.97), 0);
      this.held = [];
    }
    const ev = this.tl.events;
    while (this.nextEvent < ev.length) {
      const e = ev[this.nextEvent];
      if (e.timeQ >= endQ - 1e-6) break;
      const t = this.timeOf(e.timeQ);
      if (t > horizon) break;
      const when = Math.max(t, this.ctx.currentTime);
      // a note that runs past the loop end is cut at the end
      const durQ = Math.min(e.durQ, endQ - e.timeQ);
      this.play1(e.midi, when, Math.max(0.05, durQ * spq * 0.97), e.part ?? 0);
      this.nextEvent++;
    }
    if (this.metronome) {
      while (this.nextClick < this.clicks.length) {
        const c = this.clicks[this.nextClick];
        if (c.timeQ >= endQ - 1e-6) break;
        const t = this.timeOf(c.timeQ);
        if (t > horizon) break;
        this.click(Math.max(t, this.ctx.currentTime), c.accent);
        this.nextClick++;
      }
    } else {
      // keep the pointer moving so enabling the metronome mid-play doesn't burst old clicks
      while (this.nextClick < this.clicks.length && this.clicks[this.nextClick].timeQ < endQ - 1e-6 && this.timeOf(this.clicks[this.nextClick].timeQ) < this.ctx.currentTime) this.nextClick++;
    }
  }

  /** The loop end has been scheduled: begin the next pass exactly at the end time, possibly at a faster tempo. */
  private wrapLoop() {
    if (!this.tl || !this.loop) return;
    const tEnd = this.timeOf(this.loop.endQ);
    this.prevEndQ = this.loop.endQ;
    this.prevBpm = this.bpm;
    this.pass++;
    if (this.trainer) {
      const next = trainerBpm(this.trainer, this.pass);
      if (next !== trainerBpm(this.trainer, this.pass - 1)) this.bpm = next;
    }
    const sq = this.loop.startQ;
    this.anchorQ = sq;
    this.anchorTime = tEnd;
    this.minQ = sq;
    this.passStartQ = sq;
    this.nextEvent = this.tl.events.findIndex((e) => e.timeQ >= sq - 1e-6);
    if (this.nextEvent < 0) this.nextEvent = this.tl.events.length;
    this.nextClick = this.clicks.findIndex((c) => c.timeQ >= sq - 1e-6);
    if (this.nextClick < 0) this.nextClick = this.clicks.length;
    this.held = [];
    for (let i = 0; i < this.nextEvent; i++) {
      const e = this.tl.events[i];
      const remQ = e.timeQ + e.durQ - sq;
      if (remQ > 0.02) this.held.push({ midi: e.midi, remQ });
    }
    this.pendingPass.push({ at: tEnd, pass: this.pass, bpm: this.bpm });
  }

  private play1(note: number, time: number, duration: number, part: number) {
    this.voice?.start({ note, time, duration, velocity: 0.8 });
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
