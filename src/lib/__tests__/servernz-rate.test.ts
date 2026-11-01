import { describe, expect, it } from "vitest";
import { OTHER_LODGE_BOUNDS, OTHER_LODGE_RATE_FIELDS } from "@/lib/other-lodges";
import {
  centsToServerRate,
  ratesFromServer,
  ratesToServer,
  SERVER_RATE_WIRE_NAMES,
  serverRateToCents,
  withRatesFromServer,
  type ServerRateWireName,
} from "@/lib/servernz-rate";

// The one boundary between this site's integer-cent rates and the central
// server's dollars (#61, INV-MONEY-001/003). Pinned in both directions, at the
// edges of the range, and for the values a binary double cannot hold exactly.

describe("serverRateToCents", () => {
  it.each([
    [0, 0],
    [0.1, 10],
    [0.29, 29],
    [1.005e1, 1005],
    [45, 4500],
    [45.5, 4550],
    [45.55, 4555],
    [99999.99, 9999999],
  ])("%s dollars is %i cents", (dollars, cents) => {
    expect(serverRateToCents(dollars)).toBe(cents);
  });

  it.each([
    ["three decimal places", 45.555],
    ["a negative rate", -1],
    ["more than the column holds", 100000],
    ["a cent too many", 99999.991],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a tiny fraction", 1e-7],
    ["a decimal string", "45.50"],
    ["null", null],
    ["undefined", undefined],
  ])("refuses %s (null, never zero)", (_label, value) => {
    expect(serverRateToCents(value)).toBeNull();
  });
});

describe("centsToServerRate", () => {
  it("prints the shortest exact dollars", () => {
    expect(JSON.stringify(centsToServerRate(4550))).toBe("45.5");
    expect(JSON.stringify(centsToServerRate(29))).toBe("0.29");
    expect(JSON.stringify(centsToServerRate(0))).toBe("0");
    expect(JSON.stringify(centsToServerRate(9999999))).toBe("99999.99");
  });

  it("round-trips exactly through the wire and back", () => {
    // Every cent below $10, then a stride across the rest of the range, then
    // the top of it: cents -> dollars -> JSON -> dollars -> cents is identity.
    const samples = [
      ...Array.from({ length: 1000 }, (_, i) => i),
      ...Array.from({ length: 1000 }, (_, i) => i * 9973),
      OTHER_LODGE_BOUNDS.rateCentsMax - 1,
      OTHER_LODGE_BOUNDS.rateCentsMax,
    ];
    for (const cents of samples) {
      const wire = JSON.parse(JSON.stringify(centsToServerRate(cents)));
      expect(serverRateToCents(wire), String(cents)).toBe(cents);
    }
  });
});

describe("the rate keys on the wire", () => {
  it("names every rate column by the server's key without the Cents suffix", () => {
    for (const field of OTHER_LODGE_RATE_FIELDS) {
      expect(`${SERVER_RATE_WIRE_NAMES[field]}Cents`).toBe(field);
    }
  });

  it("leaves a rate the server did not send absent, and maps null to null", () => {
    expect(ratesFromServer({ winterRateAdult: 45.5, summerRateAdult: null })).toEqual({
      winterRateAdultCents: 4550,
      summerRateAdultCents: null,
    });
    expect(ratesFromServer({})).toEqual({});
  });

  it("sends every rate under the server's key, in dollars", () => {
    const record = Object.fromEntries(
      OTHER_LODGE_RATE_FIELDS.map((f) => [f, null]),
    ) as Parameters<typeof ratesToServer>[0];
    const wire = ratesToServer({ ...record, winterRate5To11Cents: 2000 });
    expect(Object.keys(wire).sort()).toEqual(
      Object.values(SERVER_RATE_WIRE_NAMES).sort(),
    );
    expect(wire.winterRate5To11).toBe(20);
    expect(wire.summerRateAdult).toBeNull();
  });
});

describe("withRatesFromServer (the pull's conversion, driven by the one list)", () => {
  it("moves every rate the server sent to its cents column and leaves no dollar key behind", () => {
    const wire = Object.fromEntries(
      Object.values(SERVER_RATE_WIRE_NAMES).map((key, i) => [key, i + 0.5]),
    ) as Record<ServerRateWireName, number>;
    // A pulled row: other fields beside the rates, as the schema hands it on.
    const row = { name: "Aorangi Ski Club", ...wire };
    const out = withRatesFromServer(row);
    expect(out).toHaveProperty("name", "Aorangi Ski Club");
    OTHER_LODGE_RATE_FIELDS.forEach((field, i) => {
      expect(out).toHaveProperty(field, i * 100 + 50);
      expect(out).not.toHaveProperty(SERVER_RATE_WIRE_NAMES[field]);
    });
  });

  it("adds no rate the server did not send", () => {
    const row = { name: "Aorangi Ski Club", winterRateAdult: null };
    const out = withRatesFromServer(row);
    expect(out).toEqual({ name: "Aorangi Ski Club", winterRateAdultCents: null });
  });
});
