import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { requireClubTimeZone } from "@/lib/club-time";
import {
  auditMidStayEditHistory,
  FIX_2743_MERGED_AT,
  FIX_2744_MERGED_AT,
  MidStayEditCutOffUnknownError,
  type MidStayEditAuditResult,
} from "@/lib/mid-stay-edit-history-audit";
import { formatMidStayEditAuditReport, parseMidStayEditAuditArgs } from "@/lib/mid-stay-edit-history-audit-report";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const ZONE = requireClubTimeZone("Pacific/Auckland");
const MARKER_FINISHED = new Date("2026-08-10T10:00:00.000Z");
const BOOKED_AT = new Date("2026-06-01T00:00:00.000Z");
// 12 July in the club's zone (NZST, UTC+12): the middle of a 10-15 July stay.
const MID_STAY = new Date("2026-07-12T00:00:00.000Z");
const at = (iso: string) => new Date(iso);
// Names live in the stored snapshots; no output may carry them.
const NAME = { firstName: "Privatename", lastName: "Fixturesurname" };

type Mod = {
  id: string;
  bookingId: string;
  modificationType: string;
  previousData: unknown;
  newData: unknown;
  createdAt: Date;
};

function mod(
  id: string,
  bookingId: string,
  options: {
    type?: string;
    createdAt?: Date;
    previous?: Record<string, unknown>;
    next?: Record<string, unknown>;
    checkIn?: string;
    checkOut?: string;
  } = {},
): Mod {
  const checkIn = options.checkIn ?? "2026-07-10";
  const checkOut = options.checkOut ?? "2026-07-15";
  return {
    id,
    bookingId,
    modificationType: options.type ?? "BATCH_MODIFY",
    createdAt: options.createdAt ?? MID_STAY,
    previousData: {
      checkIn,
      checkOut,
      guestCount: 2,
      totalPriceCents: 50000,
      discountCents: 0,
      promoAdjustmentCents: 0,
      removedGuests: [],
      ...options.previous,
    },
    newData: { checkIn, checkOut, guestCount: 2, totalPriceCents: 50000, addedGuests: [], ...options.next },
  };
}

type Guest = { bookingId: string; createdAt: Date; priceCents: number; nights: { priceCents: number | null }[] };

function fakeDb(fixture: {
  modifications: Mod[];
  guests?: Guest[];
  bookings?: { id: string; memberId: string | null; lodgeId: string; createdAt: Date }[];
  seasons?: { lodgeId: string; startDate: Date; endDate: Date; updatedAt: Date; membershipTypeRates: { updatedAt: Date }[] }[];
  history?: boolean;
  markerFinishedAt?: Date | null;
}) {
  const history = fixture.history ?? true;
  const markerFinishedAt = fixture.markerFinishedAt === undefined ? MARKER_FINISHED : fixture.markerFinishedAt;
  const bookingIds = [...new Set(fixture.modifications.map((row) => row.bookingId))];
  // Only read methods exist: a write would throw, so the audit cannot write by accident.
  const reads = {
    // `withReadOnlySnapshot`'s `SET TRANSACTION READ ONLY`, the only statement it executes.
    $executeRaw: vi.fn(async () => 0),
    // `readMigrationFinishedAt`: the history-table probe, then the marker's finish.
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) =>
      strings.join("").includes("to_regclass")
        ? [{ present: history }]
        : markerFinishedAt
          ? [{ finished_at: markerFinishedAt }]
          : [],
    ),
    bookingModification: {
      findMany: vi.fn(async (args: { where: { modificationType: { in: string[] } } }) =>
        fixture.modifications
          .filter((row) => args.where.modificationType.in.includes(row.modificationType))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)),
      ),
      groupBy: vi.fn(async () =>
        bookingIds.map((bookingId) => ({
          bookingId,
          _max: {
            createdAt: new Date(
              Math.max(...fixture.modifications.filter((row) => row.bookingId === bookingId).map((row) => row.createdAt.getTime())),
            ),
          },
        })),
      ),
    },
    booking: {
      findMany: vi.fn(async () =>
        fixture.bookings ?? bookingIds.map((id) => ({ id, memberId: `member-of-${id}`, lodgeId: "lodge_a", createdAt: BOOKED_AT })),
      ),
    },
    bookingGuest: { findMany: vi.fn(async () => fixture.guests ?? []) },
    season: {
      findMany: vi.fn(async () =>
        fixture.seasons ?? [
          {
            lodgeId: "lodge_a",
            startDate: at("2026-06-01"),
            endDate: at("2026-10-31"),
            updatedAt: at("2026-05-01T00:00:00Z"),
            membershipTypeRates: [{ updatedAt: at("2026-05-01T00:00:00Z") }],
          },
        ],
      ),
    },
  };
  const $transaction = vi.fn(async (run: (tx: typeof reads) => Promise<unknown>, options: unknown) => {
    void options;
    return run(reads);
  });
  return { ...reads, $transaction };
}

