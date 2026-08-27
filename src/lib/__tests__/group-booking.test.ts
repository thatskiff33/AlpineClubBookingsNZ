import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  AgeTier,
  BookingStatus,
  GroupBookingPaymentMode,
  GroupBookingStatus,
} from "@prisma/client";

// #2919 only: the pure helpers below touch no database. The verification-token
// lodge lookup does, so this file stubs the single delegate it reads.
const { groupBookingJoinFindUnique } = vi.hoisted(() => ({
  groupBookingJoinFindUnique: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { groupBookingJoin: { findUnique: groupBookingJoinFindUnique } },
}));

import { hashActionToken, issueActionToken } from "@/lib/action-tokens";
import {
  generateGroupBookingCode,
  hasGroupStayFullyEnded,
  isGroupJoinable,
  isOrganiserBookingActive,
  normaliseJoinCode,
  parseNonMemberJoinGuests,
  resolveGroupJoinVerificationLodgeName,
  toGroupBookingSummary,
  type GroupBookingRecordForSummary,
} from "@/lib/group-booking";

describe("generateGroupBookingCode", () => {
  it("generates an 8-character code from the unambiguous charset", () => {
    const code = generateGroupBookingCode();
    expect(code).toHaveLength(8);
    // Only uppercase letters/digits, and never the ambiguous I, L, O, 0, 1.
    expect(code).toMatch(/^[A-Z2-9]+$/);
    expect(code).not.toMatch(/[ILO01]/);
  });

  it("generates distinct codes across many calls", () => {
    const codes = new Set(
      Array.from({ length: 1000 }, () => generateGroupBookingCode())
    );
    // Collisions across 1000 draws from ~8.5e11 codes are vanishingly unlikely.
    expect(codes.size).toBe(1000);
  });
});

describe("normaliseJoinCode", () => {
  it("trims, uppercases, and strips spaces and dashes", () => {
    expect(normaliseJoinCode("  ab cd-23  ")).toBe("ABCD23");
    expect(normaliseJoinCode("abcd2345")).toBe("ABCD2345");
    expect(normaliseJoinCode("AB-CD-23-45")).toBe("ABCD2345");
  });

  it("returns an empty string for blank input", () => {
    expect(normaliseJoinCode("   ")).toBe("");
  });
});

describe("isGroupJoinable", () => {
  const now = new Date("2026-06-16T00:00:00Z");

  it("is joinable when OPEN with no deadline", () => {
    expect(
      isGroupJoinable({ status: GroupBookingStatus.OPEN, joinDeadline: null }, now)
    ).toBe(true);
  });

  it("is joinable when OPEN with a future deadline", () => {
    expect(
      isGroupJoinable(
        {
          status: GroupBookingStatus.OPEN,
          joinDeadline: new Date("2026-06-20T00:00:00Z"),
        },
        now
      )
    ).toBe(true);
  });

  it("is not joinable when OPEN but the deadline has passed", () => {
    expect(
      isGroupJoinable(
        {
          status: GroupBookingStatus.OPEN,
          joinDeadline: new Date("2026-06-10T00:00:00Z"),
        },
        now
      )
    ).toBe(false);
  });

  it("is not joinable when CLOSED or CANCELLED", () => {
    expect(
      isGroupJoinable(
        { status: GroupBookingStatus.CLOSED, joinDeadline: null },
        now
      )
    ).toBe(false);
    expect(
      isGroupJoinable(
        { status: GroupBookingStatus.CANCELLED, joinDeadline: null },
        now
      )
    ).toBe(false);
  });
});

describe("isOrganiserBookingActive", () => {
  it("is active for live host statuses", () => {
    for (const status of [
      BookingStatus.PAID,
      BookingStatus.CONFIRMED,
      BookingStatus.PAYMENT_PENDING,
    ]) {
      expect(isOrganiserBookingActive({ status, deletedAt: null })).toBe(true);
    }
  });

  it("is inactive when cancelled, bumped or soft-deleted", () => {
    expect(
      isOrganiserBookingActive({ status: BookingStatus.CANCELLED, deletedAt: null })
    ).toBe(false);
    expect(
      isOrganiserBookingActive({ status: BookingStatus.BUMPED, deletedAt: null })
    ).toBe(false);
    expect(
      isOrganiserBookingActive({
        status: BookingStatus.PAID,
        deletedAt: new Date("2026-06-01T00:00:00Z"),
      })
    ).toBe(false);
  });
});

