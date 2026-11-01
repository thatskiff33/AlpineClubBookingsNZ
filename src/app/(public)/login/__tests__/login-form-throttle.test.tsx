// @vitest-environment jsdom

import { render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// #4609: a throttled password attempt shows one fixed wait message, the same
// for every account, pointing at any other sign-in way the club has on.
const { mockSignIn } = vi.hoisted(() => ({ mockSignIn: vi.fn() }));
vi.mock("next-auth/react", () => ({ signIn: mockSignIn }));
vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ name: "Test Club" }),
}));

import { LoginForm } from "@/app/(public)/login/login-form";
import { LOGIN_THROTTLED_CODE } from "@/lib/login-throttle-policy";

function renderForm(props: Partial<React.ComponentProps<typeof LoginForm>> = {}) {
  return render(
    <LoginForm verified={false} emailChanged={false} redirectTo="/dashboard" {...props} />,
  );
}

function submit() {
  // The password form's own field; the magic-link form has an email box too.
  fireEvent.change(document.getElementById("email")!, {
    target: { value: "treasurer@example.org" },
  });
  fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: "pw" } });
  fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));
}

const WAIT = /too many sign-in attempts for this account\. please wait a few minutes and try again/i;
const OTHER_WAY = /or use another way to sign in below/i;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("LoginForm — per-account throttle message (#4609)", () => {
  it("shows the fixed wait message for the throttled code", async () => {
    mockSignIn.mockResolvedValue({ error: "CredentialsSignin", code: LOGIN_THROTTLED_CODE });
    renderForm();
    submit();
    expect(await screen.findByText(WAIT)).toBeTruthy();
    expect(screen.queryByText(OTHER_WAY)).toBeNull();
  });

  it.each([
    [{ magicLinkEnabled: true }],
    [{ googleLoginEnabled: true }],
  ])("points to another way in when one is on (%o)", async (props) => {
    mockSignIn.mockResolvedValue({ error: "CredentialsSignin", code: LOGIN_THROTTLED_CODE });
    renderForm(props);
    submit();
    expect(await screen.findByText(OTHER_WAY)).toBeTruthy();
  });

  it("keeps the generic message for a wrong password", async () => {
    mockSignIn.mockResolvedValue({ error: "CredentialsSignin", code: "credentials" });
    renderForm({ magicLinkEnabled: true });
    submit();
    expect(await screen.findByText(/invalid email or password/i)).toBeTruthy();
    expect(screen.queryByText(WAIT)).toBeNull();
  });
});