const run = (db: ReturnType<typeof fakeDb>, before?: Date) =>
  auditMidStayEditHistory({ db: db as never, zone: ZONE, before });

function findingsById(result: MidStayEditAuditResult) {
  return Object.fromEntries(
    result.examined.map((edit) => [
      edit.modificationId,
      edit.findings.map((finding) => ({ shape: finding.shape, atStakeCents: finding.atStakeCents })),
    ]),
  );
}

function shapeFixture() {
  const guest = (bookingId: string, createdAt: Date, priceCents: number): Guest => ({
    bookingId,
    createdAt,
    priceCents,
    nights: [{ priceCents: priceCents / 5 }],
  });
  return fakeDb({
    modifications: [
      // Listed.
      mod("rebilled", "b_rebilled", { next: { totalPriceCents: 60000 } }),
      mod("add_excess", "b_add_excess", { next: { totalPriceCents: 70000, addedGuests: [NAME] } }),
      mod("extension", "b_extension", { next: { checkOut: "2026-07-17", totalPriceCents: 80000 } }),
      mod("add_edited_later", "b_add_later", { next: { totalPriceCents: 70000, addedGuests: [NAME] } }),
      mod("later_name_fix", "b_add_later", { type: "GUEST_UPDATE", createdAt: at("2026-07-13T00:00:00Z") }),
      mod("removal", "b_removal", { createdAt: at("2026-07-11T00:00:00Z"), previous: { removedGuests: [NAME] }, next: { totalPriceCents: 40000 } }),
      mod("give_back_after_removal", "b_removal", {
        createdAt: at("2026-07-13T00:00:00Z"),
        previous: { totalPriceCents: 40000 },
        next: { checkOut: "2026-07-14", totalPriceCents: 35000 },
      }),
      mod("give_back_party", "b_party", { next: { checkOut: "2026-07-13", totalPriceCents: 30000 } }),
      mod("give_back_rate_change", "b_rate_change", { previous: { guestCount: 1 }, next: { checkOut: "2026-07-13", totalPriceCents: 42000 } }),
      mod("give_back_discount", "b_discount", {
        previous: { guestCount: 1, discountCents: 2000 },
        next: { checkOut: "2026-07-13", totalPriceCents: 45000 },
      }),
      mod("officer_shortened", "b_officer", {
        next: { checkOut: "2026-07-13", totalPriceCents: 38000, adminOverride: true, pricingMode: "recalculate" },
      }),
      mod("officer_unchanged_total", "b_officer_zero", { type: "DATE_CHANGE", next: { checkOut: "2026-07-16", pricingMode: "recalculate" } }),
      mod("unreadable", "b_unreadable", { previous: { totalPriceCents: "lots" } }),
      // Until #1099 a name edit ran the same pricing, so one could re-bill an ended guest.
      mod("name_edit_rebilled", "b_name_edit", { type: "GUEST_UPDATE", next: { totalPriceCents: 60000 } }),
      // Clear, or not examined at all.
      mod("add_exact", "b_add_exact", { next: { totalPriceCents: 65000, addedGuests: [NAME] } }),
      // One guest: none can have ended while the stay runs, and the rates are untouched.
      mod("give_back_clean", "b_clean", { previous: { guestCount: 1 }, next: { checkOut: "2026-07-13", totalPriceCents: 30000 } }),
      mod("before_check_in", "b_early", { createdAt: at("2026-07-05T00:00:00Z"), next: { totalPriceCents: 60000 } }),
      mod("after_cut_off", "b_late", {
        createdAt: at("2026-08-12T00:00:00Z"),
        checkIn: "2026-08-10",
        checkOut: "2026-08-15",
        next: { totalPriceCents: 60000 },
      }),
      mod("officer_before_check_in", "b_officer_early", {
        createdAt: at("2026-07-05T00:00:00Z"),
        next: { totalPriceCents: 60000, adminOverride: true, pricingMode: "recalculate" },
      }),
      mod("shift", "b_shift", { type: "ADMIN_DATE_SHIFT", next: { checkOut: "2026-07-16", pricingMode: "shift" } }),
      mod("shift_through_date_change", "b_shift2", { type: "DATE_CHANGE", next: { checkOut: "2026-07-16", pricingMode: "shift", totalPriceCents: 60000 } }),
      mod("typo_fix", "b_typo", { type: "GUEST_TYPO_FIX", next: { totalPriceCents: 60000 } }),
    ],
    guests: [
      guest("b_add_excess", new Date(MID_STAY.getTime() + 2_000), 15000),
      guest("b_add_excess", BOOKED_AT, 25000),
      guest("b_add_later", MID_STAY, 15000),
      guest("b_add_exact", MID_STAY, 15000),
    ],
    bookings: [
      ...["b_rebilled", "b_add_excess", "b_extension", "b_add_later", "b_removal", "b_party", "b_discount", "b_officer", "b_officer_zero", "b_unreadable", "b_name_edit", "b_add_exact", "b_clean", "b_early", "b_late", "b_officer_early", "b_shift2"].map(
        (id) => ({ id, memberId: `member-of-${id}`, lodgeId: "lodge_a", createdAt: BOOKED_AT }),
      ),
      { id: "b_rate_change", memberId: "member-of-b_rate_change", lodgeId: "lodge_b", createdAt: BOOKED_AT },
    ],
    seasons: [
      { lodgeId: "lodge_a", startDate: at("2026-06-01"), endDate: at("2026-10-31"), updatedAt: at("2026-05-01T00:00:00Z"), membershipTypeRates: [] },
      // Lodge B's winter rate was edited after the booking was made.
      {
        lodgeId: "lodge_b",
        startDate: at("2026-06-01"),
        endDate: at("2026-10-31"),
        updatedAt: at("2026-05-01T00:00:00Z"),
        membershipTypeRates: [{ updatedAt: at("2026-06-20T00:00:00Z") }],
      },
      // A change to lodge A's rates for other nights does not count.
      { lodgeId: "lodge_a", startDate: at("2026-12-01"), endDate: at("2026-12-31"), updatedAt: at("2026-06-20T00:00:00Z"), membershipTypeRates: [] },
    ],
  });
}

