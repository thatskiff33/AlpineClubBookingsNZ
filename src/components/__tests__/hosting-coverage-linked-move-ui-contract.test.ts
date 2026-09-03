// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { stripComments } from "@/lib/__tests__/support/strip-comments";
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
    combinedPolicyRetainedCents: 0,
    settlementMethodRequired: false,
    settlementMethodChosen: false,
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
    expect(moveBoth).toHaveAccessibleName(/\$35\.00 would be payable across both/);
    expect(moveBoth).toHaveAccessibleName(
      /A change fee applies to both bookings . \$20\.00 in all . and the figures above already take it into account/,
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
      /change fee on the other booking has been waived by the club, so the figures above carry one change fee only \(\$10\.00\)/,
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
      /\$42\.50 would come back to you across both bookings/,
    );
    expect(moveBoth).toHaveAccessibleName(
      /asked once whether that comes back to your card or as account credit; the one choice covers both bookings/,
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

  it("reports the save in flight on the live region, and the panel says so", () => {
    // `busy` was declared on this component and never passed by the panel, so
    // `aria-busy` was permanently false while a two-booking move was in flight.
    const { rerender } = render(
      createElement(HostingCoverageLinkedMovePrompt, {
        ...BASE,
        prompt: promptData(),
      }),
    );
    expect(screen.getByRole("alert")).toHaveAttribute("aria-busy", "false");
    rerender(
      createElement(HostingCoverageLinkedMovePrompt, {
        ...BASE,
        prompt: promptData(),
        busy: true,
      }),
    );
    expect(screen.getByRole("alert")).toHaveAttribute("aria-busy", "true");
    // And the one caller really passes it.
    expect(source("src/components/edit-booking-panel.tsx")).toContain(
      "busy={saving}",
    );
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
        /Another of your bookings needs an adult on the nights below/,
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


  /**
   * THE CASE THAT COULD CHARGE A MEMBER MONEY NO SCREEN NAMED.
   *
   * Per booking, "money comes back" and "money is payable" are mutually
   * exclusive. Across two bookings they are not — `combineLinkedMoveQuote` sums
   * each independently — and the exclusive ternary that rendered them let the
   * refund branch win. The fixture in
   * `booking-linked-date-move-service.test.ts` has produced this state all along
   * (due $35.00 and refund $2.00 on one quote) and nothing asserted what the
   * member was told about it.
   */
  it("names BOTH figures when both are moving, and says they do not net off", () => {
    render(
      createElement(HostingCoverageLinkedMovePrompt, {
        ...BASE,
        prompt: promptData({
          // A shifts into peak: +$120 price, +$50 fee. B shifts off an event
          // surcharge: -$300, +$50. Both totals are positive at once.
          combinedAmountDueCents: 17_000,
          combinedRefundCents: 25_000,
          combinedChangeFeeCents: 10_000,
          settlementMethodRequired: true,
        }),
      }),
    );

    const moveBoth = screen.getByRole("radio", { name: /Move both bookings/ });
    expect(moveBoth).toHaveAccessibleName(/\$170\.00 would be payable/);
    expect(moveBoth).toHaveAccessibleName(/\$250\.00 would come back to you/);
    expect(moveBoth).toHaveAccessibleName(
      /do not cancel each other out: each booking settles on its own/,
    );
  });

  it("formats money through the canonical formatter, separators and all", () => {
    // The hand-rolled formatter this replaces printed `$1234.56` while every
    // other figure on the same page printed `$1,234.56`, and hard-coded a `$` for
    // a club whose currency may not be dollars at all (`INV-CONFIG-001`).
    render(
      createElement(HostingCoverageLinkedMovePrompt, {
        ...BASE,
        prompt: promptData({ combinedAmountDueCents: 123_456 }),
      }),
    );
    expect(
      screen.getByRole("radio", { name: /Move both bookings/ }),
    ).toHaveAccessibleName(/\$1,234\.56 would be payable/);
  });

  it("counts the bookings it is talking about, because the cap is 25 and not 1", () => {
    // A member with one adult and two parties of guests is an ordinary family
    // shape. The singular wording told them "The booking above will be left
    // without adult supervision" while the list showed two — understating the
    // consequence on the arm the design relies on for informed consent.
    const second = {
      ...promptData().linkedBookings[0]!,
      bookingId: "bk-dependent-02",
      reference: "BK-SECND",
    };
    render(
      createElement(HostingCoverageLinkedMovePrompt, {
        ...BASE,
        prompt: promptData({
          linkedBookings: [...promptData().linkedBookings, second],
          bothChangeFeesCharged: false,
        }),
      }),
    );

    expect(
      screen.getByText(/2 of your bookings need an adult on the nights below/),
    ).toBeVisible();
    const moveAll = screen.getByRole("radio", { name: /Move all 3 bookings/ });
    expect(moveAll).toHaveAccessibleName(/across all 3 bookings/);
    expect(moveAll).toHaveAccessibleName(
      /change fee on the other 2 bookings has been waived/,
    );
    expect(
      screen.getByRole("radio", { name: /Move only this booking/ }),
    ).toHaveAccessibleName(
      /The 2 bookings listed above will be left without adult supervision/,
    );
  });

  /**
   * #3232 D3: the incident's recorded explanation reaches the booking page, and
   * reaches ONLY staff.
   *
   * The audit row's `details` is whoever's explanation applies — a member's
   * recorded decision about their own two bookings, or an officer's PRIVATE
   * override reason, which the booking's own member must never read. So the DATA
   * FEED is gated rather than the render, the way #2008's duplicate-capture rows
   * on the same page already are: a non-admin viewer never receives the rows at
   * all. Asserted on the source because the query lives in a server component.
   */
  it("feeds the incident's own history rows to staff only", () => {
    // COMMENTS BLANKED FIRST, and that is the whole difference from the assertion
    // this replaces. That one sliced the RAW source, and the paragraph explaining
    // the gate sits inside the slice — so deleting the gating ternary outright,
    // while leaving the word `canSeeAdminTools` in the prose above it, left the
    // rows in every member's feed and the guard still green. Measured on this
    // branch before it was replaced.
    const page = stripComments(
      source("src/app/(authenticated)/bookings/[id]/page.tsx"),
    );
    expect(page).toContain("booking.hostingCoverage.incidentOpened");
    const gate = page.slice(
      page.indexOf("const bookingAuditLogs"),
      page.indexOf("booking.hostingCoverage.incidentOpened"),
    );
    expect(
      gate,
      "the incident actions must be inside a canSeeAdminTools branch, not the shared list",
    ).toContain("canSeeAdminTools");
    // AND THE SECOND LOCK, which is the one a query edit cannot lose: the timeline
    // builder is TOLD who is reading, so the rows are dropped for a member even if
    // they reach it. `booking-history.test.ts` asserts that behaviourally; this
    // asserts the page really passes the audience rather than defaulting it.
    expect(
      page,
      "the history builder must be handed the viewer's audience (#3232 D3)",
    ).toContain('audience: canSeeAdminTools ? "staff" : "member"');
  });

  it("keeps the shared browser contract free of server-only dependencies", () => {
    const client = source("src/lib/hosting-coverage-linked-move-client.ts");
    expect(client).not.toMatch(
      /(?:from\s+|import\s*)["'](?:@prisma\/client|node:crypto|server-only)["']/,
    );
  });
});
