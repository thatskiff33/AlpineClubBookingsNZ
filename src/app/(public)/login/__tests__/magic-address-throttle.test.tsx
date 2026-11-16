// @vitest-environment jsdom
import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const { signIn } = vi.hoisted(() => ({ signIn: vi.fn() }));
vi.mock("next-auth/react", () => ({ signIn }));
// Follow the live URL, as Next does after replaceState, so the scrubbed token is
// gone from the search params and only the page's in-memory copy can retry it.
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

import MagicLinkPage from "../magic/page";
import { ADDRESS_THROTTLED_CODE, ADDRESS_THROTTLED_MESSAGE } from "@/lib/login-throttle-policy";

beforeEach(() => {
  vi.resetAllMocks();
  window.history.replaceState(null, "", "/login/magic?token=unused-test-token");
});

it("shows a network wait and lets the member retry the unconsumed token from memory", async () => {
  signIn.mockResolvedValueOnce({ error: ADDRESS_THROTTLED_CODE, code: ADDRESS_THROTTLED_CODE })
    .mockResolvedValueOnce({ error: "CredentialsSignin", code: "PASSWORD_CHANGE_REQUIRED" });
  render(<StrictMode><MagicLinkPage /></StrictMode>);
  expect(await screen.findByText(ADDRESS_THROTTLED_MESSAGE)).toBeTruthy();
  // #4951: the paused screen is a single card, so its title is the page's one h1.
  expect(
    screen.getAllByRole("heading", { level: 1 }).map((heading) => heading.textContent)
  ).toEqual(["Sign-in temporarily paused"]);
  expect(screen.queryByText(/expired|invalid|didn't work/i)).toBeNull();
  expect(window.location.search).toBe("");
  expect(signIn).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Set a new password to continue")).toBeTruthy();
  expect(signIn).toHaveBeenNthCalledWith(2, "magic-link", { token: "unused-test-token", redirect: false });
});

it("still describes an invalid token as invalid", async () => {
  signIn.mockResolvedValue({ error: "CredentialsSignin", code: "credentials" });
  render(<MagicLinkPage />);
  await waitFor(() => expect(screen.getByText(/may have expired/i)).toBeTruthy());
  expect(screen.queryByText(ADDRESS_THROTTLED_MESSAGE)).toBeNull();
});
