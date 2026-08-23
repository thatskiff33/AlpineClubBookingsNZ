// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

  it("passes the route layout CSP nonce through AppProviders", async () => {
    render(
      /*
        CT-4 (#2870) split `AppProviders` in two: an async SERVER component that
        resolves the club's persisted timezone, and this client shell holding the
        provider stack. The nonce pass-through being asserted here lives in the
        shell, and a server component cannot be rendered by Testing Library, so
        the test points at the half that owns the behaviour.
      */
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
