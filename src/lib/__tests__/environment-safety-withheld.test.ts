import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The withheld-application-email count (#3035 supplying #3034's surface; epic
 * #2986).
 *
 * WHY THIS NUMBER EXISTS AT ALL. A live club installation that has been wrongly
 * declared a copy silently stops emailing its members, and no property of the
 * DATABASE can distinguish it from a legitimate staging copy — a copy is restored
 * from production and holds exactly the same records. What distinguishes them is
 * consequence: a real club withholds a steady, recent stream; an idle copy
 * withholds almost nothing. So the count and its recency are the signal, and the
 * three states have to stay tellable apart, because "none held back" and "we
 * could not count" look identical on a screen and mean opposite things.
 */

const mocks = vi.hoisted(() => ({
  aggregate: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { emailLog: { aggregate: mocks.aggregate } },
}));
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));

import { readWithheldApplicationEmail } from "@/lib/environment-safety-withheld";

function aggregateResult(count: number, mostRecentAt: Date | null) {
  return { _count: { _all: count }, _max: { createdAt: mostRecentAt } };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("readWithheldApplicationEmail", () => {
  it("counts BOTH the confirmed-copy suppressions and the unknown-environment blocks", async () => {
    /*
      Both are "held back for environment-safety reasons", and the unknown half is
      the MORE urgent of the two: it is the live club that upgraded without the
      declaration. Leaving it out would have made this number read as reassurance
      on exactly that installation.
    */
    mocks.aggregate
      .mockResolvedValueOnce(
        aggregateResult(12, new Date("2026-06-20T01:00:00.000Z")),
      )
      .mockResolvedValueOnce(
        aggregateResult(5, new Date("2026-06-25T02:00:00.000Z")),
      )
      // The capture-in-production subset (#3035 review): part of the `blocked`
      // five above, counted separately so the LIVE-site surfaces can act on it.
      .mockResolvedValueOnce(aggregateResult(2, null));

    expect(await readWithheldApplicationEmail()).toEqual({
      available: true,
      count: 17,
      mostRecentAt: "2026-06-25T02:00:00.000Z",
      captureInProduction: 2,
    });

    const [suppressed, blocked, capture] = mocks.aggregate.mock.calls.map(
      (call) => call[0],
    );
    expect(suppressed.where).toEqual({ status: "SKIPPED_NON_PRODUCTION" });
    expect(blocked.where).toEqual({
      status: "FAILED",
      deliveryBlockReason: { not: null },
    });
    // A SUBSET of `blocked`, so it must not be added into `count` — the total
    // above is 12 + 5, not 12 + 5 + 2.
    expect(capture.where).toEqual({
      status: "FAILED",
      deliveryBlockReason: "CAPTURE_TRANSPORT_IN_PRODUCTION",
    });
  });

  /*
    #3035 review: THE ONE WITHHOLD A PRODUCTION INSTALLATION CAN HAVE.

    Both operator surfaces rendered the withheld line only under NON_PRODUCTION
    and UNKNOWN, on the premise that a live site holds nothing back. A live club
    that declares USE_LOCAL_CAPTURE=true is in a total mail outage and the premise
    is false — so this number exists to let those surfaces say so there, and it is
    kept apart from the total because SKIPPED_NON_PRODUCTION rows are terminal and
    would otherwise nag a repaired live site for ever.
  */
  it("breaks out the capture-in-production rows without double-counting them", async () => {
    mocks.aggregate
      .mockResolvedValueOnce(aggregateResult(0, null))
      .mockResolvedValueOnce(
        aggregateResult(9, new Date("2026-06-30T03:00:00.000Z")),
      )
      .mockResolvedValueOnce(aggregateResult(9, null));

    expect(await readWithheldApplicationEmail()).toEqual({
      available: true,
      count: 9,
      mostRecentAt: "2026-06-30T03:00:00.000Z",
      captureInProduction: 9,
    });
  });

  it("takes the most recent instant across the two populations, not the last one read", async () => {
    mocks.aggregate
      .mockResolvedValueOnce(
        aggregateResult(1, new Date("2026-06-28T00:00:00.000Z")),
      )
      .mockResolvedValueOnce(
        aggregateResult(1, new Date("2026-06-01T00:00:00.000Z")),
      )
      .mockResolvedValueOnce(aggregateResult(0, null));

    expect(await readWithheldApplicationEmail()).toMatchObject({
      mostRecentAt: "2026-06-28T00:00:00.000Z",
    });
  });

  it("reports an honest zero when this installation has genuinely held nothing back", async () => {
    mocks.aggregate.mockResolvedValue(aggregateResult(0, null));

    expect(await readWithheldApplicationEmail()).toEqual({
      available: true,
      count: 0,
      mostRecentAt: null,
      captureInProduction: 0,
    });
  });

  it("counts only the environment outcomes, never the club's own No emails decision", async () => {
    // A busy live club withholds plenty of SKIPPED_NO_EMAILS rows by choice.
    // Counting those would make it look like a copy holding mail back.
    mocks.aggregate.mockResolvedValue(aggregateResult(0, null));
    await readWithheldApplicationEmail();
    for (const call of mocks.aggregate.mock.calls) {
      expect(JSON.stringify(call[0].where)).not.toContain("SKIPPED_NO_EMAILS");
    }
  });

  it("answers 'cannot count' rather than zero when the read fails", async () => {
    /*
      The distinction the whole three-state type exists for. A fabricated zero
      reads as "this copy has held nothing back", which is the one reassurance a
      wrongly-declared live site must never be given.
    */
    mocks.aggregate.mockRejectedValue(new Error("relation does not exist"));

    expect(await readWithheldApplicationEmail()).toEqual({ available: false });
    expect(mocks.logger.error).toHaveBeenCalledTimes(1);
    // The log carries the fault's message and not the whole error object, which
    // on a Prisma failure can hold the connection string.
    expect(mocks.logger.error.mock.calls[0][0]).toEqual({
      scope: "environment-safety-withheld",
      err: { message: "relation does not exist" },
    });
  });
});
