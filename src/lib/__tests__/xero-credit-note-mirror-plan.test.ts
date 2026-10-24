import { describe, expect, it } from "vitest";
import { planOutsideSpendMirror, type OutsideSpendMirrorInput } from "@/lib/xero-credit-note-mirror-plan";

const base: OutsideSpendMirrorInput = { lotCents: 5_250, sliceCents: 0, writtenDownCents: 0, outsideSpendCents: 0, balanceCents: 5_250 };
const plan = (over: Partial<OutsideSpendMirrorInput>) => planOutsideSpendMirror({ ...base, ...over });

describe("planOutsideSpendMirror (#4270)", () => {
  it.each([
    ["nothing spent, nothing written down", {}, { kind: "none", leftForAllocationCents: 0 }],
    ["fully spent, fully free", { outsideSpendCents: 5_250 }, { kind: "write-down", cents: 5_250, leftForAllocationCents: 0 }],
    ["partly spent", { outsideSpendCents: 2_000 }, { kind: "write-down", cents: 2_000, leftForAllocationCents: 0 }],
    ["more spent since a write-down: only the difference", { outsideSpendCents: 3_000, writtenDownCents: 2_000 }, { kind: "write-down", cents: 1_000, leftForAllocationCents: 0 }],
    ["already written down to the spend", { outsideSpendCents: 3_000, writtenDownCents: 3_000 }, { kind: "none", leftForAllocationCents: 0 }],
    ["spend larger than the lot is bounded by the lot", { outsideSpendCents: 9_000 }, { kind: "write-down", cents: 5_250, leftForAllocationCents: 0 }],
    ["spend larger than the lot, already fully written down", { outsideSpendCents: 9_000, writtenDownCents: 5_250, balanceCents: 0 }, { kind: "none", leftForAllocationCents: 0 }],
    ["a booking has drawn some: only the free part, the rest is left", { outsideSpendCents: 5_250, sliceCents: 2_000, balanceCents: 3_250 }, { kind: "write-down", cents: 3_250, leftForAllocationCents: 2_000 }],
    ["wholly drawn by a booking: nothing free, all left", { outsideSpendCents: 5_250, sliceCents: 5_250, balanceCents: 0 }, { kind: "none", leftForAllocationCents: 5_250 }],
    ["free part already written down, the drawn part is left", { outsideSpendCents: 5_250, sliceCents: 2_000, writtenDownCents: 3_250, balanceCents: 0 }, { kind: "none", leftForAllocationCents: 2_000 }],
    ["balance caps the write-down so it never goes below zero", { outsideSpendCents: 5_250, balanceCents: 1_000 }, { kind: "write-down", cents: 1_000, leftForAllocationCents: 4_250 }],
    ["a negative balance writes nothing", { outsideSpendCents: 5_250, balanceCents: -300 }, { kind: "none", leftForAllocationCents: 5_250 }],
    ["slices and write-down exceeding the lot (inconsistent): nothing free", { outsideSpendCents: 5_250, sliceCents: 4_000, writtenDownCents: 2_000, balanceCents: 5_250 }, { kind: "none", leftForAllocationCents: 3_250 }],
    ["spend undone: the whole write-down is restored", { outsideSpendCents: 0, writtenDownCents: 5_250, balanceCents: 0 }, { kind: "restore", cents: 5_250, leftForAllocationCents: 0 }],
    ["spend reduced: only the difference is restored", { outsideSpendCents: 2_000, writtenDownCents: 5_250, balanceCents: 0 }, { kind: "restore", cents: 3_250, leftForAllocationCents: 0 }],
    ["a restore is never more than was written down", { outsideSpendCents: 0, writtenDownCents: 1_000 }, { kind: "restore", cents: 1_000, leftForAllocationCents: 0 }],
  ] as const)("%s", (_name, over, expected) => {
    expect(plan(over)).toEqual(expected);
  });

  it("rejects amounts that are not whole non-negative cents", () => {
    expect(() => plan({ lotCents: 10.5 })).toThrow(/lotCents/);
    expect(() => plan({ sliceCents: -1 })).toThrow(/sliceCents/);
    expect(() => plan({ writtenDownCents: -1 })).toThrow(/writtenDownCents/);
    expect(() => plan({ outsideSpendCents: Number.NaN })).toThrow(/outsideSpendCents/);
    expect(() => plan({ balanceCents: 1.5 })).toThrow(/balanceCents/);
  });
});