describe("hasGroupStayFullyEnded", () => {
  // Booking dates are date-only lodge nights stored as UTC midnights, and the
  // second argument is now THE CLUB'S TODAY in that same encoding rather than a
  // raw instant the helper projects for itself (#3123). It used to derive the
  // day from `APP_TIME_ZONE`, i.e. the container's — so a club whose configured
  // zone differed from its deployment's closed, or kept open, a group's joins
  // on the wrong day, and no call site could see it happening. Every caller now
  // resolves the club's day once, outside any transaction, and passes it down.
  const checkOut = new Date("2026-06-17T00:00:00Z");
  const clubDay = (day: string) => new Date(`${day}T00:00:00.000Z`);

  it("has ended when the stay checks out today (matches the unpaid-finished-stays cutoff)", () => {
    expect(hasGroupStayFullyEnded({ checkOut }, clubDay("2026-06-17"))).toBe(
      true,
    );
  });

  it("has ended once the check-out day is in the past", () => {
    expect(hasGroupStayFullyEnded({ checkOut }, clubDay("2026-06-20"))).toBe(
      true,
    );
  });

  it("has not ended while the stay checks out tomorrow", () => {
    expect(hasGroupStayFullyEnded({ checkOut }, clubDay("2026-06-16"))).toBe(
      false,
    );
  });

  it("follows the CLUB's day, wherever the container thinks it is (#3123)", () => {
    // This case used to hand in `2026-06-16T13:00Z` — 01:00 on the 17th in New
    // Zealand — and rely on the helper projecting it. That projection was the
    // defect: it read the CONTAINER's zone, not the club's. The day is now
    // stated, so the same two answers come from the two days themselves.
    expect(hasGroupStayFullyEnded({ checkOut }, clubDay("2026-06-17"))).toBe(
      true,
    );
    expect(hasGroupStayFullyEnded({ checkOut }, clubDay("2026-06-16"))).toBe(
      false,
    );
  });

  it("is invariant to the host process's own zone", () => {
    // Both operands are UTC-midnight day encodings, so nothing about the
    // machine can move this answer — which is the property the migration buys.
    const original = process.env.TZ;
    try {
      const answers = ["UTC", "Pacific/Kiritimati", "Pacific/Pago_Pago"].map(
        (zone) => {
          process.env.TZ = zone;
          return hasGroupStayFullyEnded({ checkOut }, clubDay("2026-06-16"));
        },
      );
      expect(new Set(answers)).toEqual(new Set([false]));
    } finally {
      process.env.TZ = original ?? "";
    }
  });
});

