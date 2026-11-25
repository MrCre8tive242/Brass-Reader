// Copies the microphone samples to the page (raw PCM, no encoder delay), 128 frames at a time.
// It stops for good when the page says so: a processor that keeps answering "true" stays alive (and running)
// for as long as the audio context does, one more for every recording made.
class PcmRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.done = false;
    this.port.onmessage = (e) => { if (e.data === 'stop') this.done = true; };
  }
  process(inputs) {
    if (this.done) return false;
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('pcm-recorder', PcmRecorder);
