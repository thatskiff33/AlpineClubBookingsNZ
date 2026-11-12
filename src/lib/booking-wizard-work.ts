import { z } from "zod";
import { ageTierEnum } from "@/lib/age-tier-schema";
import {
  compareCalendarDates,
  parseCalendarDate,
  type CalendarDate,
} from "@/lib/club-time";

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
 * ## Privacy (`INV-PRIV`)
 *
 * Guest names and age tiers sit in `sessionStorage`: one tab, gone when the tab
 * closes, never a cookie and never `localStorage`. No identity-document or
 * medical field is collected by the wizard, so none can be kept. The copy is
 * stamped with the signed-in member's id and a copy for anyone else is thrown
 * away on read, and it is cleared on every sign-out (`signOutMember`), on
 * submit, waitlist join, draft save, exception request and "Start again".
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
  memberGuestConsentPreview: z
    .enum(["PENDING", "NOTIFY_ONLY", "ADMIN_ASSIGNED"])
    .optional(),
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
  groupPaymentMode: z.enum(["EACH_PAYS_OWN", "ORGANISER_PAYS"]),
  paymentMethod: z.enum(["stripe", "internet_banking"]),
  memberReviewJustification: z.string(),
  useCredit: z.boolean(),
  attendingWorkParty: z.boolean(),
  selectedWorkPartyEventId: z.string().nullable(),
  waitlistAlternateLodgeIds: z.array(z.string()),
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

/** Keep the wizard's inputs for this tab, replacing any earlier copy. */
export function saveWizardWork(work: SavedWizardWork): void {
  const storage = tabStorage();
  if (!storage) return;
  const record = {
    ...work,
    version: SAVED_WORK_VERSION,
  };
  try {
    const parsed = savedWorkSchema.safeParse(record);
    if (!parsed.success) {
      clearWizardWork();
      return;
    }
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
