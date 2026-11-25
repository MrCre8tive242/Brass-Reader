import { openMic, type Mic } from './pitchMic';

/** One microphone shared by everything that needs it (pitch check, recording). Closed when the last user lets go. */
export class MicSession {
  private mic: Mic | null = null;
  private opening: Promise<Mic> | null = null;
  private users = 0;
  private listeners = new Set<(live: boolean) => void>();

  /** Called with true when the microphone opens and false when it closes (for the "mic is on" light). */
  subscribe(fn: (live: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
  private emit() { const live = this.mic !== null; for (const fn of this.listeners) fn(live); }

  async acquire(ctx: AudioContext): Promise<Mic> {
    this.users++;
    try {
      if (!this.mic) {
        this.opening ??= openMic(ctx);
        this.mic = await this.opening;
        this.opening = null;
        this.emit();
      }
      return this.mic;
    } catch (e) {
      this.users = Math.max(0, this.users - 1);
      this.opening = null;
      throw e;
    }
  }

  release() {
    this.users = Math.max(0, this.users - 1);
    if (this.users === 0 && this.mic) { this.mic.stop(); this.mic = null; this.emit(); }
  }

  get active() { return this.users > 0; }
}
