#!/usr/bin/env node
/**
 * Offline documentation link checker (issue #2049).
 *
 * Walks every tracked Markdown file and verifies that each RELATIVE link (and
 * relative image) resolves to a file that exists on disk, AND that any anchor
 * fragment (`#section`, `file.md#section`) resolves to a real heading in the
 * target file. External URLs (http/https/mailto/tel) and protocol-relative
 * links are intentionally NOT fetched — CI keeps external-URL checking out of
 * the blocking path to stay deterministic (see .github/workflows/docs-link-check.yml
 * and lychee.toml). This script is the fast local equivalent: run it before
 * pushing docs changes.
 *
 *   pnpm run docs:linkcheck            # check, exit non-zero on any broken link
 *   node scripts/check-doc-links.mjs  # same
 *
 * It parses inline Markdown links `[text](target)`, reference definitions
 * `[label]: target`, and inline images `![alt](target)`.
 *
 * Anchor validation mirrors GitHub's heading-slug algorithm (lowercase, drop
 * punctuation, spaces -> hyphens, de-duplicate repeats with -1/-2 suffixes) and
 * also honours explicit HTML `id=`/`name=` anchors, so a same-file `#x` or a
 * cross-file `path.md#x` link to a renamed heading fails locally exactly as it
 * would under lychee's `--include-fragments` in CI. The slugger is a close
 * approximation of GitHub's, not a byte-for-byte reimplementation; CI (lychee)
 * remains authoritative if the two ever disagree on an exotic heading.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const REPO_ROOT = path.resolve(path.join(import.meta.dirname, ".."));

// Directories we never scan: dependencies, build output, VCS, and Playwright
// artifacts. Keep this aligned with lychee.toml's exclude_path.
const IGNORED_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  "test-results",
  "playwright-report",
  "coverage",
  ".turbo",
]);

/** Recursively collect *.md files under `dir`, skipping IGNORED_DIRS. */
function collectMarkdown(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      collectMarkdown(path.join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

// Inline links/images: ![alt](target) and [text](target). The target group
// stops at whitespace or ')', so `[x](a.md "title")` yields `a.md`.
const INLINE_LINK = /!?\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)/g;
// Reference definitions at line start: [label]: target
const REF_DEF = /^\s*\[[^\]]+\]:\s*(\S+)/;

function isExternal(target) {
  if (!target) return true;
  if (target.startsWith("//")) return true; // protocol-relative
  // Scheme like http:, https:, mailto:, tel:, data:
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return true;
  return false;
}

/** Split a link target into { pathPart, fragment }. Fragment excludes the `#`. */
function splitTarget(raw) {
  let t = raw.trim();
  if (t.startsWith("<") && t.endsWith(">")) t = t.slice(1, -1);
  let fragment = null;
  const hashIdx = t.indexOf("#");
  if (hashIdx !== -1) {
    fragment = t.slice(hashIdx + 1);
    t = t.slice(0, hashIdx);
  }
  // Drop a query string if present on the path part.
  const qIdx = t.indexOf("?");
  if (qIdx !== -1) t = t.slice(0, qIdx);
  // Percent-encoded path segments (e.g. %5Bdate%5D for a Next.js [date] route)
  // are valid links; decode before checking the filesystem.
  try {
    t = decodeURIComponent(t);
  } catch {
    // Leave malformed encodings as-is; they will simply fail existence.
  }
  if (fragment !== null) {
    try {
      fragment = decodeURIComponent(fragment);
    } catch {
      /* leave as-is */
    }
  }
  return { pathPart: t, fragment };
}

// --- GitHub-compatible heading slugs -----------------------------------------

/**
 * Reduce a heading's Markdown to its rendered text: strip the `#` markers,
 * unwrap links/images to their text, and drop inline-code backticks. This is
 * what GitHub slugs, not the raw source.
 */
