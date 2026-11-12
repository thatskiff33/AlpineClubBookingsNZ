// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import QRCode from "qrcode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Keep a soft-navigation regression observable without needing a Next router.
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));

import {
  TwoFactorEnrollPanel,
  TwoFactorVerifyPanel,
} from "@/app/(public)/login/two-factor-panels";

const replaceDocument = vi.fn();
const originalLocation = window.location;
const setup = {
  secret: "TESTSETUPKEY",
  otpauthUrl: "otpauth://totp/Test?secret=TESTSETUPKEY",
  issuer: "Test",
  label: "Test member",
};
const recoveryCodes = ["recovery-one", "recovery-two"];
const deepLink = "/bookings/example?tab=guests&return=%2Fdashboard#party";
const privateInvite = "/family-invite/private-test-token";

function response(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { replace: replaceDocument },
  });
});

afterEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
  vi.unstubAllGlobals();
});

function expectPrivateDestinationAbsent(container: HTMLElement) {
  for (const element of container.querySelectorAll("*")) {
    for (const attribute of element.attributes) {
      expect(attribute.value).not.toContain(privateInvite);
    }
  }
  expect(container.textContent).not.toContain(privateInvite);
}

describe("two-factor enrollment completion", () => {
  it.each(["TOTP", "EMAIL"] as const)(
    "%s retains recovery codes until Continue replaces the document with the exact server destination",
    async (method) => {
      const fetchMock = vi.fn(async (url: string) =>
        response(url.endsWith("/totp/setup") ? setup : { recoveryCodes }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const { container } = render(<TwoFactorEnrollPanel callbackUrl={deepLink} />);
      await screen.findByText(setup.secret);
      if (method === "EMAIL") {
        fireEvent.click(screen.getByRole("button", { name: "Email" }));
      }
      fireEvent.change(screen.getByLabelText(method === "TOTP" ? "Authenticator code" : "Email code"), {
        target: { value: "123456" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Enroll" }));

      await screen.findByRole("heading", { name: "Save your recovery codes" });
      for (const code of recoveryCodes) expect(screen.getByText(code)).toBeVisible();
      expect(replaceDocument).not.toHaveBeenCalled();
      expect(container.querySelector(`[href="${deepLink}"]`)).toBeNull();
      expect(fetchMock).toHaveBeenCalledWith(`/api/auth/2fa/enroll/${method.toLowerCase()}`, expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
      }));

      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      expect(replaceDocument).toHaveBeenCalledExactlyOnceWith(deepLink);
    },
  );

  it("keeps a private invite destination out of recovery-screen attributes", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      response(url.endsWith("/totp/setup") ? setup : { recoveryCodes }),
    ));
    const { container } = render(<TwoFactorEnrollPanel callbackUrl={privateInvite} />);
    await screen.findByText(setup.secret);
    fireEvent.change(screen.getByLabelText("Authenticator code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
    await screen.findByRole("heading", { name: "Save your recovery codes" });
    expectPrivateDestinationAbsent(container);
    expect(replaceDocument).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(replaceDocument).toHaveBeenCalledExactlyOnceWith(privateInvite);
  });

  it.each(["rejected", "network"] as const)("does not navigate after %s enrollment", async (failure) => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/totp/setup")) return response(setup);
      if (failure === "network") throw new Error("Network unavailable");
      return response({ error: "Invalid code" }, false);
    }));
    render(<TwoFactorEnrollPanel callbackUrl={deepLink} />);
    await screen.findByText(setup.secret);
    fireEvent.change(screen.getByLabelText("Authenticator code"), { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
    await screen.findByText(failure === "network" ? "Network unavailable" : "Invalid code");
    expect(screen.getByLabelText("Authenticator code")).toHaveValue("000000");
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(replaceDocument).not.toHaveBeenCalled();
  });
});

