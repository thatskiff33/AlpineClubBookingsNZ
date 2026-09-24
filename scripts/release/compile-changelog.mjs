#!/usr/bin/env node
/**
 * Release-time changelog compiler (issue #2452).
 *
 * Every branch used to write its entry straight into the top of
 * `## Unreleased` in `CHANGELOG.md`, so concurrent lanes conflicted on that one
 * file daily (AGENTS.md §5, "Housekeeping that bites parallel lanes"). Each PR
 * now drops a self-contained fragment into `changelog.d/` instead — one new
 * file per PR, which git merges without a conflict — and this script folds the
 * collected fragments into a real release section when a release is cut.
 *
 *   node scripts/release/compile-changelog.mjs 0.14.0                # date = today (NZ)
 *   node scripts/release/compile-changelog.mjs 0.14.0 2026-08-04     # explicit date
 *   node scripts/release/compile-changelog.mjs 0.14.0 --dry-run      # print, change nothing
 *
 * What it does, in order:
 *   1. Reads every `changelog.d/*.md` fragment except the reserved
 *      `README.md` / `.gitkeep`, in a deterministic filename order.
 *   2. Folds any entries still written directly under a legacy `## Unreleased`
 *      heading into the same new release section (transition support — several
 *      PRs opened before the fragment convention still carry direct entries).
 *   3. Inserts `## <version> - <date>` above the existing releases, leaving the
 *      `## Unreleased` heading in place with its pointer note and nothing else.
 *      The note is identified by its `<!-- changelog-pointer-note:start -->`
 *      sentinel, never by position, and is re-emitted directly under the
 *      heading every time — see the sentinel constants below for why.
 *   4. Deletes the changelog fragments it consumed and committed, clean
 *      `size-allowances.d/*.md` files made inert by their merge to main.
 *      Untracked or locally edited allowance files are never deleted.
 *   5. Prints exactly what it did,
 *      including a loud warning for anything left under `## Unreleased` that is
 *      neither the note nor an entry.
 *
 * It never rewrites historical sections: everything from the next `## ` heading
 * down is copied through byte-for-byte.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { ALLOWANCE_DIR, isReservedAllowanceName, isSafeAllowanceName } from "../lib/allowance-dir.mjs";

const REPO_ROOT = path.resolve(path.join(import.meta.dirname, "..", ".."));

/** Directory holding one Markdown fragment per merged PR. */
export const FRAGMENTS_DIRNAME = "changelog.d";

/**
 * Files in `changelog.d/` that are part of the convention rather than entries.
 * Compared case-insensitively so `readme.md` is never compiled into a release.
 */
const RESERVED_FRAGMENT_NAMES = new Set(["readme.md", ".gitkeep"]);
const MERGED_ALLOWANCE_REF = "origin/main";

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const UNRELEASED_HEADING = /^## Unreleased[ \t]*$/;
const ANY_HEADING = /^## /;
/** A top-level changelog entry bullet. Continuation paragraphs are indented. */
const ENTRY_BULLET = /^- /;

/**
 * Sentinel comments anchoring the "entries live in `changelog.d/`" pointer note
 * under `## Unreleased`.
 *
 * The note MUST be identified by these markers rather than by its position in
 * the section. `CHANGELOG.md` is declared `merge=union` (#2451), so a branch
 * that still writes its entry directly under `## Unreleased` can have that
 * entry land ABOVE the note after a union merge. A positional rule ("everything
 * above the first bullet is the note") then reads the note as part of the
 * entries, publishes it inside a release section, and deletes it from
 * `## Unreleased` — permanently, and in a way no test of the happy path sees.
 * Marker-anchored, the note is recognised wherever it sits and is re-emitted
 * canonically directly under `## Unreleased` on every compile.
 */
