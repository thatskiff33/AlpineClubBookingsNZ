// @vitest-environment jsdom

// #4949: the sign-in, password and public-form surfaces. A failure lands in a
// recovery alert that was mounted empty and takes focus; a result that replaces
// the form is spoken from a status region mounted before the request, and focus
// never drops to the top of the page.

import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";

import { expectRecoveryAlertToHoldFocus } from "@/lib/__tests__/helpers/focus";

const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));

import ForgotPasswordPage from "@/app/(public)/forgot-password/page";
import ChangePasswordPage from "@/app/(public)/change-password/page";
import ResetPasswordPage from "@/app/(public)/reset-password/page";
import { TwoFactorVerifyPanel } from "@/app/(public)/login/two-factor-panels";
import { ContactPageClient } from "@/app/(website)/contact/contact-page-client";
import { BookingRequestRespondClient } from "@/app/(website-dynamic)/booking-requests/respond/[token]/booking-request-respond-client";
import type { ClubIdentity } from "@/config/club-identity-types";

const FAILURE = "The club could not do that just now.";

type Reply = { ok: boolean; status?: number; body: unknown };

// GETs (the password policy, the committee list, the quote) answer `load`;
// every other request is the action under test and answers `action`.
function installFetch(action: Reply, load: unknown = {}) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const isLoad = !init?.method || init.method === "GET";
    const { ok, status = ok ? 200 : 400, body } = isLoad ? { ok: true, body: load } : action;
    return { ok, status, json: async () => body } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function type(label: RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function press(name: RegExp) {
  const button = await screen.findByRole("button", { name });
  button.focus();
  await act(async () => {
    fireEvent.click(button);
  });
}

async function expectFailureAnnounced(id: string, text = FAILURE) {
  const alert = document.getElementById(id);
  expect(alert).toHaveAttribute("role", "alert");
  await waitFor(() => expect(alert).toHaveTextContent(text));
  await expectRecoveryAlertToHoldFocus(alert);
}

afterEach(() => {
  nav.search = "";
  vi.unstubAllGlobals();
});

describe("password and sign-in failures land in a recovery alert that takes focus (#4949)", () => {
  it("forgot password", async () => {
    installFetch({ ok: false, body: { error: FAILURE } });
    render(<ForgotPasswordPage />);
    type(/^Email$/, "member@example.test");
    await press(/Send reset link/i);
    await expectFailureAnnounced("forgot-password-error");
  });

  it("change password, refused by the server", async () => {
    installFetch({ ok: false, body: { error: FAILURE } });
    render(<ChangePasswordPage />);
    type(/Current Password/, "old-password-123");
    type(/^New Password$/, "new-password-1234");
    type(/Confirm New Password/, "new-password-1234");
    await press(/Change Password/);
    await expectFailureAnnounced("change-password-error");
  });

  it("change password, rejected before sending", async () => {
    const fetchMock = installFetch({ ok: true, body: {} });
    render(<ChangePasswordPage />);
    type(/Current Password/, "old-password-123");
    type(/^New Password$/, "new-password-1234");
    type(/Confirm New Password/, "different-password");
    await press(/Change Password/);
    await expectFailureAnnounced("change-password-error", "Passwords do not match.");
    expect(fetchMock).not.toHaveBeenCalledWith("/api/auth/change-password", expect.anything());
  });

  it("reset password, refused by the server", async () => {
    nav.search = "token=reset-token";
    installFetch({ ok: false, body: { error: FAILURE } });
    render(<ResetPasswordPage />);
    type(/^New password$/, "new-password-1234");
    type(/Confirm new password/i, "new-password-1234");
    await press(/Update password/);
    await expectFailureAnnounced("reset-password-error");
  });

  it("two-factor code", async () => {
    installFetch({ ok: false, body: { error: FAILURE } });
    render(<TwoFactorVerifyPanel callbackUrl="/dashboard" enrolledMethod="TOTP" />);
    type(/Two-factor code/, "000000");
    await press(/^Verify$/);
    await expectFailureAnnounced("two-factor-verify-error");
  });
});

describe("reset-password fields name their own error (#4949)", () => {
  it("marks each failing field invalid, reads its error first and focuses the first", async () => {
    nav.search = "token=reset-token";
    const fetchMock = installFetch({ ok: true, body: {} });
    render(<ResetPasswordPage />);
    const password = screen.getByLabelText(/^New password$/);
    const confirm = screen.getByLabelText(/Confirm new password/i);
    expect(password).not.toHaveAttribute("aria-invalid");
    expect(password).toHaveAttribute("aria-describedby", "password-requirements");

    // Submitted directly: a browser's own `required` check would stop the
    // click first, and this pins what the form's own check does.
    type(/^New password$/, "short");
    await act(async () => {
      fireEvent.submit(password.closest("form")!);
    });

    expect(password).toHaveAttribute("aria-invalid", "true");
    expect(password.getAttribute("aria-describedby")?.split(" ")[0]).toBe("password-error");
    expect(password).toHaveAccessibleDescription(/^Password must be at least/);
    expect(confirm).toHaveAttribute("aria-invalid", "true");
    expect(confirm).toHaveAccessibleDescription("Please confirm your new password");
    await waitFor(() => expect(document.activeElement).toBe(password));
    expect(fetchMock).not.toHaveBeenCalledWith("/api/auth/reset-password", expect.anything());

    // Fixing the first field moves focus to the one still failing.
    type(/^New password$/, "new-password-1234");
    type(/Confirm new password/i, "different-password");
    await press(/Update password/);

    expect(password).not.toHaveAttribute("aria-invalid");
    expect(confirm).toHaveAccessibleDescription("Passwords do not match");
    await waitFor(() => expect(document.activeElement).toBe(confirm));
  });
});

const club = { name: "Example Club", publicUrl: "https://example.org", socialLinks: {} } as unknown as ClubIdentity;

async function fillContactForm() {
  render(<ContactPageClient club={club} />);
  type(/^Name$/, "Riley Guest");
  type(/^Email$/, "riley@example.test");
  type(/^Message$/, "Is the lodge open in May?");
  await press(/Send Message/);
}

describe("contact form (#4949)", () => {
  it("announces a failure in a recovery alert that takes focus", async () => {
    installFetch({ ok: false, body: { error: FAILURE } }, { members: [] });
    await fillContactForm();
    await expectFailureAnnounced("contact-form-error");
  });

  it("speaks the confirmation from a region mounted with the form and keeps focus on the page", async () => {
    installFetch({ ok: true, body: {} }, { members: [] });
    render(<ContactPageClient club={club} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("");
    type(/^Name$/, "Riley Guest");
    type(/^Email$/, "riley@example.test");
    type(/^Message$/, "Is the lodge open in May?");
    await press(/Send Message/);

    expect(screen.getByRole("status")).toBe(status);
    expect(status).toHaveTextContent("Message Sent");
    const again = screen.getByRole("button", { name: /Send Another Message/ });
    await waitFor(() => expect(document.activeElement).toBe(again));

    await press(/Send Another Message/);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(/^Name$/)));
  });
});

