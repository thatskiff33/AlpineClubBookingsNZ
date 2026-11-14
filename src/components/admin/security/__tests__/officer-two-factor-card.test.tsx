// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: () => true,
  ADMIN_VIEW_ONLY_ACTION_REASON: "View-only reason",
}));

import { OfficerTwoFactorCard } from "@/components/admin/security/officer-two-factor-card";

// #4618 review: clearing the grace field must not read as 0 days (an
// immediate gate). An empty field is invalid and Save stays disabled until a
// whole number in range is typed, 0 included.

function graceInput() {
  return screen.getByLabelText("Grace period (days)") as HTMLInputElement;
}

function saveButton() {
  return screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
}

describe("OfficerTwoFactorCard grace field (#4618)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ officerTwoFactorPolicy: true, officerTwoFactorGraceDays: 14 }),
            { status: 200 },
          ),
      ),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("treats a cleared grace field as invalid, not as zero days", async () => {
    render(<OfficerTwoFactorCard canEdit />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect(graceInput().value).toBe("14");

    fireEvent.change(graceInput(), { target: { value: "" } });
    expect(graceInput().value).toBe("");
    expect(saveButton().disabled).toBe(true);

    fireEvent.change(graceInput(), { target: { value: "0" } });
    expect(saveButton().disabled).toBe(false);

    fireEvent.change(graceInput(), { target: { value: "61" } });
    expect(saveButton().disabled).toBe(true);
  });
});
