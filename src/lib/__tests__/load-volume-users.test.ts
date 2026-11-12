import { describe, expect, it } from "vitest";
import { DEMO_SEED_DOMAIN } from "@/lib/demo-seed-guard";
import { planLoadVolume } from "../../../prisma/load-volume-plan";
import {
  volumeMemberLocal,
  volumeUserPool,
} from "../../../load/lib/volume-users.js";

describe("load volume users (#4940)", () => {
  it("requires the caller to provide the seeder's domain", () => {
    expect(() => volumeUserPool(2)).toThrow(/LOAD_VOLUME_DOMAIN/);
    expect(volumeUserPool(0)).toEqual([]);
  });

  it("names the members the volume plan writes", () => {
    const plan = planLoadVolume({
      seed: 1,
      memberCount: 3,
      seasonsBack: 1,
      today: "2026-07-01",
      lodges: [],
      targetOccupancy: 0.5,
      maxNights: 2,
      maxPartySize: 2,
      cancelRate: 0,
      internetBankingRate: 0,
    } as Parameters<typeof planLoadVolume>[0]);
    expect(plan.members.map((member) => member.local)).toEqual(
      volumeUserPool(3, DEMO_SEED_DOMAIN).map((email) => email.split("@")[0]),
    );
    expect(volumeUserPool(2, "example.test")).toEqual([
      "load-00001@example.test",
      "load-00002@example.test",
    ]);
  });

  it("refuses an index outside the five-digit range", () => {
    expect(volumeMemberLocal(0)).toBe("load-00001");
    expect(() => volumeMemberLocal(-1)).toThrow();
    expect(() => volumeMemberLocal(99999)).toThrow();
    expect(() => volumeMemberLocal(1.5)).toThrow();
  });
});
