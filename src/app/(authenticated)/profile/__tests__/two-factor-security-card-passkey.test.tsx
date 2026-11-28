// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ startRegistration: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@simplewebauthn/browser", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@simplewebauthn/browser")),
  startRegistration: mocks.startRegistration,
}));

import { WebAuthnError } from "@simplewebauthn/browser";

import { TwoFactorSecurityCard } from "@/app/(authenticated)/profile/two-factor-security-card";
import { NON_DISCOVERABLE_PASSKEY_ERROR } from "@/lib/second-factor-enrolment";

describe("profile passkey card: a key that cannot store a passkey (#4620)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
    );
  });

  it("says so in the club's words when the browser refuses the key", async () => {
    mocks.startRegistration.mockRejectedValue(
      new WebAuthnError({
        message:
          "Discoverable credentials were required but no available authenticator supported it",
        code: "ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT",
        cause: new Error("ConstraintError"),
      }),
    );
    render(<TwoFactorSecurityCard enabled={false} method={null} moduleEnabled passkeys={[]} />);

    fireEvent.click(screen.getByRole("button", { name: "Add passkey" }));

    expect(await screen.findByText(NON_DISCOVERABLE_PASSKEY_ERROR)).toBeInTheDocument();
    expect(screen.getByRole("alert")).not.toHaveTextContent("Discoverable credentials");
  });

  it("keeps the browser's own message for any other refusal", async () => {
    mocks.startRegistration.mockRejectedValue(new Error("The request was cancelled."));
    render(<TwoFactorSecurityCard enabled={false} method={null} moduleEnabled passkeys={[]} />);

    fireEvent.click(screen.getByRole("button", { name: "Add passkey" }));

    expect(await screen.findByText("The request was cancelled.")).toBeInTheDocument();
  });
});
