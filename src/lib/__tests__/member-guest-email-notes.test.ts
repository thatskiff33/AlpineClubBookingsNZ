import { describe, expect, it } from "vitest";
import {
  evaluateGuestSelfRemoval,
  type GuestSelfRemovalBlocker,
} from "@/lib/booking-guest-self-removal";
import { parseDateOnly } from "@/lib/date-only";
import { getEmailTemplateDefinition } from "@/lib/email-message-registry";
import {
  buildMemberGuestPartyList,
  composeGuestNightsLabel,
  composeMemberGuestAdded,
  composeMemberGuestConsentAsk,
  composeMemberGuestConsentOutcome,
  composeMemberGuestRemovalNote,
  composeMemberGuestWithdrawn,
  MEMBER_GUEST_REMOVAL_NOTE_BY_BLOCKER,
  MEMBER_GUEST_SELF_REMOVAL_OFFER,
  type MemberGuestRemovalFacts,
} from "@/lib/member-guest-email-notes";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

/**
 * #2307 (epic #2305, MG2) — the shared composers behind the four member-guest
 * emails.
 *
 * Two properties matter more than the wording and are what most of this file is
 * about:
 *
 *  1. THE FLAT TOKEN AND THE HTML CANNOT DRIFT. Every composed value is rendered
 *     twice — once into the admin-editable default body, once into the
 *     hand-built HTML — and both renderings come from one helper. The party
 *     listing is the one that could actually diverge (a heading, a list, an
 *     order), so it is asserted name by name in both forms.
 *  2. THE REMOVAL SENTENCE CANNOT CONTRADICT THE SERVER. Owner decision D-14
 *     applies the ordinary self-removal blockers to a member who never
 *     consented, so the email must offer "take yourself off" exactly when
 *     `evaluateGuestSelfRemoval` would allow it and never otherwise. The whole
 *     blocker matrix is walked below.
 */

// The fixture every registry preview sample is composed from. Kept here as the
// single definition so the sample-agreement assertions at the bottom of this
// file are checking one thing against one thing.
const FIXTURE = {
  bookerName: "Dave Ngata",
  guest: { firstName: "Priya", lastName: "Kaur" },
  party: [
    { firstName: "Dave", lastName: "Ngata" },
    { firstName: "Marama", lastName: "Ngata" },
    { firstName: "Ari", lastName: "Ngata" },
    { firstName: "Priya", lastName: "Kaur" },
  ],
  nights: [parseDateOnly("2026-08-08"), parseDateOnly("2026-08-09")],
  lodgeName: "Example Mountain Club Lodge",
  checkIn: parseDateOnly("2026-08-08"),
  checkOut: parseDateOnly("2026-08-10"),
  expiredAt: parseDateOnly("2026-08-07"),
  creditCents: 4800,
} as const;

/** Anything that looks like a money figure: a currency sign or cents. */
const MONEY_PATTERN = /[$€£]|\d+[.,]\d{2}/;

