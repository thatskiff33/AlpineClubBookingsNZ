// "+ Add Member Guest" (epic #2305) MG2 (#2307) — the delegate consent page's
// decision function. Lens (b)'s concerns live here: the guestId in the URL
// must not work as an existence oracle, a delegate must never be handed the
// booking page or its money, and only the delegate rule's accepted callers
// ever see anything specific.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseDateOnly } from "@/lib/date-only";
import type { MemberGuestConsentDelegateResolver } from "@/lib/member-guest-delegate";
import { resolveDelegateConsentPageState } from "@/lib/member-guest-delegate-page";

const GUEST_ID = "bg-1";
const TARGET = "m-target";
const DELEGATE = "m-delegate";
const STRANGER = "m-stranger";

const CHECK_IN = parseDateOnly("2026-08-08");
const CHECK_OUT = parseDateOnly("2026-08-10");
const EXPIRES = parseDateOnly("2026-08-07");

function guestRow(overrides: Record<string, unknown> = {}) {
  const { booking: bookingOverrides, ...rest } = overrides;
  return {
    id: GUEST_ID,
    memberId: TARGET,
    firstName: "Tama",
    lastName: "Kaur",
    consentStatus: "PENDING",
    consentRespondedAt: null,
    consentExpiresAt: EXPIRES,
    stayStart: CHECK_IN,
    stayEnd: CHECK_OUT,
    nights: [{ stayDate: CHECK_IN }, { stayDate: parseDateOnly("2026-08-09") }],
    ...rest,
    booking: {
      id: "bk-1",
      lodgeId: "lodge-1",
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      status: "PAID",
      deletedAt: null,
      member: { firstName: "Dave", lastName: "Ngata" },
      guests: [
        { id: "bg-owner", firstName: "Dave", lastName: "Ngata" },
        { id: GUEST_ID, firstName: "Tama", lastName: "Kaur" },
      ],
      ...(bookingOverrides as object | undefined),
    },
  };
}

function makeDb(row: unknown, options?: { dateOfBirth?: Date | null; quotePriced?: boolean }) {
  return {
    bookingGuest: { findUnique: vi.fn(async () => row) },
    member: {
      findUnique: vi.fn(async () => ({
        dateOfBirth: options?.dateOfBirth ?? null,
      })),
    },
    bookingRequest: {
      findFirst: vi.fn(async () => (options?.quotePriced ? { id: "br-1" } : null)),
    },
  } as never;
}

function resolver(accepts: boolean): MemberGuestConsentDelegateResolver {
  return {
    canRespondForTarget: vi.fn(async () => accepts),
    resolveNotificationRecipients: vi.fn(async () => []),
  };
}

const moduleOn = vi.fn(async () => true);

// `stateFor` below pins `now` to 1 August 2026 against a check-in of 8 August
// 2026, and STAY_NOT_FUTURE outranks the blocker each refusal test is actually
// about. The wall clock is therefore pushed well PAST every fixture date: if
// the resolver ever stops threading its own `now` down into the refusal
// prediction, these tests fail immediately instead of on 8 August 2026.
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2027-03-01T00:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("who gets past the neutral state", () => {
  it("collapses no-row, non-member row, family row and stranger to ONE indistinguishable state", async () => {
    const cases = [
      makeDb(null),
      makeDb(guestRow({ memberId: null })),
      makeDb(guestRow({ consentStatus: null })),
    ];
    for (const db of cases) {
      const state = await resolveDelegateConsentPageState({
        guestId: GUEST_ID,
        viewerMemberId: DELEGATE,
        db,
        delegateResolver: resolver(true),
        moduleEnabled: moduleOn,
      });
      expect(state).toEqual({ kind: "NOT_FOUND" });
    }

    // A stranger against a REAL pending row gets byte-for-byte the same state.
    const stranger = await resolveDelegateConsentPageState({
      guestId: GUEST_ID,
      viewerMemberId: STRANGER,
      db: makeDb(guestRow()),
      delegateResolver: resolver(false),
      moduleEnabled: moduleOn,
    });
    expect(stranger).toEqual({ kind: "NOT_FOUND" });
  });

  it("tells an unauthorized caller nothing — not even whether the module is on", async () => {
    const moduleProbe = vi.fn(async () => false);
    const state = await resolveDelegateConsentPageState({
      guestId: GUEST_ID,
      viewerMemberId: STRANGER,
      db: makeDb(guestRow()),
      delegateResolver: resolver(false),
      moduleEnabled: moduleProbe,
    });
    expect(state).toEqual({ kind: "NOT_FOUND" });
    // The module read runs only AFTER the delegate rule accepts the caller.
    expect(moduleProbe).not.toHaveBeenCalled();
  });

  it("redirects the target to their own surface — the booking page — without consulting the delegate rule", async () => {
    const rule = resolver(false);
    const state = await resolveDelegateConsentPageState({
      guestId: GUEST_ID,
      viewerMemberId: TARGET,
      db: makeDb(guestRow()),
      delegateResolver: rule,
      moduleEnabled: moduleOn,
    });
    expect(state).toEqual({ kind: "TARGET_SELF", bookingId: "bk-1" });
    expect(rule.canRespondForTarget).not.toHaveBeenCalled();
  });

  it("asks the delegate rule about the right pair", async () => {
    const rule = resolver(true);
    await resolveDelegateConsentPageState({
      guestId: GUEST_ID,
      viewerMemberId: DELEGATE,
      db: makeDb(guestRow()),
      delegateResolver: rule,
      moduleEnabled: moduleOn,
    });
    expect(rule.canRespondForTarget).toHaveBeenCalledWith(
      expect.objectContaining({ actorMemberId: DELEGATE, targetMemberId: TARGET }),
    );
  });
});

