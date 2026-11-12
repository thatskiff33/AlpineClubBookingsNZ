// @vitest-environment jsdom

// #4949: an action's failure lands in a recovery alert that was mounted empty
// and takes focus; its success fills a status region mounted before the
// request. One case per surface the issue names.

import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@/lib/__tests__/support/club-time-render";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { expectRecoveryAlertToHoldFocus } from "@/lib/__tests__/helpers/focus";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("next-auth/react", () => ({ signIn: vi.fn() }));

import { SwitchToInternetBankingButton } from "@/components/switch-to-internet-banking-button";
import { SendGuestPaymentLinkButton } from "@/components/send-guest-payment-link-button";
import { DeleteBookingButton } from "@/components/delete-booking-button";
import { MembershipCancellationConfirmCard } from "@/components/membership-cancellation-confirm-card";
import { NominationConfirmCard } from "@/components/nomination-confirm-card";
import { PartnerInviteClaimCard } from "@/components/partner-invite-claim-card";
import { DeleteAccountButton } from "@/app/(authenticated)/profile/delete-account-button";
import { NotificationPreferences } from "@/app/(authenticated)/profile/notification-preferences";
import { GoogleAccountCard } from "@/app/(authenticated)/profile/google-account-card";
import { TwoFactorSecurityCard } from "@/app/(authenticated)/profile/two-factor-security-card";
import { DataExportButton } from "@/app/(authenticated)/profile/data-export-button";
import type { MembershipCancellationConfirmationDetails } from "@/lib/membership-cancellation-requests";

const FAILURE = "The club could not do that just now.";

type Reply = { ok: boolean; status?: number; body: unknown };

// With `load`, a GET only loads the surface's initial state and answers it;
// every other request is the action under test and answers `action`.
function installFetch(action: Reply, load?: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const isLoad = load !== undefined && (!init?.method || init.method === "GET");
      const reply = isLoad ? { ok: true, body: load } : action;
      const { ok, status = ok ? 200 : 500, body } = reply;
      return { ok, status, json: async () => body } as Response;
    }),
  );
}

async function press(name: RegExp) {
  const button = await screen.findByRole("button", { name });
  button.focus();
  await act(async () => {
    fireEvent.click(button);
  });
}