export const POINTER_NOTE_START = "<!-- changelog-pointer-note:start -->";
export const POINTER_NOTE_END = "<!-- changelog-pointer-note:end -->";
const POINTER_NOTE_START_RE = /^[ \t]*<!--[ \t]*changelog-pointer-note:start[ \t]*-->[ \t]*$/;
const POINTER_NOTE_END_RE = /^[ \t]*<!--[ \t]*changelog-pointer-note:end[ \t]*-->[ \t]*$/;

/**
 * The note written back when `## Unreleased` carries no sentinel-marked one —
 * an older CHANGELOG.md, or one whose note was lost before this anchoring
 * existed. Compiling restores it, so the pointer cannot stay missing.
 */
const DEFAULT_POINTER_NOTE = [
  POINTER_NOTE_START,
  "",
  "Entries for the next release are written as one file per pull request in",
  "[`changelog.d/`](changelog.d/README.md), not added here by hand (#2452);",
  "`scripts/release/compile-changelog.mjs` folds them into a version section when a",
  "release is cut. Any entries still listed below were written before that change",
  "and are folded in the same way.",
  "",
  POINTER_NOTE_END,
];

/**
 * Deterministic fragment order: ascending, comparing runs of digits
 * numerically so `999-x.md` sorts before `2448-x.md` rather than after it
 * (plain lexicographic order would put a three-digit PR number last forever).
 * Ties fall back to a plain codepoint compare so the order never depends on
 * locale or on the order the filesystem happened to list the directory in.
 */
export function compareFragmentNames(a, b) {
  const chunksA = a.match(/\d+|\D+/g) ?? [];
  const chunksB = b.match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(chunksA.length, chunksB.length); i += 1) {
    const left = chunksA[i];
    const right = chunksB[i];
    const bothNumeric = /^\d/.test(left) && /^\d/.test(right);
    if (bothNumeric) {
      if (Number(left) !== Number(right)) {
        return Number(left) - Number(right);
      }
    } else if (left !== right) {
      return left < right ? -1 : 1;
    }
  }
  if (chunksA.length !== chunksB.length) {
    return chunksA.length - chunksB.length;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Read every compilable fragment from `dir`, in `compareFragmentNames` order. */
export function readFragments(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.toLowerCase().endsWith(".md") &&
        !RESERVED_FRAGMENT_NAMES.has(entry.name.toLowerCase()),
    )
    .map((entry) => entry.name)
    .sort(compareFragmentNames)
    .map((name) => {
      const bytes = fs.readFileSync(path.join(dir, name));
      return {
        name,
        bytes,
        // Fragments are pinned to LF by .gitattributes, but a file created by a
        // Windows editor before it is committed can still arrive as CRLF; the
        // compiled CHANGELOG.md must stay LF-only.
        body: bytes.toString("utf8").replace(/\r\n/g, "\n"),
      };
    });
}

/**
 * Release-prep starts from current origin/main. Only that ref's files have
 * merged, even if a release-prep branch contains its own new commits. Never
 * include untracked or locally edited drafts.
 * Preflight the whole removal set before CHANGELOG.md is written.
 */
