// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemberOnboardingWizard } from "@/components/member-onboarding-wizard";

// This file deliberately does NOT mock `@/components/ui/dialog`: initial focus
// is Radix behaviour, and the mocked dialog in member-onboarding-wizard.test.tsx
// cannot show it.
vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@/app/(authenticated)/profile/profile-form", () => ({
  ProfileForm: () => <div data-testid="profile-form" />,
}));

vi.mock("@/app/(authenticated)/profile/family-group-section", () => ({
  FamilyGroupSection: () => <div data-testid="family-group-section" />,
}));

const status = {
  isProfileComplete: true,
  isDetailsConfirmed: false,
  canBeBookedAsMember: false,
  missingFields: [],
  missingFieldDetails: [],
  needsOwnLoginConfirmation: true,
  confirmationMode: "self",
  hasCompletedOnboarding: false,
  needsOnboardingConfirmation: true,
  requiresWizard: true,
};

const onboardingData = {
  shouldShow: true,
  currentMember: {
    id: "member-1",
    name: "Alice Smith",
    profile: {},
    status,
    needsOwnDetailsConfirmation: true,
  },
  familyGroups: [],
  pendingRequests: [],
};

describe("MemberOnboardingWizard initial focus (real dialog)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Log out is the only tabbable element while the payload loads, so Radix's
  // default would focus it and a stray Enter or Space would sign the member out.
  it("focuses the dialog, not Log out, while loading and after the step renders", async () => {
    let resolveLoad: (value: unknown) => void = () => {};
    global.fetch = vi.fn(
      () => new Promise((resolve) => (resolveLoad = resolve))
    ) as unknown as typeof fetch;

    render(<MemberOnboardingWizard initialShouldShow />);

    const dialog = await screen.findByRole("dialog");
    const logOut = screen.getByRole("button", { name: "Log out" });
    expect(screen.getByText("Loading member details")).toBeTruthy();
    expect(document.activeElement).toBe(dialog);
    expect(document.activeElement).not.toBe(logOut);

    resolveLoad({ ok: true, json: async () => onboardingData });
    await screen.findByRole("button", { name: "Confirm details are correct" });

    expect(document.activeElement).toBe(dialog);
    // Still reachable: a real, enabled, named button that Tab can land on.
    expect(logOut.getAttribute("tabindex")).toBeNull();
    expect((logOut as HTMLButtonElement).disabled).toBe(false);
  });
});
