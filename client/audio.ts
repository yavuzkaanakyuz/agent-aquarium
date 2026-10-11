import type { Mood } from '../shared/protocol';

/**
 * Fully synthesized audio, no files: calm, endlessly varying background music,
 * Animal Crossing-style babble in each inhabitant's own voice when they talk,
 * and a few small effects. Browsers only allow audio to start after a user click.
 */

const PENTA = [0, 2, 4, 7, 9]; // major pentatonic (semitones)
// I – vi – IV – V (C major), root notes (C4 = 60)
const PROGRESSION = [
  [48, 55, 60, 64],
  [45, 52, 57, 60],
  [41, 48, 53, 57],
  [43, 50, 55, 59],
];
const midi = (n: number) => 440 * 2 ** ((n - 69) / 12);

export interface VoiceOptions {
  seed: number; // per-inhabitant voice color
  mood: Mood;
  child: boolean;
  golem: boolean;
  pan: number; // -1..1
  gain: number; // 0..1 (distance)
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private musicBus!: GainNode;
  private voiceBus!: GainNode;
  private reverb!: ConvolverNode;
  private nextBeat = 0;
  private beat = 0;
  private timer: number | null = null;
  private night = false;
  private voicesNow = 0;

  enabled = false;
  musicVolume = 0.5;
  voiceVolume = 0.8;

  /** Must be called from a user click. */
  async enable() {
    if (!this.ctx) this.build();
    await this.ctx!.resume();
    this.enabled = true;
    this.applyVolumes();
    if (this.timer == null) {
      this.nextBeat = this.ctx!.currentTime + 0.1;
      this.timer = window.setInterval(() => this.schedule(), 100);
    }
  }

  disable() {
    this.enabled = false;
    if (this.ctx) this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.2);
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  setNight(night: boolean) {
    this.night = night;
  }

