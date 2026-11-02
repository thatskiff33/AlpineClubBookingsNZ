import { readHeldOnceEverAlertTimes, sendAdminAlertOnceEverClaim, type OnceEverAlertClaim } from "@/lib/admin-alert-once";
import { releaseAlertCooldown } from "@/lib/alert-cooldown";
import type { AdminAlertSendResult } from "@/lib/email/admin-alert-send-result";
import logger from "@/lib/logger";

/**
 * #4690 (`INV-SSOT`): THE ONE SEQUENCE for a once-ever admin alert whose caller
 * retries until it is out - the unrecognised Stripe payment's (#4670, #4679,
 * `INV-INT-032`) and the superseded-payment refund's (#4690). Claim and send
 * through `sendAdminAlertOnceEverClaim`; then:
 * - kept: `settled`;
 * - this call's own claim not kept (its send failed; its claim write threw; or
 *   its send reached nobody and the claim helper deferred it for a day): given
 *   back under the exact stamp it wrote - a no-op for a deferred claim, whose
 *   stamp the deferral moved - twice for the uncertain claim, whose helper made
 *   no release of its own, and `not-sent`;
 * - another holder has it: `settled` when `isSent` says it went out; given back
 *   meanwhile: `not-sent`; younger than `inFlightMs`: `in-flight`, a sibling
 *   still sending; older: a dead sender's, given back under its exact stamp and
 *   claimed and sent once more, read the same way - except that another
 *   holder's claim found after the takeover (a sibling re-claimed it first) is
 *   `taken-over`.
 * Each caller keeps its own window and its own answer to `not-sent`,
 * `in-flight` and `taken-over`. Throws only when a read or the takeover's
 * release throws.
 */
export async function sendAdminAlertOnceEverWithTakeover(args: {
  key: string;
  label: string;
  context: Record<string, unknown>;
  send: () => Promise<AdminAlertSendResult>;
  /** Whether the alert went out though a claim is held: the caller's sent marker. */
  isSent: () => Promise<boolean>;
  /** How long another holder's claim counts as a sibling still sending. */
  inFlightMs: number;
}): Promise<"settled" | "in-flight" | "taken-over" | "not-sent"> {
  const { key, isSent, inFlightMs } = args;
  const attempt = () => sendAdminAlertOnceEverClaim(args);
  const read = async (claim: OnceEverAlertClaim): Promise<"settled" | "not-sent" | "held"> => {
    if (claim.kept) return "settled";
    if (claim.claimedAt) {
      await giveBackOwnOnceEverClaim({ ...args, claim: { claimedAt: claim.claimedAt, claimUncertain: claim.claimUncertain } });
      return "not-sent";
    }
    return (await isSent()) ? "settled" : "held";
  };

  const first = await read(await attempt());
  if (first !== "held") return first;
  const heldAt = (await readHeldOnceEverAlertTimes([key], new Date())).get(key);
  if (!heldAt) return "not-sent";
  if (Date.now() - heldAt.getTime() < inFlightMs) return "in-flight";
  await releaseAlertCooldown({ key, claimedAt: heldAt });
  const second = await read(await attempt());
  return second === "held" ? "taken-over" : second;
}

/**
 * Give back a once-ever claim this call took and could not use, under the exact
 * stamp it wrote, so a newer claim is never touched (#4670). An uncertain claim
 * (its write threw, #4679) gets two tries; a failed send's one more, after the
 * claim helper's own. Never throws.
 */
export async function giveBackOwnOnceEverClaim({
  key,
  label,
  context,
  claim,
}: {
  key: string;
  label: string;
  context: Record<string, unknown>;
  claim: Pick<OnceEverAlertClaim, "claimUncertain"> & { claimedAt: Date };
}): Promise<void> {
  const failed = claim.claimUncertain ? "Failed to give back the uncertain" : "Failed again to release the";
  for (let attempt = 1; attempt <= (claim.claimUncertain ? 2 : 1); attempt += 1) {
    try {
      await releaseAlertCooldown({ key, claimedAt: claim.claimedAt });
      return;
    } catch (err) {
      logger.error({ ...context, err, attempt }, `${failed} ${label} claim`);
    }
  }
}
