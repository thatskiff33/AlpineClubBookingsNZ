import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ManualRefundTaskKind,
  ManualRefundTaskStatus,
  Prisma,
} from "@prisma/client";

/**
 * #3030 (epic #2797): the pending-financial-review state.
 *
 * Two things are under test, and they fail in different directions.
 *
 * The OCCURRENCE KEY must be stable enough that a retried edit raises one task,
 * and discriminating enough that a genuinely different edit is never mistaken for
 * a replay of an earlier one. Getting the first wrong duplicates work; getting
 * the second wrong loses money silently, because a replay that matches a
 * COMPLETED task raises nothing and nobody ever reviews the second adjustment.
 *
 * The RAISE must be idempotent, must leave an unknown amount genuinely unknown
 * rather than zero, and must never reopen a terminal occurrence.
 */

vi.mock("server-only", () => ({}));

import {
  buildEditFinancialReviewReason,
  editFinancialReviewOccurrenceKey,
  findOpenEditFinancialReviewTask,
  raiseEditFinancialReviewTask,
  EditFinancialReviewError,
} from "@/lib/edit-financial-review";
import {
  EDIT_FINANCIAL_REVIEW_CAUSES,
  parseEditFinancialReviewContext,
  type EditFinancialReviewOccurrence,
} from "@/lib/edit-financial-review-context";
import { parseCalendarDate } from "@/lib/club-time";

/**
 * Fixtures go through the real parser, so a typo in a test date is a test
 * failure rather than a branded-string cast that quietly lies.
 */
function day(value: string) {
  const parsed = parseCalendarDate(value);
  if (!parsed) throw new Error(`Test fixture is not a calendar date: ${value}`);
  return parsed;
}

function occurrence(
  overrides: Partial<EditFinancialReviewOccurrence> = {},
): EditFinancialReviewOccurrence {
  return {
    bookingId: "booking-1",
    bookingGuestId: "guest-1",
    cause: "PARTIAL_STORED_NIGHT_PRICES",
    surrenderedNightDates: [day("2026-08-02"), day("2026-08-03")],
    addedNightDates: [],
    storedEvidence: {
      guestTotalCents: 13500,
      nightPrices: [
        { date: day("2026-08-01"), priceCents: 4500 },
        { date: day("2026-08-02"), priceCents: 4500 },
        { date: day("2026-08-03"), priceCents: null },
      ],
    },
    ...overrides,
  };
}

const mocks = vi.hoisted(() => ({
  executeRaw: vi.fn(),
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
}));

function store() {
  return {
    $executeRaw: (...a: unknown[]) => mocks.executeRaw(...a),
    manualRefundTask: {
      findUnique: (...a: unknown[]) => mocks.findUnique(...a),
      findFirst: (...a: unknown[]) => mocks.findFirst(...a),
      create: (...a: unknown[]) => mocks.create(...a),
    },
  } as unknown as Prisma.TransactionClient;
}

const raiseInput = {
  guestMemberId: "member-1",
  bookingCheckIn: day("2026-08-01"),
  bookingCheckOut: day("2026-08-04"),
  // #3032: the settlement anchor a confirmed amount closes against (D-3032-1).
  bookingModificationId: "mod-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.executeRaw.mockResolvedValue(1);
  mocks.findUnique.mockResolvedValue(null);
  mocks.create.mockResolvedValue({
    id: "task-new",
    status: ManualRefundTaskStatus.OPEN,
  });
});

