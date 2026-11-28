// @vitest-environment jsdom

// #5442 follow-up: a control disabled while its request runs loses focus to
// <body> (a browser at once, jsdom on its 16 ms focus fixup), and nothing gives
// it back. Each surface here leaves that control in place on the outcome
// tested and moves focus nowhere else, so it holds focus only because
// `useActionFocusReturn` returns it. The slow reply is the discriminating
// case; the instant one pins that the return does not fight a fast reply.

import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { REPLY_SPEEDS, expectToHoldFocus, replyDelay } from "@/lib/__tests__/helpers/focus";

const { mockSignIn, toastError, saveResponseAsFile } = vi.hoisted(() => ({
  mockSignIn: vi.fn(),
  toastError: vi.fn(),
  saveResponseAsFile: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("next-auth/react", () => ({ signIn: mockSignIn }));
vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));
vi.mock("@/lib/save-response-as-file", () => ({ saveResponseAsFile }));
// Stripe Elements needs a live key and a browser; the settle button is enough.
vi.mock("@/components/stripe/StripeProvider", () => ({ default: () => null }));
vi.mock("@/components/stripe/PaymentForm", () => ({ default: () => null }));
vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ name: "Test Club" }),
}));
// Radix Select does not open in jsdom; a native select keeps `onValueChange`.
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    disabled,
    children,
  }: {
    value?: string;
    onValueChange?: (value: string) => void;
    disabled?: boolean;
    children?: React.ReactNode;
  }) => (
    <select
      aria-label="Preferred room"
      value={value}
      disabled={disabled}
      onChange={(event) => onValueChange?.(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children?: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

import { NoticeAcknowledgeButton } from "@/components/notice-acknowledge-button";
import { ArrivalTimeEditor } from "@/components/arrival-time-editor";
import { RequestedRoomEditor } from "@/components/requested-room-editor";
import { BookingGuestDietaryCard } from "@/app/(authenticated)/bookings/[id]/_components/booking-guest-dietary-card";
import { PromoCodeList } from "@/components/promo-code-list";
import { DataExportButton } from "@/app/(authenticated)/profile/data-export-button";
import { InductionSignOffForm } from "@/components/induction-sign-off-form";
import { FoodOrderForm } from "@/components/food-orders/food-order-form";
import { LoginForm } from "@/app/(public)/login/login-form";
import { TwoFactorSecurityCard } from "@/app/(authenticated)/profile/two-factor-security-card";
import { PartnerLinkSection } from "@/app/(authenticated)/profile/partner-link-section";
import { ProfileForm } from "@/components/profile/profile-form";
import { TwoFactorVerifyPanel } from "@/app/(public)/login/two-factor-panels";
import { OrganiserGroupBookingCard } from "@/components/group-booking/organiser-group-booking-card";

type Reply = { ok: boolean; body: unknown };

const REFUSAL = "The club could not do that just now.";

// A GET answers `load` at once (the surface's initial state); every other
// request is the action under test and answers `action` after `delayMs`.
function installFetch(action: Reply, { load, delayMs }: { load?: unknown; delayMs: number }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const isLoad = !init?.method || init.method === "GET";
      if (isLoad && load !== undefined) {
        return { ok: true, status: 200, json: async () => load } as Response;
      }
      await replyDelay(delayMs);
      const { ok, body } = action;
      return { ok, status: ok ? 200 : 400, json: async () => body } as Response;
    }),
  );
}

