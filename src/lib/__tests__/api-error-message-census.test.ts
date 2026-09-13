import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * How many private "turn a failed response into a message" helpers survive, and
 * exactly where (#2931, `INV-SSOT`).
 *
 * `src/lib/api-error-message.ts` is the one home for that rule. It is NOT yet
 * the one way the tree does it, and a docblock that claimed it was would be
 * false — which is why this census exists: the figure the module and the pull
 * request quote is whatever this test measures, and a NEW private copy makes it
 * fail rather than quietly making the claim staler.
 *
 * Converging the survivors is deliberately not this issue's work. They sit on
 * surfaces other lanes are editing, and several are not straight copies at all:
 * `servernz-api.ts` strips control characters and caps the length,
 * `email-message-settings-panel.tsx` appends zod issues to the headline, and
 * `admin-member-xero-actions.ts` returns an error object carrying recovery
 * hints. Each of those needs a judgement about what the shared helper should
 * grow, not a sweep.
 *
 * This test reads the source tree from disk, so it has no import edge to the
 * files it scans and `npm run test:related` cannot reach it. Run it by name.
 */

const SCANNED_DIR = "src";

/** The one home. Its own definitions are the thing copies are counted against. */
const CANONICAL_MODULE = "src/lib/api-error-message.ts";

/**
 * Every surviving private copy, `path:name`, measured on this branch.
 *
 * Eleven of them are called `responseErrorMessage` and take a PARSED BODY —
 * the same rule one step later. That is why the canonical module's own exports
 * say which shape they take in their names: an export called
 * `responseErrorMessage` taking a `Response` would sit beside eleven functions
 * of that name taking a body, and an auto-import would collide in silence.
 */
const SURVIVING_PRIVATE_COPIES = [
  "src/app/(admin)/admin/ai-assistant/ai-assistant-client.tsx:readError",
  "src/app/(admin)/admin/backups/backups-client.tsx:readError",
  "src/app/(admin)/admin/backups/setup/backup-wizard-steps.tsx:readError",
  "src/app/(admin)/admin/committee/page.tsx:responseErrorMessage",
  "src/app/(admin)/admin/lodges/[id]/setup/page.tsx:readError",
  "src/app/(admin)/admin/member-fields/page.tsx:responseErrorMessage",
  "src/app/(admin)/admin/members/[id]/_components/member-committee-assignments-card.tsx:responseErrorMessage",
  "src/app/(admin)/admin/members/[id]/_components/member-seasonal-membership-card.tsx:responseErrorMessage",
  "src/app/(admin)/admin/membership-types/page.tsx:responseErrorMessage",
  "src/app/(admin)/admin/modules/page.tsx:responseErrorMessage",
  "src/app/(admin)/admin/setup/setup-page-client.tsx:responseErrorMessage",
  "src/app/(admin)/admin/site-style/site-style-wizard.tsx:responseErrorMessage",
  "src/app/(admin)/admin/waitlist/page.tsx:getErrorMessage",
  "src/app/(admin)/admin/xero/_components/api.ts:readErrorMessage",
  "src/app/(public)/login/two-factor-panels.tsx:readJsonError",
  "src/components/admin/email-settings/email-message-settings-panel.tsx:templateErrorMessage",
  "src/components/admin/finance-report-mappings-panel.tsx:responseErrorMessage",
  "src/components/admin/membership-cancellation-settings-panel.tsx:responseErrorMessage",
  "src/components/admin/security/password-policy-card.tsx:responseErrorMessage",
  "src/lib/admin-member-xero-actions.ts:readActionError",
  "src/lib/servernz-api.ts:readError",
];

/**
 * The surfaces this change converged, which must therefore NOT appear above.
 * Listing them by name is what stops a later revert from passing silently: a
 * restored private copy fails the census AND fails this second assertion with
 * the surface named.
 */
const CONVERGED_BY_THIS_CHANGE = [
  "src/app/(admin)/admin/bed-allocation/page.tsx",
  "src/app/(admin)/admin/bed-allocation/_components/allocation-preferences-section.tsx",
  "src/components/admin/bed-allocation-removal-dialog.tsx",
  "src/components/admin/booking-bed-allocation-panel.tsx",
  "src/components/admin/rooms-beds-manager.tsx",
  "src/components/admin/booking-policies/adult-member-hosting-section.tsx",
  "src/components/admin/booking-policies/minimum-night-stay-section.tsx",
];

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
  const lines = source.split(/\r?\n/);
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

describe("private failed-response readers (#2931, INV-SSOT)", () => {
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

  it("still finds a population at all", () => {
    expect(measured.length).toBeGreaterThan(0);
  });

  /**
   * The measured figure is what the canonical module's docblock and the pull
   * request quote. A new private copy fails here with its own path, which is
   * the reminder to import the shared helper instead.
   */
  it("names every surviving copy, so the count is measured and not claimed", () => {
    expect(measured).toEqual(SURVIVING_PRIVATE_COPIES);
  });

  it("leaves none behind on the surfaces this change converged", () => {
    const regressions = measured.filter((entry) =>
      CONVERGED_BY_THIS_CHANGE.some((file) => entry.startsWith(`${file}:`)),
    );
    expect(regressions).toEqual([]);
  });

  it("keeps the canonical module's two shapes distinguishable by name", () => {
    const canonical = sources.find(({ rel }) => rel === CANONICAL_MODULE);
    expect(canonical).toBeDefined();
    // An export named `responseErrorMessage` would collide with the eleven
    // body-shaped locals above; both canonical readers must say their shape.
    expect(canonical?.text).not.toMatch(/export (async )?function responseErrorMessage\b/);
    expect(canonical?.text).toMatch(/export function apiErrorMessageFromBody\b/);
    expect(canonical?.text).toMatch(/export async function apiErrorMessageFromResponse\b/);
  });
});
