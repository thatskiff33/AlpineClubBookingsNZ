// The admin tree positions attention through ONE module (#2934, `INV-SSOT-001`).
//
// `src/hooks/use-scroll-to-feedback.ts` is the single home of "where does the
// admin's attention go after an action": failure, reveal and success each have
// one primitive there, and every scroll in it honours reduced motion. A direct
// `scrollIntoView` / `scrollTo` in an admin component, or a focus deferred to
// `requestAnimationFrame`, is the per-page hack that module replaced — the kind
// that drifts, races rendering, and ignores the platform's motion preference.
//
// This is a census rather than a structural guard because a DOM method cannot
// be made unrepresentable; the exclusion list lives in the module that owns the
// fact, not here, and a stale entry fails below so the list can only shrink.
//
// It reads the tree from disk, so `npm run test:related` cannot reach it — run
// it by name (`npm run test:named`) when an admin file gains a scroll or focus.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { DIRECT_SCROLL_EXCLUSIONS } from "@/hooks/use-scroll-to-feedback";

const PRIMITIVE_MODULE = "src/hooks/use-scroll-to-feedback.ts";

const ADMIN_PREFIXES = [
  "src/app/(admin)/",
  "src/components/admin/",
  "src/components/focused-action-error.tsx",
  "src/hooks/",
];

function isAdminSource(file: string) {
  if (!/\.(ts|tsx)$/.test(file)) return false;
  if (file.includes("__tests__/") || /\.test\.tsx?$/.test(file)) return false;
  return ADMIN_PREFIXES.some((prefix) => file.startsWith(prefix));
}

function trackedAdminSources(): string[] {
  const listing = execFileSync("git", ["ls-files", "-z", "src"], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return listing
    .split("\0")
    .filter(Boolean)
    .map((file) => file.replaceAll("\\", "/"))
    .filter(isAdminSource)
    .sort();
}

/** Strip line comments and block comments so prose naming a method is not a call. */
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
// A `//` not preceded by `:` (a URL) or a quote (a string literal). The backtick
// is spelled by code point because oxc misreads it inside a regex character class.
const LINE_COMMENT = new RegExp("(^|[^:\"'\\x60])//[^\\n]*", "g");
function withoutComments(source: string) {
  return source.replace(BLOCK_COMMENT, "").replace(LINE_COMMENT, "$1");
}

const DIRECT_SCROLL = /\b(?:scrollIntoView|scrollTo)\s*\(/g;
const DEFERRED_FOCUS = /requestAnimationFrame\s*\([\s\S]{0,200}?\.focus\s*\(/g;

function findings(file: string) {
  const source = withoutComments(
    fs.readFileSync(path.join(process.cwd(), file), "utf8"),
  );
  const direct = source.match(DIRECT_SCROLL) ?? [];
  const deferred = source.match(DEFERRED_FOCUS) ?? [];
  return { direct: direct.length, deferred: deferred.length };
}

describe("admin attention goes through the shared primitive (#2934)", () => {
  const files = trackedAdminSources();
  const excluded = new Set(DIRECT_SCROLL_EXCLUSIONS.map((entry) => entry.file));

  it("enumerates the admin tree", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain(PRIMITIVE_MODULE);
  });

  it("has no direct scrollIntoView / scrollTo outside the primitive and its recorded exclusions", () => {
    const offenders = files
      .filter((file) => file !== PRIMITIVE_MODULE && !excluded.has(file))
      .map((file) => ({ file, ...findings(file) }))
      .filter((entry) => entry.direct > 0)
      .map((entry) => `${entry.file} (${entry.direct})`);

    expect(
      offenders,
      "INV-SSOT-001 / #2934: an admin surface scrolls directly instead of through " +
        "`scrollToError` / `revealEditor` / `scrollToTop` / `useActionAttention` / " +
        "`useRevealAttention` in `src/hooks/use-scroll-to-feedback.ts`. Route it there; " +
        "if the scroll is genuinely not the result of an admin's action, record it in " +
        "`DIRECT_SCROLL_EXCLUSIONS` with the reason.",
    ).toEqual([]);
  });

  it("defers no focus to requestAnimationFrame", () => {
    const offenders = files
      .filter((file) => file !== PRIMITIVE_MODULE)
      .map((file) => ({ file, ...findings(file) }))
      .filter((entry) => entry.deferred > 0)
      .map((entry) => entry.file);

    expect(
      offenders,
      "#2934: a focus deferred to the next animation frame is guessing at when " +
        "the target will exist. Drive it from state instead — an effect keyed on " +
        "the request (see `focusRowRequest` in `roster-editor.tsx`), or " +
        "`useRevealAttention` keyed on the action's nonce.",
    ).toEqual([]);
  });

  it("keeps every exclusion live, so the list can only shrink", () => {
    for (const entry of DIRECT_SCROLL_EXCLUSIONS) {
      expect(files, `${entry.file} is no longer a tracked admin source`).toContain(
        entry.file,
      );
      expect(
        findings(entry.file).direct,
        `${entry.file} no longer scrolls directly — remove its DIRECT_SCROLL_EXCLUSIONS entry`,
      ).toBeGreaterThan(0);
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  });
});