describe("#3030 occurrence key - the same structural edit is one occurrence", () => {
  it("is byte-identical for the same edit against the same stored evidence, so a retry raises one task", () => {
    expect(editFinancialReviewOccurrenceKey(occurrence())).toBe(
      editFinancialReviewOccurrenceKey(occurrence()),
    );
  });

  it("does not depend on the order the planner walked the nights in, or on a repeated night", () => {
    const shuffled = occurrence({
      surrenderedNightDates: [
        day("2026-08-03"),
        day("2026-08-02"),
        day("2026-08-03"),
      ],
      storedEvidence: {
        guestTotalCents: 13500,
        nightPrices: [
          { date: day("2026-08-03"), priceCents: null },
          { date: day("2026-08-01"), priceCents: 4500 },
          { date: day("2026-08-02"), priceCents: 4500 },
        ],
      },
    });
    expect(editFinancialReviewOccurrenceKey(shuffled)).toBe(
      editFinancialReviewOccurrenceKey(occurrence()),
    );
  });

  it("carries its namespace and version in the clear, and 64 hex characters of digest", () => {
    const key = editFinancialReviewOccurrenceKey(occurrence());
    expect(key).toMatch(/^edit-financial-review:v1:[0-9a-f]{64}$/);
  });

  it("MUTATION: PINS the digest for a fixed occurrence, so widening the hashed material without bumping v1 fails loudly", () => {
    // Every OTHER test in this describe recomputes the key on both sides -
    // key(a) === key(a), key(shuffled) === key(base), the discrimination cases -
    // so all of them would still pass if the canonicalisation, the field set or
    // the digest algorithm changed. This one would not.
    //
    // It matters more here than for the sibling `computeProposalHash`, which
    // re-derives from a frozen snapshot: this key is STORED in a unique-indexed
    // column and IS the duplicate fence. Add a field to `material` without
    // bumping OCCURRENCE_KEY_VERSION and every OPEN task already on file becomes
    // unreachable by key - the raise finds nothing, raises a SECOND task for one
    // adjustment, and two admins can hand the same money back twice. The module
    // docblock forbids that; this is what enforces it.
    //
    // If you are here because this failed: do NOT re-pin it. Either you changed
    // the material and must bump the namespace version (and then re-pin), or you
    // changed the canonicalisation and must not have.
    expect(editFinancialReviewOccurrenceKey(occurrence())).toBe(
      "edit-financial-review:v1:3d3fcd8e9b0b3de5bab1fee6a9e794146bb7747c19633cef428bce52e1667eca",
    );
  });

  it.each([
    ["a different booking", { bookingId: "booking-2" }],
    ["a different guest strand", { bookingGuestId: "guest-2" }],
    ["a different cause", { cause: "STORED_TOTAL_MISMATCH" as const }],
    [
      "a different set of surrendered nights",
      { surrenderedNightDates: [day("2026-08-02")] },
    ],
    ["nights the edit also adds", { addedNightDates: [day("2026-08-09")] }],
  ])("is a different occurrence for %s", (_label, overrides) => {
    expect(editFinancialReviewOccurrenceKey(occurrence(overrides))).not.toBe(
      editFinancialReviewOccurrenceKey(occurrence()),
    );
  });

  it("distinguishes a night surrendered, reviewed, re-added and surrendered AGAIN - which is the case a date-only key loses money on", () => {
    // First occurrence: three stored nights, the last of them unpriced.
    const first = occurrence({
      surrenderedNightDates: [day("2026-08-03")],
    });
    // The first edit committed, so 2026-08-03 left the stored evidence. The night
    // is later re-added and surrendered again: same booking, same guest, same
    // cause, same night. On booking/guest/cause/dates alone this would hash to
    // the key the COMPLETED task already holds, the raise would find a terminal
    // row, and the second adjustment would never reach an admin.
    const second = occurrence({
      surrenderedNightDates: [day("2026-08-03")],
      storedEvidence: {
        guestTotalCents: 9000,
        nightPrices: [
          { date: day("2026-08-01"), priceCents: 4500 },
          { date: day("2026-08-02"), priceCents: 4500 },
        ],
      },
    });
    expect(editFinancialReviewOccurrenceKey(second)).not.toBe(
      editFinancialReviewOccurrenceKey(first),
    );
  });

  it("distinguishes an absent stored price from a zero one, because a comped night is a real sold price", () => {
    const absent = occurrence({
      storedEvidence: {
        guestTotalCents: 9000,
        nightPrices: [{ date: day("2026-08-01"), priceCents: null }],
      },
    });
    const comped = occurrence({
      storedEvidence: {
        guestTotalCents: 9000,
        nightPrices: [{ date: day("2026-08-01"), priceCents: 0 }],
      },
    });
    expect(editFinancialReviewOccurrenceKey(absent)).not.toBe(
      editFinancialReviewOccurrenceKey(comped),
    );
  });

  it("names the nights it gave back rather than implying a RANGE across ones it did not", () => {
    // "3 nights (2026-08-02 to 2026-08-20)" reads as a nineteen-night span. This
    // sentence is what an admin reads in the finance queue while pricing real
    // money, so it must not overstate the stay.
    const reason = buildEditFinancialReviewReason(
      occurrence({
        surrenderedNightDates: [
          day("2026-08-02"),
          day("2026-08-03"),
          day("2026-08-20"),
        ],
      }),
    );
    expect(reason).toContain("3 nights: 2026-08-02, 2026-08-03, 2026-08-20");
    expect(reason).not.toContain("2026-08-02 to 2026-08-20");
  });

  it("does not move when only the operator prose changes, because text is not the identity", () => {
    const key = editFinancialReviewOccurrenceKey(occurrence());
    const reason = buildEditFinancialReviewReason(occurrence());
    expect(reason).not.toContain(key);
    // The reason is derived from the same occurrence and fits the column.
    expect(reason.length).toBeGreaterThan(0);
    expect(reason.length).toBeLessThanOrEqual(500);
    expect(editFinancialReviewOccurrenceKey(occurrence())).toBe(key);
  });
});

