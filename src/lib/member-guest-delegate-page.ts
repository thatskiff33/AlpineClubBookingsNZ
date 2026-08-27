import { isEffectiveModuleEnabled } from "@/lib/admin-modules";
import { isQuotePricedBooking } from "@/lib/booking-modify-validation";
import {
  clubCalendarDateOf,
  dateOnlyInstantOf,
  type CalendarDate,
  type ClubTimeZone,
} from "@/lib/club-time";
import { clubTimeZone } from "@/lib/club-time/server";
import { eachDateOnlyInRange } from "@/lib/date-only";
import { calculateMemberAgeParts } from "@/lib/member-age";
import {
  familyAdultDelegateResolver,
  type MemberGuestConsentDelegateResolver,
} from "@/lib/member-guest-delegate";
import { MEMBER_GUEST_MODULE_KEY } from "@/lib/member-guest-consent";
import {
  predictConsentDeclineRefusal,
  type PredictableConsentDeclineBlocker,
} from "@/lib/member-guest-consent-card";
import { prisma } from "@/lib/prisma";

/**
 * The delegate consent page's whole decision, extracted from the route so it is
 * unit testable ("+ Add Member Guest", epic #2305, MG2 #2307, owner decisions
 * D-5/D-9/D-10).
 *
 * WHY THIS PAGE EXISTS AT ALL. D-9 makes a member with no login of their own
 * the NORMAL consent target, so the person answering is routinely a family
 * adult who is NOT a guest on the booking. The booking page's own guard
 * (`isLinkedGuestViewer`) would redirect them away — correctly. This page is
 * the surface their email link lands on, and it carries real traffic.
 *
 * THE ASYMMETRY IS A SECURITY CHOICE, stated on the mockup pack and preserved
 * here. A target with a login sees the whole booking page (owner decision D-11
 * applies to GUEST ROWS). A delegate sees ONLY this panel — names, dates, and
 * the question — never the booking page and never money. We do NOT widen the
 * linked-guest-viewer rule to admit delegates, because that would hand a
 * delegate the whole booking including its prices; and nothing this resolver
 * returns carries a price for the same reason.
 *
 * ONE NEUTRAL "NOTHING HERE" STATE, deliberately. "No such guest row", "not a
 * consent row", and "you are not this target's delegate" all collapse to
 * `NOT_FOUND`, mirroring the consent endpoint's uniform 403: the guestId in
 * the URL must not work as an existence oracle for who is on which booking.
 * Only a caller the delegate rule ACCEPTS ever sees a more specific state.
 */

export interface DelegateConsentAskFacts {
  bookingId: string;
  guestId: string;
  /** The member being added: the row's own name, plus their age when known. */
  guest: { firstName: string; lastName: string; ageYears: number | null };
  bookerName: string;
  bookerFirstName: string;
  lodgeId: string | null;
  checkIn: Date;
  checkOut: Date;
  /** The guest's own nights, date-only. */
  guestNights: Date[];
  consentExpiresAt: Date | null;
  /** Everyone on the booking — names only, no money (owner decision MG2-D-a). */
  party: string[];
  /** A predictable decline refusal, or null when both buttons render (D-14). */
  refusalBlocker: PredictableConsentDeclineBlocker | null;
}

export type DelegateConsentPageState =
  /** Nothing to show this caller. Deliberately indistinguishable — see above. */
  | { kind: "NOT_FOUND" }
  /** The viewer IS the target; their surface is the booking page (D-11). */
  | { kind: "TARGET_SELF"; bookingId: string }
  /** An accepted delegate, but the module has been switched off since. */
  | { kind: "MODULE_OFF"; guestFirstName: string }
  /** Somebody already answered. `respondedByViewer` when it was this viewer. */
  | {
      kind: "ALREADY_ANSWERED";
      status: "CONFIRMED" | "DECLINED";
      guestFirstName: string;
      respondedAt: Date | null;
    }
  /** The request lapsed with no answer (the row survived its removal attempt). */
  | { kind: "LAPSED"; guestFirstName: string }
  | { kind: "ASK"; facts: DelegateConsentAskFacts };

/**
 * Whole years between a date of birth and the club's today. Null if unknown.
 *
 * THIS USED TO BE A SECOND COPY OF THE AGE RULE, and it read both operands
 * through `APP_TIME_ZONE` (#3123). Two things were wrong with that. The zone was
 * the container's rather than the club's persisted one (`INV-CONFIG-002`); and
 * `Member.dateOfBirth` is a stored `@db.Date` calendar day
 * (`prisma/schema.prisma:514`), which takes no timezone at all — projecting its
 * UTC-midnight encoding into a zone behind Greenwich lands on the previous
 * evening, so a member born on 1 January read a year short on their own
 * birthday for every club west of UTC. That is #3082, and `member-age.ts`
 * already fixed it once; this file now uses that answer rather than keeping its
 * own.
 *
 * `todayInClub` is a `yyyy-MM-dd` calendar date, which
 * `calculateMemberAgeParts` takes as written.
 */
function ageInYears(
  dateOfBirth: Date | null,
  todayInClub: CalendarDate,
): number | null {
  return calculateMemberAgeParts(dateOfBirth, todayInClub)?.years ?? null;
}