describe("a removed booking (#5266, INV-ADDPAY-034)", () => {
  const REMOVED_AT = new Date("2026-07-20T00:00:00.000Z");

  it("tells the target it was removed, instead of sending them to the booking page", async () => {
    const rule = resolver(false);
    const state = await resolveDelegateConsentPageState({
      guestId: GUEST_ID,
      viewerMemberId: TARGET,
      db: makeDb(guestRow({ booking: { deletedAt: REMOVED_AT } })),
      delegateResolver: rule,
      moduleEnabled: moduleOn,
    });
    expect(state).toEqual({ kind: "BOOKING_REMOVED" });
    expect(rule.canRespondForTarget).not.toHaveBeenCalled();
  });

  it("tells an accepted family adult it was removed, even with the module switched off", async () => {
    const state = await resolveDelegateConsentPageState({
      guestId: GUEST_ID,
      viewerMemberId: DELEGATE,
      db: makeDb(guestRow({ booking: { deletedAt: REMOVED_AT } })),
      delegateResolver: resolver(true),
      moduleEnabled: async () => false,
    });
    expect(state).toEqual({ kind: "BOOKING_REMOVED" });
  });

  it("gives a stranger the same NOT_FOUND, by the same reads, as on a live booking", async () => {
    async function strangerOn(row: unknown) {
      const db = makeDb(row) as unknown as {
        bookingGuest: { findUnique: ReturnType<typeof vi.fn> };
        member: { findUnique: ReturnType<typeof vi.fn> };
        bookingRequest: { findFirst: ReturnType<typeof vi.fn> };
      };
      const rule = resolver(false);
      const moduleProbe = vi.fn(async () => true);
      const state = await resolveDelegateConsentPageState({
        guestId: GUEST_ID,
        viewerMemberId: STRANGER,
        db: db as never,
        delegateResolver: rule,
        moduleEnabled: moduleProbe,
      });
      return {
        state,
        guestReads: db.bookingGuest.findUnique.mock.calls,
        memberReads: db.member.findUnique.mock.calls.length,
        requestReads: db.bookingRequest.findFirst.mock.calls.length,
        delegateAsks: (rule.canRespondForTarget as ReturnType<typeof vi.fn>).mock.calls.map(
          ([args]) => ({ actorMemberId: args.actorMemberId, targetMemberId: args.targetMemberId }),
        ),
        moduleReads: moduleProbe.mock.calls.length,
      };
    }

    const removed = await strangerOn(guestRow({ booking: { deletedAt: REMOVED_AT } }));
    const live = await strangerOn(guestRow());
    expect(removed.state).toEqual({ kind: "NOT_FOUND" });
    expect(removed).toEqual(live);
  });
});

