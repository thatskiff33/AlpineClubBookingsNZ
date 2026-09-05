import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  evaluateGuestSelfRemoval,
  describeGuestSelfRemovalBlocker,
  type GuestSelfRemovalBlocker,
} from "@/lib/booking-guest-self-removal";
import {
  MEMBER_GUEST_REMOVAL_NOTE_BY_BLOCKER,
  MEMBER_GUEST_SELF_REMOVAL_OFFER,
  composeMemberGuestRemovalNote,
  composeMemberGuestWithdrawn,
} from "@/lib/member-guest-email-notes";

/**
 * MG4 (#2309) — the edit path's two OWNER DECISIONS, pinned as absences.
 *
 * Both D-13 and D-14 were ticked in the direction of building LESS, and both
 * are the kind of decision a later change undoes by being helpful. A test that
 * only exercised what MG4 adds would not notice either being quietly reversed,
 * so these pin the shapes the decisions rule out.
 */

function readRepoFile(relative: string): string {
  return fs.readFileSync(path.join(process.cwd(), relative), "utf8");
}

/**
 * The files the two copy sweeps read.
 *
 * ONE LIST FOR BOTH SWEEPS, because both ask the same question of the same
 * surfaces — "does any member-facing sentence promise something the code
 * deliberately does not do?" — and a file added to one sweep and forgotten by
 * the other is exactly the gap a shared list closes.
 */
const MEMBER_FACING_SURFACES = [
  "src/lib/member-guest-email-notes.ts",
  "src/lib/member-guest-consent-card.ts",
  "src/components/member-guest-consent-card.tsx",
  "src/components/member-guest-delegate-consent-card.tsx",
  "src/components/booking/edit-member-guest-section.tsx",
  "docs/user-guide/being-added-to-a-booking.md",
  "docs/user-guide/booking-a-stay.md",
];

// ---------------------------------------------------------------------------
// D-13 — consent covers the booking however it later changes
// ---------------------------------------------------------------------------

