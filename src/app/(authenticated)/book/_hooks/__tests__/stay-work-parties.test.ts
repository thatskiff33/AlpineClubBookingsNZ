import { describe, expect, it, vi } from "vitest";
import type { WorkPartyEvent } from "@/components/book/booking-wizard-types";
import type { PromoResult } from "@/components/promo-code-input";
import { reconcileWorkPartySelection } from "../stay-work-parties";

/**
 * #5148: the selection rule the review step applies to a fresh list of the
 * stay's work parties, moved out of the wizard unchanged.
 */
const spring = { id: "wp-1", name: "Spring" } as WorkPartyEvent;
const autumn = { id: "wp-2", name: "Autumn" } as WorkPartyEvent;

function apply(combineWithCodes = false) {
  return {
    select: vi.fn(),
    setAttending: vi.fn(),
    noticeCleared: vi.fn(),
    setAppliedPromos: vi.fn(),
    combineWithCodesRef: { current: combineWithCodes },
  };
}

/** Run the updater the rule handed `setAppliedPromos` against a list. */
function promosAfter(a: ReturnType<typeof apply>, current: PromoResult[]) {
  const updater = a.setAppliedPromos.mock.calls[0]?.[0] as (
    list: PromoResult[],
  ) => PromoResult[];
  return updater(current);
}

describe("reconcileWorkPartySelection", () => {
  it("ticks the work party a Join came from when nothing is selected", () => {
    const a = apply();
    reconcileWorkPartySelection(
      [spring],
      { selectedId: null, previousEvents: [], joinedId: "wp-1" },
      a,
    );
    expect(a.select).toHaveBeenCalledWith("wp-1");
    expect(a.setAttending).toHaveBeenCalledWith(true);
    expect(a.setAppliedPromos).not.toHaveBeenCalled();
  });

  it("leaves the member's own choice alone on a Join visit", () => {
    const a = apply();
    reconcileWorkPartySelection(
      [spring, autumn],
      { selectedId: "wp-2", previousEvents: [spring, autumn], joinedId: "wp-1" },
      a,
    );
    expect(a.select).not.toHaveBeenCalled();
  });

  it("keeps a selection still in the list", () => {
    const a = apply();
    reconcileWorkPartySelection(
      [spring],
      { selectedId: "wp-1", previousEvents: [spring], joinedId: null },
      a,
    );
    expect(a.select).not.toHaveBeenCalled();
    expect(a.setAppliedPromos).not.toHaveBeenCalled();
  });

  it("clears a selection that left the list, names it, and drops its discount when alone", () => {
    const a = apply(false);
    reconcileWorkPartySelection(
      [autumn],
      { selectedId: "wp-1", previousEvents: [spring, autumn], joinedId: null },
      a,
    );
    expect(a.select).toHaveBeenCalledWith(null);
    expect(a.setAttending).toHaveBeenCalledWith(false);
    expect(a.noticeCleared).toHaveBeenCalledWith("Spring");
    const workBee = { workPartyEvent: { id: "wp-1" } } as unknown as PromoResult;
    expect(promosAfter(a, [workBee])).toEqual([]);
  });

  it("keeps the codes when the working bee was combined with them", () => {
    const a = apply(true);
    reconcileWorkPartySelection(
      [],
      { selectedId: "wp-1", previousEvents: [spring], joinedId: null },
      a,
    );
    const list = [
      { workPartyEvent: { id: "wp-1" } },
      { code: "SAVE10" },
    ] as unknown as PromoResult[];
    expect(promosAfter(a, list)).toBe(list);
  });
});
