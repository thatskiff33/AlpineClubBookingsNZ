import type { Prisma } from "@prisma/client";
import { loadClubTaxSettings } from "../../club-tax-settings";
import { requireInstant, type ClubTimeZone } from "../../club-time";
import { getClubFormat } from "../../club-format-settings";
import { readClubTimeZoneOutsideRequest } from "../../club-time-zone-runtime";
import { prisma } from "../../prisma";
import logger from "../../logger";
import { bookingJournalInactiveReason, type BookingJournalContext } from "./journal-activity";
import { resolveMemberMoneyPostingContext } from "./post";

/** Said once per process: a club whose currency no card can be charged in posts nothing (`journal-activity.ts`). */
let inactiveLogged = false;

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
 * through the module client, never under the door's locks. The timezone and
 * format readers always answer; a tax setting that cannot be read is carried as
 * "unreadable", which refuses only a batch that needs a fresh split; and a club
 * whose currency no card can be charged in gets an inactive journal, so its
 * doors post nothing rather than fail (`journal-activity.ts`). The instant is the
 * door's own moment of acting, the source fact a booking event records; a door
 * that rolls back and retries resolves again and posts nothing twice, because
 * an event key already posted is a no-op (`postBookingLedgerJournal`).
 */
export async function resolveBookingMoneyPostingContext(options: {
  /** The club's timezone, where the door has already read it before its transaction: one read, one club day. */
  zone?: ClubTimeZone;
  /** The client the tax setting is read through: the server's, unless a caller runs on its own. */
  db?: Pick<Prisma.TransactionClient, "clubTaxSettings">;
} = {}): Promise<BookingJournalContext> {
  const effectiveAt = requireInstant(new Date());
  const [zone, format, taxSettings] = await Promise.all([
    options.zone ?? readClubTimeZoneOutsideRequest(),
    getClubFormat(),
    // A read that fails is carried, not thrown: only a batch needing a fresh
    // split refuses it, naming why, inside the door's transaction, so the door
    // rolls back then; a correction repeats its posted split and needs no setting (D3).
    loadClubTaxSettings(options.db ?? prisma).catch((error: unknown) => ({
      unreadable: error instanceof Error ? error.message : String(error),
    })),
  ]);
  // A pre-transaction decision: the door proceeds and posts nothing (never a caught refusal).
  const inactive = bookingJournalInactiveReason(format);
  if (inactive !== null) {
    if (!inactiveLogged) logger.warn({ currency: format.unusableStoredCurrency }, `Member-money journal inactive: ${inactive} (#4627)`);
    inactiveLogged = true;
    return { inactive: "unusable-currency", detail: inactive };
  }
  return resolveMemberMoneyPostingContext({
    effectiveAt,
    zone,
    format,
    policyVersion: BOOKING_LEDGER_POLICY_VERSION,
    codingVersion: MEMBER_MONEY_CODING_VERSION,
    taxSettings,
  });
}

/**
 * A door's club time in one read (#4627): the club's zone, for its own club-day
 * decisions, and the journal's context on that same zone. Before the door's
 * transaction, like the resolver above.
 */
export async function resolveBookingDoorClock(): Promise<{ zone: ClubTimeZone; journal: BookingJournalContext }> {
  const zone = await readClubTimeZoneOutsideRequest();
  return { zone, journal: await resolveBookingMoneyPostingContext({ zone }) };
}
