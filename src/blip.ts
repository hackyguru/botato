/**
 * The sound a bot makes when you pick it up.
 *
 * Synthesised, like the music under setup and for the same reasons: a file
 * would mean shipping audio in a binary that is proud of being small, and this
 * is two oscillators and an envelope. It weighs nothing and there is no loop
 * point to hear.
 *
 * Every bot has its own note, taken from the same seed its face is taken from,
 * so the one that looks a particular way also sounds a particular way and the
 * two agree. The notes come from the pentatonic the setup music already uses —
 * nothing in it can sound wrong against anything else in it, which matters
 * when somebody clicks four bots in two seconds.
 *
 * Short and quiet on purpose. A boop is a confirmation, not an event: it
 * should be under the pointer and gone, and it should never be the loudest
 * thing in the room. Cute is a rising note and a soft one — a bubble rather
 * than a beep.
 */

/** A4 = 440, equal temperament, note numbers as MIDI. */
const hz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

/** The same C pentatonic the music picks its bells from, an octave down: a
 *  roster of these played in any order is a phrase rather than a pile. */
const NOTES = [60, 62, 64, 67, 69, 72, 74];

/** One context for the life of the window. Making one per click leaks them —
 *  a browser allows a handful and then refuses — and they cannot be created
 *  before a gesture anyway, which a click is. */
let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  return ctx;
}

/**
 * Boop the note that belongs to `seed`.
 *
 * A bend rather than a pluck, because that is the difference between a
 * confirmation and a creature. The pitch starts a fourth below and slides up
 * into the note over seventy milliseconds — a rising tone is the shape of a
 * question and of a small friendly thing noticing you, and it is why a bubble
 * popping sounds cheerful and a door closing does not.
 *
 * Sines only, and a lowpass over both: anything with harmonics in it at this
 * length reads as a beep from a machine. The octave above is there for a
 * little air and is quiet enough that nobody would name it if asked what they
 * heard.
 */
export function blip(seed: number): void {
  const at = audio();
  if (!at) return;
  // Suspended is what a context becomes when the window loses focus; a click
  // is a gesture, so it is allowed to wake up.
  if (at.state === "suspended") void at.resume();

  const note = NOTES[Math.abs(seed) % NOTES.length];
  const now = at.currentTime;
  const top = hz(note);

  const gain = at.createGain();
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.07, now + 0.012);
  // Exponential, and never quite to zero: a ramp to zero is a click, which is
  // the one sound this is trying not to make.
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);

  const soft = at.createBiquadFilter();
  soft.type = "lowpass";
  soft.frequency.setValueAtTime(2400, now);
  soft.Q.value = 0.6;

  const body = at.createOscillator();
  body.type = "sine";
  // Up a fourth, in a curve rather than a straight line: pitch is heard
  // logarithmically, so a linear slide sounds like it slows down at the top.
  body.frequency.setValueAtTime(top * 0.75, now);
  body.frequency.exponentialRampToValueAtTime(top, now + 0.07);

  const air = at.createOscillator();
  air.type = "sine";
  air.frequency.setValueAtTime(top * 1.5, now);
  air.frequency.exponentialRampToValueAtTime(top * 2, now + 0.07);
  const airGain = at.createGain();
  airGain.gain.setValueAtTime(0.22, now);
  airGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.11);

  body.connect(gain);
  air.connect(airGain).connect(gain);
  gain.connect(soft).connect(at.destination);

  body.start(now);
  air.start(now);
  body.stop(now + 0.24);
  air.stop(now + 0.24);
}