describe("the states an accepted delegate sees", () => {
  async function stateFor(
    row: unknown,
    options?: Parameters<typeof makeDb>[1] & { moduleEnabled?: () => Promise<boolean> },
  ) {
    return resolveDelegateConsentPageState({
      guestId: GUEST_ID,
      viewerMemberId: DELEGATE,
      db: makeDb(row, options),
      delegateResolver: resolver(true),
      moduleEnabled: options?.moduleEnabled ?? moduleOn,
      now: new Date("2026-08-01T00:00:00.000Z"),
    });
  }

  it("says so when the module has been switched off", async () => {
    const state = await stateFor(guestRow(), {
      moduleEnabled: async () => false,
    });
    expect(state).toEqual({ kind: "MODULE_OFF", guestFirstName: "Tama" });
  });

  it("reports an already-answered request honestly, either way", async () => {
    const respondedAt = parseDateOnly("2026-08-02");
    expect(
      await stateFor(
        guestRow({ consentStatus: "CONFIRMED", consentRespondedAt: respondedAt }),
      ),
    ).toEqual({
      kind: "ALREADY_ANSWERED",
      status: "CONFIRMED",
      guestFirstName: "Tama",
      respondedAt,
    });
    expect(
      await stateFor(
        guestRow({ consentStatus: "DECLINED", consentRespondedAt: respondedAt }),
      ),
    ).toMatchObject({ kind: "ALREADY_ANSWERED", status: "DECLINED" });
  });

  it("reports a lapsed request as lapsed", async () => {
    expect(await stateFor(guestRow({ consentStatus: "EXPIRED" }))).toEqual({
      kind: "LAPSED",
      guestFirstName: "Tama",
    });
  });

  it("returns the ask facts — names, dates and the question, never money", async () => {
    const state = await stateFor(guestRow(), {
      dateOfBirth: parseDateOnly("2017-05-01"),
    });
    expect(state.kind).toBe("ASK");
    if (state.kind !== "ASK") return;
    expect(state.facts).toEqual({
      bookingId: "bk-1",
      guestId: GUEST_ID,
      guest: { firstName: "Tama", lastName: "Kaur", ageYears: 9 },
      bookerName: "Dave Ngata",
      bookerFirstName: "Dave",
      lodgeId: "lodge-1",
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      guestNights: [CHECK_IN, parseDateOnly("2026-08-09")],
      consentExpiresAt: EXPIRES,
      party: ["Dave Ngata", "Tama Kaur"],
      refusalBlocker: null,
    });
    // Belt and braces on the no-money promise: nothing in the facts payload
    // smells like a price.
    expect(JSON.stringify(state.facts)).not.toMatch(/price|cents|total/i);
  });

  it("omits the age when the target's date of birth is unknown", async () => {
    const state = await stateFor(guestRow(), { dateOfBirth: null });
    expect(state.kind === "ASK" && state.facts.guest.ageYears).toBeNull();
  });

  it("predicts the quote-priced decline refusal for the warning copy", async () => {
    const state = await stateFor(guestRow(), { quotePriced: true });
    expect(state.kind === "ASK" && state.facts.refusalBlocker).toBe("QUOTE_PRICED");
  });

  it("predicts the refusal against the clock it was given, not the wall clock", async () => {
    // `stateFor` pins now to 1 August 2026 while the wall clock is pinned to
    // 1 March 2027 — long after the 8 August 2026 check-in. Reading the wall
    // clock would report STAY_NOT_FUTURE and drop the "No thanks" button for a
    // stay that has not happened yet.
    const state = await stateFor(guestRow(), { quotePriced: true });
    expect(state.kind === "ASK" && state.facts.refusalBlocker).not.toBe(
      "STAY_NOT_FUTURE",
    );

    // ...and it does report STAY_NOT_FUTURE when the caller's own clock says
    // the stay has started, so the assertion above is not vacuous.
    const started = await resolveDelegateConsentPageState({
      guestId: GUEST_ID,
      viewerMemberId: DELEGATE,
      db: makeDb(guestRow()),
      delegateResolver: resolver(true),
      moduleEnabled: moduleOn,
      now: new Date("2026-08-08T12:00:00.000+12:00"),
    });
    expect(started.kind === "ASK" && started.facts.refusalBlocker).toBe(
      "STAY_NOT_FUTURE",
    );
  });

  it("falls back to the stay envelope when the row has no night rows", async () => {
    const state = await stateFor(guestRow({ nights: [] }));
    expect(state.kind === "ASK" && state.facts.guestNights).toHaveLength(2);
  });
});
