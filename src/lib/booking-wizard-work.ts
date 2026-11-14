import { GroupBookingPaymentMode } from "@prisma/client";
import { z } from "zod";
import { ageTierEnum } from "@/lib/age-tier-schema";
import {
  compareCalendarDates,
  parseCalendarDate,
  type CalendarDate,
} from "@/lib/club-time";
import { MEMBER_GUEST_CONSENT_PREVIEW_VALUES } from "@/lib/member-guest-consent-preview";

/**
 * The booking wizard's work in progress, kept in this browser tab (#4950).
 *
 * The wizard holds everything in React state, so any full navigation away threw
 * it all away — a refresh, the back button, and the profile detours the guests
 * step sends a member on with "then return here". This module is the ONE home
 * of what is kept, where, under which version, and the three operations on it
 * (`INV-SSOT`): save, load-and-validate, clear.
 *
 * ## What is kept, and what never is
 *
 * Only what the member typed or chose: the lodge, the dates, the party, the
 * notes, the step reached and the review-step choices listed in
 * {@link savedWorkSchema}. Never anything fetched or derived — no price, quote,
 * promo result, credit balance, family list, subscription or created booking.
 * Prices are always re-quoted from the restored inputs, and the family list is
 * always re-fetched, so a family member completed on the profile shows as
 * addable on return.
 *
 * The payment method is payment state, so it is not kept either (#4950's
 * acceptance criteria). The wizard withdraws an Internet Banking choice whenever
 * the current quote cannot hold it, which is exactly the state a restore starts
 * in, so a kept choice would be reset to card before the member saw it.
 *
 * ## Privacy (`INV-PRIV`)
 *
 * Guest names and age tiers sit in `sessionStorage`: one tab, gone when the tab
 * closes, never a cookie and never `localStorage`. No identity-document or
 * medical field is collected by the wizard, so none can be kept. The copy is
 * stamped with the signed-in member's id and a copy for anyone else is thrown
 * away on read, and it is cleared on every sign-out (`signOutMember`), on
 * submit, waitlist join, draft save, exception request and "Start again".
 *
 * Limit: a session that ends by expiry or revocation never runs
 * `signOutMember`, so the copy then stays in the tab until the next member's
 * `/book` visit discards it (the member stamp) or the tab closes.
 */

const STORAGE_KEY = "booking-wizard-work";

/**
 * Bump on any change to {@link savedWorkSchema}. A copy with any other version
 * is discarded, never migrated: it is minutes of typing, not a record.
 */
const SAVED_WORK_VERSION = 1;

const calendarDateString = z
  .string()
  .refine((value) => parseCalendarDate(value) !== null);

// Field by field, never `GuestData` wholesale: a field the wizard later adds to
// a guest row must be a deliberate decision here, not kept by accident.
const savedGuestSchema = z.object({
  firstName: z.string(),
  lastName: z.string(),
  ageTier: ageTierEnum,
  isMember: z.boolean(),
  memberId: z.string().optional(),
  stayStart: calendarDateString.optional(),
  stayEnd: calendarDateString.optional(),
  nights: z.array(calendarDateString).optional(),
  // Kept, not re-derived: it is what the member was shown when they added a
  // member from outside their family, and `partyNeedsSupervisionJustification`
  // reads it, so dropping it made an outsider count as the supervising adult
  // and the create route refuse a party the wizard had let through. Display
  // only; the server decides consent for itself.
  memberGuestConsentPreview: z.enum(MEMBER_GUEST_CONSENT_PREVIEW_VALUES).optional(),
});

const savedWorkSchema = z.object({
  version: z.literal(SAVED_WORK_VERSION),
  memberId: z.string().min(1),
  lodgeId: z.string().min(1),
  checkIn: calendarDateString.nullable(),
  checkOut: calendarDateString.nullable(),
  // "pay" is never kept: reaching it means a booking already exists.
  step: z.enum(["dates", "guests", "review"]),
  guests: z.array(savedGuestSchema),
  notes: z.string(),
  perGuestDatesEnabled: z.boolean(),
  multiDateRangesEnabled: z.boolean(),
  expectedArrivalTime: z.string().nullable(),
  requestedRoomId: z.string().nullable(),
  cancelIfGuestsBumped: z.boolean(),
  groupTrip: z.boolean(),
  groupPaymentMode: z.nativeEnum(GroupBookingPaymentMode),
  memberReviewJustification: z.string(),
  useCredit: z.boolean(),
  attendingWorkParty: z.boolean(),
  selectedWorkPartyEventId: z.string().nullable(),
  waitlistAlternateLodgeIds: z.array(z.string()),
  // Whether the wizard's one-shot "add the member to the party" has run. An
  // empty party means "the member left themselves out" only once it has; an
  // empty party saved before it ran (the family list still loading, or the
  // member's own record blocked until they finish their profile) must still be
  // seeded on return.
  selfSeedSettled: z.boolean(),
});

