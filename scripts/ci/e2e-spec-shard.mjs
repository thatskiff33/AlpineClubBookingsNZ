import { readdirSync } from "node:fs";
import path from "node:path";

import { E2E_SPEC_SECONDS } from "./e2e-spec-durations.mjs";
import { escapeRegex } from "./escape-regex.mjs";

// #4397: which `chromium` spec files one E2E shard runs. Playwright's own
// `--shard` cannot split this suite: `pre-setup` depends on `chromium`, which
// depends on `setup`, and a sharded run keeps a dependency chain whole, so
// shard 1 received all 203 tests and the others none. Each shard instead gets
// its own stack and database and a slice of the spec FILES, chosen here and
// applied as the project's `testMatch` (a CLI file filter would not hold:
// Playwright runs a project's dependencies in full whatever the filter).
//
// Files are dealt by measured duration (e2e-spec-durations.mjs), longest first,
// each to the shard with the least time so far; shard 1 starts already charged
// with the `pre-setup` specs it alone runs. The deal is a pure function of the
// tree and the durations file, so every shard computes the same partition. It
// replaced a round-robin by name, which left the slowest shard about a minute
// behind the fastest on 27 Oct 2026.

/** `E2E_SHARD=i/N`, or null when unset (an ordinary, unsharded run). */
export function parseE2eShard(value) {
  if (value === undefined || value === "") return null;
  const match = /^([1-9]\d?)\/([1-9]\d?)$/.exec(value);
  if (!match || Number(match[1]) > Number(match[2])) throw new Error(`Invalid E2E_SHARD: ${value} (expected i/N)`);
  return { index: Number(match[1]), total: Number(match[2]) };
}

/**
 * Playwright's own default `testMatch`: what a project picks up when the
 * config names no pattern, which is how `chromium` is declared. One
 * definition, so a file Playwright would run is never missing from every
 * shard.
 */
export const PLAYWRIGHT_TEST_FILE = /\.(?:spec|test)\.[cm]?[jt]sx?$/;
/** The test-dir subfolders that belong to other projects, never `chromium`. */
export const MULTI_LODGE_DIR = "multi-lodge";
export const PRE_SETUP_DIR = "pre-setup";
export const NOT_CHROMIUM_DIRS = [MULTI_LODGE_DIR, PRE_SETUP_DIR];
const NOT_CHROMIUM_RELATIVE = new RegExp(`^(?:${NOT_CHROMIUM_DIRS.join("|")})/`);

/**
 * The `chromium` project's `testIgnore` for those folders. Playwright tests it
 * against ABSOLUTE paths, so it is anchored to the resolved test directory: a
 * parent folder that happens to share one of the names cannot hide every spec.
 */
export function notChromiumIgnore(testDir) {
  const root = path.resolve(testDir).split(path.sep).join("/");
  return new RegExp(`^${escapeRegex(root)}/(?:${NOT_CHROMIUM_DIRS.join("|")})/`);
}

/** The test files (relative to `testDir`, `/`-separated) the default `chromium` project owns. */
export function chromiumSpecFiles(testDir) {
  return readdirSync(testDir, { recursive: true })
    .map((entry) => String(entry).split(path.sep).join("/"))
    .filter((file) => PLAYWRIGHT_TEST_FILE.test(file) && !NOT_CHROMIUM_RELATIVE.test(file))
    .sort();
}

/** The seconds a spec file is dealt as: its measurement, or the median of all of them. */
function secondsFor(durations) {
  const known = Object.values(durations).sort((a, b) => a - b);
  const median = known.length === 0 ? 1 : known[Math.floor(known.length / 2)];
  return (file) => durations[file] ?? median;
}

/**
 * Each shard's files, in sorted order: the longest-first greedy deal described
 * above. Ties go to the lower-numbered shard, and equal durations deal in name
 * order, so the result never depends on iteration order.
 */
export function dealShards(files, total, durations = E2E_SPEC_SECONDS) {
  const seconds = secondsFor(durations);
  const preSetup = Object.keys(durations).filter((file) => file.startsWith(`${PRE_SETUP_DIR}/`));
  const loads = Array.from({ length: total }, (_, i) => (i === 0 && total > 1 ? preSetup.reduce((sum, file) => sum + seconds(file), 0) : 0));
  const shards = Array.from({ length: total }, () => []);
  const order = [...files].sort((a, b) => seconds(b) - seconds(a) || (a < b ? -1 : a > b ? 1 : 0));
  for (const file of order) {
    const lightest = loads.indexOf(Math.min(...loads));
    shards[lightest].push(file);
    loads[lightest] += seconds(file);
  }
  return shards.map((shard) => shard.sort());
}

export function specsForShard(files, { index, total }, durations = E2E_SPEC_SECONDS) {
  return dealShards(files, total, durations)[index - 1];
}

/**
 * `testMatch` patterns for one shard's files, anchored to the absolute test
 * directory, so a same-named file in a subdirectory is never matched too.
 * Refuses an empty slice: a shard that matched nothing would pass vacuously.
 */
export function shardTestMatch(testDir, shard) {
  const root = path.resolve(testDir).split(path.sep).join("/");
  const files = specsForShard(chromiumSpecFiles(testDir), shard);
  if (files.length === 0) throw new Error(`E2E_SHARD=${shard.index}/${shard.total} found no spec files under ${root}`);
  return files.map((file) => new RegExp(`^${escapeRegex(`${root}/${file}`)}$`));
}