export function retiredAllowancePaths(repoRoot) {
  const dir = path.join(repoRoot, ALLOWANCE_DIR);
  const dirStat = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!dirStat) return [];
  if (!dirStat.isDirectory()) {
    throw new Error(`${ALLOWANCE_DIR}/ must be a real directory, not a link or file.`);
  }

  let tracked;
  try {
    execFileSync("git", ["-C", repoRoot, "merge-base", "--is-ancestor", MERGED_ALLOWANCE_REF, "HEAD"], {
      stdio: "ignore",
    });
    tracked = execFileSync(
      "git",
      ["-C", repoRoot, "ls-tree", "-r", "-z", MERGED_ALLOWANCE_REF, "--", ALLOWANCE_DIR],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    throw new Error(
      `Cannot inspect merged ${ALLOWANCE_DIR}/ files: fetch ${MERGED_ALLOWANCE_REF} and start release-prep from it (${error.message}).`,
    );
  }

  const paths = [];
  for (const entry of tracked.split("\0").filter(Boolean)) {
    const separator = entry.indexOf("\t");
    if (separator < 0) throw new Error(`Malformed ${MERGED_ALLOWANCE_REF} allowance tree entry.`);
    const [mode, type] = entry.slice(0, separator).split(" ");
    const relative = entry.slice(separator + 1);
    const parts = relative.split("/");
    if (parts[0] !== ALLOWANCE_DIR || parts.length !== 2) {
      throw new Error(`Unsafe allowance path in ${MERGED_ALLOWANCE_REF}: ${relative}`);
    }
    const name = parts[1];
    if (isReservedAllowanceName(name)) continue;
    if (!isSafeAllowanceName(name)) {
      throw new Error(`Unsafe allowance filename in ${MERGED_ALLOWANCE_REF}: ${relative}`);
    }
    if (type !== "blob" || !["100644", "100755"].includes(mode)) {
      throw new Error(`Committed allowance must not be a symlink: ${relative}`);
    }
    try {
      execFileSync("git", ["-C", repoRoot, "diff", "--quiet", MERGED_ALLOWANCE_REF, "HEAD", "--", relative], {
        stdio: "ignore",
      });
    } catch {
      throw new Error(`Merged allowance has branch edits; preserve it and re-run: ${relative}`);
    }
    const absolute = path.join(dir, name);
    if (!fs.lstatSync(absolute).isFile()) {
      throw new Error(`Committed allowance must be a regular file: ${relative}`);
    }
    try {
      execFileSync("git", ["-C", repoRoot, "diff", "--quiet", "HEAD", "--", relative], {
        stdio: "ignore",
      });
    } catch {
      throw new Error(`Committed allowance has local edits; preserve it and re-run: ${relative}`);
    }
    paths.push(relative);
  }
  return paths.sort((a, b) => compareFragmentNames(path.basename(a), path.basename(b)));
}

function stripBlankEdges(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start += 1;
  while (end > start && lines[end - 1].trim() === "") end -= 1;
  return lines.slice(start, end);
}

/**
 * Split the body of `## Unreleased` into three buckets, by MARKER not position:
 *
 *   - `note` — the sentinel-anchored pointer note, wherever it sits;
 *   - `legacy` — top-level `- ` entries (with their indented continuations),
 *     which the compile releases;
 *   - `unrecognised` — anything else, which is neither released nor deleted but
 *     reported loudly, because silently keeping unknown prose under
 *     `## Unreleased` forever is how an entry goes missing without a trace.
 *
 * Exported for tests. Throws on a malformed sentinel, which is the only
 * situation where guessing could swallow real entries into the note.
 */
export function classifyUnreleasedSection(sectionLines) {
  const note = [];
  const legacy = [];
  const unrecognised = [];
  let inNote = false;
  let sawNote = false;
  let target = null;
  let pendingBlanks = [];

  for (const line of sectionLines) {
    if (inNote) {
      note.push(line);
      if (POINTER_NOTE_END_RE.test(line)) inNote = false;
      continue;
    }
    if (POINTER_NOTE_START_RE.test(line)) {
      if (sawNote) {
        throw new Error(
          `CHANGELOG.md has more than one "${POINTER_NOTE_START}" sentinel under "## Unreleased" — ` +
            "keep exactly one and re-run.",
        );
      }
      inNote = true;
      sawNote = true;
      note.push(line);
      pendingBlanks = [];
      target = null;
      continue;
    }
    if (line.trim() === "") {
      pendingBlanks.push(line);
      continue;
    }
    if (ENTRY_BULLET.test(line)) {
      target = legacy;
    } else if (!/^[ \t]/.test(line) || target === null) {
      // A non-indented line that is not a bullet starts something we do not
      // recognise. An indented line continues whatever bucket is open.
      target = unrecognised;
    }
    if (target.length > 0) target.push(...pendingBlanks);
    pendingBlanks = [];
    target.push(line);
  }

  if (inNote) {
    throw new Error(
      `CHANGELOG.md has an unterminated "${POINTER_NOTE_START}" sentinel under "## Unreleased" — ` +
        `close it with "${POINTER_NOTE_END}" and re-run.`,
    );
  }

  return { note, legacy, unrecognised, hasNote: sawNote };
}

