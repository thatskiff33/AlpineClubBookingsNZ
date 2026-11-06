import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { stripComments } from "@/lib/__tests__/support/strip-comments";
import { balancedBrackets } from "./support/balanced-brackets";

/**
 * #4675 (`INV-PAY-120`): THE RUNNER'S CLOSE IS FENCED ON THE CLAIM IT HOLDS.
 *
 * A recovery attempt that stalled past the stale reaper used to close its row
 * SUCCEEDED after another runner had reclaimed it and minted the ask: the close
 * was fenced only off SUCCEEDED, so the live runner's claim hold then lost and
 * the debt was never asked for. The close is now fenced on the attempt's claim
 * (`heldPaymentRecoveryClaimWhere`: PROCESSING, its `attempts`, its exact
 * `processingStartedAt`), and the one close that holds no claim - the webhook's,
 * for a superseded intent Stripe reports cancelled - is its own function with
 * one caller.
 *
 * This census is the ratchet: a runner path that closes through the unclaimed
 * close, a second SUCCEEDED write spelled beside the two closes, or a close whose
 * fence drifts off the shared claim builder fails it. TypeScript already refuses
 * a bare id where a claim is due; what it cannot see is which close a new path
 * reaches for.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const RECOVERY_MODULE = "src/lib/payment-recovery.ts";
const CLAIMED_CLOSE = "completePaymentRecoveryOperation";
const UNCLAIMED_CLOSE = "completeUnclaimedPaymentRecoveryOperation";
const WEBHOOK_CLOSER = "completeCanceledSupersededPaymentIntentRecovery";
const CLAIM_FENCE = "heldPaymentRecoveryClaimWhere";
const SUCCEEDED_DATA = "succeededPaymentRecoveryData()";
const SUCCEEDED_WRITE = "status: PaymentRecoveryOperationStatus.SUCCEEDED,";
/** The one other SUCCEEDED write: an inline door's close of its own row, not a runner's (#1351). */
const DOOR_CLOSE = "markGroupSettlementRefundRecoverySucceeded";

function code(): string {
  const absolute = path.join(REPO_ROOT, RECOVERY_MODULE);
  // A census that cannot find its subject is a false green, not a pass.
  expect(fs.existsSync(absolute), `${RECOVERY_MODULE} is missing`).toBe(true);
  return stripComments(fs.readFileSync(absolute, "utf8"));
}

function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) found.push(at);
  return found;
}

/**
 * `[start, end)` of a declared function's body, by brace balance from the first brace that ends a
 * line after its parameters - a return type's `{ ... }` never does.
 */
function body(source: string, declaration: string): { start: number; end: number; text: string } {
  const declared = source.indexOf(declaration);
  expect(declared, `${RECOVERY_MODULE} no longer declares \`${declaration}\`; re-point this census rather than loosen it`).toBeGreaterThan(-1);
  const parameters = balancedBrackets(source, source.indexOf("(", declared));
  const start = source.indexOf("{\n", parameters.end + 1);
  const { end, text } = balancedBrackets(source, start);
  return { start, end: end + 1, text };
}

describe("#4675: the runner's SUCCEEDED close is fenced on the claim it holds, census", () => {
  it("fences the claimed close on the shared claim builder, which the claim hold uses too", () => {
    const source = code();
    const close = body(source, `async function ${CLAIMED_CLOSE}(`);
    expect(close.text, `${CLAIMED_CLOSE} must close only where ${CLAIM_FENCE}(claim) matches`).toContain(`where: ${CLAIM_FENCE}(claim),`);
    const hold = body(source, "async function holdAdditionalIntentRecoveryClaim<T>(");
    expect(hold.text, "the claim hold re-asserts the same claim the close is fenced on (INV-SSOT)").toContain(`where: ${CLAIM_FENCE}(operation),`);
  });

  it("closes without a claim in exactly one place: the webhook's close of a cancelled superseded intent", () => {
    const source = code();
    const calls = occurrences(source, `${UNCLAIMED_CLOSE}(`).filter((at) => !source.slice(Math.max(0, at - 15), at).includes("function "));
    const webhook = body(source, `export async function ${WEBHOOK_CLOSER}(`);
    expect(
      calls.map((at) => at >= webhook.start && at < webhook.end),
      `${UNCLAIMED_CLOSE} has a caller outside ${WEBHOOK_CLOSER}. A runner holds a claim and closes through ${CLAIMED_CLOSE}, so a stale attempt cannot close a row another runner reclaimed.`,
    ).toEqual([true]);
  });

  it("spells the SUCCEEDED write once for both closes, and once for the group-settlement door", () => {
    const source = code();
    expect(occurrences(source, SUCCEEDED_DATA), `both closes, and only they, use ${SUCCEEDED_DATA}`).toHaveLength(3);
    const closes = [body(source, `async function ${CLAIMED_CLOSE}(`), body(source, `async function ${UNCLAIMED_CLOSE}(`)];
    for (const close of closes) expect(close.text).toContain(SUCCEEDED_DATA);
    const writes = occurrences(source, SUCCEEDED_WRITE);
    const data = body(source, "function succeededPaymentRecoveryData(");
    const door = body(source, `export async function ${DOOR_CLOSE}(`);
    expect(
      writes.map((at) => (at >= data.start && at < data.end ? "data" : at >= door.start && at < door.end ? "door" : "elsewhere")),
      `A SUCCEEDED write has appeared outside the two closes' shared data and ${DOOR_CLOSE}. A runner closes through ${CLAIMED_CLOSE}, fenced on its claim.`,
    ).toEqual(["door", "data"]);
  });
});
