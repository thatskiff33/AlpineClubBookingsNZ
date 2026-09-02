// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { HostingCoverageLinkedMovePrompt } from "@/components/hosting-coverage-linked-move-prompt";
import type { HostingCoverageLinkedMovePromptData } from "@/lib/hosting-coverage-linked-move-client";

/**
 * #3232's offer, as the member sees it.
 *
 * THE ONE THING THIS COMPONENT MUST NOT DO IS ANSWER FOR THEM. Both arms move
 * money — one charges for a second booking they may not want moved, the other
 * leaves a booking without adult supervision — so a preselected radio is a money
 * decision taken on a click the member never made. Nothing else on this prompt is
 * as load-bearing, which is why it is the first assertion here and why the panel
 * carries its own enforcement of the same rule.
 */
function source(path: string) {
  return readFileSync(path, "utf8").replaceAll("\\", "/");
}

function promptData(
  overrides: Partial<HostingCoverageLinkedMovePromptData> = {},
): HostingCoverageLinkedMovePromptData {
  return {
    message:
      "booking BK-DEPEN at Alpine Lodge (2026-08-10 to 2026-08-12) is relying " +
      "on this booking for adult supervision.",
    acceptStateKey: `v1:${"a".repeat(64)}`,
    declineStateKey: `v1:${"b".repeat(64)}`,
    linkedMoveAvailable: true,
    linkedBookings: [
      {
        bookingId: "bk-dependent-01",
        reference: "BK-DEPEN",
        lodgeName: "Alpine Lodge",
        uncoveredNights: ["2026-08-10", "2026-08-11"],
        currentCheckIn: "2026-08-10",
        currentCheckOut: "2026-08-12",
        proposedCheckIn: "2026-08-20",
        proposedCheckOut: "2026-08-22",
        priceDiffCents: -1_200,
        changeFeeCents: 1_000,
      },
    ],
    combinedAmountDueCents: 3_500,
    combinedRefundCents: 0,
    combinedChangeFeeCents: 2_000,
    settlementMethodRequired: false,
    bothChangeFeesCharged: true,
    ...overrides,
  };
}

const BASE = {
  choice: null,
  idPrefix: "test-linked-move",
  onChoiceChange: () => undefined,
};

