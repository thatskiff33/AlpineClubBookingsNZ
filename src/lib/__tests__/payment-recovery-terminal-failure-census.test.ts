import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { stripComments } from "@/lib/__tests__/support/strip-comments";

/**
 * #3220: "THIS RECOVERY IS DEAD" IS ONE TRANSITION, IN ONE PLACE.
 *
 * A `PaymentRecoveryOperation` going terminally `FAILED` is the moment the rest
 * of the system is told to stop waiting for it. The booking-vs-Xero repair tool
 * reads that deadness as permission to stop deferring and to raise the edit's
 * supplementary invoice UNPAID (`OPEN_PAYMENT_RECOVERY_STATUSES` in
 * `xero-booking-repair-load.ts`, the #3202 control). So whatever has to happen
 * when a recovery dies has to happen on EVERY route to that status, and before
 * this issue there were three of them - the worker's own catch and the
 * stale-worker reaper's two arms - each with its own status write, its own
 * `nextRetryAt` policy, and only one of the three alerting anybody.
 *
 * The pre-decision review counted the module's mentions of
 * `PaymentRecoveryOperationStatus.FAILED` and found SIX, which is the number the
 * issue records. Three of those are `where` filters that READ the status: they
 * can never be a transition, but they are exactly what makes the question "where
 * does this module decide a recovery is dead" cost six candidates to answer.
 * They are named constants now.
 *
 * This census is the ratchet. It fails when a seventh mention appears anywhere
 * under `src/`, and it fails when the single WRITE moves out of the chokepoint -
 * either of which would put a route to terminal failure outside the one place
 * that knows what terminal failure costs.
 *
 * BY WALK, NOT BY NAME (`INV-SSOT-004`): a population measured by naming the
 * files you already know about cannot see the file somebody adds tomorrow.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

const CHOKEPOINT = "markPaymentRecoveryOperationFailed";
const RECOVERY_MODULE = "src/lib/payment-recovery.ts";
const STATUS_MENTION = "PaymentRecoveryOperationStatus.FAILED";
const STATUS_WRITE = `status: ${STATUS_MENTION}`;

/** The body of `markPaymentRecoveryOperationFailed`, opening brace included. */
const CHOKEPOINT_BODY_OPENS =
  "): Promise<PaymentRecoveryFailureOutcome> {";

/** Every non-test source file under `src/`, found by walking the tree. */
function sourceFiles(): string[] {
  const root = path.join(REPO_ROOT, "src");
  expect(fs.existsSync(root), "src/ is missing").toBe(true);

  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__") continue;
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) {
        continue;
      }
      found.push(path.relative(REPO_ROOT, full).split(path.sep).join("/"));
    }
  };
  walk(root);
  return found.sort();
}

/** Code only. A postmortem naming the status is prose, not a call site. */
function code(relative: string): string {
  const absolute = path.join(REPO_ROOT, relative);
  // A census that cannot find its subject is a false green, not a pass.
  expect(fs.existsSync(absolute), `${relative} is missing`).toBe(true);
  return stripComments(fs.readFileSync(absolute, "utf8"));
}

function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return found;
    found.push(at);
    from = at + needle.length;
  }
}

/** `[start, end)` of the chokepoint's body, by brace balance from its opener. */
function chokepointBody(source: string): { start: number; end: number } {
  const declared = source.indexOf(`async function ${CHOKEPOINT}(`);
  expect(
    declared,
    `${RECOVERY_MODULE} no longer declares \`async function ${CHOKEPOINT}(\`. If the chokepoint was renamed, rename it here; if it was removed, the six transitions it replaced are back and this census is the thing that says so.`,
  ).toBeGreaterThan(-1);

  const opens = source.indexOf(CHOKEPOINT_BODY_OPENS, declared);
  expect(
    opens,
    `${CHOKEPOINT} no longer ends its signature with \`${CHOKEPOINT_BODY_OPENS}\`, so this census cannot find its body. Re-verify the signature here rather than loosening the search - the whole assertion below is "the write is INSIDE this function".`,
  ).toBeGreaterThan(-1);

  const start = source.indexOf("{", opens + CHOKEPOINT_BODY_OPENS.length - 1);
  let depth = 0;
  for (let at = start; at < source.length; at += 1) {
    if (source[at] === "{") depth += 1;
    else if (source[at] === "}") {
      depth -= 1;
      if (depth === 0) return { start, end: at + 1 };
    }
  }
  throw new Error(`${CHOKEPOINT} has no balanced body in ${RECOVERY_MODULE}`);
}

describe("INV-PAY-052: one terminal-failure transition, census", () => {
  it("names the status in exactly one module, exactly three times", () => {
    const mentions = new Map<string, number>();
    for (const relative of sourceFiles()) {
      const count = occurrences(code(relative), STATUS_MENTION).length;
      if (count > 0) mentions.set(relative, count);
    }

    expect(
      Object.fromEntries([...mentions.entries()].sort()),
      "A seventh mention of PaymentRecoveryOperationStatus.FAILED has appeared. If it is a READ, route it through one of this module's two status-set constants (CLAIMABLE_PAYMENT_RECOVERY_STATUSES, NON_TERMINAL_PAYMENT_RECOVERY_STATUSES). If it is a WRITE, it is a second route to terminal failure: call markPaymentRecoveryOperationFailed instead, so whatever a dead recovery costs is paid on this route too. Do not update this expectation to make the census agree with the tree.",
    ).toEqual({
      // Two status-set constants (reads) and the chokepoint's one write.
      [RECOVERY_MODULE]: 3,
    });
  });

  it("writes the status in exactly one place, and that place is the chokepoint", () => {
    const source = code(RECOVERY_MODULE);
    const writes = occurrences(source, STATUS_WRITE);

    expect(
      writes.length,
      `${RECOVERY_MODULE} sets ${STATUS_MENTION} in ${writes.length} places. There is exactly one route to terminal failure and it is ${CHOKEPOINT}.`,
    ).toBe(1);

    const body = chokepointBody(source);
    expect(
      writes[0] >= body.start && writes[0] < body.end,
      `The one ${STATUS_MENTION} write sits OUTSIDE ${CHOKEPOINT}. Everything a dead recovery has to do - the exhaustion alert today, and whatever is hung off it next - lives in that function, so a write outside it is a route that silently skips all of it.`,
    ).toBe(true);
  });

  it("keeps the reader-side sets named rather than re-spelled", () => {
    const source = code(RECOVERY_MODULE);

    // Both constants exist, and both are `as const` so a caller cannot mutate
    // the shared set out from under the other reader.
    for (const name of [
      "CLAIMABLE_PAYMENT_RECOVERY_STATUSES",
      "NON_TERMINAL_PAYMENT_RECOVERY_STATUSES",
    ]) {
      expect(source, `${name} is gone from ${RECOVERY_MODULE}`).toContain(
        `const ${name} = [`,
      );
    }

    // The shape the constants replaced. An inline list of statuses spelled at a
    // query is how the module got to six mentions in the first place.
    expect(
      source.includes(`in: [\n          ${STATUS_MENTION}`),
      "A status list has been spelled inline at a query again. Use the named constant.",
    ).toBe(false);
  });
});