export type SavedWizardWork = Omit<z.infer<typeof savedWorkSchema>, "version">;

function tabStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    // Storage disabled by the browser: the wizard simply forgets, as before.
    return null;
  }
}

/**
 * A per-guest date the member has cleared reads as '' from a native date input.
 * The guest form shows the booking's own date for it, so it is the same as no
 * per-guest date, and must not make the whole copy unsavable.
 */
function withoutBlankGuestDates(guest: SavedWizardWork["guests"][number]) {
  const { stayStart, stayEnd, ...rest } = guest;
  return {
    ...rest,
    ...(stayStart ? { stayStart } : {}),
    ...(stayEnd ? { stayEnd } : {}),
  };
}

/**
 * Keep the wizard's inputs for this tab, replacing any earlier copy. A state
 * that does not fit the saved shape leaves the earlier copy as it was: one
 * transient value must never erase the member's work.
 */
export function saveWizardWork(work: SavedWizardWork): void {
  const storage = tabStorage();
  if (!storage) return;
  const record = {
    ...work,
    guests: work.guests.map(withoutBlankGuestDates),
    version: SAVED_WORK_VERSION,
  };
  try {
    const parsed = savedWorkSchema.safeParse(record);
    if (!parsed.success) return;
    storage.setItem(STORAGE_KEY, JSON.stringify(parsed.data));
  } catch {
    // Quota or privacy mode: losing the copy is the old behaviour, not an error.
  }
}

/**
 * The kept work for `memberId`, or null. Any copy that fails to parse, has
 * another version, or belongs to another member is removed, so a second member
 * signing in on the same tab never sees the first member's party.
 */
export function loadWizardWork(memberId: string): SavedWizardWork | null {
  const storage = tabStorage();
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const result = savedWorkSchema.safeParse(parsed);
  if (!result.success || result.data.memberId !== memberId) {
    clearWizardWork();
    return null;
  }
  const { version: _version, ...work } = result.data;
  return work;
}

/** Forget the kept work for this tab. Safe to call when there is none. */
export function clearWizardWork(): void {
  try {
    tabStorage()?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing more can be done; the member-id check still guards the next read.
  }
}

/**
 * Decide what of a loaded copy may be restored, given what is true now.
 *
 * - The lodge must still be one the member may book, or the whole copy is
 *   discarded (null): every other input was chosen for that lodge.
 * - The dates must still pass the wizard's own date rules — both present, a
 *   real range, and not starting before the club's today (`INV-DATE`, judged
 *   through club time by the caller per `INV-CONFIG-002`). If not, the dates
 *   and anything tied to them (per-guest ranges and nights) are dropped, the
 *   party is kept, and the member lands on the dates step.
 */
export function reconcileRestoredWork(
  work: SavedWizardWork,
  context: { bookableLodgeIds: readonly string[]; today: CalendarDate },
): SavedWizardWork | null {
  if (!context.bookableLodgeIds.includes(work.lodgeId)) return null;
  const checkIn = work.checkIn ? parseCalendarDate(work.checkIn) : null;
  const checkOut = work.checkOut ? parseCalendarDate(work.checkOut) : null;
  const datesStillValid =
    checkIn !== null &&
    checkOut !== null &&
    compareCalendarDates(checkIn, checkOut) < 0 &&
    compareCalendarDates(checkIn, context.today) >= 0;
  if (datesStillValid) return work;
  return {
    ...work,
    checkIn: null,
    checkOut: null,
    step: "dates",
    perGuestDatesEnabled: false,
    multiDateRangesEnabled: false,
    guests: work.guests.map((guest) => {
      const kept = { ...guest };
      delete kept.stayStart;
      delete kept.stayEnd;
      delete kept.nights;
      return kept;
    }),
  };
}