describe("auditMidStayEditHistory (#5242) - which edits, and how each reads", () => {
  it("lists one finding per edit and shape, with what is at stake", async () => {
    const result = await run(shapeFixture());

    expect(findingsById(result)).toEqual({
      rebilled: [{ shape: "rebilled-nothing-bought", atStakeCents: 10000 }],
      add_excess: [{ shape: "added-guests-excess", atStakeCents: 5000 }],
      extension: [{ shape: "extended-or-mixed", atStakeCents: 30000 }],
      add_edited_later: [{ shape: "added-guests-unmatched", atStakeCents: 20000 }],
      removal: [{ shape: "give-back-may-hide-rebill", atStakeCents: null }],
      give_back_after_removal: [{ shape: "give-back-may-hide-rebill", atStakeCents: null }],
      give_back_party: [{ shape: "give-back-may-hide-rebill", atStakeCents: null }],
      give_back_rate_change: [{ shape: "give-back-repriced", atStakeCents: 8000 }],
      give_back_discount: [{ shape: "give-back-repriced", atStakeCents: 5000 }],
      officer_shortened: [{ shape: "officer-recalculated", atStakeCents: 12000 }],
      officer_unchanged_total: [{ shape: "officer-recalculated", atStakeCents: 0 }],
      unreadable: [{ shape: "unreadable", atStakeCents: null }],
      name_edit_rebilled: [{ shape: "rebilled-nothing-bought", atStakeCents: 10000 }],
      add_exact: [],
      give_back_clean: [],
      // A name edit since #1099 echoes the stored price: examined, and clear.
      later_name_fix: [],
    });
    expect(result.midStayAfterCutOff).toBe(1);
  });

  it("carries the booking's member and the edit's club day on each examined edit", async () => {
    const result = await run(shapeFixture());
    expect(result.examined.find((edit) => edit.modificationId === "rebilled")).toMatchObject({
      bookingId: "b_rebilled",
      memberId: "member-of-b_rebilled",
      editedOn: "2026-07-12",
      priceChangeCents: 10000,
    });
  });

  it("falls back to possible, never clear, when the added guests cannot be matched", async () => {
    const db = fakeDb({
      modifications: [mod("two_added_one_found", "b1", { next: { totalPriceCents: 65000, addedGuests: [NAME, NAME] } })],
      guests: [{ bookingId: "b1", createdAt: MID_STAY, priceCents: 15000, nights: [] }],
    });
    expect(findingsById(await run(db))).toEqual({
      two_added_one_found: [{ shape: "added-guests-unmatched", atStakeCents: 15000 }],
    });
  });

  it("reads a negative guest or night price on the booking as a #2744 sign", async () => {
    const db = fakeDb({
      modifications: [mod("give_back", "b1", { previous: { guestCount: 1 }, next: { checkOut: "2026-07-13", totalPriceCents: 45000 } })],
      guests: [{ bookingId: "b1", createdAt: BOOKED_AT, priceCents: 20000, nights: [{ priceCents: -500 }, { priceCents: null }] }],
    });
    expect(findingsById(await run(db))).toEqual({ give_back: [{ shape: "give-back-repriced", atStakeCents: 5000 }] });
  });

  it("reads a stay no season covers any more as a rate change: a deleted season leaves no row", async () => {
    const db = fakeDb({
      modifications: [mod("give_back", "b1", { previous: { guestCount: 1 }, next: { checkOut: "2026-07-13", totalPriceCents: 45000 } })],
      seasons: [],
    });
    expect(findingsById(await run(db))).toEqual({ give_back: [{ shape: "give-back-repriced", atStakeCents: 5000 }] });
  });

  it("says a rise is a floor when the edit that bought nothing also gave nights back", async () => {
    const db = fakeDb({
      modifications: [
        mod("rise_with_removal", "b1", { previous: { removedGuests: [NAME] }, next: { totalPriceCents: 52000 } }),
        mod("rise_alone", "b2", { next: { totalPriceCents: 52000 } }),
      ],
    });
    const result = await run(db);
    const reason = (id: string) => result.examined.find((edit) => edit.modificationId === id)?.findings[0];
    expect(reason("rise_with_removal")).toMatchObject({ shape: "rebilled-nothing-bought", atStakeCents: 2000 });
    expect(reason("rise_with_removal")?.reason).toMatch(/at least this much/);
    expect(reason("rise_alone")?.reason).not.toMatch(/at least/);
  });

  it("names the earlier removal when it is why a give-back is listed", async () => {
    const result = await run(shapeFixture());
    const reason = (id: string) => result.examined.find((edit) => edit.modificationId === id)?.findings[0]?.reason;
    expect(reason("give_back_after_removal")).toMatch(/earlier mid-stay edit removed a guest/);
    expect(reason("give_back_party")).toMatch(/history cannot say whether one had/);
  });

  it("examines check-in day to check-out day by the club's calendar, not UTC", async () => {
    const edge = (id: string, iso: string) => mod(id, `b_${id}`, { createdAt: at(iso), next: { totalPriceCents: 60000 } });
    const db = fakeDb({
      modifications: [
        edge("day_before", "2026-07-09T00:00:00Z"),
        edge("check_in_day", "2026-07-10T00:00:00Z"),
        edge("check_out_day", "2026-07-15T00:00:00Z"),
        edge("day_after", "2026-07-16T00:00:00Z"),
        // 01:00 on 10 July in Auckland, still 9 July in UTC.
        edge("club_check_in_utc_day_before", "2026-07-09T13:00:00Z"),
        // 00:30 on 16 July in Auckland, still 15 July in UTC.
        edge("club_day_after_utc_check_out", "2026-07-15T12:30:00Z"),
      ],
    });
    const result = await run(db);
    expect(result.examined.map((edit) => edit.modificationId).sort()).toEqual(
      ["check_in_day", "check_out_day", "club_check_in_utc_day_before"].sort(),
    );
    expect(result.examined.find((edit) => edit.modificationId === "club_check_in_utc_day_before")?.editedOn).toBe("2026-07-10");
  });
});

