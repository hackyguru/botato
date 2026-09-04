/**
 * The bodies bots are drawn in.
 *
 * A silhouette is not a path anybody typed. It is a radius that varies with
 * angle — `r(θ) = 1 + Σ harmonics + Σ lobes` — sampled and closed with a
 * Catmull-Rom spline, which is what makes every one of them smooth by
 * construction. There is no seam where two curves were spliced, because there
 * are no two curves.
 *
 * Two knobs, and both are continuous:
 *
 *   harmonics  a cosine round the whole body. k=1 leans it, k=2 ovals it, k=5
 *              gives it five soft sides. This is the difference between a
 *              pebble and an egg.
 *   lobes      one smooth bump at one angle. A wide one is a crest, a narrow
 *              one is a horn, a pair is ears, and a negative one is a bite
 *              taken out of the side.
 *
 * Which matters beyond looks: a bot asking to change its own shape sends three
 * numbers per feature rather than path data. A model is poor at beziers and
 * good at "a tall narrow bump near the top" — and whatever numbers come back,
 * the result still obeys the spec, because the spec is enforced here rather
 * than hoped for. Mass is normalised, curvature is continuous, and the eye line
 * is derived from the body that came out.
 */

/** A body: what its radius does, and where it is looking. */
export interface Silhouette {
  /** `[k, amplitude, phase]` — a cosine round the whole outline. */
  harmonics?: [number, number, number][];
  /** `[angle, amplitude, width]` — one smooth bump. Negative takes a bite. */
  lobes?: [number, number, number][];
  /** Both pupils together, as a fraction of body width. The only licence a
   *  character has, and the whole of what makes one look attentive and another
   *  dreamy. */
  gaze?: number;
}

const TAU = Math.PI * 2;
const TOP = -Math.PI / 2;

/** The family. Named for what you would call them out loud, because a shape
 *  you can name is a shape you can remember — which is the entire job. */
export const SILHOUETTES: Record<string, Silhouette> = {
  pebble: { harmonics: [[2, 0.06, 0.4], [3, 0.04, 1.2]] },
  drop: { lobes: [[TOP, 0.62, 0.5]] },
  bean: { harmonics: [[1, 0.11, 0.9], [2, 0.07, 0]], gaze: 0.014 },
  cloud: { lobes: [[-2.5, 0.2, 0.42], [TOP, 0.24, 0.42], [-0.64, 0.2, 0.42]], gaze: -0.01 },
  cat: { lobes: [[-2.1, 0.42, 0.24], [-1.05, 0.42, 0.24]] },
  hare: { lobes: [[-1.86, 0.68, 0.15], [-1.28, 0.68, 0.15]], gaze: 0.016 },
  horns: { lobes: [[-2.5, 0.4, 0.2], [-0.64, 0.4, 0.2]], gaze: -0.014 },
  crest: { lobes: [[-1.9, 0.52, 0.3]], harmonics: [[1, 0.05, 0]], gaze: 0.01 },
  tuft: { lobes: [[-1.9, 0.3, 0.17], [TOP, 0.34, 0.17], [-1.24, 0.3, 0.17]] },
  egg: { harmonics: [[1, 0.14, Math.PI / 2]], gaze: 0.008 },
  spike: { lobes: [[TOP, 0.9, 0.16]] },
  moon: { lobes: [[0.5, -0.36, 0.6]], harmonics: [[1, 0.07, 0]], gaze: -0.02 },
};

export const BODIES = Object.keys(SILHOUETTES);

/** What a body saved before this looked like, in the nearest thing that exists
 *  now. Six of the old heads were one square with a different corner radius,
 *  so there is not much to preserve — but a bot's face is not something an
 *  update should change more than it has to. */
const WAS: Record<string, string> = {
  circle: "pebble",
  squircle: "pebble",
  drop: "drop",
  bean: "bean",
  egg: "egg",
  shield: "crest",
};

/** Read a body name, whatever era it was written in. */
export function bodyOf(name: string | undefined): string {
  if (name && SILHOUETTES[name]) return name;
  if (name && WAS[name]) return WAS[name];
  return "pebble";
}

function radius(body: Silhouette, t: number): number {
  let r = 1;
  for (const [k, amp, phase] of body.harmonics ?? []) r += amp * Math.cos(k * t + phase);
  for (const [at, amp, width] of body.lobes ?? []) {
    // Wrapped to the nearest turn, or a lobe at the top tears where the angle
    // rolls over and the outline arrives back at a different radius.
    let d = t - at;
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    r += amp * Math.exp(-((d / width) ** 2));
  }
  return Math.max(0.16, r);
}

/** A drawn body: its outline, and where a face sits on it. */
export interface Drawn {
  /** The path, in a 100×100 box. */
  d: string;
  /** The eye line, as a percentage of that box — the optical centre of the
   *  body rather than the middle of the box, which for a teardrop or a pair of
   *  ears are a long way apart. */
  eyeY: number;
  /** How far apart the eyes go, as a percentage. */
  eyeGap: number;
}

const drawn = new Map<string, Drawn>();

/** Draw one, once. Twelve bodies and a roster that repaints constantly, so the
 *  work is done on first sight and never again. */
export function body(name: string): Drawn {
  const found = drawn.get(name);
  if (found) return found;

  const shape = SILHOUETTES[bodyOf(name)];
  const N = 96;
  const pts: [number, number][] = [];
  for (let i = 0; i < N; i++) {
    const t = (i / N) * TAU + TOP;
    const r = radius(shape, t);
    pts.push([Math.cos(t) * r, Math.sin(t) * r]);
  }

  // Area by the shoelace, so every body can be scaled to weigh the same.
  // Width would not do it: a body with ears is taller than it is heavy, and
  // matching widths makes it loom over the one beside it in a column.
  let area = 0;
  for (let i = 0; i < N; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % N];
    area += x1 * y2 - x2 * y1;
  }
  const scale = 44 / Math.sqrt(Math.abs(area) / 2 / Math.PI);

  const xs = pts.map((p) => p[0] * scale);
  const ys = pts.map((p) => p[1] * scale);
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  const dx = 50 - (left + right) / 2;
  const dy = 50 - (top + bottom) / 2;
  const p: [number, number][] = pts.map(([x, y]) => [x * scale + dx, y * scale + dy]);

  // Catmull-Rom through every sample, as cubics: each control point comes from
  // the neighbours, which is what makes the join at a sample smooth rather than
  // merely continuous.
  let d = `M${p[0][0].toFixed(2)} ${p[0][1].toFixed(2)}`;
  for (let i = 0; i < N; i++) {
    const p0 = p[(i - 1 + N) % N];
    const p1 = p[i];
    const p2 = p[(i + 1) % N];
    const p3 = p[(i + 2) % N];
    d +=
      `C${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(2)} ${(p1[1] + (p2[1] - p0[1]) / 6).toFixed(2)},` +
      `${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(2)} ${(p2[1] - (p3[1] - p1[1]) / 6).toFixed(2)},` +
      `${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
  }

  const made: Drawn = {
    d: d + "Z",
    // Six below the middle of the body's own box, which is where a face sits
    // on a creature: ears and points are above the eyes, never level with them.
    eyeY: 50 + (bottom - top) * 0.06,
    eyeGap: (right - left) * 0.13,
  };
  drawn.set(name, made);
  return made;
}

/** The gaze a body was given, in percent of the box. */
export const gazeOf = (name: string): number => (SILHOUETTES[bodyOf(name)]?.gaze ?? 0) * 100;
