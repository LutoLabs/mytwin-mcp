// voice-pcm-worklet.js
// Runs on the audio RENDER thread (not the main thread). Downsamples the mic
// from the context sample rate to linear16 / 16 kHz mono and posts Int16 chunks
// to the main thread, which forwards them to Deepgram. Moving this off the main
// thread is what keeps Safari from beach-balling (ScriptProcessorNode did it on
// the main thread).
class PcmTapProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    const outRate = opts.outRate || 16000;
    // `sampleRate` is a global in AudioWorkletGlobalScope (the context's rate).
    this._ratio = sampleRate / outRate;
    this._chunk = Math.max(256, Math.round(outRate * 0.08)); // ~80ms per post
    this._buf = new Int16Array(this._chunk);
    this._n = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const ch = input && input[0];
    if (!ch || ch.length === 0) return true;   // keep processor alive
    const ratio = this._ratio;
    for (let i = 0; i < ch.length; i += ratio) {
      let v = ch[i | 0];
      v = v < -1 ? -1 : v > 1 ? 1 : v;
      this._buf[this._n++] = v < 0 ? v * 0x8000 : v * 0x7FFF;   // Int16Array truncates
      if (this._n >= this._buf.length) {
        const out = this._buf.slice(0, this._n);                // copy to transfer
        this.port.postMessage(out.buffer, [out.buffer]);
        this._n = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-tap', PcmTapProcessor);