describe("buildMemberGuestPartyList (#2307, MG2-D-a)", () => {
  it("lists every guest's first AND last name together, in the order given", () => {
    const list = buildMemberGuestPartyList(FIXTURE.party);

    expect(list.names).toEqual([
      "Dave Ngata",
      "Marama Ngata",
      "Ari Ngata",
      "Priya Kaur",
    ]);
    // Not "all the first names, then all the last names" — the bug the existing
    // check-in reminder shipped with.
    expect(list.text).toContain("- Priya Kaur");
    expect(list.text).not.toContain("Dave, Marama");
  });

  it("carries its own heading inside the token", () => {
    // The heading has to be INSIDE the composed block: if the default body owned
    // it, an empty list would print a bare heading with nothing under it.
    const list = buildMemberGuestPartyList(FIXTURE.party);
    expect(list.text.split("\n")[0]).toBe("Everyone on this booking:");
    expect(list.html).toContain("Everyone on this booking");
  });

  it("renders to the empty string when there is nobody to list", () => {
    for (const empty of [[], [{ firstName: " ", lastName: " " }]]) {
      const list = buildMemberGuestPartyList(empty);
      expect(list.text).toBe("");
      expect(list.html).toBe("");
      expect(list.names).toEqual([]);
    }
  });

  it("lists the same names in the same order in the flat text and the HTML", () => {
    const list = buildMemberGuestPartyList(FIXTURE.party);

    const fromText = list.text
      .split("\n")
      .slice(1)
      .map((line) => line.replace(/^- /, ""));
    const fromHtml = Array.from(
      list.html.matchAll(/<li>([^<]*)<\/li>/g),
      (match) => match[1],
    );

    expect(fromText).toEqual(list.names);
    expect(fromHtml).toEqual(list.names);
  });

  it("contains no money anywhere, even when the caller holds priced guest rows", () => {
    // Owner decision MG2-D-a: names only. The parameter type carries just the
    // two name fields, and a priced row splatted in whole must still not leak a
    // figure into either rendering.
    const priced = FIXTURE.party.map((member, index) => ({
      ...member,
      priceCents: 4800 + index,
      ageTier: "ADULT" as const,
    }));
    const list = buildMemberGuestPartyList(priced);

    expect(list.text).not.toMatch(MONEY_PATTERN);
    expect(list.html).not.toMatch(MONEY_PATTERN);
  });

  it("escapes member-supplied names in the HTML rendering", () => {
    const list = buildMemberGuestPartyList([
      { firstName: '<script>alert("x")</script>', lastName: "O'Brien" },
    ]);

    expect(list.html).not.toContain("<script>");
    expect(list.html).toContain("&lt;script&gt;");
    expect(list.html).toContain("&#39;");
    // The flat text is plain text and is escaped by the renderer at send time,
    // so it keeps the literal name.
    expect(list.text).toContain("O'Brien");
  });
});

describe("composeGuestNightsLabel (#2307)", () => {
  it("returns the empty string when the guest has no nights", () => {
    expect(composeGuestNightsLabel([])).toBe("");
  });

  it("names a single night in the singular", () => {
    expect(composeGuestNightsLabel([parseDateOnly("2026-08-08")])).toBe(
      "8 Aug 2026 (1 night)",
    );
  });

  it("lists a short stay night by night", () => {
    expect(composeGuestNightsLabel(FIXTURE.nights)).toBe(
      "8 Aug 2026, 9 Aug 2026 (2 nights)",
    );
  });

  it("collapses a long contiguous run to its ends", () => {
    const nights = [
      "2026-08-08",
      "2026-08-09",
      "2026-08-10",
      "2026-08-11",
      "2026-08-12",
    ].map(parseDateOnly);

    expect(composeGuestNightsLabel(nights)).toBe(
      "8 Aug 2026 to 12 Aug 2026 (5 nights)",
    );
  });

  it("lists a long NON-contiguous set rather than implying a range", () => {
    const nights = [
      "2026-08-08",
      "2026-08-09",
      "2026-08-14",
      "2026-08-15",
    ].map(parseDateOnly);

    expect(composeGuestNightsLabel(nights)).toBe(
      "8 Aug 2026, 9 Aug 2026, 14 Aug 2026, 15 Aug 2026 (4 nights)",
    );
  });

  it("sorts and de-duplicates whatever order the caller holds them in", () => {
    const nights = ["2026-08-09", "2026-08-08", "2026-08-09"].map(parseDateOnly);
    expect(composeGuestNightsLabel(nights)).toBe(
      "8 Aug 2026, 9 Aug 2026 (2 nights)",
    );
  });

  it("reads the NZ calendar date of a date-only value", () => {
    // A @db.Date column is UTC midnight. A bare toLocaleDateString on a
    // non-NZ machine reports the previous day (the #2256 class of bug).
    expect(composeGuestNightsLabel([new Date("2026-08-08T00:00:00Z")])).toContain(
      "8 Aug 2026",
    );
  });
});

