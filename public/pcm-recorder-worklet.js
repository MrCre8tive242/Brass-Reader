// Copies the microphone samples to the page (raw PCM, no encoder delay), 128 frames at a time.
class PcmRecorder extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('pcm-recorder', PcmRecorder);
