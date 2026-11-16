// ALP-580: the stored night list of a hosting-coverage re-evaluation is read
// back strictly. This code writes every list from real lodge nights, so a right-
// shaped day that does not exist (`2026-02-30`) can only be corruption, and it
// would reach `parseDateOnly` as an Invalid Date. Dropping it keeps the item
// bounded: the same rule that already drops a non-string or a loose shape.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  loadClaimedHostingCoverageReevaluation,
  type HostingCoverageQueueDb,
} from "@/lib/adult-member-hosting-coverage-queue";

/** A queue db whose one claimed row carries `nights` exactly as stored. */
function dbWithStoredNights(nights: unknown): HostingCoverageQueueDb {
  return {
    hostingCoverageReevaluation: {
      findFirst: vi.fn().mockResolvedValue({
        id: "item-1",
        memberId: "member-1",
        lodgeId: "lodge-1",
        nights,
        cause: "BOOKING_CHANGED",
        sourceBookingId: null,
        actorMemberId: null,
        reason: null,
        attempts: 1,
        claimToken: "token-1",
      }),
    },
  } as unknown as HostingCoverageQueueDb;
}

async function readNights(nights: unknown): Promise<string[]> {
  const item = await loadClaimedHostingCoverageReevaluation(
    { id: "item-1", claimToken: "token-1" },
    dbWithStoredNights(nights),
  );
  return item!.nights;
}

describe("hosting coverage queue: stored nights are real days (ALP-580)", () => {
  it("drops a right-shaped night that does not exist, keeping the real ones", async () => {
    expect(
      await readNights(["2026-08-15", "2026-02-30", "2026-02-29", "2026-08-14"]),
    ).toEqual(["2026-08-14", "2026-08-15"]);
  });

  it("yields no nights when every stored entry is a non-day, so the item is a no-op", async () => {
    expect(await readNights(["2026-02-30", "2026-13-01", "2026-04-31"])).toEqual([]);
  });

  it("keeps a leap day and still drops loose shapes and non-strings", async () => {
    expect(
      await readNights(["2028-02-29", "2026-8-14", "20260814", 20260814, null]),
    ).toEqual(["2028-02-29"]);
  });
});
