// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HostingCoverageOverridePrompt } from "@/components/hosting-coverage-override-prompt";

function source(path: string) {
  return readFileSync(path, "utf8").replaceAll("\\", "/");
}

describe("officer hosting-coverage override UI authority (#2576 §7, §11)", () => {
  it("keeps only static warning evidence in the permanent assertive region", () => {
    const props = {
      confirmed: false,
      reason: "",
      idPrefix: "test-override",
      onConfirmedChange: () => undefined,
      onReasonChange: () => undefined,
    };
    const { rerender } = render(
      createElement(HostingCoverageOverridePrompt, { ...props, prompt: null }),
    );
    const alert = screen.getByRole("alert");
    expect(alert).toBeEmptyDOMElement();

    rerender(
      createElement(HostingCoverageOverridePrompt, {
        ...props,
        prompt: {
          message: "This change would leave another booking uncovered.",
          strandedStateKey: `v1:${"a".repeat(64)}`,
          strandedBookings: [
            {
              bookingId: "booking-private-id",
              reference: "ACB-1234",
              lodgeName: "Example Lodge",
              nights: ["2026-08-14"],
            },
          ],
        },
      }),
    );

    expect(screen.getByRole("alert")).toBe(alert);
    expect(
      within(alert).getByText(/Separate hosting coverage override required/),
    ).toBeVisible();
    expect(within(alert).getByText("ACB-1234")).toBeVisible();
    expect(within(alert).queryByRole("textbox")).toBeNull();
    expect(within(alert).queryByRole("checkbox")).toBeNull();

    const reason = screen.getByLabelText(
      /Private hosting override reason \(required\)/,
    );
    expect(reason).toHaveAttribute(
      "aria-describedby",
      "test-override-reason-hint",
    );
    expect(screen.getByRole("checkbox")).toHaveAccessibleName(
      /I confirm these exact affected bookings and nights remain confirmed/,
    );
  });

  it("keeps the shared browser contract free of server-only dependencies", () => {
    const client = source("src/lib/hosting-coverage-override-client.ts");
    expect(client).not.toMatch(
      /(?:from\s+|import\s*)["'](?:@prisma\/client|node:crypto|server-only)["']/,
    );
  });

  it("passes cancellation authority from the exact booking-management role", () => {
    // #2958: the cancel button renders in the page's lifecycle-actions section.
    const page = source(
      "src/app/(authenticated)/bookings/[id]/_components/booking-lifecycle-actions.tsx",
    );
    expect(page).toContain(
      'canOverrideHostingCoverage={viewerAuthorizationRole === "ADMIN"}',
    );
    expect(page).toContain(
      'canChooseMemberEmail={viewerAuthorizationRole === "ADMIN"}',
    );

    const cancel = source("src/components/cancel-booking-button.tsx");
    expect(cancel).toContain("canOverrideHostingCoverage = false");
    expect(cancel).toContain("canOverrideHostingCoverage\n          ?");
    expect(cancel).not.toMatch(
      /const canOverrideHostingCoverage\s*=\s*canChooseMemberEmail/,
    );
  });

  it("gates edit details on the server-serialised officer role", () => {
    const edit = source("src/components/edit-booking-panel.tsx");
    expect(edit).toContain('const actingAsAdmin = booking.viewerRole === "ADMIN"');
    expect(edit).toContain(
      "actingAsAdmin\n          ? readHostingCoverageOverridePrompt(data)",
    );
    expect(edit).toContain("actingAsAdmin && activeHostingOverrideState");
  });

  it("does not add an override producer to member self-removal or draft confirmation", () => {
    const guestControls = source("src/components/self-remove-from-booking-card.tsx");
    const confirmDraft = source("src/components/confirm-draft-button.tsx");
    expect(guestControls).not.toContain("hostingCoverageOverride");
    // DRAFT confirmation only adds attendance/coverage and this button is not an
    // officer edit surface, so a same-owner stranding prompt is unreachable here.
    expect(confirmDraft).not.toContain("hostingCoverageOverride");
  });
});
