/**
 * The music under the setup carousel.
 *
 * Synthesised rather than shipped. A file would mean licensing something,
 * carrying a megabyte of audio in a binary that is proud of being eleven, and
 * having a loop point somebody can hear — and botcage already prefers making a
 * thing on the machine to downloading one. This is a few oscillators and a
 * delay line, and it weighs nothing.
 *
 * What it plays: I–V–vi–IV in C, six seconds a chord, which is the progression
 * every hopeful song is built on. A pad holds the chord, a bell picks out notes
 * from the pentatonic above it, and a lowpass takes the edge off everything. It
 * is quiet on purpose — the loudest it gets is about a tenth of full scale.
 *
 * Nothing starts without a gesture, because a browser will not allow it and
 * because a first launch that makes noise before you have touched anything is
 * a first launch that took a liberty. Everything fades; nothing stops dead.
 */

/** A4 = 440, equal temperament, note numbers as MIDI. */
const hz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

/** C major, G major, A minor, F major — as MIDI note numbers. */
const CHORDS = [
  [48, 55, 64, 67], // C  E  G
  [43, 50, 59, 67], // G  B  D
  [45, 52, 60, 64], // Am C  E
  [41, 48, 57, 65], // F  A  C
];

/** C pentatonic, an octave and a half of it: nothing in here can sound wrong
 *  over any of the four chords, which is the whole reason to pick one. */
const BELLS = [72, 74, 76, 79, 81, 84, 86];

const CHORD_SECONDS = 6;

export class Music {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private timer: number | null = null;
  /** Set while the tail is still ringing, to let go of the speaker after it. */
  private idle: number | null = null;
  private bar = 0;
  private stopped = true;

  /** Whether anything is currently playing. */
  get playing(): boolean {
    return !this.stopped;
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;

    if (this.idle !== null) {
      window.clearTimeout(this.idle);
      this.idle = null;
    }

    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = this.ctx ?? new Ctor();
    this.ctx = ctx;
    // Opened from a click, so this resolves — but a window restored into setup
    // has had no gesture yet, and then it simply waits.
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});

    const out = ctx.createGain();
    out.gain.value = 0;
    // Two seconds to arrive. Music that starts at full volume is a noise.
    out.gain.linearRampToValueAtTime(0.1, ctx.currentTime + 2);

    const soft = ctx.createBiquadFilter();
    soft.type = "lowpass";
    soft.frequency.value = 2000;
    soft.Q.value = 0.4;

    // A delay rather than a reverb: one line with a little feedback gives the
    // room, and an impulse response would be the audio file this avoids.
    const echo = ctx.createDelay(1);
    echo.delayTime.value = 0.45;
    const back = ctx.createGain();
    back.gain.value = 0.28;
    const wet = ctx.createGain();
    wet.gain.value = 0.3;

    soft.connect(out);
    soft.connect(echo);
    echo.connect(back);
    back.connect(echo);
    echo.connect(wet);
    wet.connect(out);
    out.connect(ctx.destination);

    this.out = out;
    (this as unknown as { soft: BiquadFilterNode }).soft = soft;

    this.bar = 0;
    this.tick();
  }

  /** Fade out and let the tail ring, rather than cutting it. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;

    const { ctx, out } = this;
    if (!ctx || !out) return;
    out.gain.cancelScheduledValues(ctx.currentTime);
    out.gain.setValueAtTime(out.gain.value, ctx.currentTime);
    out.gain.linearRampToValueAtTime(0, ctx.currentTime + 1.2);
    this.out = null;

    // Then let go of the audio device. A context left running holds the
    // speaker open for as long as the app is, and macOS counts an open output
    // as something worth staying awake for — which is a lot to ask on behalf
    // of a dialog nobody has looked at since Tuesday. Suspended rather than
    // closed, because closing it means a new one and another gesture to
    // resume it; `start` wakes this one back up.
    this.idle = window.setTimeout(() => {
      this.idle = null;
      if (this.stopped) void ctx.suspend().catch(() => {});
    }, 1500);
  }

  /** One chord, and the bells over it, then schedule the next. */
  private tick(): void {
    const ctx = this.ctx;
    const soft = (this as unknown as { soft?: BiquadFilterNode }).soft;
    if (!ctx || !soft || this.stopped) return;

    const at = ctx.currentTime + 0.05;
    const chord = CHORDS[this.bar % CHORDS.length];

    for (const note of chord) {
      this.pad(soft, hz(note), at);
      // A second oscillator a few cents off, which is the whole difference
      // between a pad and a test tone.
      this.pad(soft, hz(note) * 1.004, at, 0.6);
    }

    // Two or three bells a bar, never on the beat.
    const many = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < many; i += 1) {
      const when = at + 0.6 + Math.random() * (CHORD_SECONDS - 1.4);
      this.bell(soft, hz(BELLS[Math.floor(Math.random() * BELLS.length)]), when);
    }

    this.bar += 1;
    this.timer = window.setTimeout(() => this.tick(), CHORD_SECONDS * 1000);
  }

  private pad(to: AudioNode, freq: number, at: number, level = 1): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = 0;
    // Long in, long out, and overlapping the next chord — so the harmony
    // changes underneath you rather than in front of you.
    g.gain.linearRampToValueAtTime(0.05 * level, at + 1.6);
    g.gain.setValueAtTime(0.05 * level, at + CHORD_SECONDS - 1.2);
    g.gain.linearRampToValueAtTime(0, at + CHORD_SECONDS + 0.8);
    osc.connect(g);
    g.connect(to);
    osc.start(at);
    osc.stop(at + CHORD_SECONDS + 1);
  }

  private bell(to: AudioNode, freq: number, at: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = 0;
    // Struck, then a long decay: a short attack is what makes it read as a
    // note being played rather than a tone being switched on.
    g.gain.linearRampToValueAtTime(0.07, at + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 3.2);
    osc.connect(g);
    g.connect(to);
    osc.start(at);
    osc.stop(at + 3.3);
  }
}
