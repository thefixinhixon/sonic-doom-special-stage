// AudioWorklet that plays DOOM MUS music through the OPL2 emulator.
import { MusPlayer } from './opl.js';

class OplMusProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.player = new MusPlayer(new Uint8Array(options.processorOptions.genmidi), sampleRate);
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'play') this.player.play(new Uint8Array(m.mus), m.loop !== false);
      else if (m.type === 'stop') this.player.stop();
      else if (m.type === 'fade') this.player.fade();
    };
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const l = out[0];
    const r = out[1] || out[0];
    // always render so released notes can decay after a stop
    this.player.render(l, r, l.length);
    return true;
  }
}

registerProcessor('opl-mus', OplMusProcessor);
