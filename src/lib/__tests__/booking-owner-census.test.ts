/**
 * WHO OWNS THIS BOOKING IS READ IN ONE PLACE — the guard (#3368, `INV-SSOT-005`).
 *
 * Stage 3 of programme #2912 replaced every direct read of a booking's member
 * with `bookingOwner()`. This census is what keeps that true: it reads every
 * non-test source file from disk and fails when a direct read comes back.
 *
 * `npm run test:related` CANNOT SELECT THIS FILE. It has no import edge to the
 * tree it scans, so the module graph cannot reach it from a changed file — the
 * same blind spot `AGENTS.md` names for the other disk-scanning censuses in
 * this directory. It is CI-caught by design; run it by name.
 *
 * ## What it looks for, and what it deliberately cannot see
 *
 * A read is `X.member` or `X.memberId` where `X` is a booking. Three ways of
 * knowing that `X` is a booking, in descending order of how much of the tree
 * they cover:
 *
 * 1. **Its NAME ends in "booking"** — `booking`, `fullBooking`,
 *    `payment.booking`, `reviewedBooking`. This is most of the tree and it is
 *    also the shape a new reader is overwhelmingly likely to be written in.
 * 2. **It was BOUND from the booking delegate in the same file** —
 *    `const fresh = await tx.booking.findUnique(...)`. This is the one that
 *    earns its keep: it is how the sweep found `fresh`, `held`, `key`,
 *    `lockTarget` and `entry`, five aliases that a name-based scan cannot see
 *    and that a TYPE-based census missed as well, because each of them selects
 *    two or three columns and nothing in that selection says "booking".
 * 3. **It is the callback parameter of an iteration over something named for
 *    bookings** — `bookings.map((b) => …)`.
 *
 * **Stated limits, because a census that hides its blind spots is worse than no
 * census.** A booking reached through a parameter typed elsewhere, through
 * `for (const child of children)`, through a bracket access, or through a
 * destructure is not seen — though the destructure is separately asserted to be
 * absent below, so that one is a closed door rather than an open blind spot.
 * What makes those limits tolerable is that the accessor is the ONLY import a
 * new reader would reach for; a reader who has gone to the trouble of aliasing
 * a booking through an untyped parameter has gone past several signposts.
 *
 * ## The lists this publishes, and why they are lists rather than counts
 *
 * Stage 4 (#3369) makes the member link optional. The two families below are
 * where a missing member is a correctness problem rather than a display one, so
 * this census keeps them enumerated and current — for the next stage to work
 * from, and so nobody re-derives them by hand at the moment they matter.
 * **Re-measure by running this test; never edit a list by incrementing it.**
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  relativeSource,
  sourceFiles,
} from "@/lib/__tests__/support/booking-guest-night-writer-scan";
import { stripCommentsAndStrings } from "@/lib/__tests__/support/strip-comments";

/**
 * The ONE file allowed to read the column directly: the accessor's own body,
 * which is what every other reader now goes through.
 */
const ACCESSOR = "src/lib/booking-owner.ts";

/** `X.member` / `X.memberId`, with `X` captured as prefix plus last segment. */
const READ =
  /(?<![\w$])((?:[A-Za-z_$][\w$]*\s*\??\.\s*)*)([A-Za-z_$][\w$]*)\s*\??\.\s*(member|memberId)\b/g;

