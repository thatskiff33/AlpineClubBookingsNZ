// @vitest-environment jsdom

// #4594 — a guest taken off the booking (pending save) used to be shown at 40%
// opacity with a strike-through, the faintest text in the app and likely under
// 3:1. The row now keeps its text at full strength, keeps the strike-through,
// and says "Removed" in words, in a tag the strike does not run through.

import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ExistingGuestRow } from "@/components/edit-booking/existing-guest-row";
import type { Guest } from "@/components/edit-booking/types";
import { cleanup, render, screen } from "@/lib/__tests__/support/club-time-render";

const guest: Guest = {
  id: "guest-1",
  firstName: "Robin",
  lastName: "Example",
  ageTier: "ADULT",
  isMember: true,
  priceCents: 4500,
};

function renderRow(isRemoved: boolean) {
  return render(
    <ExistingGuestRow
      guest={guest}
      isRemoved={isRemoved}
      linkedMember={undefined}
      memberLinkEnabled={false}
      nonMemberGuestNamesEditable={false}
      canEditNonMemberGuestNames={false}
      canFixNonMemberGuestNameTypos={false}
      overrideEnabled={false}
      isInProgressEdit={false}
      perGuestDatesEnabled={false}
      canRemove
      nameEdit={{ firstName: "Robin", lastName: "Example" }}
      range={{ stayStart: "2026-07-10", stayEnd: "2026-07-12" }}
      checkIn="2026-07-10"
      checkOut="2026-07-12"
      bookingCheckIn="2026-07-10"
      bookingCheckOut="2026-07-12"
      ageTierOptions={[]}
      onUpdateName={vi.fn()}
      onUpdateRange={vi.fn()}
      onRemove={vi.fn()}
      onUndoRemove={vi.fn()}
      onStartLink={vi.fn()}
      onUnlink={vi.fn()}
    />,
  );
}

afterEach(cleanup);

describe("ExistingGuestRow, a removed guest (#4594)", () => {
  it("says Removed in words and keeps the strike-through, without fading", () => {
    const { container } = renderRow(true);
    const row = container.firstElementChild as HTMLElement;

    const tag = screen.getByText("Removed");
    expect(tag).toBeVisible();
    // An inline-block box is not struck by its ancestor's line-through.
    expect(tag).toHaveClass("inline-block");
    expect(row).toHaveClass("line-through");
    expect(row.className).not.toMatch(/(?<![:\w-])opacity-/);
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
  });

  it("shows no tag and no strike on a guest who is staying", () => {
    const { container } = renderRow(false);
    const row = container.firstElementChild as HTMLElement;

    expect(screen.queryByText("Removed")).toBeNull();
    expect(row).not.toHaveClass("line-through");
    expect(screen.getByRole("button", { name: "Remove" })).toBeEnabled();
  });
});
