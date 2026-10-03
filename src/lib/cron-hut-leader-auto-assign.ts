import { prisma } from "./prisma";
import {
  addDaysDateOnly,
  eachDateOnlyInRange,
  formatDateOnly,
  parseDateOnly,
} from "@/lib/date-only";
import { getGuestBedNightKeys } from "@/lib/booking-guest-stay-ranges";
import {
  hutLeaderStayBookingWhere,
  stayedNightRunContaining,
} from "@/lib/hut-leader-stayed-nights";
import { clubToday, dateOnlyInstantOf } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { lodgeNullTolerantScope } from "./lodges";
import { acquireLodgeCapacityLock } from "./lodge-capacity-lock";
import { findHutLeaderOverlapRefusal } from "./hut-leader-overlap-guard";
import { loadHutLeaderLookaheadDays } from "./lodge-settings";
import { loadEffectiveModuleFlags } from "./module-settings";
import { OPERATIONALLY_PRESENT_GUEST_WHERE } from "@/lib/member-guest-consent";
import { HutLeaderAssignmentSource } from "@prisma/client";
import logger from "./logger";

/**
 * Auto-assign hut leaders when only 1 adult member is booked for a date.
 * Uses the configured lookahead, finds dates without an assignment, and
 * auto-assigns if exactly 1 distinct adult member is staying. No-op when the
 * Hut leaders module is disabled.
 *
 * The row it writes covers the NIGHTS that member stays (#3817): from the first
 * to the last night of the run of consecutive nights containing the date, so it
 * ends on `checkOut - 1`, never on the check-out day, and a split stay gets one
 * row per run. A night between two runs is not theirs and is not claimed.
 *
 * Runs per (lodge, night), never club-wide (#2915). Each lodge has its own hut
 * leader — the same rule the admin route states — so every decision here is
 * taken within one lodge: whether the night is already covered, who is present
 * to be chosen, whether "exactly one adult member" holds, and whether an
 * existing assignment overlaps. Pooling any of them across lodges silently
 * under-assigns: one lodge's leader used to silence every other lodge for that
 * night, and two lodges each with exactly one eligible adult summed to two, so
 * neither of them got a leader.
 *
 * #2887 adds the SERIALIZATION on top of that scoping. Deciding per lodge is
 * not enough on its own: the overlap read and the insert are one decision, and
 * run unlocked they race an admin (or a second cron container) into two
 * overlapping leaders at one lodge, which no database constraint prevents. The
 * create therefore runs inside a transaction holding that lodge's capacity key,
 * with the already-covered and overlap questions re-asked under it. The cheap
 * asks above the lock stay: they skip most nights without paying for one.
 */
