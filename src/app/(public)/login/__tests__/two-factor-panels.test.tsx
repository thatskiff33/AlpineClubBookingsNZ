// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
