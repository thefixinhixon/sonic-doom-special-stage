// Audio front end: DOOM sound effects through WebAudio, and two music
// engines running in AudioWorklets (Sonic 2's own Z80 sound driver, and an
// OPL2 player for DOOM's MUS tracks).

export class Audio {
  constructor() {
    this.ctx = null;
    this.buffers = new Map();
    this.musicNode = null;
    this.sfxGain = null;
    this.musicGain = null;
    this.smps = null;
    this.opl = null;
    this.ready = false;
    this.current = null;
    this.muted = false;
  }

  // Must be called from a user gesture.
  async start(rom, art) {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.art = art;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    this.sfxGain = ctx.createGain();
    this.sfxGain.gain.value = 0.6;
    this.sfxGain.connect(this.master);
    this.musicGain = ctx.createGain();
    this.musicGain.gain.value = 0.55;
    this.musicGain.connect(this.master);
    try {
      await ctx.audioWorklet.addModule(new URL('./smps-worklet.js', import.meta.url));
      this.smps = new AudioWorkletNode(ctx, 'smps', { outputChannelCount: [2], processorOptions: { rom } });
      this.smps.connect(this.musicGain);
    } catch (e) {
      console.warn('Sonic music unavailable:', e);
    }
    try {
      await ctx.audioWorklet.addModule(new URL('./opl-worklet.js', import.meta.url));
      const genmidi = art.lump('GENMIDI');
      this.opl = new AudioWorkletNode(ctx, 'opl-mus', { outputChannelCount: [2], processorOptions: { genmidi } });
      this.opl.connect(this.musicGain);
    } catch (e) {
      console.warn('DOOM music unavailable:', e);
    }
    this.ready = true;
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 1;
  }

  buffer(name) {
    let b = this.buffers.get(name);
    if (b === undefined) {
      const s = this.art.sound(name);
      if (!s || !s.samples.length) b = null;
      else {
        b = this.ctx.createBuffer(1, s.samples.length, s.rate);
        b.copyToChannel(s.samples, 0);
      }
      this.buffers.set(name, b);
    }
    return b;
  }

  sfx(name, { volume = 1, rate = 1, pan = 0 } = {}) {
    if (!this.ctx || !name) return;
    const b = this.buffer(name);
    if (!b) return;
    const src = this.ctx.createBufferSource();
    src.buffer = b;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = volume;
    let node = g;
    if (pan && this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = pan;
      g.connect(p);
      node = p;
    }
    src.connect(g);
    node.connect(this.sfxGain);
    src.start();
  }

  // Sonic 2 music by sound ID (e.g. 0x92 special stage, 0x9D emerald)
  sonicMusic(id) {
    this.stopDoomMusic();
    this.current = { kind: 'sonic', id };
    this.smps?.port.postMessage({ type: 'play', id });
  }
  sonicCommand(id) {
    this.smps?.port.postMessage({ type: 'play', id });
  }

  // Roland SC-55 renderings made by tools/render_sc55.mjs, if present
  async loadTrack(lump) {
    if (!this.tracks) this.tracks = new Map();
    if (this.tracks.has(lump)) return this.tracks.get(lump);
    const p = (async () => {
      try {
        const r = await fetch(`assets/music/${lump}.ogg`);
        if (!r.ok) return null;
        return await this.ctx.decodeAudioData(await r.arrayBuffer());
      } catch {
        return null;
      }
    })();
    this.tracks.set(lump, p);
    return p;
  }

  async doomMusic(lump, loop = true) {
    this.smps?.port.postMessage({ type: 'stop' });
    this.stopDoomMusic();
    this.current = { kind: 'doom', lump };
    const buf = await this.loadTrack(lump);
    if (this.current?.lump !== lump) return; // something else started meanwhile
    if (buf) {
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = loop;
      const g = this.ctx.createGain();
      g.gain.value = 1.6;
      src.connect(g);
      g.connect(this.musicGain);
      src.start();
      this.doomSrc = { src, gain: g };
      return;
    }
    // fall back to the OPL2 (AdLib) synth
    const data = this.art.lump(lump);
    if (data) this.opl?.port.postMessage({ type: 'play', mus: data.slice(), loop });
  }
  stopDoomMusic() {
    this.opl?.port.postMessage({ type: 'stop' });
    if (this.doomSrc) {
      try {
        this.doomSrc.src.stop();
      } catch {}
      this.doomSrc = null;
    }
  }

  fadeOut() {
    if (!this.current) return;
    if (this.current.kind === 'sonic') this.smps?.port.postMessage({ type: 'play', id: 0xf9 });
    else if (this.doomSrc) {
      const { src, gain } = this.doomSrc;
      const t = this.ctx.currentTime;
      gain.gain.setValueAtTime(gain.gain.value, t);
      gain.gain.linearRampToValueAtTime(0, t + 1.5);
      src.stop(t + 1.6);
      this.doomSrc = null;
    } else this.opl?.port.postMessage({ type: 'fade' });
    this.current = null;
  }

  stopAll() {
    this.smps?.port.postMessage({ type: 'stop' });
    this.stopDoomMusic();
    this.current = null;
  }

  // Decode the next stage's track ahead of time
  preload(lump) {
    if (this.ctx && lump) this.loadTrack(lump);
  }
}