  applyVolumes() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.enabled ? 0.9 : 0, t, 0.2);
    this.musicBus.gain.setTargetAtTime(this.musicVolume * 0.35, t, 0.3);
    this.voiceBus.gain.setTargetAtTime(this.voiceVolume * 0.6, t, 0.1);
  }

  private build() {
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(ctx.destination);
    this.musicBus = ctx.createGain();
    this.voiceBus = ctx.createGain();
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(2.4);
    const wet = ctx.createGain();
    wet.gain.value = 0.35;
    this.musicBus.connect(this.master);
    this.musicBus.connect(this.reverb);
    this.voiceBus.connect(this.master);
    this.reverb.connect(wet).connect(this.master);
  }

  /** Synthetic reverb: exponentially decaying noise. */
  private impulse(seconds: number) {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
    }
    return buf;
  }

  // ---------- music ----------
  private schedule() {
    const ctx = this.ctx!;
    const beatLen = this.night ? 0.95 : 0.7;
    while (this.nextBeat < ctx.currentTime + 0.4) {
      this.playBeat(this.beat, this.nextBeat, beatLen);
      this.nextBeat += beatLen;
      this.beat++;
    }
  }

  private playBeat(beat: number, t: number, beatLen: number) {
    const bar = Math.floor(beat / 8) % PROGRESSION.length;
    const chord = PROGRESSION[bar];
    const step = beat % 8;
    if (step === 0) {
      // Pad chord and bass
      for (const n of chord.slice(1)) this.pad(midi(n), t, beatLen * 8);
      this.pluck(midi(chord[0] - 12), t, 1.2, 0.18, 'sine');
    }
    // Arpeggio: denser by day, sparse at night; always near the pentatonic
    const density = this.night ? 0.35 : 0.65;
    if (Math.random() < density) {
      const root = chord[0] + 12;
      const note = root + PENTA[Math.floor(Math.random() * PENTA.length)] + (Math.random() < 0.3 ? 12 : 0);
      this.pluck(midi(note), t + (Math.random() < 0.2 ? beatLen / 2 : 0), 0.9, this.night ? 0.06 : 0.09, 'triangle');
    }
    // An occasional little bell
    if (step === 4 && Math.random() < 0.25) this.pluck(midi(chord[3] + 24), t, 2, 0.03, 'sine');
  }

  private pad(freq: number, t: number, dur: number) {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = this.night ? 600 : 1100;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.05, t + dur * 0.3);
    g.gain.linearRampToValueAtTime(0, t + dur);
    for (const detune of [-6, 6]) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = freq;
      o.detune.value = detune;
      o.connect(f);
      o.start(t);
      o.stop(t + dur + 0.1);
    }
    f.connect(g).connect(this.musicBus);
  }

  private pluck(freq: number, t: number, dur: number, vol: number, type: OscillatorType) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.musicBus);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  // ---------- speech ----------
  /** "Says" the text as short syllable-like blips with shifting pitch. */
  speak(text: string, v: VoiceOptions) {
    if (!this.enabled || !this.ctx || v.gain <= 0.02 || this.voicesNow > 4) return;
    const ctx = this.ctx;
    const chars = [...text.replace(/\s+/g, '')];
    const emojiOnly = chars.length <= 3;
    const syllables = emojiOnly ? 1 : Math.min(14, Math.max(2, Math.round(chars.length / 3)));

    // Per-inhabitant base pitch (≈ 200–420 Hz), shifted by mood
    const moodShift = { joy: 3, fear: 4, anger: -4, sadness: -3, loneliness: -2, pride: 1, calm: 0 }[v.mood];
    const speed = { joy: 0.8, fear: 0.7, anger: 0.85, sadness: 1.35, loneliness: 1.2, pride: 1, calm: 1 }[v.mood];
    const base = 200 * 2 ** (((v.seed % 13) + moodShift + (v.child ? 6 : 0)) / 12);
    const wave: OscillatorType = v.golem ? 'square' : v.mood === 'anger' ? 'sawtooth' : 'triangle';

    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, v.pan));
    const out = ctx.createGain();
    out.gain.value = v.gain * (emojiOnly ? 0.5 : 1) * (v.golem ? 0.35 : 1);
    out.connect(panner).connect(this.voiceBus);

    let t = ctx.currentTime + 0.02;
    const step = 0.075 * speed;
    this.voicesNow++;
    for (let i = 0; i < syllables; i++) {
      const o = ctx.createOscillator();
      const formant = ctx.createBiquadFilter();
      const g = ctx.createGain();
      o.type = wave;
      // Syllable pitch: pentatonic jumps + a slight fall at the end (unless it's a question)
      const semis = PENTA[Math.floor(Math.random() * PENTA.length)] - (i === syllables - 1 && !text.includes('?') ? 3 : 0);
      const f0 = base * 2 ** (semis / 12);
      o.frequency.setValueAtTime(f0 * 1.04, t);
      o.frequency.exponentialRampToValueAtTime(f0, t + step * 0.6);
      formant.type = 'bandpass';
      formant.frequency.value = 700 + Math.random() * 1200; // different "vowels"
      formant.Q.value = 1.4;
      const len = step * (0.7 + Math.random() * 0.3);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.5, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.001, t + len);
      o.connect(formant).connect(g).connect(out);
      o.connect(g); // mix in a bit of dry signal
      o.start(t);
      o.stop(t + len + 0.02);
      t += step + (Math.random() < 0.15 ? step * 0.8 : 0); // occasional word gap
    }
    setTimeout(() => this.voicesNow--, (t - ctx.currentTime) * 1000 + 50);
  }

  // ---------- effects ----------
  sfx(kind: 'hit' | 'tap' | 'munch' | 'chime', pan: number, gain: number) {
    if (!this.enabled || !this.ctx || gain <= 0.02) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.01;
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    const out = ctx.createGain();
    out.gain.value = gain * 0.6;
    out.connect(panner).connect(this.voiceBus);
    if (kind === 'chime') {
      for (const [i, n] of [72, 76, 79].entries()) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = midi(n);
        g.gain.setValueAtTime(0, t + i * 0.08);
        g.gain.linearRampToValueAtTime(0.25, t + i * 0.08 + 0.01);
        g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.08 + 0.6);
        o.connect(g).connect(out);
        o.start(t + i * 0.08);
        o.stop(t + i * 0.08 + 0.7);
      }
      return;
    }
    // Short noise-based sounds
    const dur = kind === 'hit' ? 0.18 : kind === 'munch' ? 0.09 : 0.05;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 2;
    const repeats = kind === 'munch' ? 3 : 1;
    for (let r = 0; r < repeats; r++) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const f = ctx.createBiquadFilter();
      f.type = kind === 'hit' ? 'lowpass' : 'bandpass';
      f.frequency.value = kind === 'hit' ? 500 : kind === 'munch' ? 1800 : 2600;
      const g = ctx.createGain();
      g.gain.value = kind === 'hit' ? 0.9 : 0.5;
      src.connect(f).connect(g).connect(out);
      src.start(t + r * 0.12);
    }
  }
}