export async function resolveDelegateConsentPageState(params: {
  guestId: string;
  viewerMemberId: string;
  db?: typeof prisma;
  delegateResolver?: MemberGuestConsentDelegateResolver;
  /** Injected for tests; defaults to the shared module read. */
  moduleEnabled?: () => Promise<boolean>;
  now?: Date;
}): Promise<DelegateConsentPageState> {
  const {
    guestId,
    viewerMemberId,
    db = prisma,
    delegateResolver = familyAdultDelegateResolver,
    moduleEnabled = () => isEffectiveModuleEnabled(MEMBER_GUEST_MODULE_KEY),
    now = new Date(),
  } = params;

  if (!guestId || !viewerMemberId) return { kind: "NOT_FOUND" };

  // The club's PERSISTED timezone, resolved ONCE for this page (#3123,
  // INV-CONFIG-002). `clubTimeZone()` rather than the CLI-safe runtime reader:
  // nothing outside a React request reaches this module — no CLI root, no
  // instrumentation edge — so the request-scoped React `cache()` memo is free
  // here. Both temporal answers below are derived from this one value, so the
  // age and the stay-started prediction can never be worked out on two
  // different days.
  const zone: ClubTimeZone = await clubTimeZone();
  const todayInClub = clubCalendarDateOf(now, zone);

  const guest = await db.bookingGuest.findUnique({
    where: { id: guestId },
    select: {
      id: true,
      memberId: true,
      firstName: true,
      lastName: true,
      consentStatus: true,
      consentRespondedAt: true,
      consentExpiresAt: true,
      stayStart: true,
      stayEnd: true,
      nights: { select: { stayDate: true } },
      booking: {
        select: {
          id: true,
          lodgeId: true,
          checkIn: true,
          checkOut: true,
          status: true,
          deletedAt: true,
          member: { select: { firstName: true, lastName: true } },
          // Names only — never prices. The party listing is MG2-D-a as ticked.
          guests: { select: { id: true, firstName: true, lastName: true } },
        },
      },
    },
  });

  // A row that is not a member-guest consent row at all — no such row, a
  // non-member guest, a family-scope row with nothing to answer, or a
  // soft-deleted booking — is the same NOT_FOUND as "not your family". The
  // authorization check runs BEFORE any status is disclosed, so an
  // unauthorized caller learns nothing from any of these branches.
  if (
    !guest ||
    !guest.memberId ||
    guest.consentStatus === null ||
    guest.booking.deletedAt
  ) {
    return { kind: "NOT_FOUND" };
  }

  if (guest.memberId === viewerMemberId) {
    // The target answering for themselves belongs on the booking page — D-11
    // grants their pending row full access, and the consent card lives there.
    return { kind: "TARGET_SELF", bookingId: guest.booking.id };
  }

  const isDelegate = await delegateResolver.canRespondForTarget({
    actorMemberId: viewerMemberId,
    targetMemberId: guest.memberId,
    db,
  });
  if (!isDelegate) return { kind: "NOT_FOUND" };

  // Only an ACCEPTED delegate gets past this line; every state below may
  // honestly describe the request because the caller is entitled to know.
  if (!(await moduleEnabled())) {
    return { kind: "MODULE_OFF", guestFirstName: guest.firstName };
  }

  if (guest.consentStatus === "CONFIRMED" || guest.consentStatus === "DECLINED") {
    return {
      kind: "ALREADY_ANSWERED",
      status: guest.consentStatus,
      guestFirstName: guest.firstName,
      respondedAt: guest.consentRespondedAt,
    };
  }

  if (guest.consentStatus === "EXPIRED") {
    return { kind: "LAPSED", guestFirstName: guest.firstName };
  }

  // PENDING — the ask itself.
  const [target, quotePriced] = await Promise.all([
    db.member.findUnique({
      where: { id: guest.memberId },
      select: { dateOfBirth: true },
    }),
    isQuotePricedBooking(db, guest.booking.id),
  ]);

  return {
    kind: "ASK",
    facts: {
      bookingId: guest.booking.id,
      guestId: guest.id,
      guest: {
        firstName: guest.firstName,
        lastName: guest.lastName,
        ageYears: ageInYears(target?.dateOfBirth ?? null, todayInClub),
      },
      bookerName:
        `${guest.booking.member.firstName} ${guest.booking.member.lastName}`.trim(),
      bookerFirstName: guest.booking.member.firstName,
      lodgeId: guest.booking.lodgeId,
      checkIn: guest.booking.checkIn,
      checkOut: guest.booking.checkOut,
      guestNights:
        guest.nights.length > 0
          ? guest.nights.map((night) => night.stayDate)
          : eachDateOnlyInRange(guest.stayStart, guest.stayEnd),
      consentExpiresAt: guest.consentExpiresAt,
      party: guest.booking.guests.map((row) =>
        `${row.firstName} ${row.lastName}`.trim(),
      ),
      refusalBlocker: predictConsentDeclineRefusal({
        bookingStatus: guest.booking.status,
        bookingCheckIn: guest.booking.checkIn,
        bookingGuestCount: guest.booking.guests.length,
        isQuotePriced: quotePriced,
        // The SAME club day the age above is worked out from. `now` is already
        // an injectable parameter of this resolver, so leaving the prediction to
        // read the wall clock for itself would have meant one call answering
        // two questions against two different days — and a caller that pinned
        // the clock would still have got a wall-clock answer here. `now` is a
        // real instant, so it is PROJECTED through the club's zone; the stored
        // `@db.Date` check-in it is compared against is decoded, not projected
        // (`predictConsentDeclineRefusal`).
        today: dateOnlyInstantOf(todayInClub),
      }),
    },
  };
}
