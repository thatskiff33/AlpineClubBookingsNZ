// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * #3123 — the two instants `/admin/environment` prints are the CLUB's.
 *
 * The panel names when application mail was last held back and when the safer
 * override was last changed. Both are real INSTANTS, so neither has a civil date
 * until a zone is chosen — and before this migration both went through
 * `formatNZInstantOrRaw`, whose zone was `APP_TIME_ZONE`: the container's clock.
 * For a club west of Greenwich that dated an override change to the previous
 * day, on the screen an operator opens precisely because something already looks
 * wrong.
 *
 * ## How it discriminates
 *
 * The environment zone is modelled as `America/Denver` — behind Greenwich, where
 * the defect shows — and the provider carries a DIFFERENT zone. (The
 * `APP_TIME_ZONE` constant this file used to pin there was deleted in #3567;
 * nothing reads the environment's zone any more.) `club-time-render`'s default,
 * `Pacific/Auckland`, is also the environment's fallback, and its own docblock
 * says a suite using it "proves nothing about zone authority".
 */

import { ClubTimeProvider } from "@/components/club-time-provider";
import { EnvironmentSafetyPanel } from "@/components/admin/environment-safety-panel";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

const ENVIRONMENT_ZONE = "America/Denver";
const CLUB_ZONE = "Pacific/Auckland";

/** 2:00 UTC: 25 June 14:00 in Auckland, 24 June 20:00 in Denver. */
const STRADDLES = "2026-06-25T02:00:00.000Z";

function environmentState() {
  return {
    role: "NON_PRODUCTION",
    decidedBy: "DECLARATION",
    declaration: { kind: "non-production", raw: "non-production" },
    override: {
      on: false,
      readable: true,
      updatedAt: STRADDLES,
      updatedByName: "Ada Lovelace",
    },
    withheldEmail: {
      available: true,
      count: 3,
      mostRecentAt: STRADDLES,
      captureInProduction: 0,
    },
    xeroContactContainment: { available: false },
    notes: [],
  };
}

function renderPanel(zone: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ state: environmentState() }),
    })),
  );
  return render(
    <ClubTimeProvider zone={zone} locale={CLUB_FORMAT_TEST.locale}>
      <EnvironmentSafetyPanel />
    </ClubTimeProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the environment panel's stamps take the club's zone (#3123)", () => {
  it("PREMISE: the environment and the club disagree about this instant", () => {
    // Without this leg the cases below pass just as well when the two zones
    // agree, which is the false green #3123's contract names.
    const day = (zone: string) =>
      new Intl.DateTimeFormat("en-NZ", {
        timeZone: zone,
        dateStyle: "medium",
      }).format(new Date(STRADDLES));
    expect(day(ENVIRONMENT_ZONE)).toBe("24 Jun 2026");
    expect(day(CLUB_ZONE)).toBe("25 Jun 2026");
  });

  it("dates the withheld-mail and override stamps in the club's zone", async () => {
    // BEFORE the migration both read "24 Jun 2026" — Denver's day, through
    // APP_TIME_ZONE, whatever the club had configured.
    renderPanel(CLUB_ZONE);
    await waitFor(() => {
      expect(screen.getByTestId("environment-role")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Most recently 25 Jun 2026/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Last changed 25 Jun 2026/)).toBeInTheDocument();
    expect(screen.queryByText(/24 Jun 2026/)).not.toBeInTheDocument();
  });

  it("moves with the persisted zone — kills a hard-coded Pacific/Auckland", async () => {
    // The leg a literal club zone cannot pass. Pago Pago is UTC-11, so it reads
    // the previous day for this instant while Auckland reads the next one.
    renderPanel("Pacific/Pago_Pago");
    await waitFor(() => {
      expect(screen.getByTestId("environment-role")).toBeInTheDocument();
    });
    expect(screen.getByText(/Last changed 24 Jun 2026/)).toBeInTheDocument();
    expect(screen.queryByText(/25 Jun 2026/)).not.toBeInTheDocument();
  });
});
