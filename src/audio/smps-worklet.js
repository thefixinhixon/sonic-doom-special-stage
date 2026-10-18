// AudioWorklet that runs the Mega Drive sound hardware with Sonic 2's driver.
import { SoundMachine } from './smps.js';

class SmpsProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const rom = new Uint8Array(options.processorOptions.rom);
    this.machine = new SoundMachine(rom, sampleRate);
    this.active = false;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'play') {
        this.machine.play(m.id);
        this.active = true;
      } else if (m.type === 'sfx') {
        this.machine.sfx(m.id);
        this.active = true;
      } else if (m.type === 'stop') {
        this.machine.play(0xfd);
        this.active = false;
      } else if (m.type === 'volume') {
        this.machine.volume = m.value;
      }
    };
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const l = out[0];
    const r = out[1] || out[0];
    if (!this.active) {
      l.fill(0);
      if (r !== l) r.fill(0);
      return true;
    }
    this.machine.render(l, r, l.length);
    return true;
  }
}

registerProcessor('smps', SmpsProcessor);
