import { describe, expect, it } from "vitest";
import { pluralHutLeaderLabel } from "@/config/hut-leader-label";

/*
  #3976 — a club that saved its hut-leader label as "Hut Leaders" read
  "Hut Leaderss" in the admin sidebar, because every plural was the label plus
  "s". The helper is the one place the plural is built.
*/
describe("pluralHutLeaderLabel (#3976)", () => {
  it("adds an s to a singular label", () => {
    expect(pluralHutLeaderLabel("Hut Leader")).toBe("Hut Leaders");
    expect(pluralHutLeaderLabel("Custodian")).toBe("Custodians");
    expect(pluralHutLeaderLabel("Warden")).toBe("Wardens");
  });

  it("leaves a label that already ends in s as typed", () => {
    expect(pluralHutLeaderLabel("Hut Leaders")).toBe("Hut Leaders");
  });

  it("treats a trailing capital S the same way", () => {
    expect(pluralHutLeaderLabel("HUT LEADERS")).toBe("HUT LEADERS");
    expect(pluralHutLeaderLabel("HUT LEADER")).toBe("HUT LEADERs");
  });

  it("ignores surrounding whitespace when deciding and does not keep it", () => {
    expect(pluralHutLeaderLabel("Hut Leaders  ")).toBe("Hut Leaders");
    expect(pluralHutLeaderLabel(" Hut Leader ")).toBe("Hut Leaders");
  });
});