/** `const fresh = await tx.booking.findUnique(` and its assignment form. */
const DELEGATE_BINDING =
  /([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?[A-Za-z_$][\w$.]*\.booking\s*\.\s*(?:findUnique|findUniqueOrThrow|findFirst|findFirstOrThrow|findMany|create|update|upsert)\b/g;

/**
 * `bookings.map((b) => …)` — the callback's parameter is a booking.
 *
 * The name ends in "ookings" after at least one character, which is how
 * `bookings`, `allBookings` and `payment.bookings` are all one pattern.
 * Requiring a leading character AND then an upper- or lower-case B — the
 * obvious way, and how this was first written — silently excluded the bare
 * `bookings`, the commonest spelling in the tree. The fixture below caught it.
 */
const ITERATION_BINDING =
  /[A-Za-z_$][\w$.]*ookings\s*\??\.\s*(?:map|flatMap|filter|forEach|find|findIndex|some|every|reduce)\s*\(\s*\(?\s*([A-Za-z_$][\w$]*)/g;

/**
 * A destructure of the owner off a booking, which would walk around the READ.
 * Ends in "ooking" for the same reason the iteration rule ends in "ookings":
 * the bare `= booking` is the spelling that matters most, and a leading
 * character class could not see it.
 */
const DESTRUCTURE =
  /(?:const|let|var)\s*\{[^}]*\b(?:member|memberId)\b[^}]*\}\s*=\s*[A-Za-z_$][\w$.]*ooking\b/g;

/**
 * `row.booking` — whatever `row` is, it is not itself a booking.
 *
 * The one exclusion the alias rules need, and a STRUCTURAL fact rather than an
 * allowlist, which is why it is written as a rule. The admin work-parties
 * table iterates `detail.attendingBookings`, whose rows are ATTENDANCE
 * records: each carries both the attendee (`row.member`) and the booking
 * (`row.booking`). The iteration rule cannot tell a list of bookings from a
 * list of rows ABOUT bookings by the name alone — but a value with a booking
 * hanging off it has answered the question itself.
 *
 * Scoped to the two ALIAS rules and deliberately not to the name rule: it must
 * never be able to excuse `payment.booking.member`, where the value named for
 * a booking IS the booking.
 */
const CARRIES_A_BOOKING =
  /(?<![\w$])([A-Za-z_$][\w$]*)\s*\??\.\s*booking(?![\w$])/g;

type Hit = { file: string; line: number; via: string; text: string };

function scan(): { hits: Hit[]; destructures: Hit[]; files: number; code: Map<string, string> } {
  const hits: Hit[] = [];
  const destructures: Hit[] = [];
  const code = new Map<string, string>();
  const files = sourceFiles()
    .map(relativeSource)
    .filter((file) => /^(?:src|scripts)\//.test(file) && file !== ACCESSOR);

  for (const file of files) {
    const source = stripCommentsAndStrings(readFileSync(file, "utf8"));
    code.set(file, source);

    const aliases = new Set<string>();
    for (const [, name] of source.matchAll(DELEGATE_BINDING)) aliases.add(name);
    for (const [, name] of source.matchAll(ITERATION_BINDING)) aliases.add(name);
    for (const [, name] of source.matchAll(CARRIES_A_BOOKING)) aliases.delete(name);

    source.split("\n").forEach((text, index) => {
      for (const match of text.matchAll(READ)) {
        const prefix = (match[1] ?? "").replace(/\s/g, "");
        const last = match[2];
        const via = /booking$/i.test(last)
          ? "named for a booking"
          : !prefix && aliases.has(last)
            ? "bound from the booking delegate, or iterated from bookings"
            : null;
        if (!via) continue;
        hits.push({ file, line: index + 1, via, text: text.trim() });
      }
      for (const _ of text.matchAll(DESTRUCTURE)) {
        destructures.push({ file, line: index + 1, via: "destructure", text: text.trim() });
      }
    });
  }
  return { hits, destructures, files: files.length, code };
}

const scanned = scan();

const describeHit = (hit: Hit) =>
  `${hit.file}:${hit.line} (${hit.via}) — ${hit.text.slice(0, 120)}`;

describe("#3368: a booking's owner is read in exactly one place", () => {
  it("scans a meaningful number of source files", () => {
    // A walker that silently found nothing would make every assertion below
    // vacuous, which is how a census fails without failing.
    expect(scanned.files).toBeGreaterThan(1500);
  });

  it("finds no direct read of a booking's member outside the accessor", () => {
    expect(
      scanned.hits.map(describeHit),
      "A booking's member is being read directly again. `INV-SSOT-005`: who " +
        "owns a booking is answered by `bookingOwner()` in " +
        "`src/lib/booking-owner.ts` and nowhere else, because stage 4 (#3369) " +
        "makes the member link optional and every one of these sites would " +
        "otherwise need its own answer to what a missing member means. Route " +
        "the read through the accessor; if this really is not a booking, say " +
        "so here with the reason.",
    ).toEqual([]);
  });

  it("finds no destructure of the owner off a booking", () => {
    // The READ pattern is a property access. A destructure would produce a
    // bare `memberId` that no scanner in this tree can attribute to a booking,
    // so the census closes that door rather than living with it: there were
    // none before this stage and there are none now.
    expect(
      scanned.destructures.map(describeHit),
      "`const { memberId } = booking` walks around this census entirely — the " +
        "binding it produces is indistinguishable from any other `memberId`. " +
        "Read it through `bookingOwner()` instead (`INV-SSOT-005`).",
    ).toEqual([]);
  });

  it("FAILS when a new direct read appears (fixture proof)", () => {
    const injected = [
      "const owner = booking.memberId;",
      "sendEmail(reviewedBooking.member.email);",
      "const fresh = await tx.booking.findUnique({});\nnotify(fresh.memberId);",
      "bookings.map((b) => b.member.firstName);",
    ];
    for (const code of injected) {
      const aliases = new Set<string>();
      for (const [, name] of code.matchAll(DELEGATE_BINDING)) aliases.add(name);
      for (const [, name] of code.matchAll(ITERATION_BINDING)) aliases.add(name);
      for (const [, name] of code.matchAll(CARRIES_A_BOOKING)) aliases.delete(name);
      const found = [...code.matchAll(READ)].filter(([, prefix, last]) => {
        const bare = (prefix ?? "").replace(/\s/g, "") === "";
        return /booking$/i.test(last) || (bare && aliases.has(last));
      });
      expect(found.length, `no hit for: ${code}`).toBeGreaterThan(0);
    }
  });

  it("does NOT fire on a read that already goes through the accessor", () => {
    // Without this the census could be "passing" because the sweep deleted the
    // reads rather than routing them, and a reviewer could not tell.
    const routed = "const id = bookingOwner(booking).memberId;";
    const found = [...routed.matchAll(READ)].filter(([, , last]) =>
      /booking$/i.test(last),
    );
    expect(found).toEqual([]);
  });

  it("does NOT fire on a row that merely CARRIES a booking", () => {
    // `detail.attendingBookings.map((row) => row.member.firstName)` in the
    // admin work-parties table: `row` is an attendance record, and its
    // `member` is the ATTENDEE, not a booking's owner. Without this rule the
    // census could only pass by carrying an allowlist.
    const code =
      "attendingBookings.map((row) => row.member.firstName + row.booking.status);";
    const aliases = new Set<string>();
    for (const [, name] of code.matchAll(ITERATION_BINDING)) aliases.add(name);
    expect(aliases.has("row"), "the iteration rule should bind it").toBe(true);
    for (const [, name] of code.matchAll(CARRIES_A_BOOKING)) aliases.delete(name);
    const found = [...code.matchAll(READ)].filter(([, prefix, last]) => {
      const bare = (prefix ?? "").replace(/\s/g, "") === "";
      return /booking$/i.test(last) || (bare && aliases.has(last));
    });
    expect(found).toEqual([]);
  });

  it("does NOT fire on another model's own member link", () => {
    // `BookingGuest.memberId` is the GUEST's member, not the booking's owner,
    // and it is not this rule's business. The name test ends on "booking", so
    // `bookingGuest` is outside it — and that has to stay true, because the
    // tree is full of those reads.
    const guest = "recordGuest(row.bookingGuest.memberId);";
    const found = [...guest.matchAll(READ)].filter(([, , last]) =>
      /booking$/i.test(last),
    );
    expect(found).toEqual([]);
  });
});

/**
 * The two families stage 4 has to decide site by site.
 *
 * Both are asserted as sorted lists rather than counts: when one changes, the
 * failure shows WHICH site arrived, which is the thing the next stage needs.
 * The #2912 census put the first family at ten and the second at three. Both
 * were floors measured on an older tree; these are the measurement.
 */
const COMPARISON =
  /bookingOwner\([^()]*\)\.memberId\s*(?:!==|===|!=|==)|(?:!==|===|!=|==)\s*bookingOwner\([^()]*\)\.memberId/;

const MEMBER_KEYED_HELPER =
  /\b(?:lockMemberCreditLedger|getMemberCreditBalance|findOrCreateXeroContact|restoreCreditFromBooking|createBookingModificationCredit)\(\s*\n?\s*bookingOwner\(/;

function sitesMatching(pattern: RegExp): string[] {
  const out: string[] = [];
  for (const [file, source] of scanned.code) {
    source.split("\n").forEach((text, index) => {
      if (pattern.test(text)) out.push(`${file}:${index + 1}`);
    });
  }
  return out.sort();
}

describe("#3368: the two families stage 4 (#3369) has to answer for", () => {
  it("enumerates every ownership comparison against an actor", () => {
    const sites = sitesMatching(COMPARISON);
    expect(
      sites,
      "The set of `is this booking the actor's own?` comparisons has moved. " +
        "Every one of them becomes unconditionally true once a booking can be " +
        "owned by an organisation, so stage 4 (#3369) works from this list. " +
        "RE-MEASURE BY RUNNING THIS TEST and paste the result — a list edited " +
        "by hand is a list that has already drifted. The decision about what " +
        "these comparisons mean is in `src/lib/booking-owner.ts` " +
        "(`INV-SSOT-005`).",
    ).toEqual(OWNERSHIP_COMPARISON_SITES);
  });

  it("enumerates every member-keyed helper handed the owner's id", () => {
    const sites = sitesMatching(MEMBER_KEYED_HELPER);
    expect(
      sites,
      "The set of member-keyed credit, ledger and Xero calls taking a " +
        "booking's owner has moved. A null member id either throws inside the " +
        "helper or degenerates to a shared advisory key, which is an " +
        "`INV-LOCK` hazard that only appears under concurrency — so stage 4 " +
        "(#3369) branches at each of these rather than passing an empty key. " +
        "RE-MEASURE BY RUNNING THIS TEST rather than editing the list.",
    ).toEqual(MEMBER_KEYED_HELPER_SITES);
  });
});

/** Measured, not counted by hand. Re-measure by running this test. */
const OWNERSHIP_COMPARISON_SITES: readonly string[] = [
  "src/app/(authenticated)/bookings/[id]/_lib/booking-detail-viewer.ts:37",
  "src/app/(authenticated)/bookings/[id]/page.tsx:187",
  "src/app/(authenticated)/bookings/page.tsx:134",
  "src/app/api/bookings/[id]/additional-payment-secret/route.ts:52",
  "src/app/api/bookings/[id]/arrival-time/route.ts:140",
  "src/app/api/bookings/[id]/arrival-time/route.ts:248",
  "src/app/api/bookings/[id]/arrival-time/route.ts:298",
  "src/app/api/bookings/[id]/arrival-time/route.ts:367",
  "src/app/api/bookings/[id]/cancel-preview/route.ts:49",
  "src/app/api/bookings/[id]/change-requests/route.ts:211",
  "src/app/api/bookings/[id]/change-requests/route.ts:539",
  "src/app/api/bookings/[id]/confirm-draft/route.ts:90",
  "src/app/api/bookings/[id]/confirm-modification-payment/route.ts:69",
  "src/app/api/bookings/[id]/confirm-payment/route.ts:80",
  "src/app/api/bookings/[id]/exception-requests/route.ts:120",
  "src/app/api/bookings/[id]/guests/route.ts:317",
  "src/app/api/bookings/[id]/modify-quote/route.ts:332",
  "src/app/api/bookings/[id]/notes/route.ts:47",
  "src/app/api/bookings/[id]/refund-request/route.ts:225",
  "src/app/api/bookings/[id]/refund-request/route.ts:41",
  "src/app/api/bookings/[id]/requested-room/options/route.ts:85",
  "src/app/api/bookings/[id]/send-guest-payment-link/route.ts:66",
  "src/app/api/payments/create-payment-intent/route.ts:131",
  "src/app/api/payments/create-setup-intent/route.ts:54",
  "src/app/api/payments/switch-to-internet-banking/route.ts:113",
  "src/lib/adult-member-hosting-review.ts:2875",
  "src/lib/adult-member-hosting-review.ts:3115",
  "src/lib/booking-batch-modification-service.ts:973",
  "src/lib/booking-cancel.ts:464",
  "src/lib/booking-date-modification-service.ts:376",
  "src/lib/booking-delete.ts:121",
  "src/lib/booking-delete.ts:70",
  "src/lib/booking-email-authority.ts:115",
  "src/lib/booking-guest-removal-service.ts:417",
  "src/lib/booking-guest-removal-service.ts:751",
  "src/lib/booking-linked-date-move-service.ts:233",
  "src/lib/booking-member-night-conflicts.ts:352",
  "src/lib/booking-modify-validation.ts:527",
  "src/lib/group-booking.ts:264",
  "src/lib/kiosk-access.ts:232",
  "src/lib/manual-refund-task-queue-payload.ts:153",
  "src/lib/requested-room-write.ts:62",
  "src/lib/waitlist-cross-lodge.ts:334",
  "src/lib/waitlist-cross-lodge.ts:522",
  "src/lib/waitlist.ts:1075",
  "src/lib/waitlist.ts:933",
  "src/lib/xero-period-lock-guard.ts:566",
];

/** Measured, not counted by hand. Re-measure by running this test. */
const MEMBER_KEYED_HELPER_SITES: readonly string[] = [
  "src/app/(authenticated)/bookings/[id]/_lib/booking-detail-editor-data.ts:82",
  "src/app/api/bookings/[id]/modify-quote/route.ts:740",
  "src/app/api/payments/switch-to-internet-banking/route.ts:235",
  "src/lib/booking-cancel.ts:336",
  "src/lib/booking-cancel.ts:983",
  "src/lib/booking-credit-election.ts:131",
  "src/lib/booking-credit-election.ts:167",
  "src/lib/diagnostics/tools/packs/finance-evidence.ts:559",
  "src/lib/internet-banking-payment-cron.ts:80",
  "src/lib/organisation-xero-contacts.ts:160",
  "src/lib/payment-reconciliation.ts:1370",
  "src/lib/payment-reconciliation.ts:406",
  "src/lib/xero-applied-credit-allocation.ts:470",
  "src/lib/xero-applied-credit-allocation.ts:566",
  "src/lib/xero-applied-credit-allocation.ts:626",
  "src/lib/xero-applied-credit-deallocation.ts:710",
  "src/lib/xero-inbound/credit-note-repairs.ts:767",
];