describe("#3030 raise - one task per occurrence, and an unknown amount stays unknown", () => {
  it("raises an OPEN task whose amount is NULL rather than zero, typed by kind and keyed by occurrence", async () => {
    const result = await raiseEditFinancialReviewTask({
      ...raiseInput,
      occurrence: occurrence(),
      store: store(),
    });

    const data = mocks.create.mock.calls[0][0].data;
    expect(data.kind).toBe(ManualRefundTaskKind.EDIT_FINANCIAL_REVIEW);
    expect(data.status).toBe(ManualRefundTaskStatus.OPEN);
    expect(data.occurrenceKey).toBe(
      editFinancialReviewOccurrenceKey(occurrence()),
    );
    // The whole point of the feature: not 0.
    expect(data.amountCents).toBeNull();
    expect(data.raisedAmountCents).toBeNull();
    // A credit owed for a surrendered night sits against no captured payment.
    expect(data.paymentId).toBeNull();
    expect(result).toMatchObject({
      taskId: "task-new",
      created: true,
      status: ManualRefundTaskStatus.OPEN,
    });
  });

  it("takes the global settlement key BEFORE it looks for an existing task, which is what makes find-then-create atomic", async () => {
    const calls: string[] = [];
    mocks.executeRaw.mockImplementation((...a: unknown[]) => {
      calls.push(`lock:${JSON.stringify(a[0])}`);
      return Promise.resolve(1);
    });
    mocks.findUnique.mockImplementation(() => {
      calls.push("findUnique");
      return Promise.resolve(null);
    });

    await raiseEditFinancialReviewTask({
      ...raiseInput,
      occurrence: occurrence(),
      store: store(),
    });

    expect(calls[0]).toContain("pg_advisory_xact_lock(1)");
    expect(calls[1]).toBe("findUnique");
  });

  it("returns the existing task on a replay instead of raising a second one", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "task-existing",
      status: ManualRefundTaskStatus.OPEN,
    });

    const result = await raiseEditFinancialReviewTask({
      ...raiseInput,
      occurrence: occurrence(),
      store: store(),
    });

    expect(mocks.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ taskId: "task-existing", created: false });
  });

  it.each([
    [ManualRefundTaskStatus.COMPLETED],
    [ManualRefundTaskStatus.DISMISSED],
  ])(
    "does not reopen or duplicate an occurrence already resolved as %s - terminal means terminal",
    async (status) => {
      mocks.findUnique.mockResolvedValue({ id: "task-done", status });

      const result = await raiseEditFinancialReviewTask({
        ...raiseInput,
        occurrence: occurrence(),
        store: store(),
      });

      expect(mocks.create).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        taskId: "task-done",
        created: false,
        status,
      });
    },
  );

  it("reports a lost race on the unique index loudly rather than swallowing it, because it cannot be recovered in place", async () => {
    mocks.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("unique", {
        code: "P2002",
        clientVersion: "test",
        meta: { target: ["occurrenceKey"] },
      }),
    );

    await expect(
      raiseEditFinancialReviewTask({
        ...raiseInput,
        occurrence: occurrence(),
        store: store(),
      }),
    ).rejects.toMatchObject({
      name: "EditFinancialReviewError",
      status: 409,
    });
  });

  it("does NOT tell the caller to retry a unique violation on some OTHER constraint, which retrying could never fix", async () => {
    // Today `occurrenceKey` is the only unique constraint on ManualRefundTask
    // besides the cuid primary key, so this cannot happen yet. A later
    // `@@unique([bookingId, kind])` would make it happen, and the operator would
    // be told "raised concurrently - retry the edit" for a violation that every
    // retry reproduces exactly.
    mocks.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("unique", {
        code: "P2002",
        clientVersion: "test",
        meta: { target: ["bookingId", "kind"] },
      }),
    );

    await expect(
      raiseEditFinancialReviewTask({
        ...raiseInput,
        occurrence: occurrence(),
        store: store(),
      }),
    ).rejects.not.toBeInstanceOf(EditFinancialReviewError);
  });

  it("MUTATION: refuses the FULL Prisma client, because the advisory lock it takes would commit and release before the find", async () => {
    // The type cannot refuse it: Prisma 7's deny list is
    // ["$connect","$disconnect","$on","$use","$extends"], so `PrismaClient` is
    // structurally assignable to `Prisma.TransactionClient`, and `$transaction`
    // is on BOTH (Prisma 7 nests transactions). `$connect` is what tells them
    // apart, and this is the only thing enforcing it.
    const fullClient = {
      ...store(),
      $connect: () => Promise.resolve(),
      $transaction: () => Promise.resolve(),
    } as unknown as Prisma.TransactionClient;

    await expect(
      raiseEditFinancialReviewTask({
        ...raiseInput,
        occurrence: occurrence(),
        store: fullClient,
      }),
    ).rejects.toMatchObject({
      name: "EditFinancialReviewError",
      status: 500,
    });
    // Nothing was attempted with it - in particular no advisory lock was taken
    // in an implicit transaction that would commit and release it immediately.
    expect(mocks.executeRaw).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("accepts a real transaction client, which DOES carry $transaction on Prisma 7", async () => {
    // Guards the guard: discriminating on `$transaction` instead of `$connect`
    // would refuse every legitimate caller. Measured against a real PostgreSQL
    // on 7.9.1, an interactive transaction client reports
    // `typeof tx.$transaction === "function"` and `typeof tx.$connect ===
    // "undefined"`.
    const txClient = {
      ...store(),
      $transaction: () => Promise.resolve(),
    } as unknown as Prisma.TransactionClient;

    await expect(
      raiseEditFinancialReviewTask({
        ...raiseInput,
        occurrence: occurrence(),
        store: txClient,
      }),
    ).resolves.toMatchObject({ created: true });
  });

  it("refuses to write a reviewContext its own reader could not read back, rather than storing evidence nobody can recover", async () => {
    // The read site returns null rather than throwing, deliberately - an admin
    // must still see the task. That is the wrong behaviour for the WRITE, where
    // the alternative is a row whose money evidence is lost for good: the edit
    // destroys the stored night prices, and the occurrence key is minted over
    // the same material, so the identity goes with it.
    await expect(
      raiseEditFinancialReviewTask({
        ...raiseInput,
        occurrence: occurrence({
          // A caller whose planner type widened. TypeScript cannot stop this:
          // the value crosses a `Json` boundary and `CalendarDate` is a branded
          // string a cast can forge.
          storedEvidence: {
            guestTotalCents: 4500.5,
            nightPrices: [],
          },
        }),
        store: store(),
      }),
    ).rejects.toMatchObject({
      name: "EditFinancialReviewError",
      status: 400,
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("lets any other database error through untouched, so a real fault is not disguised as a race", async () => {
    mocks.create.mockRejectedValue(new Error("connection reset"));

    await expect(
      raiseEditFinancialReviewTask({
        ...raiseInput,
        occurrence: occurrence(),
        store: store(),
      }),
    ).rejects.not.toBeInstanceOf(EditFinancialReviewError);
  });

  it.each([[-1], [12.5]])(
    "refuses to raise a task with %s as its amount - money is non-negative whole cents",
    async (bad) => {
      await expect(
        raiseEditFinancialReviewTask({
          ...raiseInput,
          occurrence: occurrence(),
          raisedAmountCents: bad,
          store: store(),
        }),
      ).rejects.toMatchObject({ status: 400 });
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.executeRaw).not.toHaveBeenCalled();
    },
  );

  it("writes a reviewContext that reads back through the parser and still holds the whole occurrence", async () => {
    await raiseEditFinancialReviewTask({
      ...raiseInput,
      occurrence: occurrence(),
      store: store(),
    });

    const written = mocks.create.mock.calls[0][0].data.reviewContext;
    // Round-tripped through JSON, because that is what Postgres will hand back.
    const parsed = parseEditFinancialReviewContext(
      JSON.parse(JSON.stringify(written)),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.occurrence).toEqual(occurrence());
    expect(parsed?.bookingCheckIn).toBe("2026-08-01");
    expect(parsed?.guestMemberId).toBe("member-1");
    // The evidence the edit DESTROYS is captured; the live payment history is
    // deliberately not copied here.
    expect(JSON.stringify(written)).not.toContain("payment");
  });
});

describe("#3030 pending-review fence - the read #3032 needs", () => {
  it("looks for an OPEN review by BOOKING and kind, because a credit-only task has no payment to find it by", async () => {
    mocks.findFirst.mockResolvedValue(null);

    await findOpenEditFinancialReviewTask("booking-9", store());

    expect(mocks.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          bookingId: "booking-9",
          kind: ManualRefundTaskKind.EDIT_FINANCIAL_REVIEW,
          status: ManualRefundTaskStatus.OPEN,
        },
      }),
    );
  });
});