describe("D-13: an edit never revisits a consent that has already been given", () => {
  const NEW_CHECK_IN = new Date("2026-09-20T00:00:00.000Z");
  const NEW_CHECK_OUT = new Date("2026-09-24T00:00:00.000Z");

  /**
   * The committed consent of a cross-family member guest who said yes to a
   * SHORTER stay than the one this edit is about to write.
   */
  const CONSENTED = {
    consentStatus: "CONFIRMED" as const,
    consentRequestedAt: new Date("2026-08-01T09:00:00.000Z"),
    consentRespondedAt: new Date("2026-08-02T09:00:00.000Z"),
    consentRespondedByMemberId: "m-sam",
    consentExpiresAt: new Date("2026-08-08T09:00:00.000Z"),
  };

  function fakeTx() {
    const updates: Array<{ where: unknown; data: Record<string, unknown> }> = [];
    return {
      updates,
      tx: {
        bookingGuest: {
          create: vi.fn(async () => ({
            id: "bg-new",
            stayStart: NEW_CHECK_IN,
            stayEnd: NEW_CHECK_OUT,
            memberId: null,
          })),
          update: vi.fn(
            async (args: { where: unknown; data: Record<string, unknown> }) => {
              updates.push(args);
              return {};
            },
          ),
          delete: vi.fn(async () => ({})),
        },
        bookingGuestNight: {
          deleteMany: vi.fn(async () => ({ count: 0 })),
          createMany: vi.fn(async () => ({ count: 0 })),
        },
        choreAssignment: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      },
    };
  }

  it("leaves a consented guest's five consent columns untouched when the stay is lengthened", async () => {
    // THE SCENARIO D-13 DECIDES: Sam agreed to two nights, and the booker now
    // stretches the booking to four. The ticked option accepts the silent
    // extension, so the ONLY correct behaviour is for nothing about Sam's
    // consent to move — no PENDING reset, no expiry-clock restart, no touch at
    // all. A regression that "helpfully" re-asked would fail here rather than
    // quietly overriding an owner decision.
    const { applyGuestChanges } = await import("@/lib/booking-modify-plan");
    const { tx, updates } = fakeTx();

    const existingGuest = {
      id: "bg-sam",
      firstName: "Sam",
      lastName: "Whittaker",
      ageTier: "ADULT" as const,
      isMember: true,
      memberId: "m-sam",
      stayStart: new Date("2026-09-20T00:00:00.000Z"),
      stayEnd: new Date("2026-09-22T00:00:00.000Z"),
      priceCents: 4000,
      ...CONSENTED,
    };

    await applyGuestChanges(
      tx as unknown as Parameters<typeof applyGuestChanges>[0],
      {
        bookingId: "bk-1",
        newCheckIn: NEW_CHECK_IN,
        newCheckOut: NEW_CHECK_OUT,
        removedGuests: [],
        remainingGuests: [
          existingGuest,
        ] as unknown as Parameters<typeof applyGuestChanges>[1]["remainingGuests"],
        proposedRemainingGuests: [
          {
            guest: existingGuest,
            stayStart: NEW_CHECK_IN,
            stayEnd: NEW_CHECK_OUT,
          },
        ] as unknown as Parameters<
          typeof applyGuestChanges
        >[1]["proposedRemainingGuests"],
        normalizedAddGuests: undefined,
        priceBreakdown: {
          guests: [
            {
              priceCents: 8000,
              perNightCents: [2000, 2000, 2000, 2000],
              perNightPriceSources: ["SOLD", "SOLD", "SOLD", "SOLD"],
              nightDates: [NEW_CHECK_IN],
            },
          ],
        },
        inProgressPlan: null,
      },
    );

    const samUpdates = updates.filter(
      (update) => (update.where as { id?: string }).id === "bg-sam",
    );
    expect(samUpdates.length).toBeGreaterThan(0);
    for (const update of samUpdates) {
      // Byte-identical means ABSENT, not "written back the same": a write-back
      // would be a second writer of these columns and would show up in the
      // consent-column census as one.
      expect(update.data).not.toHaveProperty("consentStatus");
      expect(update.data).not.toHaveProperty("consentRequestedAt");
      expect(update.data).not.toHaveProperty("consentRespondedAt");
      expect(update.data).not.toHaveProperty("consentRespondedByMemberId");
      expect(update.data).not.toHaveProperty("consentExpiresAt");
    }
    // The dates DID change — otherwise this test would pass over a no-op.
    expect(
      samUpdates.some(
        (update) => update.data.stayEnd instanceof Date || "stayEnd" in update.data,
      ),
    ).toBe(true);
  });

  it("ships no change-notification template, because the ticked option promised none", () => {
    // The epic's REJECTED D-13 option carried the change notification in its
    // second clause; the ticked one names the accepted outcome as "silent". A
    // template for it would be net-new scope in the one place the owner chose
    // the quieter behaviour, so its absence is asserted rather than assumed.
    const defaults = readRepoFile("src/lib/email-message-audit-defaults.ts");
    expect(defaults).not.toContain("member-guest-stay-changed");
    expect(defaults).not.toContain("member-guest-consent-reset");

    const senders = readRepoFile("src/lib/email/member-guest.ts");
    expect(senders).not.toContain("StayChanged");
  });

  it("keeps the member-facing copy free of any promise that consent is re-asked", () => {
    // The sweep §4.2 asks for, as a test rather than as a one-off review pass.
    // Any surface that told a member "you will be asked again if the dates
    // change" would be describing behaviour this codebase deliberately does not
    // have.
    const surfaces = MEMBER_FACING_SURFACES;
    // AFFIRMATIVE FORMS ONLY, deliberately. A file may — and several do —
    // EXPLAIN that nobody is asked again; that is the decision being documented,
    // not a promise being made. What none of them may contain is a second-person
    // undertaking that the member WILL be asked, which is what these match.
    const overPromises = [
      /you(?:'ll| will| are| 'll)?\s*(?:be\s+)?asked\s+again/i,
      /we(?:'ll| will)\s+ask\s+you\s+again/i,
      /ask(?:ed)?\s+(?:you\s+)?to\s+agree\s+again/i,
      /you(?:'ll| will)\s+be\s+asked\s+if\s+the\s+dates/i,
    ];
    for (const surface of surfaces) {
      const text = readRepoFile(surface);
      for (const pattern of overPromises) {
        const match = text.match(pattern);
        expect(
          match,
          `${surface} promises re-consent: ${match?.[0] ?? ""}`,
        ).toBeNull();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// D-14 — the ordinary self-removal blockers apply to a guest who never agreed
// ---------------------------------------------------------------------------

describe("D-14: nothing offers a self-removal the server would refuse", () => {
  const CHECK_IN = new Date("2026-09-20T00:00:00.000Z");
  const BASE = {
    actorMemberId: "m-sam",
    guestMemberId: "m-sam",
    bookingOwnerMemberId: "m-booker",
    bookingStatus: "CONFIRMED",
    bookingCheckIn: CHECK_IN,
    bookingGuestCount: 3,
    today: new Date("2026-09-01T00:00:00.000Z"),
  };

  const TRAPPING_STATES: Array<{
    blocker: GuestSelfRemovalBlocker;
    facts: Parameters<typeof evaluateGuestSelfRemoval>[0];
  }> = [
    {
      blocker: "LAST_GUEST",
      // An admin-added member guest who is the sole occupant. Taking themselves
      // off would empty the booking, so the club has to cancel it instead.
      facts: { ...BASE, bookingGuestCount: 1 },
    },
    {
      blocker: "QUOTE_PRICED",
      // Every row MG4-D-b creates, by construction.
      facts: { ...BASE, isQuotePriced: true },
    },
    {
      blocker: "STAY_NOT_FUTURE",
      // Added close to the stay, or simply did not notice in time.
      facts: { ...BASE, today: new Date("2026-09-20T00:00:00.000Z") },
    },
  ];

  it.each(TRAPPING_STATES)(
    "names the real blocker and a real remedy instead of offering self-removal ($blocker)",
    ({ blocker, facts }) => {
      const verdict = evaluateGuestSelfRemoval(facts);
      expect(verdict.canSelfRemove).toBe(false);
      expect(verdict.blocker).toBe(blocker);

      const note = composeMemberGuestRemovalNote({
        facts,
        audience: { kind: "TARGET" },
        bookerName: "Dave Ngata",
      });

      // It must NOT be the offer...
      expect(note).not.toBe(MEMBER_GUEST_SELF_REMOVAL_OFFER);
      expect(note).not.toMatch(/you can take yourself off/i);
      // ...it must be the sentence written for this exact blocker...
      expect(note).toBe(MEMBER_GUEST_REMOVAL_NOTE_BY_BLOCKER[blocker]);
      // ...and it must point at somebody who can actually act.
      expect(note).toMatch(/club/i);
    },
  );

  it("names the club as the ONLY remedy on a quote-priced booking, not the booker who cannot help", () => {
    // The one place the shared blocker copy is deliberately NOT reused. The
    // generic QUOTE_PRICED sentence ends "ask the person who made the booking,
    // or the club, to take you off it" — but on a pipeline booking the person
    // who made it is a non-login contact who cannot change anything, so sending
    // the member to them is a dead end. D-15's real remedies are cancel or
    // re-quote, and only the club can do either.
    const shared = describeGuestSelfRemovalBlocker("QUOTE_PRICED");
    const emailNote = MEMBER_GUEST_REMOVAL_NOTE_BY_BLOCKER.QUOTE_PRICED;
    expect(emailNote).not.toBe(shared);
    expect(emailNote).toMatch(/only the club/i);
    expect(emailNote).toMatch(/re-?quote/i);
  });

  it("keeps the self-removal offer when the server would actually allow it", () => {
    // The other half of the honesty property: a note that never offered removal
    // would also never contradict the server, and would also be useless.
    const note = composeMemberGuestRemovalNote({
      facts: BASE,
      audience: { kind: "TARGET" },
      bookerName: "Dave Ngata",
    });
    expect(note).toBe(MEMBER_GUEST_SELF_REMOVAL_OFFER);
  });

  it("never promises self-removal unconditionally in the member-facing copy", () => {
    // THE SECOND HALF OF THE §4.4 SWEEP, and the half the UX review found still
    // open. The member guide told a reader in two places that they could take
    // themselves off — flatly, with no condition — eighty lines above the
    // section that lists the situations where they cannot. A guest on a
    // quote-priced booking (every row MG4-D-b creates) reading only the first
    // sentence learns the opposite of the truth.
    //
    // WHY THESE PATTERNS AND NOT "you can take yourself off". That exact phrase
    // is `MEMBER_GUEST_SELF_REMOVAL_OFFER`, and it is emitted ONLY when
    // `evaluateGuestSelfRemoval` says the server would allow it — the tests
    // above pin that. What may never appear is an UNQUALIFIED version: the
    // modal plus an always/still/at-any-time adverb, the "guaranteed" framing
    // the epic explainer used, or the decline outcome stated as a certainty.
    const unconditionalSelfRemoval = [
      /(?:can|could|may|will be able to)\s+(?:always|still|simply)\s+(?:take|remove)\s+yourself\s+(?:off|from)/i,
      /(?:take|remove)\s+yourself\s+off\s+[^.]*\bat any time\b/i,
      /always\s+(?:be able to\s+)?(?:take|remove)\s+yourself\s+off/i,
      /guaranteed\s+self-?removal/i,
      // The consent card's "No" outcome, stated as a certainty. Saying no is
      // refused on a quote-priced, last-guest, started or settled booking.
      /releases the bed[^.]*and takes you off the booking/i,
    ];
    for (const surface of MEMBER_FACING_SURFACES) {
      const text = readRepoFile(surface);
      for (const pattern of unconditionalSelfRemoval) {
        const match = text.match(pattern);
        expect(
          match,
          `${surface} promises self-removal unconditionally: ${match?.[0] ?? ""}`,
        ).toBeNull();
      }
    }
  });

  it("leaves evaluateGuestSelfRemoval with no consent-aware exception", () => {
    // MG4 builds honesty, not machinery: a carve-out that let a
    // never-consented guest bypass a blocker would be a capacity/money change
    // nobody decided. The predicate must not know consent exists.
    const source = readRepoFile("src/lib/booking-guest-self-removal.ts");
    expect(source).not.toContain("consentStatus");
    expect(source).not.toContain("MemberGuestConsentStatus");
  });
});

// ---------------------------------------------------------------------------
// The withdrawal notice's three cases
// ---------------------------------------------------------------------------

describe("the withdrawal notice says which of the three things happened", () => {
  it("tells a cancelled request apart from a removal, for the target and for a delegate", () => {
    const cancelled = composeMemberGuestWithdrawn({
      context: "REQUEST_CANCELLED",
      bookerName: "Dave Ngata",
      audience: { kind: "TARGET" },
    });
    expect(cancelled.heading).toMatch(/withdrawn/i);
    expect(cancelled.contextNote).toMatch(/released/i);
    // Nothing left to answer: the member must not go looking for the request.
    expect(cancelled.contextNote).toMatch(/nothing left for you to answer/i);

    const takenOff = composeMemberGuestWithdrawn({
      context: "TAKEN_OFF",
      bookerName: "Dave Ngata",
      audience: { kind: "TARGET" },
    });
    expect(takenOff.heading).toMatch(/no longer on/i);
    expect(takenOff.contextNote).toContain("Dave Ngata");

    const delegate = composeMemberGuestWithdrawn({
      context: "TAKEN_OFF",
      bookerName: "Dave Ngata",
      audience: {
        kind: "DELEGATE",
        guest: { firstName: "Tama", lastName: "Kaur" },
      },
    });
    // A delegate must never read "you are no longer on" about a booking they
    // were never on — D-9 makes this reader the normal case.
    expect(delegate.heading).toContain("Tama Kaur");
    expect(delegate.heading).not.toMatch(/^You /);
    expect(delegate.contextNote).toMatch(/does not have a login of their own/i);
  });

  it("never names anybody on a withdrawn request, because the code cannot tell who withdrew it", () => {
    // THE BUG THIS PINS. `REQUEST_CANCELLED` is chosen from the ROW — the
    // consent status is still PENDING — by the guest-removal route and by the
    // batch modification alike, and neither consults the actor. So the booker
    // and a club officer both land here, and the earlier copy said
    // "{booker} has called off the request" for both: wrong about half the
    // time, and where an officer had acted it also put a staff name in front of
    // somebody who is not on the booking. Signed-off mockup question 3 answers
    // this "no name", and this is the assertion that keeps it that way.
    for (const audience of [
      { kind: "TARGET" as const },
      {
        kind: "DELEGATE" as const,
        guest: { firstName: "Tama", lastName: "Kaur" },
      },
    ]) {
      const cancelled = composeMemberGuestWithdrawn({
        context: "REQUEST_CANCELLED",
        bookerName: "Dave Ngata",
        audience,
      });
      expect(cancelled.heading).not.toContain("Dave");
      expect(cancelled.contextNote).not.toContain("Dave");
      expect(cancelled.contextNote).not.toContain("Ngata");
      // Passive voice on purpose: no actor is named, and none is implied.
      expect(cancelled.contextNote).toMatch(/has been withdrawn/i);
    }

    // The other half of the property: TAKEN_OFF is a settled place on a
    // specific person's booking, and it KEEPS its possessive phrasing.
    const takenOff = composeMemberGuestWithdrawn({
      context: "TAKEN_OFF",
      bookerName: "Dave Ngata",
      audience: { kind: "TARGET" },
    });
    expect(takenOff.contextNote).toContain("Dave Ngata");
  });

  it("never names the booker on the pipeline case, because the reader never dealt with them", () => {
    // A booking-request booking is owned by a non-login contact the member has
    // no relationship with. Saying "X has taken you off their booking" would
    // name a stranger as though the reader knew who that was.
    const replaced = composeMemberGuestWithdrawn({
      context: "BOOKING_REQUEST_REPLACED",
      bookerName: "Silverpeak School",
      audience: { kind: "TARGET" },
    });
    expect(replaced.contextNote).not.toContain("Silverpeak School");
    expect(replaced.contextNote).toMatch(/the club/i);
    expect(replaced.contextNote).toMatch(/booking request/i);
  });
});
