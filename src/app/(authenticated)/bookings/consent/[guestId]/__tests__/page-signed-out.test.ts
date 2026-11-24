// #5266 (`INV-ADDPAY-034`): the delegate consent page only explains a removed
// booking to a signed-in target or accepted family adult. A signed-out visitor
// is sent to sign in before the page asks anything about the guest link, so
// the link itself tells them nothing, removed or not.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  resolve: vi.fn(),
  clubTimeZone: vi.fn(),
  clubFormatValues: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/member-guest-delegate-page", () => ({
  resolveDelegateConsentPageState: mocks.resolve,
}));
vi.mock("@/lib/club-time/server", () => ({ clubTimeZone: mocks.clubTimeZone }));
vi.mock("@/lib/club-format-server", () => ({ clubFormatValues: mocks.clubFormatValues }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
}));

import DelegateConsentPage from "../page";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a signed-out visitor on the delegate consent page (#5266)", () => {
  it("is sent to sign in without the guest link being resolved", async () => {
    mocks.auth.mockResolvedValue(null);
    await expect(
      DelegateConsentPage({ params: Promise.resolve({ guestId: "guest-on-removed-booking" }) }),
    ).rejects.toThrow("redirect:/login");
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.clubTimeZone).not.toHaveBeenCalled();
  });
});