function headingText(rawLine) {
  let t = rawLine.replace(/^\s*#{1,6}\s+/, "").replace(/\s+#+\s*$/, "");
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ""); // images contribute no text
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1"); // inline links -> text
  t = t.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1"); // reference links -> text
  t = t.replace(/`([^`]*)`/g, "$1"); // inline code -> inner text
  return t;
}

/**
 * GitHub's slug: lowercase, remove characters that are not letters, numbers,
 * spaces, `_`, or `-`, then turn spaces into hyphens. Consecutive separators are
 * NOT collapsed (GitHub does not collapse them either).
 */
function slugify(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** Extract explicit HTML anchors (`id="x"`, `name="x"`) from a line of Markdown. */
function htmlAnchors(line, out) {
  for (const m of line.matchAll(/\b(?:id|name)\s*=\s*["']([^"']+)["']/gi)) {
    out.add(m[1]);
  }
}

/**
 * Build the set of anchor slugs a file exposes: one per ATX heading (with
 * GitHub's -1/-2 de-duplication) plus any explicit HTML id/name anchors.
 */
function collectAnchors(mdPath) {
  const anchors = new Set();
  const occurrences = new Map(); // base slug -> times seen (GitHub's counter)
  const lines = fs.readFileSync(mdPath, "utf8").split(/\r?\n/);

  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    // Explicit HTML anchors (scan the line minus inline code spans).
    htmlAnchors(line.replace(/`[^`]*`/g, " "), anchors);

    if (!/^\s*#{1,6}\s+/.test(line)) continue;
    const base = slugify(headingText(line));
    if (!base) continue;
    let slug = base;
    while (occurrences.has(slug)) {
      const next = (occurrences.get(base) ?? 0) + 1;
      occurrences.set(base, next);
      slug = `${base}-${next}`;
    }
    occurrences.set(slug, 0);
    anchors.add(slug);
  }
  return anchors;
}

// -----------------------------------------------------------------------------

function checkFile(mdPath, anchorsByFile, problems) {
  const rel = path.relative(REPO_ROOT, mdPath);
  const lines = fs.readFileSync(mdPath, "utf8").split(/\r?\n/);
  const dir = path.dirname(mdPath);

  let inFence = false;
  lines.forEach((line, i) => {
    const fenceToggle = /^\s*(```|~~~)/.test(line);
    if (fenceToggle) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;

    // Strip inline-code spans (`...`) so example link syntax shown as code — e.g.
    // `![alt](images/x.png)` in a style guide — is not treated as a real link.
    const scannable = line.replace(/`[^`]*`/g, " ");

    const targets = [];
    for (const m of scannable.matchAll(INLINE_LINK)) targets.push(m[1]);
    const refMatch = scannable.match(REF_DEF);
    if (refMatch) targets.push(refMatch[1]);

    for (const raw of targets) {
      if (isExternal(raw)) continue;
      const { pathPart, fragment } = splitTarget(raw);

      if (!pathPart) {
        // Same-file anchor (`#section`). Validate against this file's anchors.
        if (fragment) {
          const anchors = anchorsByFile.get(mdPath);
          if (anchors && !anchors.has(fragment)) {
            problems.push({ file: rel, line: i + 1, target: raw, reason: `no heading/anchor "#${fragment}" in this file` });
          }
        }
        continue;
      }

      const resolved = path.resolve(dir, pathPart);
      if (!fs.existsSync(resolved)) {
        problems.push({ file: rel, line: i + 1, target: raw, reason: `missing file ${path.relative(REPO_ROOT, resolved)}` });
        continue;
      }

      // Cross-file anchor into a Markdown file: validate the fragment too.
      if (fragment && pathPart.toLowerCase().endsWith(".md")) {
        const anchors = anchorsByFile.get(path.resolve(resolved));
        if (anchors && !anchors.has(fragment)) {
          problems.push({
            file: rel,
            line: i + 1,
            target: raw,
            reason: `no heading/anchor "#${fragment}" in ${path.relative(REPO_ROOT, resolved)}`,
          });
        }
      }
    }
  });
}

function main() {
  const files = collectMarkdown(REPO_ROOT).sort();

  // Pre-compute the anchor set for every Markdown file so cross-file `.md#x`
  // links can be validated against the target's headings.
  const anchorsByFile = new Map();
  for (const f of files) anchorsByFile.set(path.resolve(f), collectAnchors(f));

  const problems = [];
  for (const f of files) checkFile(f, anchorsByFile, problems);

  console.log(`Checked ${files.length} Markdown files for relative-link and anchor breaks.`);
  if (problems.length === 0) {
    console.log("All relative links and anchors resolve. ✔");
    return;
  }

  console.error(`\n${problems.length} broken link(s)/anchor(s):\n`);
  for (const p of problems) {
    console.error(`  ${p.file}:${p.line}  ->  ${p.target}  (${p.reason})`);
  }
  process.exitCode = 1;
}

main();