describe("#3030 reviewContext parser - a blob it cannot vouch for is not read", () => {
  it("accepts the shape the writer produces", () => {
    expect(
      parseEditFinancialReviewContext({
        version: 1,
        occurrence: occurrence(),
        guestMemberId: null,
        bookingCheckIn: "2026-08-01",
        bookingCheckOut: "2026-08-04",
        // #3032: the settlement anchor is part of the shape the writer produces.
        bookingModificationId: "mod-1",
      }),
    ).not.toBeNull();
  });

  it.each([
    [
      "a version it does not know",
      { version: 2 as unknown as 1 },
    ],
    [
      "a date that is not a calendar date",
      { bookingCheckIn: "01/08/2026" as unknown as never },
    ],
    [
      "an unexpected extra field, which would mean it is reading a shape it does not understand",
      { somethingNew: true } as unknown as Record<string, never>,
    ],
  ])("refuses %s", (_label, overrides) => {
    expect(
      parseEditFinancialReviewContext({
        version: 1,
        occurrence: occurrence(),
        guestMemberId: null,
        bookingCheckIn: "2026-08-01",
        bookingCheckOut: "2026-08-04",
        ...overrides,
      }),
    ).toBeNull();
  });

  it("refuses negative cents anywhere in the evidence", () => {
    expect(
      parseEditFinancialReviewContext({
        version: 1,
        occurrence: {
          ...occurrence(),
          storedEvidence: {
            guestTotalCents: -1,
            nightPrices: [],
          },
        },
        guestMemberId: null,
        bookingCheckIn: "2026-08-01",
        bookingCheckOut: "2026-08-04",
      }),
    ).toBeNull();
  });

  it("refuses null and a non-object, rather than throwing at the admin surface", () => {
    expect(parseEditFinancialReviewContext(null)).toBeNull();
    expect(parseEditFinancialReviewContext("{}")).toBeNull();
  });

  it("keeps the cause vocabulary closed, so prose can never become a task type", () => {
    expect([...EDIT_FINANCIAL_REVIEW_CAUSES]).toEqual([
      "NO_STORED_NIGHT_PRICES",
      "PARTIAL_STORED_NIGHT_PRICES",
      "STORED_TOTAL_MISMATCH",
    ]);
    expect(
      parseEditFinancialReviewContext({
        version: 1,
        occurrence: { ...occurrence(), cause: "SOMETHING_ELSE" },
        guestMemberId: null,
        bookingCheckIn: "2026-08-01",
        bookingCheckOut: "2026-08-04",
      }),
    ).toBeNull();
  });
});
