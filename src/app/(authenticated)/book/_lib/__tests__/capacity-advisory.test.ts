import { describe, expect, it } from "vitest";
import {
  formatCapacityShortMessage,
  getCapacityShortNights,
} from "@/app/(authenticated)/book/_lib/capacity-advisory";

/**
 * #2930 — the wizard's per-night capacity advisory.
 *
 * It replaced a client-side HARD STOP, and that is the property most worth
 * pinning: this calculation must never be able to refuse anything. Everything
 * below is about what the member is TOLD, and the same three rules keep
 * recurring — absent data says nothing, a departure morning is not occupied, and
 * a held night is described exactly like a full one.
 */

const DATES = { checkIn: "2026-08-01", checkOut: "2026-08-04" };
const ONE_GUEST = [{}];

describe("getCapacityShortNights", () => {
  it("names only the nights the party outgrows", () => {
    expect(
      getCapacityShortNights(
        [
          { date: "2026-08-01", availableBeds: 4 },
          { date: "2026-08-02", availableBeds: 1 },
          { date: "2026-08-03", availableBeds: 0 },
        ],
        [{}, {}],
        DATES,
      ),
    ).toEqual(["2026-08-02", "2026-08-03"]);
  });

  it("says NOTHING when there are no per-night figures", () => {
    // The check failed or has not answered. An advisory built on absent data
    // would either invent a shortfall or hide a real one — the same
    // "absent is not zero" rule the calendar applies to an unloaded month.
    expect(getCapacityShortNights([], ONE_GUEST, DATES)).toEqual([]);
  });

  it("says nothing before dates are chosen", () => {
    expect(
      getCapacityShortNights([{ date: "2026-08-01", availableBeds: 0 }], ONE_GUEST, null),
    ).toEqual([]);
  });

  it("does not count a guest on their departure morning", () => {
    // Half-open occupancy (`INV-DATE-003`): a guest leaving on the 3rd occupies
    // the 1st and 2nd only, so a full 3rd is no obstacle to them.
    expect(
      getCapacityShortNights(
        [
          { date: "2026-08-01", availableBeds: 1 },
          { date: "2026-08-02", availableBeds: 1 },
          { date: "2026-08-03", availableBeds: 0 },
        ],
        [{ stayStart: "2026-08-01", stayEnd: "2026-08-03" }],
        DATES,
      ),
    ).toEqual([]);
  });

  it("counts per-guest ranges independently rather than the whole party on every night", () => {
    // Two guests, only one of whom is there on the tight night.
    expect(
      getCapacityShortNights(
        [
          { date: "2026-08-01", availableBeds: 1 },
          { date: "2026-08-02", availableBeds: 1 },
          { date: "2026-08-03", availableBeds: 1 },
        ],
        [
          { stayStart: "2026-08-01", stayEnd: "2026-08-04" },
          { stayStart: "2026-08-02", stayEnd: "2026-08-04" },
        ],
        DATES,
      ),
    ).toEqual(["2026-08-02", "2026-08-03"]);
  });

  it("cannot tell a held night from a full one, because the payload does not", () => {
    // `/api/availability/check` pins a whole-lodge-held night to zero available
    // beds and projects no hold flag (`INV-CAP-021`, ADR-001 decision 6). The
    // two inputs below are therefore byte-identical, which is the point: there
    // is no branch here that could be made to diverge later.
    const heldNight = { date: "2026-08-02", availableBeds: 0 };
    const genuinelyFullNight = { date: "2026-08-02", availableBeds: 0 };
    expect(getCapacityShortNights([heldNight], ONE_GUEST, DATES)).toEqual(
      getCapacityShortNights([genuinelyFullNight], ONE_GUEST, DATES),
    );
  });
});

describe("formatCapacityShortMessage", () => {
  it("names the single night, and says the waitlist is still open", () => {
    expect(formatCapacityShortMessage("The Lodge", ["2026-08-02"])).toBe(
      "The Lodge is full on 2026-08-02. You can still continue and join the waitlist.",
    );
  });

  it("counts the nights when there is more than one", () => {
    expect(
      formatCapacityShortMessage("The Lodge", ["2026-08-02", "2026-08-03"]),
    ).toBe(
      "The Lodge is full on 2 of your nights. You can still continue and join the waitlist.",
    );
  });

  it("always offers the next step rather than delivering a verdict", () => {
    // The wording this replaced ("does not have enough beds on …") was attached
    // to a refusal and read as one. It is attached to a Continue button now.
    for (const nights of [["2026-08-02"], ["2026-08-02", "2026-08-03"]]) {
      expect(formatCapacityShortMessage("The Lodge", nights)).toContain(
        "join the waitlist",
      );
    }
  });
});
