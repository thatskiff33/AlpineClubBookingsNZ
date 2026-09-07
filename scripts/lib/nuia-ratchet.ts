/**
 * `noUncheckedIndexedAccess` migration ratchet — the decision, with no compiler
 * in it (#2799, programme #2694).
 *
 * The compiler-facing half is `scripts/ci/check-nuia-ratchet.ts`; it runs
 * `tsc` over `tsconfig.json` with the flag forced on and hands the raw output
 * here. Everything in this file is a pure function of strings so the two
 * directions of the rule can be proved in a unit test without paying for a
 * typecheck.
 *
 * THE RULE. `tsconfig.json` typechecks clean, so every diagnostic that appears
 * once `noUncheckedIndexedAccess` is forced on is debt the flag would surface.
 * That debt is recorded, one line per diagnostic, in a committed baseline. The
 * baseline may shrink; it may never grow. A run fails when the compiler
 * produces a diagnostic the baseline does not hold (new debt), AND when the
 * baseline holds a line the compiler no longer produces (a stale line — the
 * fix must be recorded, otherwise a stale entry for one site could mask a fresh
 * diagnostic with the same text elsewhere in the same file).
 *
 * THE KEY. A diagnostic is identified by `file:TScode:message`, with the
 * line and column deliberately dropped — positions churn on every unrelated
 * edit above a site, and a baseline that moved on every edit would be rewritten
 * by every lane and conflict on every merge. The same key can legitimately
 * occur more than once in a file (`'x' is possibly 'undefined'.` at two
 * sites), so the baseline is a MULTISET: a key appears as many times as the
 * compiler reports it, and both directions compare counts, not membership.
 *
 * What the key cannot do is survive a message change: a type renamed by an
 * unrelated refactor changes the message text and reads as one stale line plus
 * one new one. That is the honest answer — the run says exactly which two
 * lines, and `--record` rewrites the file — and it is the price of a baseline
 * that positions do not churn.
 */

export const BASELINE_PATH = "scripts/ci/noUncheckedIndexedAccess.baseline.txt";

export type NormalisedDiagnostic = {
  /** Repository-relative, forward slashes, as `tsc --pretty false` prints it. */
  file: string;
  code: string;
  message: string;
};

/** `file:TScode:message` — the one line the baseline holds per diagnostic. */
export function diagnosticKey(d: NormalisedDiagnostic): string {
  return `${d.file}:${d.code}:${d.message}`;
}

// `path(line,col): error TS1234: message`. Anything else is a continuation
// line (tsc indents elaboration under the diagnostic it belongs to) or noise.
//
// The lazy `(.+?)` is load-bearing and must stay lazy: a Next.js route group
// puts parentheses in the PATH (`src/app/(admin)/admin/page.tsx`), so the path
// itself contains something shaped like the `(line,col)` group. Backtracking
// past `(admin)` to the real position group is the only reason those files
// parse. Narrowing the group so it cannot cross a `(` silently reclassifies
// every route-group diagnostic as a continuation line, which reads as a shorter
// diagnostic list rather than as an error. `nuia-ratchet.test.ts` covers that
// case explicitly (#2799).
const DIAGNOSTIC_LINE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

/**
 * Parse `tsc --noEmit --pretty false` output into position-free diagnostics.
 * Continuation lines are folded into the message they elaborate, whitespace
 * collapsed, so a multi-line elaboration is still one baseline line.
 */
export function parseTscOutput(output: string): NormalisedDiagnostic[] {
  const out: NormalisedDiagnostic[] = [];
  let current: NormalisedDiagnostic | null = null;
  for (const raw of output.split(/\r?\n/)) {
    const match = DIAGNOSTIC_LINE.exec(raw);
    if (match) {
      const [, file, , , code, message] = match;
      current = {
        file: (file ?? "").replaceAll("\\", "/"),
        code: code ?? "",
        message: (message ?? "").trim(),
      };
      out.push(current);
      continue;
    }
    if (current && raw.trim().length > 0) {
      current.message = `${current.message} ${raw.trim().replace(/\s+/g, " ")}`;
    }
  }
  return out;
}

/** The baseline file's text: one key per line, sorted, LF, trailing newline. */
export function renderBaseline(keys: readonly string[]): string {
  const sorted = [...keys].sort(compareKeys);
  return sorted.length === 0 ? "" : `${sorted.join("\n")}\n`;
}

export function parseBaseline(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/** Byte-order sort so the file is identical whatever locale wrote it. */
function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function countByKey(keys: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}

export type RatchetComparison = {
  /** Keys the compiler reports more often than the baseline holds them. */
  added: Array<{ key: string; extra: number }>;
  /** Keys the baseline holds more often than the compiler now reports them. */
  stale: Array<{ key: string; missing: number }>;
};

/**
 * Compare the compiler's current diagnostics with the recorded baseline as
 * multisets. Empty `added` and empty `stale` is the only passing outcome.
 */
export function compareWithBaseline(
  current: readonly string[],
  baseline: readonly string[],
): RatchetComparison {
  const now = countByKey(current);
  const recorded = countByKey(baseline);
  const added: RatchetComparison["added"] = [];
  const stale: RatchetComparison["stale"] = [];
  for (const [key, count] of now) {
    const had = recorded.get(key) ?? 0;
    if (count > had) added.push({ key, extra: count - had });
  }
  for (const [key, count] of recorded) {
    const has = now.get(key) ?? 0;
    if (count > has) stale.push({ key, missing: count - has });
  }
  added.sort((a, b) => compareKeys(a.key, b.key));
  stale.sort((a, b) => compareKeys(a.key, b.key));
  return { added, stale };
}

export type Inventory = {
  total: number;
  /** `src/lib`, `src/app`, `src/components`, `prisma`, `scripts`, ... */
  byArea: Array<{ area: string; count: number }>;
  byFile: Array<{ file: string; count: number }>;
};

/**
 * The remaining debt, grouped the way the programme's stages are cut: the
 * first two path segments under `src/`, the first segment elsewhere.
 */
export function inventory(diagnostics: readonly NormalisedDiagnostic[]): Inventory {
  const byArea = new Map<string, number>();
  const byFile = new Map<string, number>();
  for (const d of diagnostics) {
    byArea.set(areaOf(d.file), (byArea.get(areaOf(d.file)) ?? 0) + 1);
    byFile.set(d.file, (byFile.get(d.file) ?? 0) + 1);
  }
  const descending = (a: { count: number }, b: { count: number }) => b.count - a.count;
  return {
    total: diagnostics.length,
    byArea: [...byArea].map(([area, count]) => ({ area, count })).sort(descending),
    byFile: [...byFile].map(([file, count]) => ({ file, count })).sort(descending),
  };
}

export function areaOf(file: string): string {
  const segments = file.split("/");
  if (segments[0] === "src") return segments.slice(0, 2).join("/");
  return segments[0] ?? file;
}