describe("composeMemberGuestConsentAsk (#2307, D-9)", () => {
  it("addresses the member being added directly", () => {
    const ask = composeMemberGuestConsentAsk({
      bookerName: FIXTURE.bookerName,
      audience: { kind: "TARGET" },
    });

    expect(ask.heading).toBe("Can Dave Ngata add you to this booking?");
    expect(ask.contextNote).toContain("has put you down as a guest");
    expect(ask.contextNote).toContain("a bed is held for you");
  });

  it("names the guest — not the reader — when a delegate is being asked", () => {
    const ask = composeMemberGuestConsentAsk({
      bookerName: FIXTURE.bookerName,
      audience: { kind: "DELEGATE", guest: { firstName: "Tama", lastName: "Kaur" } },
    });

    // The whole point: a parent must not be told THEY are being added to a lodge
    // booking when it is their child who is (owner decision D-9 makes a target
    // with no login the normal case, not an edge case).
    expect(ask.heading).toBe("Can Dave Ngata add Tama Kaur to this booking?");
    expect(ask.contextNote).toContain("has put Tama Kaur down as a guest");
    expect(ask.contextNote).toContain("does not have a login of their own");
    expect(ask.contextNote).toContain("your answer counts as Tama's");
    expect(ask.contextNote).not.toContain("put you down");
  });

  it("never mentions money in either audience", () => {
    for (const audience of [
      { kind: "TARGET" } as const,
      {
        kind: "DELEGATE" as const,
        guest: { firstName: "Tama", lastName: "Kaur" },
      },
    ]) {
      const ask = composeMemberGuestConsentAsk({
        bookerName: FIXTURE.bookerName,
        audience,
      });
      expect(`${ask.heading} ${ask.contextNote}`).not.toMatch(MONEY_PATTERN);
    }
  });
});

describe("composeMemberGuestAdded (#2307)", () => {
  const TARGET = { kind: "TARGET" } as const;
  const DELEGATE = {
    kind: "DELEGATE" as const,
    guest: { firstName: "Tama", lastName: "Kaur" },
  };

  it("tells the three no-consent paths apart", () => {
    const notes = (["NOTIFY_ONLY", "ADMIN", "BOOKING_REQUEST"] as const).map(
      (context) =>
        composeMemberGuestAdded({
          context,
          bookerName: FIXTURE.bookerName,
          audience: TARGET,
        }).contextNote,
    );
    const [notifyOnly, admin, pipeline] = notes;

    expect(notifyOnly).toContain("this club does not ask first");
    expect(admin).toContain("the club has added you");
    expect(admin).toContain("on behalf of Dave Ngata");
    expect(pipeline).toContain("booking request");
    // Three genuinely different sentences: one template can only stand in for
    // three if the sentence that distinguishes them actually distinguishes them.
    expect(new Set(notes).size).toBe(3);
    // Each one follows "Hi <name>, " in the body, so none may be empty.
    for (const note of notes) {
      expect(note.length).toBeGreaterThan(0);
      expect(note).toContain(FIXTURE.bookerName);
    }
  });

  it("addresses the member who was added directly", () => {
    const copy = composeMemberGuestAdded({
      context: "NOTIFY_ONLY",
      bookerName: FIXTURE.bookerName,
      audience: TARGET,
    });
    expect(copy.heading).toBe("You have been added to a lodge booking");
    expect(copy.contextNote).toContain("has added you as a guest");
  });

  it("names the guest — not the reader — when a delegate is being told (D-9)", () => {
    // The defect this parameter exists for: without it a parent reads "you have
    // been added to a lodge booking" about their own child's place.
    for (const context of ["NOTIFY_ONLY", "ADMIN", "BOOKING_REQUEST"] as const) {
      const copy = composeMemberGuestAdded({
        context,
        bookerName: FIXTURE.bookerName,
        audience: DELEGATE,
      });

      expect(copy.heading).toBe("Tama Kaur has been added to a lodge booking");
      expect(copy.contextNote).toContain("Tama Kaur");
      expect(copy.contextNote).not.toContain("added you as a guest");
      expect(copy.contextNote).toContain(
        "You are being told because Tama does not have a login of their own",
      );
    }
  });
});

