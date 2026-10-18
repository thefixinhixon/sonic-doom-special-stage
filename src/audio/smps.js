// The Mega Drive sound hardware running Sonic 2's own Z80 sound driver:
// Z80 + YM2612 + SN76489, fed from the ROM. Produces stereo float samples.
import { Z80 } from './z80.js';
import { YM2612 } from './ym2612.js';
import { SN76489 } from './sn76489.js';
import { saxman } from '../sega/compress.js';
import { ROM } from '../sega/romdata.js';

const Z80_CLOCK = 3579545;
const YM_CLOCK = 7670453;
const YM_RATE = YM_CLOCK / 144;
const FRAME_RATE = 59.922743;
const ZVAR = 0x1b80;
const QUEUE_TO_PLAY = ZVAR + 8;
const QUEUE0 = ZVAR + 9;
const STOP_MUSIC = ZVAR + 3;

export class SoundMachine {
  constructor(rom, outRate) {
    this.rom = rom;
    this.outRate = outRate;
    this.driver = saxman(rom, ROM.soundDriver.off, ROM.soundDriver.len);
    this.pending = [];
    this.pendingSfx = [];
    this.reset();
  }

  reset() {
    this.ram = new Uint8Array(0x2000);
    this.ram.set(this.driver.subarray(0, 0x2000));
    this.bank = 0;
    this.ym = new YM2612();
    this.psg = new SN76489(Z80_CLOCK);
    this.z80 = new Z80(
      (a) => this.read(a),
      (a, v) => this.write(a, v),
    );
    this.cycleAcc = 0;
    this.frameAcc = 0;
    this.intCycles = 0;
    this.ymPos = 0;
    this.prev = [0, 0];
    this.cur = [0, 0];
    this.tmp = [0, 0];
    this.volume = 1;
    this.fade = 0;
    this.silent = false;
  }

  read(a) {
    if (a < 0x4000) return this.ram[a & 0x1fff];
    if (a < 0x6000) return this.ym.read();
    if (a < 0x8000) return 0xff;
    const addr = (this.bank << 15) | (a & 0x7fff);
    return addr < this.rom.length ? this.rom[addr] : 0xff;
  }

  write(a, v) {
    if (a < 0x4000) this.ram[a & 0x1fff] = v;
    else if (a < 0x6000) this.ym.write(a & 3, v);
    else if (a < 0x6100) this.bank = ((this.bank >> 1) | ((v & 1) << 8)) & 0x1ff;
    else if (a === 0x7f11) this.psg.write(v);
  }

  // 68000 side (sndDriverInput), run once per video frame
  frameTick() {
    const r = this.ram;
    if (r[QUEUE_TO_PLAY] === 0x80 && this.pending.length) {
      const id = this.pending.shift();
      if (id >= 0xfe) r[STOP_MUSIC] = id - 0xfe + 0x7f;
      else r[QUEUE_TO_PLAY] = id;
    }
    for (let i = 0; i < 3 && this.pendingSfx.length; i++) {
      if (!r[QUEUE0 + i]) r[QUEUE0 + i] = this.pendingSfx.shift();
    }
  }

  play(id) {
    if (id === 0xfd) {
      // full stop: restart the driver for a clean slate
      this.reset();
      return;
    }
    this.silent = false;
    this.pending.push(id);
  }
  sfx(id) {
    this.pendingSfx.push(id);
  }

  // Advance the hardware by one YM2612 sample.
  stepYM() {
    // Z80 cycles per YM sample
    this.cycleAcc += Z80_CLOCK / YM_RATE;
    const n = Math.floor(this.cycleAcc);
    if (n > 0) {
      this.cycleAcc -= this.z80.run(n);
      if (this.intCycles > 0) {
        this.intCycles -= n;
        if (this.intCycles <= 0) this.z80.intLine = false;
      }
    }
    this.frameAcc += 1;
    if (this.frameAcc >= YM_RATE / FRAME_RATE) {
      this.frameAcc -= YM_RATE / FRAME_RATE;
      this.frameTick();
      this.z80.intLine = true;
      this.intCycles = 228;
    }
    this.prev[0] = this.cur[0];
    this.prev[1] = this.cur[1];
    this.ym.clock(this.tmp);
    this.cur[0] = this.tmp[0];
    this.cur[1] = this.tmp[1];
  }

  // Render `n` output samples into left/right Float32Arrays.
  render(left, right, n) {
    const step = YM_RATE / this.outRate;
    const scale = 1 / 16384;
    for (let i = 0; i < n; i++) {
      this.ymPos += step;
      while (this.ymPos >= 1) {
        this.stepYM();
        this.ymPos -= 1;
      }
      const t = this.ymPos;
      left[i] = (this.prev[0] + (this.cur[0] - this.prev[0]) * t) * scale;
      right[i] = (this.prev[1] + (this.cur[1] - this.prev[1]) * t) * scale;
    }
    const psgBuf = this.psgBuf && this.psgBuf.length >= n ? this.psgBuf : (this.psgBuf = new Float32Array(n));
    psgBuf.fill(0, 0, n);
    this.psg.render(psgBuf, 0, n, this.outRate);
    for (let i = 0; i < n; i++) {
      left[i] = (left[i] + psgBuf[i]) * this.volume;
      right[i] = (right[i] + psgBuf[i]) * this.volume;
    }
  }
}
