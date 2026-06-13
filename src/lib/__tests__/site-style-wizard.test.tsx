// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SiteStyleWizard } from "@/app/(admin)/admin/site-style/site-style-wizard";
import {
  DEFAULT_CLUB_THEME_VALUES,
  type ClubThemeValues,
} from "@/lib/club-theme-schema";

const fetchMock = vi.fn();

function responseTheme(values: ClubThemeValues, completedAt: string | null) {
  return {
    theme: {
      ...values,
      completedAt,
      contrastWarnings: [],
    },
  };
}

describe("site style wizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = fetchMock as typeof fetch;
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as ClubThemeValues & {
        completeSetup?: boolean;
      };
      return {
        ok: true,
        json: async () =>
          responseTheme(
            {
              brandGold: body.brandGold,
              brandCharcoal: body.brandCharcoal,
              brandDeep: body.brandDeep,
              brandRidge: body.brandRidge,
              brandMist: body.brandMist,
              brandSnow: body.brandSnow,
              brandSafety: body.brandSafety,
              headingFontKey: body.headingFontKey,
              bodyFontKey: body.bodyFontKey,
              logoDataUrl: body.logoDataUrl,
            },
            body.completeSetup ? "2026-06-11T12:00:00.000Z" : null,
          ),
      };
    });
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
    await screen.findByText("Fonts");

    fireEvent.click(screen.getByRole("button", { name: "Save and next" }));
    await screen.findByText("Logo");

    fireEvent.click(screen.getByRole("button", { name: "Save and next" }));
    await screen.findByText("Review");

    fireEvent.click(screen.getByRole("button", { name: "Finish setup" }));

    await waitFor(() => {
      expect(screen.getByText("Site style is complete.")).toBeTruthy();
    });
    const lastCallBody = JSON.parse(
      String(fetchMock.mock.calls.at(-1)?.[1]?.body ?? "{}"),
    );
    expect(lastCallBody.completeSetup).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  }, 15_000);
});