describe("composeMemberGuestRemovalNote agrees with the shared predicate (#2307, D-14)", () => {
  const TODAY = parseDateOnly("2026-08-01");
  const BASE: MemberGuestRemovalFacts = {
    actorMemberId: "mem_guest",
    guestMemberId: "mem_guest",
    bookingOwnerMemberId: "mem_owner",
    bookingStatus: "PAID",
    bookingCheckIn: parseDateOnly("2026-08-08"),
    bookingGuestCount: 4,
    isQuotePriced: false,
    today: TODAY,
  };

  // One fixture per blocker, so the matrix below is exhaustive by construction:
  // a new blocker added to booking-guest-self-removal.ts fails to compile here
  // AND in MEMBER_GUEST_REMOVAL_NOTE_BY_BLOCKER.
  const FACTS_BY_BLOCKER: Record<
    GuestSelfRemovalBlocker,
    MemberGuestRemovalFacts
  > = {
    OWN_BOOKING: { ...BASE, bookingOwnerMemberId: "mem_guest" },
    NOT_THEIR_OWN_GUEST: { ...BASE, guestMemberId: "mem_someone_else" },
    BOOKING_STATUS: { ...BASE, bookingStatus: "CANCELLED" },
    STAY_NOT_FUTURE: { ...BASE, bookingCheckIn: parseDateOnly("2026-08-01") },
    LAST_GUEST: { ...BASE, bookingGuestCount: 1 },
    QUOTE_PRICED: { ...BASE, isQuotePriced: true },
  };

  it("offers self-removal exactly when the predicate would allow it", () => {
    expect(evaluateGuestSelfRemoval(BASE)).toEqual({
      canSelfRemove: true,
      blocker: null,
    });
    expect(
      composeMemberGuestRemovalNote({
        facts: BASE,
        audience: { kind: "TARGET" },
        bookerName: "Dave Ngata",
      }),
    ).toBe(MEMBER_GUEST_SELF_REMOVAL_OFFER);
  });

  it.each(Object.keys(FACTS_BY_BLOCKER) as GuestSelfRemovalBlocker[])(
    "never offers self-removal when the predicate refuses with %s",
    (blocker) => {
      const facts = FACTS_BY_BLOCKER[blocker];

      // The fixture really does produce the blocker it claims to — otherwise the
      // assertion below would be testing the wrong branch and still pass.
      expect(evaluateGuestSelfRemoval(facts).blocker).toBe(blocker);

      const note = composeMemberGuestRemovalNote({
        facts,
        audience: { kind: "TARGET" },
        bookerName: "Dave Ngata",
      });
      expect(note).toBe(MEMBER_GUEST_REMOVAL_NOTE_BY_BLOCKER[blocker]);
      expect(note).not.toBe(MEMBER_GUEST_SELF_REMOVAL_OFFER);
      expect(note).not.toContain("take yourself off the booking from your account");
      expect(note.length).toBeGreaterThan(0);
    },
  );

  it("names the real remedy for a quote-priced booking instead of a dead end", () => {
    // The shared describeGuestSelfRemovalBlocker wording ends "ask the person
    // who made the booking, or the club, to take you off it" — but the person
    // who made the booking CANNOT, so that is a dead end in an email.
    const note = composeMemberGuestRemovalNote({
      facts: FACTS_BY_BLOCKER.QUOTE_PRICED,
      audience: { kind: "TARGET" },
      bookerName: "Dave Ngata",
    });
    expect(note).toContain("Only the club can take you off");
    expect(note).toContain("re-quote the request");
  });

  it("never points an email reader at on-page controls", () => {
    // describeGuestSelfRemovalBlocker's OWN_BOOKING wording says "from the
    // booking details above", which is meaningless in an inbox.
    for (const blocker of Object.keys(
      MEMBER_GUEST_REMOVAL_NOTE_BY_BLOCKER,
    ) as GuestSelfRemovalBlocker[]) {
      expect(MEMBER_GUEST_REMOVAL_NOTE_BY_BLOCKER[blocker]).not.toContain(
        "above",
      );
    }
  });
});