/**
 * Pure composer: returns the new CHANGELOG.md text plus whether any legacy
 * `## Unreleased` entries were folded in, any unrecognised content left behind,
 * and whether the pointer note had to be restored. `fragments` is an ordered
 * list of `{ name, body }`; `changelog` is the current file text.
 */
export function composeChangelog({ changelog, version, date, fragments }) {
  const lines = changelog.split("\n");
  const unreleasedIndex = lines.findIndex((line) => UNRELEASED_HEADING.test(line));

  let head;
  let note = [];
  let legacy = [];
  let unrecognised = [];
  let restoredPointerNote = false;
  let tail;

  if (unreleasedIndex >= 0) {
    const nextHeadingOffset = lines
      .slice(unreleasedIndex + 1)
      .findIndex((line) => ANY_HEADING.test(line));
    const sectionEnd =
      nextHeadingOffset >= 0 ? unreleasedIndex + 1 + nextHeadingOffset : lines.length;
    const section = lines.slice(unreleasedIndex + 1, sectionEnd);
    const classified = classifyUnreleasedSection(section);
    ({ legacy, unrecognised } = classified);
    // The note is re-emitted directly under `## Unreleased` regardless of where
    // it was found, so a union merge that lands an entry above it cannot carry
    // it into the release section or lose it.
    note = classified.hasNote ? classified.note : [...DEFAULT_POINTER_NOTE];
    restoredPointerNote = !classified.hasNote;
    head = lines.slice(0, unreleasedIndex + 1);
    tail = lines.slice(sectionEnd);
  } else {
    // No `## Unreleased` heading at all: insert directly above the newest
    // release section (or, failing that, at the end of the file).
    const firstVersionIndex = lines.findIndex((line) => ANY_HEADING.test(line));
    const splitAt = firstVersionIndex >= 0 ? firstVersionIndex : lines.length;
    head = stripBlankEdges(lines.slice(0, splitAt));
    tail = lines.slice(splitAt);
  }

  const entryLines = [...legacy];
  for (const fragment of fragments) {
    entryLines.push(...stripBlankEdges(fragment.body.split("\n")));
  }

  const out = [...head];
  if (note.length > 0) {
    out.push("", ...note);
  }
  if (unrecognised.length > 0) {
    out.push("", ...unrecognised);
  }
  out.push("", `## ${version} - ${date}`, "", ...entryLines);
  if (stripBlankEdges(tail).length > 0) {
    out.push("", ...stripBlankEdges(tail), "");
  } else {
    out.push("");
  }

  return {
    changelog: out.join("\n"),
    foldedLegacyEntries: legacy.length > 0,
    unrecognised,
    restoredPointerNote,
  };
}