describe("the linked-move offer's UI contract (#3232, INV-HOST-050)", () => {
  it("preselects NOTHING, so no money decision is taken for the member", () => {
    render(
      createElement(HostingCoverageLinkedMovePrompt, {
        ...BASE,
        prompt: promptData(),
      }),
    );

    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(2);
    for (const radio of radios) {
      expect(radio).not.toBeChecked();
    }
    // And it says so, rather than leaving the member to notice.
    expect(
      screen.getByText("Choose one. Nothing is saved until you do."),
    ).toBeVisible();
  });

  it("puts each figure beside the choice that costs it", () => {
    render(
      createElement(HostingCoverageLinkedMovePrompt, {
        ...BASE,
        prompt: promptData(),
      }),
    );

    const moveBoth = screen.getByRole("radio", { name: /Move both bookings/ });
    expect(moveBoth).toHaveAccessibleName(/\$35\.00 payable across both/);
    expect(moveBoth).toHaveAccessibleName(
      /Includes the change fee on both bookings \(\$20\.00 in all\)/,
    );
    // The other arm carries its consequence in the same place.
    expect(
      screen.getByRole("radio", { name: /Move only this booking/ }),
    ).toHaveAccessibleName(/left without adult supervision on those nights/);
  });

  it("says the club has waived the second fee, when it has", () => {
    render(
      createElement(HostingCoverageLinkedMovePrompt, {
        ...BASE,
        prompt: promptData({
          bothChangeFeesCharged: false,
          combinedChangeFeeCents: 1_000,
        }),
      }),
    );

    expect(
      screen.getByRole("radio", { name: /Move both bookings/ }),
    ).toHaveAccessibleName(
      /change fee on the second booking has been waived by the club/,
    );
  });

  it("tells the member their one card-or-credit choice covers both bookings", () => {
    render(
      createElement(HostingCoverageLinkedMovePrompt, {
        ...BASE,
        prompt: promptData({
          combinedAmountDueCents: 0,
          combinedRefundCents: 4_250,
          settlementMethodRequired: true,
        }),
      }),
    );

    const moveBoth = screen.getByRole("radio", { name: /Move both bookings/ });
    expect(moveBoth).toHaveAccessibleName(
      /\$42\.50 comes back to you across both bookings/,
    );
    expect(moveBoth).toHaveAccessibleName(
      /card-or-credit choice above covers both bookings/,
    );
  });

  it("disables Move-both with a reason where there are not beds for both", () => {
    // The owner's "cannot" arm. A disabled option with a reason is a clearer
    // statement than a button that fails when pressed — and the warn-and-continue
    // path stays open beside it, which is the whole point of the arm.
    render(
      createElement(HostingCoverageLinkedMovePrompt, {
        ...BASE,
        prompt: promptData({ linkedMoveAvailable: false }),
      }),
    );

    const moveBoth = screen.getByRole("radio", { name: /Move both bookings/ });
    expect(moveBoth).toBeDisabled();
    expect(moveBoth).toHaveAccessibleName(
      /Not available: there are not enough beds free on the new nights/,
    );
    expect(
      screen.getByRole("radio", { name: /Move only this booking/ }),
    ).not.toBeDisabled();
    // No proposed dates are shown for a move that cannot happen.
    expect(screen.queryByText(/would move to/)).toBeNull();
  });

  it("disables both arms while the save is in flight, and neither becomes checked", () => {
    render(
      createElement(HostingCoverageLinkedMovePrompt, {
        ...BASE,
        prompt: promptData(),
        disabled: true,
      }),
    );

    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).toBeDisabled();
      expect(radio).not.toBeChecked();
    }
  });

  it("keeps the assertive region permanently mounted, and the radios outside it", () => {
    // Same reason its override sibling gives: inserting an already-populated
    // role=alert is missed by some screen-reader and browser pairs. And choosing
    // an option must not re-announce the whole offer.
    const { rerender } = render(
      createElement(HostingCoverageLinkedMovePrompt, {
        ...BASE,
        prompt: null,
      }),
    );
    const alert = screen.getByRole("alert");
    expect(alert).toBeEmptyDOMElement();
    expect(screen.queryAllByRole("radio")).toEqual([]);

    rerender(
      createElement(HostingCoverageLinkedMovePrompt, {
        ...BASE,
        prompt: promptData(),
      }),
    );

    expect(screen.getByRole("alert")).toBe(alert);
    expect(
      within(alert).getByText(
        /Another of your bookings needs an adult on these nights/,
      ),
    ).toBeVisible();
    expect(within(alert).queryAllByRole("radio")).toEqual([]);
  });

  it("names which booking, which lodge and which nights — and no person", () => {
    render(
      createElement(HostingCoverageLinkedMovePrompt, {
        ...BASE,
        prompt: promptData(),
      }),
    );

    // Scoped to the list row, because the offer's own sentence names the lodge
    // too and an unscoped query would match both.
    const row = screen.getByRole("listitem");
    expect(within(row).getByText("BK-DEPEN")).toBeVisible();
    expect(within(row).getByText(/at Alpine Lodge/)).toBeVisible();
    expect(within(row).getByText(/Now 2026-08-10 to 2026-08-12/)).toBeVisible();
    expect(
      within(row).getByText(/would move to 2026-08-20 to 2026-08-22/),
    ).toBeVisible();
    expect(
      within(row).getByText(
        /Nights without an adult if it stays: 2026-08-10, 2026-08-11/,
      ),
    ).toBeVisible();
  });

  it("reports the arm the member picked, and only when they pick one", () => {
    const onChoiceChange = vi.fn();
    render(
      createElement(HostingCoverageLinkedMovePrompt, {
        ...BASE,
        prompt: promptData(),
        onChoiceChange,
      }),
    );

    expect(onChoiceChange).not.toHaveBeenCalled();
    screen.getByRole("radio", { name: /Move only this booking/ }).click();
    expect(onChoiceChange).toHaveBeenCalledWith("LEAVE_UNCOVERED");
  });

  it("keeps the shared browser contract free of server-only dependencies", () => {
    const client = source("src/lib/hosting-coverage-linked-move-client.ts");
    expect(client).not.toMatch(
      /(?:from\s+|import\s*)["'](?:@prisma\/client|node:crypto|server-only)["']/,
    );
  });
});
