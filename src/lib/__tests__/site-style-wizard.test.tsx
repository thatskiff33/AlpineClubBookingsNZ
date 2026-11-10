// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SiteStyleWizard } from "@/app/(admin)/admin/website/site-style/site-style-wizard";
import {
  DEFAULT_CLUB_THEME_VALUES,
  type ClubThemeValues,
} from "@/lib/club-theme-schema";

const fetchMock = vi.fn();
const refreshMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

// The wizard now gates its controls on content:edit (#1927); render as a
// content:edit admin so these existing behaviour tests keep exercising the
// editable path.
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        id: "admin-1",
        adminPermissionMatrix: {
          overview: "edit",
          bookings: "edit",
          membership: "edit",
          finance: "edit",
          lodge: "edit",
          content: "edit",
          support: "edit",
        },
      },
    },
  }),
}));

function responseTheme(values: ClubThemeValues, completedAt: string | null) {
  return {
    theme: {
      ...values,
      completedAt,
      contrastWarnings: [],
    },
  };
}

// Full-wizard jsdom renders routinely exceed vitest's 5s default under
// parallel full-suite load; same ceiling as site-style-wizard-upload.test.tsx.
vi.setConfig({ testTimeout: 45_000 });

describe("site style wizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = fetchMock as typeof fetch;
    fetchMock.mockImplementation(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(
          String(init?.body ?? "{}"),
        ) as ClubThemeValues & {
          completeSetup?: boolean;
        };
        return {
          ok: true,
          json: async () =>
            responseTheme(
              {
                brandGold: body.brandGold,
                brandDeep: body.brandDeep,
                brandSafety: body.brandSafety,
                headingFontKey: body.headingFontKey,
                bodyFontKey: body.bodyFontKey,
                logoUrl: body.logoUrl,
                logoDataUrl: body.logoDataUrl,
                rawCss: body.rawCss ?? "",
              },
              body.completeSetup ? "2026-06-11T12:00:00.000Z" : null,
            ),
        };
      },
    );
  });

  it("saves each step and finishes setup", async () => {
    render(
      <SiteStyleWizard
        initialTheme={{
          ...DEFAULT_CLUB_THEME_VALUES,
          completedAt: null,
          contrastWarnings: [],
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save and next" }));
    await screen.findByRole("heading", { name: "Fonts" });

    fireEvent.click(screen.getByRole("button", { name: "Save and next" }));
    await screen.findByRole("heading", { name: "Raw CSS" });

    fireEvent.click(screen.getByRole("button", { name: "Save and next" }));
    await screen.findByRole("heading", { name: "Logo" });

    fireEvent.click(screen.getByRole("button", { name: "Save and next" }));
    await screen.findByRole("heading", { name: "Review" });

    fireEvent.click(screen.getByRole("button", { name: "Finish setup" }));

    await waitFor(() => {
      expect(screen.getByText("Site style is complete.")).toBeTruthy();
    });
    const lastCallBody = JSON.parse(
      String(fetchMock.mock.calls.at(-1)?.[1]?.body ?? "{}"),
    );
    expect(lastCallBody.completeSetup).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(refreshMock).toHaveBeenCalledTimes(5);
  }, 45_000);

  it("explains and previews the editable brand and fixed semantic layers", () => {
    render(
      <SiteStyleWizard
        initialTheme={{
          ...DEFAULT_CLUB_THEME_VALUES,
          completedAt: "2026-07-12T00:00:00.000Z",
          contrastWarnings: [],
        }}
      />,
    );

    expect(screen.getByText("Editable brand layer")).toBeTruthy();
    expect(screen.getByText("Fixed semantic layer")).toBeTruthy();
    expect(screen.getByText("Member + admin app preview")).toBeTruthy();
    expect(screen.getByText("Success")).toBeTruthy();
    expect(screen.getByText("Danger")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-label")).toBe(
      "Occupancy: 18 of 30 bunks filled",
    );
  });

  it("keeps Save enabled and discloses generator adjustments instead of blocking on contrast (#2187)", async () => {
    render(
      <SiteStyleWizard
        initialTheme={{
          ...DEFAULT_CLUB_THEME_VALUES,
          completedAt: null,
          contrastWarnings: [],
        }}
      />,
    );

    // A near-identical accent/neutral pair that the old blocking contrast gate
    // ("Contrast too low to save") would have rejected. Contrast is now
    // guaranteed by construction, so the seed is adjusted, never blocked.
    fireEvent.change(screen.getByLabelText("Neutral character value"), {
      target: { value: DEFAULT_CLUB_THEME_VALUES.brandGold },
    });

    // The generator's accessibility nudge is disclosed (before → after), and
    // the palette still saves — Save stays enabled.
    await screen.findByText(/Colours adjusted for accessibility/);
    expect(
      (screen.getByRole("button", { name: "Save and next" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});
