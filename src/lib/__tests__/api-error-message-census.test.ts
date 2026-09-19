import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stripComments } from "./support/strip-comments";

/**
 * No private "turn a failed response into a message" helper exists outside
 * `src/lib/api-error-message.ts` (#2931, #3445, `INV-SSOT`).
 *
 * #2931 wrote the one home and MEASURED that twenty-one private copies of the
 * rule survived across `src/`, listing each by path so a new one would trip the
 * census rather than quietly staling the figure. #3445 converged every one of
 * them: seventeen straight copies deleted, three sites that EXTEND the rule now
 * hand only the sentence to the shared module and keep their extension, and one
 * deliberately different reader left alone and named below with its reason.
 * The census is therefore no longer "these copies exist"; it is "none exists",
 * and a new private copy fails it with its own path.
 *
 * FAILING CLOSED: a source-scanning guard's real failure mode is passing
 * vacuously, because a matcher that stops recognising the shape it polices
 * measures an empty tree and every assertion below goes green over nothing. Two
 * things hold that shut. The matcher is pinned on a fixture of every writable
 * form, and the one allowlisted reader must STILL be measured on the live tree —
 * so the matcher is proven against real code on every run, and an allowlist
 * entry whose copy was converged is reported as stale rather than kept.
 *
 * Comments are blanked before matching, through the one shared stripper, so a
 * docblock that quotes the old rule as a worked example — this tree records a
 * defect at the site it removed it from — cannot be counted as a live copy.
 *
 * This test reads the source tree from disk, so it has no import edge to the
 * files it scans and `npm run test:related` cannot reach it. Run it by name.
 */

const SCANNED_DIR = "src";

/** The one home. Its own definitions are the thing copies are counted against. */
const CANONICAL_MODULE = "src/lib/api-error-message.ts";

/**
 * The readers that are deliberately NOT the shared rule, by path, each with the
 * reason it stays. `src/lib/api-error-message.ts` names the same set in its
 * docblock; this is the list a run checks, that is the list a reader reads.
 *
 * An entry here must still be measured on the tree. When its copy is converged
 * or moved, the assertion below reports the entry as stale and it comes out.
 */
const DELIBERATELY_DIFFERENT_BY_PATH: Record<string, string> = {
  "src/lib/servernz-api.ts":
    "a server-side read of a REMOTE provider's error text, whose fallback " +
    "carries the HTTP status and whose sentence is stripped of control " +
    "characters and capped in length before it is written to the audit log",
};

const DECLARATION =
  /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(|^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)[^=]*=>/;

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      walk(full, files);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      files.push(full);
    }
  }
  return files;
}

function isTestFile(rel: string): boolean {
  return rel.includes("__tests__") || /\.(test|spec)\.tsx?$/.test(rel);
}

/** The function's own lines, by brace balance, capped so a runaway stops. */
function functionBody(lines: string[], start: number): string[] | null {
  let depth = 0;
  let opened = false;
  const out: string[] = [];
  for (let i = start; i < lines.length && i < start + 40; i += 1) {
    out.push(lines[i] ?? "");
    for (const character of lines[i] ?? "") {
      if (character === "{") {
        depth += 1;
        opened = true;
      } else if (character === "}") {
        depth -= 1;
      }
    }
    if (opened && depth <= 0) return out;
  }
  return null;
}

/**
 * A private copy is a SMALL function that projects an `error` field out of a
 * parsed payload and returns a `fallback` otherwise. Matching on the shape
 * rather than on a list of names is the point: a new copy called anything at
 * all is still counted.
 */