describe("two-factor verification completion", () => {
  it.each(["TOTP", "EMAIL", "RECOVERY"] as const)(
    "%s replaces the document only after an accepted response",
    async (method) => {
      let accept!: (value: Response) => void;
      const pending = new Promise<Response>((resolve) => { accept = resolve; });
      const fetchMock = vi.fn(() => pending);
      vi.stubGlobal("fetch", fetchMock);
      render(<TwoFactorVerifyPanel callbackUrl={deepLink} enrolledMethod={method === "EMAIL" ? "EMAIL" : "TOTP"} />);
      if (method === "RECOVERY") fireEvent.click(screen.getByRole("button", { name: "Recovery" }));
      const code = method === "RECOVERY" ? recoveryCodes[0] : "123456";
      fireEvent.change(screen.getByLabelText(method === "RECOVERY" ? "Recovery code" : "Two-factor code"), {
        target: { value: code },
      });
      fireEvent.click(screen.getByRole("button", { name: "Verify" }));
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/auth/2fa/verify", expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({ method, code }),
      }));
      expect(screen.getByRole("button", { name: "Verify" })).toBeDisabled();
      expect(replaceDocument).not.toHaveBeenCalled();

      await act(async () => { accept(response({ success: true })); });
      expect(replaceDocument).toHaveBeenCalledExactlyOnceWith(deepLink);
    },
  );

  it("replaces a private invite destination without rendering it into attributes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ success: true })));
    const { container } = render(<TwoFactorVerifyPanel callbackUrl={privateInvite} enrolledMethod="TOTP" />);
    expectPrivateDestinationAbsent(container);
    fireEvent.change(screen.getByLabelText("Two-factor code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() => expect(replaceDocument).toHaveBeenCalledExactlyOnceWith(privateInvite));
    expectPrivateDestinationAbsent(container);
  });

  it.each(["rejected", "network"] as const)("retains the correction flow after %s verification", async (failure) => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => {
        if (failure === "network") throw new Error("Network unavailable");
        return response({ error: "Invalid code" }, false);
      })
      .mockResolvedValueOnce(response({ success: true }));
    vi.stubGlobal("fetch", fetchMock);
    render(<TwoFactorVerifyPanel callbackUrl={deepLink} enrolledMethod="TOTP" />);
    fireEvent.change(screen.getByLabelText("Two-factor code"), { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    await screen.findByText(failure === "network" ? "Network unavailable" : "Invalid code");
    expect(screen.getByLabelText("Two-factor code")).toHaveValue("000000");
    expect(replaceDocument).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Two-factor code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() => expect(replaceDocument).toHaveBeenCalledExactlyOnceWith(deepLink));
    expect(screen.queryByText(/Invalid code|Network unavailable/)).toBeNull();
  });
});

describe("retired recovery codes notice on the sign-in challenge (#4456)", () => {
  it("tells the member their saved codes no longer work and how to sign in instead", () => {
    render(<TwoFactorVerifyPanel callbackUrl={deepLink} enrolledMethod="EMAIL" recoveryCodesRetired />);
    const notice = screen.getByTestId("retired-recovery-codes-notice");
    expect(notice).toHaveTextContent("Your saved recovery codes no longer work");
    expect(notice).toHaveTextContent("Sign in with your email code, then generate new recovery codes from your profile.");
  });

  it("shows nothing when the member's codes still work", () => {
    render(<TwoFactorVerifyPanel callbackUrl={deepLink} enrolledMethod="TOTP" />);
    expect(screen.queryByTestId("retired-recovery-codes-notice")).toBeNull();
  });
});

describe("passkey on the sign-in challenge (#4617)", () => {
  it("shows Use your passkey beside the app code", () => {
    render(<TwoFactorVerifyPanel callbackUrl={deepLink} enrolledMethod="TOTP" hasPasskey />);
    expect(screen.getByRole("button", { name: "Use your passkey" })).toBeVisible();
    expect(screen.getByLabelText("Two-factor code")).toBeVisible();
  });

  it("shows only the passkey when no app or email method is enrolled", () => {
    render(<TwoFactorVerifyPanel callbackUrl={deepLink} enrolledMethod={null} hasPasskey />);
    expect(screen.getByRole("button", { name: "Use your passkey" })).toBeVisible();
    expect(screen.queryByLabelText("Two-factor code")).toBeNull();
    expect(screen.queryByRole("button", { name: "Verify" })).toBeNull();
  });
});

// A browser's implicit submission (#4952): Enter in a field clicks the form's
// default button — its first submit button — and does nothing when that button
// is disabled or there is no form. jsdom does not do this on a key press.
function pressEnterIn(field: HTMLElement) {
  const form = (field as HTMLInputElement).form;
  const defaultButton = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (defaultButton && !defaultButton.disabled) fireEvent.click(defaultButton);
}

describe("method choice is announced, not only shaded (#4952)", () => {
  it("names the enrolment group and marks the chosen method pressed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(setup)));
    render(<TwoFactorEnrollPanel callbackUrl={deepLink} />);
    const group = screen.getByRole("group", { name: "Verification method" });
    const app = within(group).getByRole("button", { name: "App" });
    const email = within(group).getByRole("button", { name: "Email" });
    expect(app).toHaveAttribute("aria-pressed", "true");
    expect(email).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(email);
    expect(app).toHaveAttribute("aria-pressed", "false");
    expect(email).toHaveAttribute("aria-pressed", "true");
    expect(within(email).getByText("Selected")).toBeVisible();
    await screen.findByLabelText("Email code");
  });

  it("names the sign-in group and moves pressed to Recovery", () => {
    render(<TwoFactorVerifyPanel callbackUrl={deepLink} enrolledMethod="EMAIL" hasPasskey />);
    const group = screen.getByRole("group", { name: "Verification method" });
    const email = within(group).getByRole("button", { name: "Email" });
    const recovery = within(group).getByRole("button", { name: "Recovery" });
    expect(email).toHaveAttribute("aria-pressed", "true");
    expect(recovery).toHaveAttribute("aria-pressed", "false");
    expect(within(group).queryByRole("button", { name: "Use your passkey" })).toBeNull();

    fireEvent.click(recovery);
    expect(email).toHaveAttribute("aria-pressed", "false");
    expect(recovery).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Recovery code")).toBeVisible();
  });
});

