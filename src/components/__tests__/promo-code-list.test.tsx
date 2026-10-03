// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import type { PromoResult } from "@/components/promo-code-input";
import { PromoCodeList } from "@/components/promo-code-list";
import type { PromoCodeListEntry, PromoListValidation } from "@/components/promo-code-list-client";

/**
 * The several-code list (#3492): opt-in chips grouped by guest, the booker's
 * order with a keyboard-reachable, announced reorder, and the one-code limit
 * while the club's `multiPromoCodes` switch is off.
 */
function result(code: string, promoAdjustmentCents: number, appliesTo?: string): PromoResult {
  return {
    code,
    description: null,
    type: "FREE_NIGHTS",
    discountCents: -promoAdjustmentCents,
    promoAdjustmentCents,
    totalPriceCents: 30000,
    finalPriceCents: 0,
    ...(appliesTo ? { appliesTo } : {}),
  };
}

/** A validator that accepts any list, each code worth -$10 times its position. */
const acceptAll = vi.fn(
  async (entries: PromoCodeListEntry[], appliesTo: ReadonlyMap<string, string>): Promise<PromoListValidation> => ({
    ok: true,
    applied: entries.map((entry, index) => result(entry.code, -1000 * (index + 1), appliesTo.get(entry.code))),
  }),
);

function Harness({
  initial = [],
  multiPromoCodes = true,
  validate = acceptAll,
}: {
  initial?: PromoResult[];
  multiPromoCodes?: boolean;
  validate?: (entries: PromoCodeListEntry[], appliesTo: ReadonlyMap<string, string>) => Promise<PromoListValidation>;
}) {
  const [applied, setApplied] = useState(initial);
  return (
    <PromoCodeList
      applied={applied}
      onChange={setApplied}
      validate={validate}
      multiPromoCodes={multiPromoCodes}
      ownCodes={[{ code: "MINE", detail: "10% off" }]}
      guestGroups={[{ guestName: "Sam Guest", codes: [{ code: "SAMFREE", detail: "3 free nights per booking" }] }]}
      guestLabel={(index) => `Guest ${index + 1}`}
    />
  );
}

describe("PromoCodeList", () => {
  beforeEach(() => {
    acceptAll.mockClear();
  });

  it("groups a guest's chip under their name and says it covers that guest only", async () => {
    render(<Harness />);
    const group = screen.getByRole("group", { name: "Sam Guest's promo codes" });
    const chip = screen.getByRole("button", {
      name: "Apply SAMFREE — 3 free nights per booking, applies to Sam Guest only",
    });
    expect(group).toContainElement(chip);
    fireEvent.click(chip);
    await waitFor(() => expect(screen.getByText("(applies to Sam Guest only)")).toBeInTheDocument());
    expect(screen.getByRole("status")).toHaveTextContent("SAMFREE applied.");
  });

  it("applies several codes in the booker's order, and the order buttons move them and announce it", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Apply MINE — 10% off" }));
    await screen.findByRole("button", { name: "Remove MINE" });
    fireEvent.click(screen.getByRole("button", { name: /Apply SAMFREE/ }));
    await screen.findByRole("button", { name: "Remove SAMFREE" });

    const list = screen.getByRole("list", { name: /in the order they apply/ });
    expect(list.textContent).toMatch(/MINE.*SAMFREE/);
    expect(screen.getByRole("button", { name: "Move MINE earlier" })).toBeDisabled();

    const later = screen.getByRole("button", { name: "Move MINE later" });
    later.focus();
    await act(async () => {
      fireEvent.click(later);
    });
    await waitFor(() => expect(list.textContent).toMatch(/SAMFREE.*MINE/));
    expect(screen.getByRole("status")).toHaveTextContent("MINE moved to position 2 of 2.");
    // The moved code's buttons keep the keyboard user's place: "later" is now
    // disabled at the end, so focus lands on its "earlier" twin.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move MINE earlier" })),
    );
    // The reordered list went to the validator in the new order.
    expect(acceptAll.mock.calls.at(-1)![0].map((entry) => entry.code)).toEqual(["SAMFREE", "MINE"]);
  });

  it("keeps the order and reads out the refusal when the server refuses a move", async () => {
    const refuseMoves = vi.fn(async (entries: PromoCodeListEntry[]): Promise<PromoListValidation> =>
      entries[0]!.code === "B"
        ? { ok: false, error: "A: already covered by an earlier code" }
        : { ok: true, applied: entries.map((entry) => result(entry.code, -1000)) },
    );
    render(<Harness initial={[result("A", -1000), result("B", -1000)]} validate={refuseMoves} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Move B earlier" }));
    });
    expect(screen.getByRole("list", { name: /in the order they apply/ }).textContent).toMatch(/A.*B/);
    expect(screen.getByRole("status")).toHaveTextContent("B was not moved. A: already covered by an earlier code");
  });

  it("holds one code while the multiPromoCodes switch is off: no second chip, no entry, no reorder", async () => {
    render(<Harness multiPromoCodes={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Apply MINE — 10% off" }));
    await screen.findByRole("button", { name: "Remove MINE" });
    expect(screen.queryByRole("button", { name: /Apply SAMFREE/ })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/promo code/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Move MINE/ })).not.toBeInTheDocument();
  });

  it("applies nothing until the booker chooses", () => {
    render(<Harness />);
    expect(screen.queryByRole("list", { name: /in the order they apply/ })).not.toBeInTheDocument();
    expect(acceptAll).not.toHaveBeenCalled();
  });
});