describe("the cut-off: when this install took the fixes", () => {
  const edits = () => [
    mod("before", "b1", { next: { totalPriceCents: 60000 } }),
    mod("after_marker_within_grace", "b2", {
      createdAt: at("2026-08-11T09:00:00Z"),
      checkIn: "2026-08-10",
      checkOut: "2026-08-15",
      next: { totalPriceCents: 60000 },
    }),
  ];

  it("is the marker migration's finish plus 24 hours by default", async () => {
    const result = await run(fakeDb({ modifications: edits() }));
    expect(result.cutOff).toEqual({
      instant: at("2026-08-11T10:00:00.000Z"),
      source: "migration",
      markerFinishedAt: MARKER_FINISHED,
      migrationHistory: true,
    });
    expect(result.examined.map((edit) => edit.modificationId)).toEqual(["before", "after_marker_within_grace"]);
  });

  it("takes the operator's --before instead, still reporting the marker's finish", async () => {
    const result = await run(fakeDb({ modifications: edits() }), at("2026-08-11T00:00:00Z"));
    expect(result.cutOff).toMatchObject({ source: "operator", instant: at("2026-08-11T00:00:00Z"), markerFinishedAt: MARKER_FINISHED });
    expect(result.examined.map((edit) => edit.modificationId)).toEqual(["before"]);
    expect(result.midStayAfterCutOff).toBe(1);
  });

  it("refuses to guess with no migration history or no record of the marker, unless --before is given", async () => {
    await expect(run(fakeDb({ modifications: edits(), history: false }))).rejects.toThrow(MidStayEditCutOffUnknownError);
    await expect(run(fakeDb({ modifications: edits(), markerFinishedAt: null }))).rejects.toThrow(/--before/);
    const result = await run(fakeDb({ modifications: edits(), history: false }), at("2026-08-11T00:00:00Z"));
    expect(result.cutOff).toMatchObject({ source: "operator", markerFinishedAt: null, migrationHistory: false });
  });

  it("reads in one read-only RepeatableRead snapshot", async () => {
    const db = fakeDb({ modifications: edits() });
    await run(db);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: "RepeatableRead" }));
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    expect((db.$executeRaw.mock.calls[0] as unknown as [TemplateStringsArray])[0].join("")).toBe("SET TRANSACTION READ ONLY");
  });
});

