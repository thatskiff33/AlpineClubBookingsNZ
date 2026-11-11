// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemberOnboardingWizard } from "@/components/member-onboarding-wizard";
import { MEMBER_ONBOARDING_CONFIRMED_EVENT } from "@/lib/member-onboarding-events";

const fetchMock = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("@/components/profile/profile-form", () => ({
  ProfileForm: ({ onSaved }: { onSaved?: () => void }) => (
    <button type="button" onClick={onSaved}>
      save-profile
    </button>
  ),
}));

vi.mock("@/components/profile/family-group-section", () => ({
  FamilyGroupSection: () => <div data-testid="family-group-section" />,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: ReactNode; open?: boolean }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

const profile = {
  id: "member-1",
  firstName: "Alice",
  lastName: "Smith",
  phoneCountryCode: "64",
  phoneAreaCode: "27",
  phoneNumber: "4224115",
  dateOfBirth: "1990-01-15",
  streetAddressLine1: "123 Main St",
  streetAddressLine2: "",
  streetCity: "Example",
  streetRegion: "Waikato",
  streetPostalCode: "3420",
  streetCountry: "NZ",
  postalAddressLine1: "PO Box 42",
  postalAddressLine2: "",
  postalCity: "Example",
  postalRegion: "Waikato",
  postalPostalCode: "3420",
  postalCountry: "NZ",
};

const baseStatus = {
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
    profile,
    status: baseStatus,
    needsOwnDetailsConfirmation: true,
  },
  familyGroups: [
    {
      id: "family-1",
      name: "Smith Family",
      members: [
        {
          id: "member-1",
          name: "Alice Smith",
          firstName: "Alice",
          lastName: "Smith",
          ageTier: "ADULT",
          active: true,
          canLogin: true,
          role: "MEMBER",
          isCurrentUser: true,
          status: baseStatus,
          nextAction: "current_user",
        },
        {
          id: "member-2",
          name: "Jane Smith",
          firstName: "Jane",
          lastName: "Smith",
          ageTier: "ADULT",
          active: true,
          canLogin: true,
          role: "MEMBER",
          isCurrentUser: false,
          status: baseStatus,
          nextAction: "self_confirmation_required",
        },
      ],
    },
  ],
  pendingRequests: [],
};

describe("MemberOnboardingWizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = fetchMock as typeof fetch;
  });

  it("does not mount when the server gate is false", () => {
    render(<MemberOnboardingWizard initialShouldShow={false} />);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the blocking flow and closes after confirmation", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => onboardingData,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, shouldShow: false }),
      });

    render(<MemberOnboardingWizard initialShouldShow />);

    expect(await screen.findByText("Confirm your details are correct.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Confirm details are correct" }));

    expect(
      screen.getByText("Jane has their own login and needs to sign in and confirm their details.")
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Confirm and finish/ }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/member/onboarding/confirm",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("announces completion so overlaid pages can refetch bookability state", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => onboardingData,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, shouldShow: false }),
      });

    const onConfirmed = vi.fn();
    window.addEventListener(MEMBER_ONBOARDING_CONFIRMED_EVENT, onConfirmed);
    try {
      render(<MemberOnboardingWizard initialShouldShow />);

      fireEvent.click(
        await screen.findByRole("button", { name: "Confirm details are correct" })
      );
      fireEvent.click(screen.getByRole("button", { name: /Confirm and finish/ }));

      await waitFor(() => expect(onConfirmed).toHaveBeenCalledTimes(1));
    } finally {
      window.removeEventListener(MEMBER_ONBOARDING_CONFIRMED_EVENT, onConfirmed);
    }
  });

  it("does not announce completion when the confirm call fails", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => onboardingData,
      })
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: "nope" }),
      })
      // confirmOnboarding reloads the onboarding payload after a failure.
      .mockResolvedValueOnce({
        ok: true,
        json: async () => onboardingData,
      });

    const onConfirmed = vi.fn();
    window.addEventListener(MEMBER_ONBOARDING_CONFIRMED_EVENT, onConfirmed);
    try {
      render(<MemberOnboardingWizard initialShouldShow />);

      fireEvent.click(
        await screen.findByRole("button", { name: "Confirm details are correct" })
      );
      fireEvent.click(screen.getByRole("button", { name: /Confirm and finish/ }));

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/member/onboarding/confirm",
          expect.objectContaining({ method: "POST" })
        )
      );
      expect(onConfirmed).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog")).toBeTruthy();
    } finally {
      window.removeEventListener(MEMBER_ONBOARDING_CONFIRMED_EVENT, onConfirmed);
    }
  });
});
