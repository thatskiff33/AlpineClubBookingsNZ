import { describe, expect, it, vi } from "vitest";

import {
  canonicalPartnerPair,
  compareMemberIds,
} from "@/lib/member-partner-link-shared";
import { acquireMemberPartnerLinkLocks } from "@/lib/member-partner-lock";

describe("canonical member-partner ordering", () => {
  it("uses one comparator for canonical pairs and deterministic lock ordering", async () => {
    expect(["member-z", "member-a", "member-m"].sort(compareMemberIds)).toEqual([
      "member-a",
      "member-m",
      "member-z",
    ]);
    expect(canonicalPartnerPair("member-z", "member-a")).toEqual({
      memberAId: "member-a",
      memberBId: "member-z",
    });

    const executeRaw = vi.fn().mockResolvedValue(0);
    await acquireMemberPartnerLinkLocks(
      { $executeRaw: executeRaw } as never,
      ["member-z", "", "member-a", "member-z", "member-m"],
    );

    expect(executeRaw).toHaveBeenCalledTimes(3);
    expect(executeRaw.mock.calls.map((call) => call[1])).toEqual([
      "member-partner-link:member-a",
      "member-partner-link:member-m",
      "member-partner-link:member-z",
    ]);
  });
});