// Focus the control and press it, as a keyboard user does.
async function press(button: HTMLElement) {
  button.focus();
  expect(document.activeElement).toBe(button);
  await act(async () => {
    fireEvent.click(button);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each(REPLY_SPEEDS)("a control disabled while busy keeps focus ($speed reply)", ({ delayMs }) => {
  it("notice acknowledgement that fails", async () => {
    installFetch({ ok: false, body: {} }, { delayMs });
    render(<NoticeAcknowledgeButton noticeId="n1" acknowledged={false} acknowledgedAt={null} />);
    const button = screen.getByRole("button", { name: "Acknowledge" });
    await press(button);
    await screen.findByText(/Could not record your acknowledgement/);
    await expectToHoldFocus(button, "Acknowledge");
  });

  it("arrival time that fails to save", async () => {
    installFetch({ ok: false, body: { error: REFUSAL } }, { delayMs });
    render(<ArrivalTimeEditor bookingId="bk_1" initialTime={null} canEdit />);
    fireEvent.change(screen.getByLabelText("Expected arrival time"), { target: { value: "17:30" } });
    const button = screen.getByRole("button", { name: "Save arrival time" });
    await press(button);
    await screen.findByText(REFUSAL);
    await expectToHoldFocus(button, "Save arrival time");
  });

  it("requested room that fails to save", async () => {
    installFetch(
      { ok: false, body: { error: REFUSAL } },
      { delayMs, load: { rooms: [{ id: "room-a", name: "Alpine", bedCount: 4 }] } },
    );
    render(<RequestedRoomEditor bookingId="bk_1" initialRoom={null} canEdit />);
    await screen.findByRole("option", { name: /Alpine/ });
    fireEvent.change(screen.getByLabelText("Preferred room"), { target: { value: "room-a" } });
    const button = screen.getByRole("button", { name: "Save preferred room" });
    await press(button);
    await screen.findByText(REFUSAL);
    await expectToHoldFocus(button, "Save preferred room");
  });

  it("guest dietary note that fails to save", async () => {
    installFetch({ ok: false, body: { error: REFUSAL } }, { delayMs });
    render(
      <BookingGuestDietaryCard
        bookingId="bk_1"
        canEdit
        guests={[
          {
            id: "g1",
            firstName: "Sam",
            lastName: "Guest",
            isMember: true,
            memberId: "m1",
            ageTier: "ADULT",
            dietaryRequirements: null,
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Edit dietary/ }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "No nuts" } });
    const button = screen.getByRole("button", { name: "Save" });
    await press(button);
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(REFUSAL));
    await expectToHoldFocus(button, "Save");
  });

  it("promo code the booking cannot take", async () => {
    render(
      <PromoCodeList
        applied={[]}
        onChange={vi.fn()}
        validate={async () => {
          await replyDelay(delayMs);
          return { ok: false, error: REFUSAL };
        }}
        multiPromoCodes
        ownCodes={[]}
        guestGroups={[]}
        guestLabel={(index) => `Guest ${index + 1}`}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("Enter promo code"), { target: { value: "NOPE" } });
    const button = screen.getByRole("button", { name: "Apply" });
    await press(button);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(REFUSAL));
    await expectToHoldFocus(button, "Apply");
  });

  it("data export that downloads", async () => {
    installFetch({ ok: true, body: {} }, { delayMs });
    render(<DataExportButton />);
    const button = screen.getByRole("button", { name: /Download My Data/ });
    await press(button);
    await waitFor(() => expect(saveResponseAsFile).toHaveBeenCalled());
    await expectToHoldFocus(button, "Download My Data");
  });

  it("induction sign-off that fails", async () => {
    installFetch(
      { ok: false, body: { error: REFUSAL } },
      {
        delayMs,
        load: {
          declaration: "I confirm the induction.",
          induction: {
            id: "ind1",
            kind: "MEMBER",
            status: "IN_PROGRESS",
            requiredSignOffs: 1,
            inductionDate: null,
            completedAt: null,
            finalComments: null,
            member: { id: "m1", firstName: "Sam", lastName: "Member" },
            template: { id: "t1", name: "Lodge", version: "1", kind: "MEMBER", sections: [] },
            signOffs: [],
            assignedSigners: [],
          },
        },
      },
    );
    render(<InductionSignOffForm inductionId="ind1" onComplete={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(await screen.findByRole("checkbox"));
    const button = screen.getByRole("button", { name: "Pass induction" });
    await press(button);
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(REFUSAL));
    await expectToHoldFocus(button, "Pass induction");
  });

  it("food order the club refuses", async () => {
    render(
      <FoodOrderForm
        lodges={[{ id: "lodge-a", name: "Lodge A" }]}
        today="2026-07-01"
        officerLabel="Food Officer"
        onSubmit={async () => {
          await replyDelay(delayMs);
          throw new Error(REFUSAL);
        }}
      />,
    );
    fireEvent.change(screen.getByLabelText("Needed by"), { target: { value: "2026-07-05" } });
    fireEvent.change(screen.getByLabelText(/Item/), { target: { value: "Bread" } });
    const button = screen.getByRole("button", { name: "Send this order" });
    await press(button);
    await screen.findByText(REFUSAL);
    await expectToHoldFocus(button, "Send this order");
  });

  it("password sign-in that is refused", async () => {
    mockSignIn.mockImplementation(async () => {
      await replyDelay(delayMs);
      return { error: "CredentialsSignin", code: "credentials" };
    });
    render(<LoginForm verified={false} emailChanged={false} redirectTo="/dashboard" />);
    fireEvent.change(document.getElementById("email")!, { target: { value: "member@example.org" } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: "pw" } });
    const button = screen.getByRole("button", { name: /^sign in$/i });
    await press(button);
    await screen.findByText(/Invalid email or password/);
    await expectToHoldFocus(button, "Sign in");
  });

  it("recovery codes that regenerate", async () => {
    installFetch({ ok: true, body: { recoveryCodes: ["AAAA-1111", "BBBB-2222"] } }, { delayMs });
    render(<TwoFactorSecurityCard enabled method="TOTP" moduleEnabled passkeys={[]} />);
    const button = screen.getByRole("button", { name: /Regenerate codes/ });
    await press(button);
    await screen.findByText("AAAA-1111");
    await expectToHoldFocus(button, "Regenerate codes");
  });

  it("partner request that is refused", async () => {
    installFetch(
      { ok: false, body: { error: REFUSAL } },
      {
        delayMs,
        load: {
          confirmed: null,
          pendingIncoming: [],
          pendingOutgoing: [],
          oneStepCandidates: [],
          pendingPartnerInvite: null,
        },
      },
    );
    render(<PartnerLinkSection canManage />);
    fireEvent.change(await screen.findByLabelText(/Partner's email address/), {
      target: { value: "partner@example.org" },
    });
    const button = screen.getByRole("button", { name: "Send partner request" });
    await press(button);
    await screen.findByText(REFUSAL);
    await expectToHoldFocus(button, "Send partner request");
  });

  it("sign-in email code that sends", async () => {
    installFetch({ ok: true, body: {} }, { delayMs });
    render(<TwoFactorVerifyPanel callbackUrl="/dashboard" enrolledMethod="EMAIL" />);
    const button = screen.getByRole("button", { name: "Send email code" });
    await press(button);
    await waitFor(() => expect(button).toHaveTextContent("Send another code"));
    await expectToHoldFocus(button, "Send another code");
  });

  it("group settlement that is refused", async () => {
    installFetch(
      { ok: false, body: { error: REFUSAL } },
      {
        delayMs,
        // Every GET the card makes: payment options and the club's messages.
        load: { methods: { stripe: { enabled: true } }, messages: {}, tokens: {} },
      },
    );
    render(
      <OrganiserGroupBookingCard
        bookingId="bk_1"
        canOpenGroup={false}
        group={{
          code: "ABCD2345",
          status: "OPEN",
          paymentMode: "ORGANISER_PAYS",
          joinDeadline: null,
          maxJoiners: null,
          joiners: [
            {
              id: "j1",
              name: "Jo Member",
              guestCount: 1,
              status: "CONFIRMED",
              priceCents: 4500,
              moneyReconciliation: {
                visibility: "VISIBLE",
                reconciliation: { state: "RECONCILED", reasons: [] },
              },
              isMember: true,
              paysOwn: false,
            },
          ],
          settlement: null,
        }}
      />,
    );
    const button = screen.getByRole("button", { name: "Settle group total" });
    await press(button);
    await screen.findByText(REFUSAL);
    await expectToHoldFocus(button, "Settle group total");
  });

  it("profile save that is refused", async () => {
    installFetch({ ok: false, body: { error: REFUSAL } }, { delayMs });
    render(<ProfileForm member={PROFILE_MEMBER} />);
    const button = screen.getByRole("button", { name: "Save Changes" });
    button.focus();
    // Submit the form directly: jsdom's click would stop at the address
    // fields' `required` constraint, which is not what this test is about.
    await act(async () => {
      fireEvent.submit(button.closest("form")!);
    });
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(REFUSAL));
    await expectToHoldFocus(button, "Save Changes");
  });
});

const PROFILE_MEMBER = {
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
  postalAddressLine1: "123 Main St",
  postalAddressLine2: "",
  postalCity: "Example",
  postalRegion: "Waikato",
  postalPostalCode: "3420",
  postalCountry: "NZ",
  lodgeScreenPhoneOptIn: false,
};