describe("authenticator setup QR code (#4952)", () => {
  it("draws the exact otpauth URL locally once setup loads and keeps the labelled key", async () => {
    const fetchMock = vi.fn(async () => response(setup));
    vi.stubGlobal("fetch", fetchMock);
    render(<TwoFactorEnrollPanel callbackUrl={deepLink} />);
    expect(screen.queryByRole("img")).toBeNull();

    const qr = await screen.findByRole("img", { name: "QR code to scan with your authenticator app" });
    const expected = await QRCode.toDataURL(setup.otpauthUrl, { width: 192, margin: 4 });
    expect(qr).toHaveAttribute("src", expected);
    expect(screen.getByLabelText("Or type this setup key")).toHaveTextContent(setup.secret);
    // The secret reaches no server but the setup endpoint it came from.
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/auth/2fa/totp/setup", expect.anything());
  });
});

describe("Enter submits the code (#4952)", () => {
  it.each(["TOTP", "EMAIL"] as const)("enrols %s once per Enter", async (method) => {
    const fetchMock = vi.fn(async (url: string) =>
      response(url.endsWith("/totp/setup") ? setup : { recoveryCodes }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<TwoFactorEnrollPanel callbackUrl={deepLink} />);
    await screen.findByText(setup.secret);
    if (method === "EMAIL") fireEvent.click(screen.getByRole("button", { name: "Email" }));
    const field = screen.getByLabelText(method === "TOTP" ? "Authenticator code" : "Email code");
    fireEvent.change(field, { target: { value: "123456" } });

    pressEnterIn(field);
    pressEnterIn(field);
    // A submit that skips the disabled button, as a fast double Enter can.
    fireEvent.submit(field.closest("form")!);

    await screen.findByRole("heading", { name: "Save your recovery codes" });
    const enrolCalls = fetchMock.mock.calls.filter(([url]) => url.includes("/enroll/"));
    expect(enrolCalls).toEqual([[`/api/auth/2fa/enroll/${method.toLowerCase()}`, expect.anything()]]);
  });

  it("does not enrol on Enter before the setup key has loaded", () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    render(<TwoFactorEnrollPanel callbackUrl={deepLink} />);
    const field = screen.getByLabelText("Authenticator code");
    fireEvent.change(field, { target: { value: "123456" } });
    pressEnterIn(field);
    fireEvent.submit(field.closest("form")!);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/auth/2fa/totp/setup", expect.anything());
  });

  it("keeps Send email code from submitting the enrolment", async () => {
    const fetchMock = vi.fn(async (url: string) => response(url.endsWith("/totp/setup") ? setup : {}));
    vi.stubGlobal("fetch", fetchMock);
    render(<TwoFactorEnrollPanel callbackUrl={deepLink} />);
    await screen.findByText(setup.secret);
    fireEvent.click(screen.getByRole("button", { name: "Email" }));
    fireEvent.click(screen.getByRole("button", { name: "Send email code" }));
    await screen.findByRole("button", { name: "Send another code" });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/auth/2fa/totp/setup",
      "/api/auth/2fa/email/send",
    ]);
  });

  it("verifies once per Enter and not again while the first is in flight", () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    render(<TwoFactorVerifyPanel callbackUrl={deepLink} enrolledMethod="TOTP" />);
    const field = screen.getByLabelText("Two-factor code");
    fireEvent.change(field, { target: { value: "123456" } });

    pressEnterIn(field);
    pressEnterIn(field);
    fireEvent.submit(field.closest("form")!);

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/auth/2fa/verify", expect.objectContaining({
      body: JSON.stringify({ method: "TOTP", code: "123456" }),
    }));
  });

  it("keeps Send email code from submitting the sign-in", async () => {
    const fetchMock = vi.fn(async () => response({}));
    vi.stubGlobal("fetch", fetchMock);
    render(<TwoFactorVerifyPanel callbackUrl={deepLink} enrolledMethod="EMAIL" />);
    fireEvent.click(screen.getByRole("button", { name: "Send email code" }));
    await screen.findByRole("button", { name: "Send another code" });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/auth/2fa/email/send", expect.anything());
  });
});