describe("formatMidStayEditAuditReport", () => {
  it("prints the marker's finish beside both merge times, the cut-off and the edits after it", async () => {
    const report = formatMidStayEditAuditReport(await run(shapeFixture()), CLUB_FORMAT_TEST, { summaryOnly: true });
    expect(report).toContain(FIX_2743_MERGED_AT);
    expect(report).toContain(FIX_2744_MERGED_AT);
    expect(report).toContain("2026-08-10T10:00:00.000Z");
    expect(report).toMatch(/Cut-off used: +2026-08-11T10:00:00.000Z \(the marker migration's finish plus 24 hours\)/);
    expect(report).toMatch(/Mid-stay edits after the cut-off: +1 /);
  });

  it("--summary counts each shape, the officer shape on its own line, and lists no ids", async () => {
    const report = formatMidStayEditAuditReport(await run(shapeFixture()), CLUB_FORMAT_TEST, { summaryOnly: true });
    expect(report).toContain("16 mid-stay edit(s) before the cut-off examined: 13 listed, 3 clear.");
    expect(report).toMatch(/Officer override re-priced the stay \(possible\): 2, net change \$120\.00/);
    expect(report).toMatch(/Price rose though the edit bought nothing \(#2743, certain\): 2, \$200\.00/);
    expect(report).toMatch(/Nights given back; an ended guest's re-bill may hide in the credit \(#2743, possible\): 3, 3 amount unknown/);
    expect(report).toMatch(/History unreadable - a person checks: 1/);
    expect(report).not.toMatch(/b_rebilled|member-of-|Listed edits/);
  });

  it("the full report lists each finding by id, with an officer recalculation at $0.00 included", async () => {
    const report = formatMidStayEditAuditReport(await run(shapeFixture()), CLUB_FORMAT_TEST);
    expect(report).toContain("b_add_excess | member-of-b_add_excess | add_excess | 2026-07-12 | added-guests-excess | certain | $50.00 |");
    expect(report).toContain("| officer_unchanged_total | 2026-07-12 | officer-recalculated | possible | net change $0.00 |");
    expect(report).toContain("| give_back_after_removal | 2026-07-13 | give-back-may-hide-rebill | possible | amount unknown |");
    expect(report).not.toContain("| add_exact |");
  });

  it("never carries a guest's name, in the report or the JSON", async () => {
    const result = await run(shapeFixture());
    for (const output of [formatMidStayEditAuditReport(result, CLUB_FORMAT_TEST), JSON.stringify(result)]) {
      expect(output).not.toContain(NAME.firstName);
      expect(output).not.toContain(NAME.lastName);
    }
  });
});

describe("parseMidStayEditAuditArgs", () => {
  it("reads --json, --summary and --before", () => {
    expect(parseMidStayEditAuditArgs(["--", "--json"])).toEqual({ help: false, json: true, summary: false });
    expect(parseMidStayEditAuditArgs(["--summary", "--before", "2026-08-11T00:00:00+12:00"])).toEqual({
      help: false,
      json: false,
      summary: true,
      before: at("2026-08-10T12:00:00Z"),
    });
    expect(parseMidStayEditAuditArgs(["--before=2026-08-11T00:00:00Z"]).before).toEqual(at("2026-08-11T00:00:00Z"));
  });

  it("throws on --apply and any other unknown flag: there is no write path", () => {
    expect(() => parseMidStayEditAuditArgs(["--apply"])).toThrow("Unknown argument: --apply");
    expect(() => parseMidStayEditAuditArgs(["--fix"])).toThrow("Unknown argument: --fix");
  });

  it("refuses a --before with no zone, no value, or both --json and --summary", () => {
    expect(() => parseMidStayEditAuditArgs(["--before", "2026-08-11"])).toThrow(/ISO instant/);
    expect(() => parseMidStayEditAuditArgs(["--before", "2026-08-11T00:00:00"])).toThrow(/ISO instant/);
    // JavaScript alone would roll this to 2 March and move the cut-off silently.
    expect(() => parseMidStayEditAuditArgs(["--before", "2026-02-30T00:00:00Z"])).toThrow(/ISO instant/);
    expect(() => parseMidStayEditAuditArgs(["--before"])).toThrow(/got nothing/);
    expect(() => parseMidStayEditAuditArgs(["--json", "--summary"])).toThrow(/Choose one/);
  });
});