function privateCopies(source: string): string[] {
  const lines = stripComments(source).split(/\r?\n/);
  const found: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = DECLARATION.exec(lines[i] ?? "");
    if (!match) continue;
    const body = functionBody(lines, i);
    if (!body || body.length > 18) continue;
    const text = body.join("\n");
    if (!/\bfallback\b/.test(text)) continue;
    if (!/\.error\b|\[["']error["']\]|["']error["']\s+in\b/.test(text)) continue;
    found.push(match[1] ?? match[2] ?? "");
  }
  return found;
}

const sources = walk(path.join(process.cwd(), SCANNED_DIR))
  .map((file) => ({
    rel: path.relative(process.cwd(), file).split(path.sep).join("/"),
    text: fs.readFileSync(file, "utf8"),
  }))
  .filter(({ rel }) => !isTestFile(rel));

const measured = sources
  .filter(({ rel }) => rel !== CANONICAL_MODULE)
  .flatMap(({ rel, text }) =>
    privateCopies(text).map((name) => `${rel}:${name}`),
  )
  .sort();

const allowedPaths = Object.keys(DELIBERATELY_DIFFERENT_BY_PATH);
const privateCopiesFound = measured.filter(
  (entry) => !allowedPaths.some((file) => entry.startsWith(`${file}:`)),
);

describe("private failed-response readers (#2931, #3445, INV-SSOT)", () => {
  /**
   * A source-scanning guard's real failure mode is passing VACUOUSLY: the
   * matcher stops recognising the shape it polices, the measured list empties,
   * and every assertion below goes green over nothing. Pin the matcher on a
   * fixture of each writable form first.
   */
  it("recognises a private copy however it is written", () => {
    expect(
      privateCopies(
        [
          "async function readApiError(response: Response, fallback: string) {",
          "  try {",
          "    const body = (await response.json()) as { error?: string };",
          "    return body.error ?? fallback;",
          "  } catch {",
          "    return fallback;",
          "  }",
          "}",
          "export function responseErrorMessage(body: unknown, fallback: string) {",
          '  if (typeof body === "object" && body !== null && "error" in body) {',
          "    return String(body.error);",
          "  }",
          "  return fallback;",
          "}",
          "const readIt = async (response: Response, fallback: string) => {",
          "  const body = await response.json();",
          "  return body.error ?? fallback;",
          "};",
        ].join("\n"),
      ),
    ).toEqual(["readApiError", "responseErrorMessage", "readIt"]);
  });

  it("does not count a function that reads no error field", () => {
    expect(
      privateCopies(
        [
          "function labelFor(value: string, fallback: string) {",
          "  return LABELS[value] ?? fallback;",
          "}",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  /**
   * The allowlist is the guard's proof of life. One reader is deliberately
   * different and still written in the private shape, so a healthy matcher
   * finds it on every run; a matcher that finds nothing has broken, not won.
   * The same assertion retires a stale entry: an allowlisted path whose copy
   * has since been converged is reported here rather than kept for ever.
   */
  it("still measures every deliberately different reader on the live tree", () => {
    const stillMeasured = allowedPaths.filter((file) =>
      measured.some((entry) => entry.startsWith(`${file}:`)),
    );
    expect(
      stillMeasured,
      "an allowlisted reader is no longer measured: either the matcher has " +
        "stopped recognising the shape (this census is now vacuous) or the " +
        "reader was converged and its allowlist entry must come out",
    ).toEqual(allowedPaths);
  });

  /**
   * The rule itself. A new private copy fails here with its own path, which is
   * the reminder to import `apiErrorMessageFromBody` or
   * `apiErrorMessageFromResponse` from the one home instead of writing a
   * twenty-second reading of the same rule. A reader that is DELIBERATELY
   * different — one that reads a second key, appends a validation error's
   * issue list, or bounds a remote provider's text — still hands the sentence
   * itself to the shared module and keeps only its extension, the way
   * `xero/_components/api.ts`, `email-message-settings-panel.tsx` and
   * `admin-member-xero-actions.ts` do; it is allowlisted above only when even
   * that is not the right shape, with the reason written beside the path.
   */
  it("finds no private copy outside src/lib/api-error-message.ts", () => {
    expect(
      privateCopiesFound,
      "a private failed-response reader exists outside src/lib/api-error-message.ts " +
        "(INV-SSOT-001): route it to apiErrorMessageFromBody / " +
        "apiErrorMessageFromResponse, or allowlist its path with the reason",
    ).toEqual([]);
  });

  it("keeps the canonical module's two shapes distinguishable by name", () => {
    const canonical = sources.find(({ rel }) => rel === CANONICAL_MODULE);
    expect(canonical).toBeDefined();
    // Eleven of the copies #3445 deleted were body-shaped locals called
    // `responseErrorMessage`. A branch that predates the sweep still declares
    // them, so a canonical export of that name would collide with them at
    // merge, in silence; both canonical readers keep saying their shape.
    expect(canonical?.text).not.toMatch(/export (async )?function responseErrorMessage\b/);
    expect(canonical?.text).toMatch(/export function apiErrorMessageFromBody\b/);
    expect(canonical?.text).toMatch(/export async function apiErrorMessageFromResponse\b/);
  });
});
