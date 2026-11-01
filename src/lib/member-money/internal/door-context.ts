import { loadClubTaxSettings } from "../../club-tax-settings";
import { requireInstant } from "../../club-time";
import { getClubFormat } from "../../club-format-settings";
import { readClubTimeZoneOutsideRequest } from "../../club-time-zone-runtime";
import { prisma } from "../../prisma";
import type { MemberMoneyPostingContext } from "./plan";
import { resolveMemberMoneyPostingContext } from "./post";

/**
 * The versions every M3b booking batch records (#4627). The policy version
 * names the rule set that maps legacy booking lines to journal legs
 * (`booking-charges.ts`); the coding version names the account registry
 * (`accounts.ts`). Bump one when its rules change, so a batch says which
 * rules wrote it.
 */
export const BOOKING_LEDGER_POLICY_VERSION = "booking-ledger-bridge-1";
export const MEMBER_MONEY_CODING_VERSION = "member-money-accounts-1";

/**
 * A booking door's posting context, resolved BEFORE its transaction opens
 * (`INV-LOCK-004`): the club's timezone, format and tax setting are read here
 * through the module client, never under the door's locks. The instant is the
 * door's own moment of acting, the source fact a booking event records; a door
 * that rolls back and retries resolves again and posts nothing twice, because
 * an event key already posted is a no-op (`postBookingLedgerJournal`).
 */
export async function resolveBookingMoneyPostingContext(): Promise<MemberMoneyPostingContext> {
  const effectiveAt = requireInstant(new Date());
  const [zone, format, taxSettings] = await Promise.all([
    readClubTimeZoneOutsideRequest(),
    getClubFormat(),
    loadClubTaxSettings(prisma),
  ]);
  return resolveMemberMoneyPostingContext({
    effectiveAt,
    zone,
    format,
    policyVersion: BOOKING_LEDGER_POLICY_VERSION,
    codingVersion: MEMBER_MONEY_CODING_VERSION,
    taxSettings,
  });
}