describe("toGroupBookingSummary", () => {
  // Fixed evaluation instant well before the fixture's check-out, so the
  // ended-stay exclusion (#1723 path 3) never depends on the real clock. The
  // club's own day is stated separately from the instant now (#3123): the
  // deadline comparison is an instant one, the ended-stay one is a calendar day.
  const now = new Date("2026-06-16T00:00:00Z");
  const clubToday = new Date("2026-06-16T00:00:00.000Z");
  const baseRecord: GroupBookingRecordForSummary = {
    joinCode: "ABCD2345",
    status: GroupBookingStatus.OPEN,
    paymentMode: GroupBookingPaymentMode.EACH_PAYS_OWN,
    joinDeadline: null,
    organiserBooking: {
      checkIn: new Date("2026-07-01T00:00:00Z"),
      checkOut: new Date("2026-07-03T00:00:00Z"),
      status: BookingStatus.CONFIRMED,
      deletedAt: null,
      lodge: { name: "West Ridge Hut" },
    },
    organiserMember: { firstName: "Andy" },
  };

  it("exposes only public-safe fields", () => {
    const summary = toGroupBookingSummary(baseRecord, clubToday, now);
    expect(summary).toEqual({
      code: "ABCD2345",
      status: GroupBookingStatus.OPEN,
      paymentMode: GroupBookingPaymentMode.EACH_PAYS_OWN,
      organiserFirstName: "Andy",
      // The group's actual lodge (organiser booking's lodge), so public join
      // copy names the right property in a multi-lodge club (#11).
      lodgeName: "West Ridge Hut",
      checkIn: baseRecord.organiserBooking.checkIn,
      checkOut: baseRecord.organiserBooking.checkOut,
      joinDeadline: null,
      isJoinable: true,
    });
    // No leaking of internal identifiers or member contact details.
    expect(summary).not.toHaveProperty("organiserBookingId");
    expect(summary).not.toHaveProperty("organiserMemberId");
    // The lodge id (internal) is never exposed — only the display name.
    expect(summary).not.toHaveProperty("lodgeId");
  });

  it("reflects joinability for a closed group", () => {
    const summary = toGroupBookingSummary(
      {
        ...baseRecord,
        status: GroupBookingStatus.CLOSED,
      },
      clubToday,
      now,
    );
    expect(summary.isJoinable).toBe(false);
  });

  it("is not joinable when the host booking is no longer active", () => {
    const cancelledHost = toGroupBookingSummary(
      {
        ...baseRecord,
        organiserBooking: { ...baseRecord.organiserBooking, status: BookingStatus.CANCELLED },
      },
      clubToday,
      now,
    );
    expect(cancelledHost.isJoinable).toBe(false);

    const deletedHost = toGroupBookingSummary(
      {
        ...baseRecord,
        organiserBooking: {
          ...baseRecord.organiserBooking,
          deletedAt: new Date("2026-06-01T00:00:00Z"),
        },
      },
      clubToday,
      now,
    );
    expect(deletedHost.isJoinable).toBe(false);
  });

  it("is not joinable once the group's stay has fully ended (#1723 path 3)", () => {
    // The fixture checks out on 2026-07-03; from that CLUB day onward the group
    // leaves the joinable set even while OPEN with an active host booking. The
    // club's day is now stated rather than projected out of the container's
    // zone (#3123); `now` still drives the join-deadline comparison, which is a
    // genuine instant one.
    const onCheckOutDay = toGroupBookingSummary(
      baseRecord,
      new Date("2026-07-03T00:00:00.000Z"),
      new Date("2026-07-03T00:00:00Z"),
    );
    expect(onCheckOutDay.isJoinable).toBe(false);

    const wellAfter = toGroupBookingSummary(
      baseRecord,
      new Date("2026-08-01T00:00:00.000Z"),
      new Date("2026-08-01T00:00:00Z"),
    );
    expect(wellAfter.isJoinable).toBe(false);
  });
});

describe("parseNonMemberJoinGuests", () => {
  it("parses a valid guest snapshot and trims names", () => {
    const guests = parseNonMemberJoinGuests([
      { firstName: " Sam ", lastName: " Tane ", ageTier: AgeTier.ADULT },
      { firstName: "Kit", lastName: "Rua", ageTier: AgeTier.CHILD },
    ]);
    expect(guests).toEqual([
      { firstName: "Sam", lastName: "Tane", ageTier: AgeTier.ADULT },
      { firstName: "Kit", lastName: "Rua", ageTier: AgeTier.CHILD },
    ]);
  });

  it("rejects the whole snapshot if any entry is malformed", () => {
    // Unknown age tier.
    expect(
      parseNonMemberJoinGuests([
        { firstName: "Sam", lastName: "Tane", ageTier: "SENIOR_WIZARD" },
      ])
    ).toEqual([]);
    // Missing required name.
    expect(
      parseNonMemberJoinGuests([
        { firstName: "Sam", lastName: "", ageTier: AgeTier.ADULT },
      ])
    ).toEqual([]);
    // A non-object entry poisons the batch.
    expect(
      parseNonMemberJoinGuests([
        { firstName: "Sam", lastName: "Tane", ageTier: AgeTier.ADULT },
        "not-an-object",
      ])
    ).toEqual([]);
  });

  it("returns an empty array for non-array or null input", () => {
    expect(parseNonMemberJoinGuests(null)).toEqual([]);
    expect(parseNonMemberJoinGuests(undefined)).toEqual([]);
    expect(parseNonMemberJoinGuests({ firstName: "Sam" })).toEqual([]);
    expect(parseNonMemberJoinGuests([])).toEqual([]);
  });
});