async function expectFailureAnnounced(id: string) {
  const alert = document.getElementById(id);
  expect(alert).toHaveAttribute("role", "alert");
  expect(alert).toHaveTextContent(FAILURE);
  await expectRecoveryAlertToHoldFocus(alert);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const confirmDetails = {
  tokenStatus: "ready",
  canRespond: true,
  message: "",
  request: null,
  participant: null,
} as MembershipCancellationConfirmationDetails;

const failures: Array<{
  surface: string;
  ui: ReactElement;
  alertId: string;
  steps: RegExp[];
  failsWith?: Reply;
  load?: unknown;
}> = [
  {
    surface: "switch to internet banking",
    ui: <SwitchToInternetBankingButton bookingId="bk_1" description="Pay by bank." />,
    alertId: "switch-to-internet-banking-bk_1-error",
    steps: [/Pay by internet banking instead/],
  },
  {
    surface: "guest payment link",
    ui: <SendGuestPaymentLinkButton bookingId="bk_1" />,
    alertId: "send-guest-payment-link-bk_1-error",
    steps: [/Email me a payment link/],
  },
  {
    surface: "membership-cancellation confirmation",
    ui: <MembershipCancellationConfirmCard token="t" details={confirmDetails} />,
    alertId: "membership-cancellation-confirm-error",
    steps: [/Confirm Inclusion/],
  },
  {
    surface: "nomination confirmation",
    ui: <NominationConfirmCard token="t" canConfirm />,
    alertId: "nomination-confirm-error",
    steps: [/Agree to Nominate/],
  },
  {
    surface: "partner invite claim",
    ui: <PartnerInviteClaimCard token="t" groupName="Riley family" />,
    alertId: "partner-invite-claim-error",
    steps: [/Join Riley family/],
  },
  {
    surface: "account deletion request",
    ui: <DeleteAccountButton />,
    alertId: "delete-account-error",
    steps: [/Request Account Deletion/, /Submit Deletion Request/],
  },
  {
    surface: "notification preferences",
    ui: <NotificationPreferences />,
    alertId: "notification-preferences-error",
    steps: [/^Edit$/, /Save Changes/],
    load: {},
    // The save reports its own wording, not the server's.
    failsWith: { ok: false, body: {} },
  },
  {
    surface: "Google account linking",
    ui: <GoogleAccountCard linked moduleEnabled credentialsConfigured />,
    alertId: "google-account-error",
    steps: [/Disconnect/],
    failsWith: { ok: false, body: {} },
  },
  {
    surface: "recovery-code regeneration",
    ui: <TwoFactorSecurityCard enabled method="TOTP" moduleEnabled passkeys={[]} />,
    alertId: "two-factor-security-error",
    steps: [/Regenerate codes/],
  },
  {
    surface: "data export",
    ui: <DataExportButton />,
    alertId: "data-export-error",
    steps: [/Download My Data/],
    failsWith: { ok: false, body: {} },
  },
];

describe("action failures land in a recovery alert that takes focus (#4949)", () => {
  it.each(failures)("$surface", async ({ ui, alertId, steps, failsWith, load }) => {
    installFetch(failsWith ?? { ok: false, body: { error: FAILURE } }, load);
    render(ui);
    for (const step of steps) await press(step);

    if (failsWith) {
      // Surfaces that word the failure themselves: hold the wording, not FAILURE.
      const alert = document.getElementById(alertId);
      expect(alert).toHaveAttribute("role", "alert");
      expect(alert?.textContent).not.toBe("");
      await expectRecoveryAlertToHoldFocus(alert);
      return;
    }
    await expectFailureAnnounced(alertId);
  });

  it("delete cancelled booking", async () => {
    installFetch({ ok: false, body: { error: FAILURE } });
    render(<DeleteBookingButton bookingId="bk_1" mode="cancelled" returnHref="/bookings" />);
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "Duplicate" } });
    await press(/Delete Cancelled Booking/);
    await expectFailureAnnounced("delete-booking-bk_1-error");
  });
});

const successes: Array<{
  surface: string;
  ui: ReactElement;
  trigger: RegExp;
  reply: unknown;
  text: string;
}> = [
  {
    surface: "guest payment link",
    ui: <SendGuestPaymentLinkButton bookingId="bk_1" />,
    trigger: /Email me a payment link/,
    reply: { sent: 1 },
    text: "We've emailed you a secure link to pay for your guests.",
  },
  {
    surface: "membership-cancellation confirmation",
    ui: <MembershipCancellationConfirmCard token="t" details={confirmDetails} />,
    trigger: /Confirm Inclusion/,
    reply: { message: "Your response has been recorded." },
    text: "Your response has been recorded.",
  },
  {
    surface: "nomination confirmation",
    ui: <NominationConfirmCard token="t" canConfirm />,
    trigger: /Agree to Nominate/,
    reply: {},
    text: "Your confirmation has been recorded.",
  },
  {
    surface: "partner invite claim",
    ui: <PartnerInviteClaimCard token="t" groupName="Riley family" />,
    trigger: /Join Riley family/,
    reply: {},
    text: "You have joined Riley family.",
  },
];

describe("action results fill a status region mounted before the request (#4949)", () => {
  it.each(successes)("$surface", async ({ ui, trigger, reply, text }) => {
    installFetch({ ok: true, body: reply });
    render(ui);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("");

    await press(trigger);

    expect(screen.getByRole("status")).toBe(status);
    expect(status).toHaveTextContent(text);
  });

  it("account deletion request", async () => {
    installFetch({ ok: true, body: {} });
    render(<DeleteAccountButton />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("");

    await press(/Request Account Deletion/);
    await press(/Submit Deletion Request/);

    expect(screen.getByRole("status")).toBe(status);
    expect(status).toHaveTextContent("Your deletion request has been submitted.");
  });
});