export async function autoAssignHutLeaders(): Promise<{
  assignedCount: number;
  assignedDates: string[];
}> {
  const modules = await loadEffectiveModuleFlags();
  if (!modules.hutLeaders) {
    return { assignedCount: 0, assignedDates: [] };
  }

  const lookAheadDays = await loadHutLeaderLookaheadDays();
  const today = dateOnlyInstantOf(clubToday(await readClubTimeZoneOutsideRequest()));
  const endDate = addDaysDateOnly(today, lookAheadDays);
  // UTC date-only nights, stepped with the domain's own helper — the same fix
  // `cron-capacity-warnings.ts` made (#2286 review L3). date-fns
  // `eachDayOfInterval` returns LOCAL-midnight dates, so in a container running
  // `TZ=Pacific/Auckland` every `day` here sat at 12:00Z of the PREVIOUS
  // calendar day: Prisma truncated it to that day, so the job silently ran one
  // night early, from yesterday. #3818 makes it unmissable: the shared coverage
  // helper reads the night through `isGuestActiveOnNight`, which refuses a
  // value that is not a stored calendar day rather than guess.
  const days = eachDateOnlyInRange(today, addDaysDateOnly(endDate, 1));

  const assignedDates: string[] = [];

  // Active lodges only — an archived lodge is out of service and should not be
  // rostered. Same read shape as cron-capacity-warnings.
  const activeLodges = await prisma.lodge.findMany({
    where: { active: true },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });

  for (const lodge of activeLodges) {
    for (const day of days) {
      // Check if there's already an assignment for this date AT THIS LODGE.
      //
      // THIS PROBE IS DELIBERATELY SOURCE-BLIND, and it is the one gate #2926
      // decided rather than changed (owner decision recorded on the issue; the
      // "fifth gate" its acceptance criteria name). A school-teacher row counts
      // as coverage here, so the job does not auto-assign a leader for a night
      // a school group already has teachers on site — a teacher IS present, and
      // manufacturing a second leader beside them helps nobody. The OVERLAP
      // predicate below is the opposite and on purpose: it answers "may a
      // DELIBERATE assignment stand here?", and an officer choosing to add one
      // is not to be refused by teacher rows. Coverage is automatic and stays
      // out of the way; overlap is a refusal and stops refusing.
      const existingAssignment = await prisma.hutLeaderAssignment.findFirst({
        where: {
          startDate: { lte: day },
          endDate: { gte: day },
          ...lodgeNullTolerantScope(lodge.id),
        },
      });

      if (existingAssignment) continue;

      // Find distinct adult members staying this night at this lodge. Scoped,
      // so the "exactly one adult member" test below counts the people actually
      // at THIS lodge rather than pooling every lodge's guests. The booking
      // filter is THE hut-leader stay definition the manual create/edit check
      // and the eligible-members list use (#3817, `INV-SSOT`): an operational
      // stay (PAID or COMPLETED; a booking still ahead of its check-out is
      // PAID, so COMPLETED adds nobody here) and never a soft-deleted booking.
      const bookingsForDate = await prisma.booking.findMany({
        where: {
          ...hutLeaderStayBookingWhere({ lodgeId: lodge.id, rangeStart: day, rangeEnd: day }),
          guests: {
            some: {
              ageTier: "ADULT",
              isMember: true,
              memberId: { not: null },
              stayStart: { lte: day },
              stayEnd: { gt: day },
              ...OPERATIONALLY_PRESENT_GUEST_WHERE,
            },
          },
        },
        select: {
          checkIn: true,
          checkOut: true,
          guests: {
            where: {
              ageTier: "ADULT",
              isMember: true,
              memberId: { not: null },
              stayStart: { lte: day },
              stayEnd: { gt: day },
              // Owner decision D-12 (#2307): a member whose own consent to being
              // added as a guest has not been given is not operationally present,
              // and must never be auto-made hut leader off the back of that row.
              // BOTH sites matter: the `some` decides whether the booking is
              // considered at all, and this `where` decides who is counted — and
              // this job only assigns when there is EXACTLY ONE adult member, so
              // an unconsented row left in either place would silently change the
              // outcome for the consented member standing next to them.
              ...OPERATIONALLY_PRESENT_GUEST_WHERE,
            },
            select: {
              memberId: true,
              stayStart: true,
              stayEnd: true,
              // #3817: the explicit night set, so presence and the written
              // range come from the night model, not the envelope (which fills
              // a split stay's gaps and ends on a check-out morning).
              nights: { select: { stayDate: true } },
              // Names are no longer selected: they were read only to be logged
              // (INV-PRIV-011, #2683), and not fetching them is the strongest
              // form of not leaking them.
              member: { select: { id: true, active: true } },
            },
          },
        },
      });

      // Collect distinct active adult members.
      //
      // INV-PRIV-011 (#2683): the member's composed name is deliberately NOT
      // carried here. It existed only to be logged, and this job runs nightly
      // across every lodge night, so it wrote a stream of members' full names into
      // the application log on a completely ordinary success path. The member id
      // identifies the assignment for anyone reading the log.
      //
      // #3817: a guest counts only if they hold a bed on THIS night, and the
      // nights written are the run of consecutive stayed nights containing it.
      // Both come from one read of the night model (`getGuestBedNightKeys`): no
      // run contains `day` exactly when the guest does not stay it. The SQL
      // filter above is the envelope, which is coarse (`INV-DATE-022`): it
      // admits a split stay's gap night, and its `stayEnd` is a check-out
      // MORNING, not a night.
      const dayKey = formatDateOnly(day);
      const adultMembers = new Map<string, {
        id: string;
        firstNight: Date;
        lastNight: Date;
      }>();

      for (const booking of bookingsForDate) {
        for (const guest of booking.guests) {
          if (!guest.memberId || !guest.member || !guest.member.active) continue;
          if (adultMembers.has(guest.memberId)) continue;
          const run = stayedNightRunContaining(
            getGuestBedNightKeys(guest, booking),
            dayKey,
          );
          // Not staying this night (a gap night, or the envelope only).
          if (!run) continue;
          adultMembers.set(guest.memberId, {
            id: guest.memberId,
            firstNight: parseDateOnly(run.first),
            lastNight: parseDateOnly(run.last),
          });
        }
      }

      // Only auto-assign if exactly 1 adult member is at THIS lodge that night.
      if (adultMembers.size !== 1) continue;

      const [onlyEntry] = adultMembers.entries();
      // Unreachable: `adultMembers.size === 1` is checked just above.
      if (!onlyEntry) continue;
      const [, member] = onlyEntry;

      // Overlap validation, per lodge for the same reason the admin route is:
      // an assignment at another lodge is not a conflict here. Asked through
      // the SHARED predicate all four deciding call sites use (#2887), so the
      // cheap answer here and the authoritative one under the lock below cannot
      // disagree about what an overlap is.
      //
      // SCHOOL-TEACHER ROWS STILL BLOCK HERE, and deliberately so: this call
      // omits `allowOverlappingSchoolRows`. #2926's carve-out answers "may a
      // DELIBERATE assignment stand here?", which is an officer's question and
      // not this job's. An earlier version of this comment claimed the coverage
      // probe above had already skipped any night with teachers present, so the
      // carve-out was felt at the admin route rather than here. That was FALSE,
      // and reachable: the probe asks about one `day`, while the row created
      // below spans the guest's whole run of stayed nights. Teachers 10-14 Aug, a sole adult's
      // stay 12-20 Aug, the loop reaching 15 Aug - the probe finds 15 Aug
      // uncovered, and with the carve-out applied the span read over 12-20 Aug
      // skipped the teacher rows and planted a CRON row across the school
      // nights. Being MANUAL-equivalent it then blocked officers across the
      // whole span too. Omitting the flag restores exactly the pre-carve-out
      // refusal for this job.
      const earlyOverlap = await findHutLeaderOverlapRefusal(prisma, {
        lodgeId: lodge.id,
        startDate: member.firstNight,
        endDate: member.lastNight,
      });
      if (earlyOverlap) continue;

      // Create the assignment against the lodge this iteration decided for. The
      // booking read above is scoped to it, so `member.lodgeId` is this lodge —
      // using `lodge.id` states that directly instead of re-deriving it, and
      // removes the default-lodge fallback that a club-wide loop needed.
      try {
        const created = await prisma.$transaction(async (tx) => {
          await acquireLodgeCapacityLock(tx, lodge.id);

          // Both questions re-asked under the key. Another container or an
          // admin may have covered this lodge-night since the cheap asks.
          // Source-blind for the same reason the cheap probe is, and it has to
          // match it exactly: a locked re-ask that answered a different question
          // from the one above would make the cheap skip and the authoritative
          // skip disagree (#2926).
          const lockedAssigned = await tx.hutLeaderAssignment.findFirst({
            where: {
              startDate: { lte: day },
              endDate: { gte: day },
              ...lodgeNullTolerantScope(lodge.id),
            },
            select: { id: true },
          });
          if (lockedAssigned) return false;

          const lockedOverlap = await findHutLeaderOverlapRefusal(tx, {
            lodgeId: lodge.id,
            startDate: member.firstNight,
            endDate: member.lastNight,
          });
          if (lockedOverlap) return false;

          await tx.hutLeaderAssignment.create({
            data: {
              memberId: member.id,
              // #3817: the guest's first and LAST NIGHT STAYED in this run of
              // consecutive nights — never the check-out day (INV-DATE-002).
              startDate: member.firstNight,
              endDate: member.lastNight,
              lodgeId: lodge.id,
              // #2926: the nightly sole-adult rule put this leader here. A CRON
              // row is an ordinary assignment for every purpose — it blocks and
              // is blocked exactly like a MANUAL one. The value is recorded so
              // provenance is complete and so a future question about
              // auto-assigned rows has something to ask.
              source: HutLeaderAssignmentSource.CRON,
            },
          });
          return true;
        });

        if (!created) continue;

        const dateStr = formatDateOnly(day);
        assignedDates.push(dateStr);
        logger.info(
          { memberId: member.id, date: dateStr, lodgeId: lodge.id },
          "Auto-assigned hut leader"
        );
      } catch (err) {
        logger.error({ err, memberId: member.id, lodgeId: lodge.id }, "Failed to auto-assign hut leader");
      }
    }
    }

  return { assignedCount: assignedDates.length, assignedDates };
}