describe("composeMemberGuestConsentOutcome (#2307, D-15)", () => {
  const COMMON = {
    guest: FIXTURE.guest,
    lodgeName: FIXTURE.lodgeName,
    checkIn: FIXTURE.checkIn,
    checkOut: FIXTURE.checkOut,
  };

  it("reports an acceptance as changing nothing", () => {
    const copy = composeMemberGuestConsentOutcome({
      ...COMMON,
      outcome: { kind: "APPROVED" },
    }, CLUB_FORMAT_TEST);

    expect(copy.heading).toBe("Priya Kaur has accepted");
    expect(copy.sentence).toContain("is confirmed on your booking at");
    expect(copy.sentence).toContain("Example Mountain Club Lodge, 8 Aug 2026 - 10 Aug 2026");
    expect(copy.consequenceNote).toContain("Nothing has changed on your booking");
    // No repricing happened, so no money is mentioned.
    expect(copy.consequenceNote).not.toMatch(MONEY_PATTERN);
  });

  it("reports a decline with the account credit D-15 settles it as", () => {
    const copy = composeMemberGuestConsentOutcome({
      ...COMMON,
      outcome: { kind: "DECLINED", creditCents: FIXTURE.creditCents },
    }, CLUB_FORMAT_TEST);

    expect(copy.heading).toBe("Priya Kaur has declined");
    expect(copy.sentence).toContain("has been taken off your booking");
    expect(copy.consequenceNote).toContain("$48.00 has been added to your account credit");
  });

  it("does not promise a credit when nothing had been paid", () => {
    const copy = composeMemberGuestConsentOutcome({
      ...COMMON,
      outcome: { kind: "DECLINED", creditCents: 0 },
    }, CLUB_FORMAT_TEST);

    // "$0.00 has been added to your account credit" would be a false promise.
    expect(copy.consequenceNote).not.toMatch(MONEY_PATTERN);
    expect(copy.consequenceNote).toContain("no credit to return");
    expect(copy.consequenceNote).toContain("repriced");
  });

  it("reports a lapse that released the place, dated", () => {
    const copy = composeMemberGuestConsentOutcome({
      ...COMMON,
      outcome: {
        kind: "EXPIRED_REMOVED",
        expiredAt: FIXTURE.expiredAt,
        creditCents: FIXTURE.creditCents,
      },
    }, CLUB_FORMAT_TEST);

    expect(copy.heading).toBe("Priya Kaur did not answer in time");
    expect(copy.sentence).toContain("lapsed on 7 Aug 2026 with no answer");
    expect(copy.sentence).toContain("has been taken off your booking");
    expect(copy.consequenceNote).toContain("account credit");
  });

  it("says plainly when the guest is STILL on the booking, and why", () => {
    const copy = composeMemberGuestConsentOutcome({
      ...COMMON,
      outcome: {
        kind: "EXPIRED_STILL_ON_BOOKING",
        expiredAt: FIXTURE.expiredAt,
        blocker: "QUOTE_PRICED",
      },
    }, CLUB_FORMAT_TEST);

    // The honest variant, and the one that could have been quietly omitted: the
    // owner must not be left believing the guest came off their booking.
    expect(copy.sentence).not.toContain("taken off");
    expect(copy.consequenceNote).toContain("Priya is still on the booking");
    expect(copy.consequenceNote).toContain("priced by hand");
    expect(copy.consequenceNote).toContain("re-quote the request");
    expect(copy.consequenceNote).toContain("The club has been told");
    // Nothing was repriced, so no money is claimed either way.
    expect(copy.consequenceNote).not.toMatch(MONEY_PATTERN);
  });

  it("explains every stuck reason the sweep can hit", () => {
    // Exactly the four reasons the admin exception list documents, plus the two
    // predicate blockers that cannot be reached from here — each must produce a
    // real sentence rather than a bare "because .".
    const blockers: GuestSelfRemovalBlocker[] = [
      "QUOTE_PRICED",
      "LAST_GUEST",
      "BOOKING_STATUS",
      "STAY_NOT_FUTURE",
      "OWN_BOOKING",
      "NOT_THEIR_OWN_GUEST",
    ];

    for (const blocker of blockers) {
      const copy = composeMemberGuestConsentOutcome({
        ...COMMON,
        outcome: {
          kind: "EXPIRED_STILL_ON_BOOKING",
          expiredAt: FIXTURE.expiredAt,
          blocker,
        },
      }, CLUB_FORMAT_TEST);
      expect(copy.consequenceNote).toMatch(/^Priya is still on the booking, because .+\. The club has been told and will be in touch\.$/);
    }
  });
});

