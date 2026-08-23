// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppProviders } from "@/components/app-providers";
import { AppProvidersClient } from "@/components/app-providers-client";
import { AppThemeProvider } from "@/components/app-theme-provider";
import {
  ThemeSwitcher,
  UI_THEME_STORAGE_KEY,
} from "@/components/theme-switcher";
import type { ClubIdentity } from "@/config/club-identity-types";

const {
  setThemeMock,
  themeProviderMock,
  useThemeMock,
} = vi.hoisted(() => ({
  setThemeMock: vi.fn(),
  themeProviderMock: vi.fn(({ children }: { children: ReactNode }) => children),
  useThemeMock: vi.fn(),
}));

vi.mock("next-auth/react", () => ({
  SessionProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("next-themes", () => ({
  ThemeProvider: themeProviderMock,
  useTheme: useThemeMock,
}));

vi.mock("@/components/ui/sonner", () => ({
  Toaster: () => <div data-testid="toaster" />,
}));

/*
  `app-providers.tsx` became an async SERVER component in CT-4 (#2870) whose one
  job is to `await` the club's PERSISTED timezone. That reader reaches Prisma
  through `server-only`, so it is replaced here with a fixed answer the assertion
  below can name.
*/
const PERSISTED_CLUB_ZONE = "America/Denver";

vi.mock("@/lib/club-time/server", () => ({
  clubTimeZone: async () => PERSISTED_CLUB_ZONE,
}));

const testClubIdentity: ClubIdentity = {
  bookingsName: "Example Bookings",
  contactEmail: "contact@example.org",
  emailFromName: "Example Club",
  hutLeaderLabel: "Hut Leader",
  lodgeCapacity: 20,
  lodgeName: "Example Lodge",
  lodgeTravelNote: "Allow travel time.",
  name: "Example Club",
  publicHost: "example.org",
  publicUrl: "https://example.org",
  shortName: "Example",
  socialLinks: {},
  supportEmail: "support@example.org",
};

describe("AppThemeProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useThemeMock.mockReturnValue({
      setTheme: setThemeMock,
      theme: "system",
    });
  });

  it("configures next-themes with browser storage and CSP nonce support", () => {
    render(
      <AppThemeProvider nonce="nonce-123">
        <span>themed content</span>
      </AppThemeProvider>
    );

    expect(themeProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        attribute: "class",
        defaultTheme: "system",
        disableTransitionOnChange: true,
        enableColorScheme: true,
        enableSystem: true,
        nonce: "nonce-123",
        storageKey: UI_THEME_STORAGE_KEY,
      }),
      undefined
    );
  });

  it("passes the route layout CSP nonce through AppProvidersClient", async () => {
    /*
      CT-4 (#2870) split `AppProviders` in two: an async SERVER component that
      resolves the club's persisted timezone, and this client shell holding the
      provider stack. The nonce pass-through asserted here lives in the SHELL, and
      Testing Library cannot render a server component, so this test names the
      half it renders. The hop between the two is asserted by the test below —
      without it, deleting `nonce={nonce}` from the server half was a lint warning
      and nothing else.
    */
    render(
      <AppProvidersClient
        clubIdentity={testClubIdentity}
        clubTimeZone="Pacific/Auckland"
        nonce="layout-nonce"
      >
        <span>page content</span>
      </AppProvidersClient>
    );

    expect(themeProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        nonce: "layout-nonce",
        storageKey: UI_THEME_STORAGE_KEY,
      }),
      undefined
    );
  });

  it("hands the client shell the persisted zone, the identity and the nonce", async () => {
    /*
      THE SERVER-TO-CLIENT HOP, which is the only thing `app-providers.tsx` does
      and was the one part of the split nothing covered. It is CALLED rather than
      rendered — an async server component returns a promise, which Testing
      Library cannot take — and the element it returns is inspected directly.

      All three props are asserted together because dropping any one of them is
      silent otherwise: a missing `nonce` costs a lint WARNING and a clean
      typecheck (the prop is optional, because a layout may legitimately have no
      nonce), a missing `clubIdentity` is a type error but a WRONG one is not, and
      a `clubTimeZone` that stopped coming from `@/lib/club-time/server` would put
      every browser in this application on the wrong civil time (INV-CONFIG-002).
    */
    const element = await AppProviders({
      clubIdentity: testClubIdentity,
      nonce: "layout-nonce",
      children: <span>page content</span>,
    });

    expect(element.type).toBe(AppProvidersClient);
    expect(element.props).toMatchObject({
      clubIdentity: testClubIdentity,
      clubTimeZone: PERSISTED_CLUB_ZONE,
      nonce: "layout-nonce",
    });
  });
});

describe("ThemeSwitcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useThemeMock.mockReturnValue({
      setTheme: setThemeMock,
      theme: "dark",
    });
  });

  it("renders Light, Dark, and Follow system choices", () => {
    render(<ThemeSwitcher />);

    expect(screen.getByRole("radio", { name: "Light" })).toBeTruthy();
    expect(
      screen.getByRole("radio", { name: "Dark" }).getAttribute("aria-checked")
    ).toBe("true");
    expect(
      screen.getByRole("radio", { name: "Follow system" })
    ).toBeTruthy();
  });

  it("updates next-themes when a choice is selected", () => {
    render(<ThemeSwitcher />);

    fireEvent.click(screen.getByRole("radio", { name: "Light" }));

    expect(setThemeMock).toHaveBeenCalledWith("light");
  });
});
