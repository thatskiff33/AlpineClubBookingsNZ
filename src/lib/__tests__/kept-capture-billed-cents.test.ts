import { describe, expect, it } from "vitest";
import { keptCaptureBilledCentsFromReading } from "@/lib/late-capture-kept-xero-rules";

const reading = {
  firstCut: "by-change-evidence" as const,
  hasLiveKeptReceipt: false,
  hasReceiptOperation: false,
  changeRoute: null,
  elsewhere: 0 as number | "all",
  amountCents: 10_000,
};

describe("kept capture billed cents (#4516 M4d)", () => {
  it("bills nothing when the keep will raise its own invoice", () => {
    expect(keptCaptureBilledCentsFromReading({ ...reading, firstCut: "kept-invoice", elsewhere: 4_000 })).toBe(0);
  });

  it("bills the whole capture when a receipt or a change invoice already answers it", () => {
    expect(keptCaptureBilledCentsFromReading({ ...reading, hasLiveKeptReceipt: true })).toBe(10_000);
    expect(keptCaptureBilledCentsFromReading({ ...reading, hasReceiptOperation: true })).toBe(10_000);
    expect(keptCaptureBilledCentsFromReading({ ...reading, changeRoute: "receipt", elsewhere: 1 })).toBe(10_000);
    expect(keptCaptureBilledCentsFromReading({ ...reading, changeRoute: "change-invoice" })).toBe(10_000);
  });

  it("bills only the recorded remainder of a kept invoice, and the whole of an unreadable change unless it is fully recorded", () => {
    expect(keptCaptureBilledCentsFromReading({ ...reading, changeRoute: "kept-invoice", elsewhere: 4_000 })).toBe(4_000);
    expect(keptCaptureBilledCentsFromReading({ ...reading, changeRoute: "kept-invoice", elsewhere: "all" })).toBe(10_000);
    expect(keptCaptureBilledCentsFromReading({ ...reading, changeRoute: "change-unknown", elsewhere: 4_000 })).toBe(0);
    expect(keptCaptureBilledCentsFromReading({ ...reading, changeRoute: "change-unknown", elsewhere: "all" })).toBe(10_000);
  });
});