// #2919: the group-join confirmation page named the club's DEFAULT lodge for
// every group, because the page had nothing but a token and the club identity.
describe("resolveGroupJoinVerificationLodgeName", () => {
  const RAW_TOKEN = issueActionToken().token;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the lodge the group's organiser booking is actually at", async () => {
    groupBookingJoinFindUnique.mockResolvedValue({
      groupBooking: {
        organiserBooking: { lodge: { name: "Second Lodge" } },
      },
    });

    await expect(resolveGroupJoinVerificationLodgeName(RAW_TOKEN)).resolves.toBe(
      "Second Lodge"
    );
    // Looked up by the HASH of the token, never the raw token.
    expect(groupBookingJoinFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { verificationTokenHash: hashActionToken(RAW_TOKEN) },
      })
    );
  });

  it("reads the lodge name and nothing else about the lodge", async () => {
    groupBookingJoinFindUnique.mockResolvedValue(null);

    await resolveGroupJoinVerificationLodgeName(RAW_TOKEN);

    const args = groupBookingJoinFindUnique.mock.calls[0]?.[0] as {
      select: {
        groupBooking: {
          select: {
            organiserBooking: { select: { lodge: { select: unknown } } };
          };
        };
      };
    };
    // No travel note, no door code: this is an unauthenticated surface.
    expect(
      args.select.groupBooking.select.organiserBooking.select.lodge.select
    ).toEqual({ name: true });
  });

  it("returns null for an unknown token, so the page falls back to the club default", async () => {
    groupBookingJoinFindUnique.mockResolvedValue(null);

    await expect(resolveGroupJoinVerificationLodgeName(RAW_TOKEN)).resolves.toBeNull();
  });

  it("refuses a malformed token without touching the database", async () => {
    await expect(
      resolveGroupJoinVerificationLodgeName("not-a-token")
    ).resolves.toBeNull();
    expect(groupBookingJoinFindUnique).not.toHaveBeenCalled();
  });
});

describe("joinGroupBookingAsMember resolves the club's day ONCE (#3123)", () => {
  /*
    A source contract, because the alternative is a whole booking, member,
    lodge, promotion and Xero fixture to observe one variable.

    `joinGroupBookingAsMember` used to read the club's zone TWICE — once at the
    top for the stay-has-ended refusal and the Internet Banking lead time, and
    again a few hundred lines later for `createConfirmedBooking`'s retroactive
    envelope and promotion window. Both reads were outside every transaction, so
    this was never an `INV-LOCK-004` breach; it was worse in a quieter way. A
    join running across club midnight gated the first pair on day D and handed
    D+1 to the second, and the in-tree comment claimed "one read, one answer,
    for the whole join" the whole time it was untrue. This is the instrument
    that makes the comment a contract (`INV-CONFIG-002`, owner's
    single-source-of-truth rule: resolve an authority once at the boundary and
    thread it).

    Note that ONE read now feeds TWO values of different KINDS — the
    `CalendarDate` `createConfirmedBooking` takes, and the UTC-midnight
    `@db.Date` instant the stored `checkOut` column is compared against. That
    split is the point, not a smell: conflating those two encodings is the
    defect class this issue exists to remove.
  */
  const READER = "readClubTimeZoneOutsideRequest(";

  /** The body of `joinGroupBookingAsMember`, comments and strings blanked. */
  function joinBody(): string {
    const source = readFileSync(
      path.join(__dirname, "..", "group-booking.ts"),
      "utf8",
    );
    // Comments blanked so the prose above the read — which names the reader —
    // cannot be counted, and strings blanked so neither can a message.
    const masked = source
      .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
      .replace(/\/\/[^\n]*/g, (match) => match.replace(/[^\n]/g, " "));
    const start = masked.indexOf("export async function joinGroupBookingAsMember");
    expect(start, "the function has been renamed or removed").toBeGreaterThan(-1);
    const rest = masked.slice(start + 1);
    const nextDeclaration = rest.search(/^(?:export\s+)?(?:async\s+)?function\s/m);
    return nextDeclaration === -1 ? rest : rest.slice(0, nextDeclaration);
  }

  it("reads the club's timezone exactly once for the whole join", () => {
    const body = joinBody();
    expect(body.split(READER).length - 1).toBe(1);
  });

  it("NOT VACUOUS: the slice really is the join, and really contains the read", () => {
    const body = joinBody();
    // Landmarks from three widely separated parts of the function, so a slice
    // that has silently collapsed to nothing cannot pass the count above.
    expect(body).toContain("hasGroupStayFullyEnded");
    expect(body).toContain("checkInternetBankingLeadTime");
    expect(body).toContain("createConfirmedBooking");
    expect(body).toContain(READER);
  });
});
