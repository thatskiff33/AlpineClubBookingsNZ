import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";

const { mockAuth, mockFindUnique, mockRedirect } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockFindUnique: vi.fn(),
  mockRedirect: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: () => mockAuth(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findUnique: mockFindUnique,
    },
    clubTheme: {
      findUnique: vi.fn(async () => null),
    },
  },
}));

// The layout now loads the app fonts and injects the club theme (#2102); stub
// the font loader so importing it stays light and does not pull in
// next/font/google under vitest.
vi.mock("@/lib/club-theme-fonts", () => ({
  clubThemeFontVariableClassName: "font-vars",
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => mockRedirect(path),
}));

// #3228 — `cookies` as well as `headers`. The layout now reads the hut-leader
// PIN session cookie so it can arm the interaction-renewal provider for the
// whole lodge area (the kiosk AND the roster wizard), and that reader goes
// through `next/headers`. With only `headers` mocked the whole file died at
// import; an empty cookie store is the right answer for a suite about auth
// redirects, and it means the real reader runs and returns "no session".
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
  cookies: vi.fn(async () => ({ get: () => undefined })),
}));

vi.mock("@/components/app-providers", () => ({
  AppProviders: ({ children }: { children: ReactNode }) => children,
}));

// The layout now resolves DB-first club identity via the tagged public-layout
// cache (E3 #1929). Its real module imports "server-only" (which vitest cannot
// resolve); stub the accessor with the config identity — the same value the
// layout used before it moved to the DB-first accessor.
vi.mock("@/lib/public-layout-config", async () => {
  const { clubIdentity } = await import("@/config/club-identity");
  return { getCachedClubIdentity: vi.fn(async () => clubIdentity) };
});

describe("lodge layout authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedirect.mockImplementation((path: string) => {
      throw new Error(`redirect:${path}`);
    });
  });

  it("redirects anonymous users to login before rendering lodge pages", async () => {
    mockAuth.mockResolvedValue(null);

    const { default: LodgeLayout } = await import("@/app/(lodge)/layout");

    await expect(LodgeLayout({ children: "secure" })).rejects.toThrow(
      "redirect:/login?callbackUrl=%2Flodge%2Fkiosk"
    );
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it("renders lodge pages for an active authenticated user", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "lodge-1", role: "LODGE", accessRoles: [{ role: "LODGE" }] },
    });
    mockFindUnique.mockResolvedValue({
      active: true,
      forcePasswordChange: false,
    });

    const { default: LodgeLayout } = await import("@/app/(lodge)/layout");
    const result = await LodgeLayout({ children: "secure" });
    const layoutShell = (result as ReactElement<{ children: ReactElement }>).props
      .children;

    // The shell now injects the club theme <style> ahead of the page children
    // (#2102), so children is [themeStyle, page].
    const shellChildren = (layoutShell.props as { children: unknown[] }).children;
    const [themeStyle, pageChildren] = shellChildren as [
      ReactElement<{ "data-site-style"?: string }>,
      unknown,
    ];
    expect(themeStyle.props["data-site-style"]).toBe("club-theme");

    /*
      #3228 — the page now sits inside `LodgePinSessionProvider`, and that is
      load-bearing rather than incidental. It is the ONE mount point for the
      hut-leader PIN session's interaction renewal, and this layout is where it
      belongs because it is the only ancestor shared by the two pages a hut
      leader's authority covers: the kiosk, and the chore-roster wizard a full
      navigation away. Mount it on either page instead and the other silently
      stops renewing — which is what the first cut of #3228 did, and what a
      reviewer rather than a test caught.

      `initialActive` comes from the server's own look at the cookie, which is
      what arms renewal across that navigation. False here: this suite's cookie
      store is empty.
    */
    const provider = pageChildren as ReactElement<{
      initialActive: boolean;
      children: unknown;
    }>;
    expect(provider.props.initialActive).toBe(false);
    expect(provider.props.children).toBe("secure");
  });

  it("redirects inactive authenticated users back to login", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "lodge-1", role: "LODGE", accessRoles: [{ role: "LODGE" }] },
    });
    mockFindUnique.mockResolvedValue({
      active: false,
      forcePasswordChange: false,
    });

    const { default: LodgeLayout } = await import("@/app/(lodge)/layout");

    await expect(LodgeLayout({ children: "secure" })).rejects.toThrow(
      "redirect:/login"
    );
  });

  it("redirects authenticated users who must change their password", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "lodge-1", role: "LODGE", accessRoles: [{ role: "LODGE" }] },
    });
    mockFindUnique.mockResolvedValue({
      active: true,
      forcePasswordChange: true,
    });

    const { default: LodgeLayout } = await import("@/app/(lodge)/layout");

    await expect(LodgeLayout({ children: "secure" })).rejects.toThrow(
      "redirect:/change-password"
    );
  });
});
