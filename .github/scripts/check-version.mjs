// The version lives in three files and a tag names a fourth. A release whose app
// reports a different version than its tag is the kind of thing nobody notices
// until they are trying to reproduce a bug, so it is checked on every push.
//
//   node check-version.mjs            → the three files must agree
//   node check-version.mjs v0.2.0     → and must match the tag
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(join(root, path), "utf8");

const found = {
  "package.json": JSON.parse(read("package.json")).version,
  "src-tauri/tauri.conf.json": JSON.parse(read("src-tauri/tauri.conf.json")).version,
  "src-tauri/Cargo.toml": read("src-tauri/Cargo.toml").match(/^version\s*=\s*"([^"]+)"/m)?.[1],
};

const problems = [];
const versions = new Set(Object.values(found));
if (versions.size !== 1) {
  problems.push(
    "these disagree:\n" +
      Object.entries(found)
        .map(([file, version]) => `    ${version ?? "missing"}  ${file}`)
        .join("\n"),
  );
}

const tag = process.argv[2];
if (tag) {
  const wanted = tag.replace(/^v/, "");
  const [version] = versions;
  if (version !== wanted) {
    problems.push(`tag ${tag} does not match the app's version ${version}`);
  }
}

if (problems.length) {
  console.error("Version check failed:\n  " + problems.join("\n  "));
  console.error("\nBump all three, commit, then tag.");
  process.exit(1);
}

console.log(`Version ${[...versions][0]} is consistent${tag ? ` and matches ${tag}` : ""}.`);