const quote = {
  requestId: "req_1",
  quoteId: "quote_1",
  version: 1,
  type: "GENERAL",
  schoolName: null,
  lodgeName: null,
  contactFirstName: "Riley",
  checkIn: "2026-08-01",
  checkOut: "2026-08-03",
  guestCount: 2,
  message: null,
  expiresAt: "2026-07-10T00:00:00.000Z",
  accepted: false,
  acceptedQuoteOptionId: null,
  acceptedPriceCents: null,
  declinedAfterAcceptance: false,
  declineReason: null,
  declinedAt: null,
  options: [
    { id: "opt_1", label: "Option A", cateringOption: null, totalCents: 12000, guestBreakdown: [] },
  ],
};

describe("booking-request reply (#4949)", () => {
  it("announces a failure in a recovery alert that takes focus", async () => {
    installFetch({ ok: false, body: { error: FAILURE } }, quote);
    render(<BookingRequestRespondClient token="tok" />);
    await press(/Send Question/);
    await expectFailureAnnounced("booking-request-respond-error");
  });

  it.each([
    [{ outcome: "query_sent" }, /Send Question/, "Question sent."],
    [{ outcome: "accepted", acceptedQuoteOptionId: "opt_1" }, /Accept Quote/, "Your quote has been accepted."],
  ])("speaks the outcome that replaces the form (%o)", async (reply, trigger, text) => {
    installFetch({ ok: true, body: reply }, quote);
    render(<BookingRequestRespondClient token="tok" />);
    await screen.findByRole("button", { name: trigger });
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("");

    await press(trigger);

    expect(screen.getByRole("status")).toBe(status);
    expect(status).toHaveTextContent(text);
  });
});