describe("registry preview samples mirror what the senders compose (#2307)", () => {
  /**
   * `sampleValue()` in the registry hard-codes each composed token's preview
   * text rather than importing these composers, so that the registry keeps no
   * dependency on the email layer. This is what stops that copy going stale: the
   * sample an admin previews must be byte-identical to what the composer emits
   * for the documented fixture.
   */
  function sampleFor(templateKey: string, token: string): string {
    const definition = getEmailTemplateDefinition(templateKey);
    if (!definition) throw new Error(`missing definition for ${templateKey}`);
    return definition.sampleData[token];
  }

  it("matches the consent request's composed samples", () => {
    const ask = composeMemberGuestConsentAsk({
      bookerName: FIXTURE.bookerName,
      audience: { kind: "TARGET" },
    });

    expect(sampleFor("member-guest-consent-request", "askHeading")).toBe(
      ask.heading,
    );
    expect(sampleFor("member-guest-consent-request", "askContextNote")).toBe(
      ask.contextNote,
    );
    expect(sampleFor("member-guest-consent-request", "partyListNote")).toBe(
      buildMemberGuestPartyList(FIXTURE.party).text,
    );
    expect(sampleFor("member-guest-consent-request", "guestNightsLabel")).toBe(
      composeGuestNightsLabel(FIXTURE.nights),
    );
    expect(sampleFor("member-guest-consent-request", "bookerName")).toBe(
      FIXTURE.bookerName,
    );
  });

  it("matches the added notice's composed samples", () => {
    const added = composeMemberGuestAdded({
      context: "NOTIFY_ONLY",
      bookerName: FIXTURE.bookerName,
      audience: { kind: "TARGET" },
    });
    expect(sampleFor("member-guest-added", "addedHeading")).toBe(added.heading);
    expect(sampleFor("member-guest-added", "addedContextNote")).toBe(
      added.contextNote,
    );
    expect(sampleFor("member-guest-added", "removalNote")).toBe(
      MEMBER_GUEST_SELF_REMOVAL_OFFER,
    );
  });

  it("matches the withdrawal notice's composed samples (MG4 #2309)", () => {
    // The two tokens MG4 adds, swept for the same reason as the four above: the
    // registry hard-codes the preview text so it keeps no dependency on the
    // email layer, and this is what stops that copy going stale. The sample is
    // the TAKEN_OFF case, which is the one that legitimately names the booker —
    // so if the name-free rewording of REQUEST_CANCELLED ever leaked into the
    // wrong branch, the two would stop matching here.
    const copy = composeMemberGuestWithdrawn({
      context: "TAKEN_OFF",
      bookerName: FIXTURE.bookerName,
      audience: { kind: "TARGET" },
    });

    expect(sampleFor("member-guest-request-withdrawn", "withdrawnHeading")).toBe(
      copy.heading,
    );
    expect(
      sampleFor("member-guest-request-withdrawn", "withdrawnContextNote"),
    ).toBe(copy.contextNote);
  });

  it("matches the outcome notice's composed samples", () => {
    const copy = composeMemberGuestConsentOutcome({
      guest: FIXTURE.guest,
      lodgeName: FIXTURE.lodgeName,
      checkIn: FIXTURE.checkIn,
      checkOut: FIXTURE.checkOut,
      outcome: { kind: "APPROVED" },
    }, CLUB_FORMAT_TEST);

    expect(sampleFor("member-guest-consent-outcome", "outcomeHeading")).toBe(
      copy.heading,
    );
    expect(sampleFor("member-guest-consent-outcome", "outcomeSentence")).toBe(
      copy.sentence,
    );
    expect(sampleFor("member-guest-consent-outcome", "consequenceNote")).toBe(
      copy.consequenceNote,
    );
  });

  it("previews the consent link as a real consent link, not the generic admin URL", () => {
    const sample = sampleFor("member-guest-consent-request", "consentUrl");
    expect(sample).toContain("/bookings/");
    expect(sample).not.toContain("/admin");
  });
});