/** Today's date in the club's timezone, as `YYYY-MM-DD`. */
export function todayInNewZealand(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Pacific/Auckland",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * Compile `changelog.d/` into a new release section in CHANGELOG.md.
 * Returns a summary; throws on bad input or an already-released version.
 */
export function compileChangelog({
  repoRoot = REPO_ROOT,
  version,
  date = todayInNewZealand(),
  dryRun = false,
  log = console.log,
  removeFile = fs.rmSync,
  beforeApplySnapshot = () => {},
} = {}) {
  if (!VERSION_PATTERN.test(String(version ?? ""))) {
    throw new Error(`Version must look like 0.14.0, got: ${version ?? "(missing)"}`);
  }
  if (!DATE_PATTERN.test(date)) {
    throw new Error(`Date must be YYYY-MM-DD, got: ${date}`);
  }

  const changelogPath = path.join(repoRoot, "CHANGELOG.md");
  const fragmentsDir = path.join(repoRoot, FRAGMENTS_DIRNAME);
  const originalChangelog = fs.readFileSync(changelogPath);
  const changelog = originalChangelog.toString("utf8").replace(/\r\n/g, "\n");

  if (changelog.split("\n").some((line) => line.startsWith(`## ${version} `))) {
    throw new Error(`CHANGELOG.md already has a "## ${version}" section — nothing to compile.`);
  }

  const fragments = readFragments(fragmentsDir);
  const composed = composeChangelog({ changelog, version, date, fragments });

  // Loud, before anything else in the output: content under `## Unreleased`
  // that is neither the pointer note nor a `- ` entry is NOT released and NOT
  // deleted, and a maintainer who never sees this would never learn that an
  // entry they wrote has been sitting there unreleased.
  if (composed.unrecognised.length > 0) {
    log("");
    log('!! WARNING: unrecognised content left under "## Unreleased".');
    log("!! It was NOT released and NOT deleted. Nothing here is a changelog entry");
    log("!! (a top-level `- ` bullet) or the pointer note, so the compiler cannot");
    log("!! tell what to do with it:");
    for (const line of composed.unrecognised) {
      log(`!!   | ${line}`);
    }
    log("!! Fix it by moving a real entry into a changelog.d/ fragment, or by");
    log(`!! wrapping explanatory prose in ${POINTER_NOTE_START} ... ${POINTER_NOTE_END}.`);
    log("");
  }

  if (fragments.length === 0 && !composed.foldedLegacyEntries) {
    log(
      `Nothing to compile: ${FRAGMENTS_DIRNAME}/ holds no fragments and "## Unreleased" has no ` +
        "entries. CHANGELOG.md was left unchanged.",
    );
    log("  Any spent allowance fragments remain until a release is compiled.");
    return { written: false, version, date, fragments: [], retiredAllowances: [], foldedLegacyEntries: false };
  }

  const retiredAllowances = retiredAllowancePaths(repoRoot);
  const names = fragments.map((fragment) => fragment.name);
  if (dryRun) {
    log(`  Source is local ${MERGED_ALLOWANCE_REF}; refresh it before release prep.`);
    log(`[dry run] Would add "## ${version} - ${date}" to CHANGELOG.md with:`);
    if (composed.restoredPointerNote) {
      log('  - a restored changelog.d pointer note under "## Unreleased" (it is missing)');
    }
    if (composed.foldedLegacyEntries) {
      log('  - the entries currently written directly under "## Unreleased"');
    }
    for (const name of names) {
      log(`  - ${FRAGMENTS_DIRNAME}/${name} (would be deleted)`);
    }
    for (const relative of retiredAllowances) {
      log(`  - ${relative} (spent allowance; would be deleted)`);
    }
    log("[dry run] No files were changed.");
    return { written: false, version, date, fragments: names, retiredAllowances, ...composed };
  }

  // Snapshot every planned deletion before the first write. An ordinary I/O
  // failure must not leave a new version heading with half its source files
  // still present, which would make a safe retry impossible.
  beforeApplySnapshot(); // deterministic race hook in fixture tests; no-op in the CLI
  const removalPaths = [
    ...names.map((name) => path.join(fragmentsDir, name)),
    ...retiredAllowances.map((relative) => path.join(repoRoot, relative)),
  ];
  const fragmentBytes = new Map(fragments.map(({ name, bytes }) => [path.join(fragmentsDir, name), bytes]));
  const originals = removalPaths.map((file) => {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) throw new Error(`Release fragment must be a regular file: ${file}`);
    const bytes = fs.readFileSync(file);
    const composedFrom = fragmentBytes.get(file);
    if (composedFrom && !bytes.equals(composedFrom)) {
      throw new Error(`Changelog fragment changed after it was read; preserve and rerun: ${file}`);
    }
    return { file, bytes, mode: stat.mode };
  });
  if (retiredAllowances.length > 0) {
    try {
      execFileSync("git", ["-C", repoRoot, "diff", "--quiet", "HEAD", "--", ...retiredAllowances], {
        stdio: "ignore",
      });
    } catch {
      throw new Error(`Merged allowance changed during release preflight; preserve it and rerun.`);
    }
  }
  if (!fs.readFileSync(changelogPath).equals(originalChangelog)) {
    throw new Error(`CHANGELOG.md changed after it was read; preserve and rerun: ${changelogPath}`);
  }

  try {
    fs.writeFileSync(changelogPath, composed.changelog);
    for (const { file, bytes } of originals) {
      const current = fs.lstatSync(file, { throwIfNoEntry: false });
      if (!current?.isFile() || !fs.readFileSync(file).equals(bytes)) {
        throw new Error(`Release input changed before removal; left untouched: ${file}`);
      }
      try {
        removeFile(file);
      } catch (removeError) {
        throw new Error(`Could not remove ${file}: ${removeError.message}`, { cause: removeError });
      }
    }
  } catch (error) {
    const restoreErrors = [];
    for (const { file, bytes, mode } of originals) {
      try {
        const current = fs.lstatSync(file, { throwIfNoEntry: false });
        if (!current) {
          fs.writeFileSync(file, bytes, { mode, flag: "wx" });
        } else if (!current.isFile() || !fs.readFileSync(file).equals(bytes)) {
          throw new Error(`Release input changed during rollback; left untouched: ${file}`);
        }
      } catch (restoreError) {
        restoreErrors.push(restoreError);
      }
    }
    try {
      const current = fs.lstatSync(changelogPath, { throwIfNoEntry: false });
      if (!current) {
        fs.writeFileSync(changelogPath, originalChangelog, { flag: "wx" });
      } else if (!current.isFile()) {
        throw new Error(`CHANGELOG.md changed during rollback; left untouched: ${changelogPath}`);
      } else {
        const currentBytes = fs.readFileSync(changelogPath);
        if (!currentBytes.equals(originalChangelog)) {
          if (!currentBytes.equals(Buffer.from(composed.changelog))) {
            throw new Error(`CHANGELOG.md changed during rollback; left untouched: ${changelogPath}`);
          }
          fs.writeFileSync(changelogPath, originalChangelog);
        }
      }
    } catch (restoreError) {
      restoreErrors.push(restoreError);
    }
    if (restoreErrors.length > 0) {
      throw new AggregateError(
        [error, ...restoreErrors],
        `Release compilation failed (${error.message}); automatic restoration was incomplete: ${restoreErrors.map((item) => item.message).join("; ")}. Inspect these files before retrying.`,
      );
    }
    throw new Error(`Release compilation failed (${error.message}); original files restored and the release can be retried.`, {
      cause: error,
    });
  }

  log(`  Source was local ${MERGED_ALLOWANCE_REF}; it must be refreshed before release prep.`);
  log(`Added "## ${version} - ${date}" to CHANGELOG.md.`);
  if (composed.restoredPointerNote) {
    log('  Restored the changelog.d pointer note under "## Unreleased" (it was missing).');
  }
  if (composed.foldedLegacyEntries) {
    log('  Folded in the entries that were written directly under "## Unreleased".');
  }
  log(
    names.length > 0
      ? `  Compiled and deleted ${names.length} fragment(s): ${names.join(", ")}`
      : "  No fragments were present.",
  );
  log(`  Retired ${retiredAllowances.length} committed size-allowance fragment(s).`);
  return { written: true, version, date, fragments: names, retiredAllowances, ...composed };
}

/** Parse argv into `{ version, date, dryRun }`. Exported for tests. */
export function parseArgs(argv) {
  const dryRun = argv.includes("--dry-run");
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const [version, date] = positional;
  return { version, date, dryRun };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  try {
    const { version, date, dryRun } = parseArgs(process.argv.slice(2));
    compileChangelog({ version, date: date ?? todayInNewZealand(), dryRun });
  } catch (error) {
    console.error(`compile-changelog failed: ${error.message}`);
    console.error("Usage: node scripts/release/compile-changelog.mjs <version> [YYYY-MM-DD] [--dry-run]");
    process.exitCode = 1;
  }
}
