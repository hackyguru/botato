// Whether a release being published is newer than the manifest already served.
//
// A release can be published out of order — an old one re-published to fix its
// notes, or a patch cut on an old branch after a newer version went out. The
// updater takes whatever the manifest says, so publishing either one would walk
// every install backwards into a version they have already left.
//
//   node manifest-newer.mjs current.json new.json
//
// Sets SKIP=1 in GITHUB_ENV when the new one is not newer, which is what the
// workflow's `if:` reads. Says nothing to stdout that is not worth reading in a
// log, because this runs on every publish and is boring almost every time.
import { readFileSync, appendFileSync } from "node:fs";

/** Three numbers, and anything that is not one is a zero — the same rule the
 *  app itself uses, so a tag the app would ignore is a tag this refuses to
 *  publish rather than the two disagreeing about what is newer. */
export function parts(version) {
  const clean = String(version ?? "").trim().replace(/^v/, "");
  let core = "";
  for (const ch of clean) {
    if (/[0-9.]/.test(ch)) core += ch;
    else break;
  }
  const bits = core.split(".").map((n) => (/^\d+$/.test(n) ? Number(n) : 0));
  while (bits.length < 3) bits.push(0);
  return bits.slice(0, 3);
}

export function newer(than, candidate) {
  const a = parts(candidate);
  const b = parts(than);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

const [, , currentPath, nextPath] = process.argv;
if (currentPath && nextPath) {
  const version = (p) => JSON.parse(readFileSync(p, "utf8")).version;
  const old = version(currentPath);
  const next = version(nextPath);
  if (newer(old, next)) {
    console.log(`${old} -> ${next}`);
  } else {
    console.log(`::notice::${next} is not newer than the published ${old}. Nothing to do.`);
    if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, "SKIP=1\n");
  }
}
