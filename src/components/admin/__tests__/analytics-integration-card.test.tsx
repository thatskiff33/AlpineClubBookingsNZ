// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANALYTICS_STATUS_LABELS,
  DEFAULT_ANALYTICS_BANNER_MESSAGE,
  type AnalyticsIntegrationStatus,
} from "@/lib/analytics-settings-shared";

const hookMock = vi.hoisted(() => ({ canEdit: true as boolean | undefined }));
vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: () => hookMock.canEdit,
  ADMIN_VIEW_ONLY_ACTION_REASON: "View-only reason",
}));

import { AnalyticsIntegrationCard } from "@/components/admin/analytics-integration-card";

/**
 * The Google Analytics card on Admin -> Integrations (#2573).
 *
 * This file exists because the wording on this card is not decoration: owner decision
 * section 10 mandates the privacy warning AND the closing disclaimer, section 4
 * mandates a warning shown as soon as banner-off is SELECTED (before Save), section 3
 * asks for banner-on to be marked as recommended, and clarification 2 requires "Ask
 * visitors to choose again" to be unavailable in banner-off mode. None of that was
 * pinned anywhere: the E2E drives the settings through the API and never opens this
 * card, so a refactor could have removed the disclaimer or moved the banner-off
 * warning behind a post-save state with the whole suite still green.
 *
 * The load-failure case is here for the same reason — the card is the only place that
 * state is reachable from.
 */

const SETTINGS_ENDPOINT = "/api/admin/integrations/analytics";
const RECONSENT_ENDPOINT = "/api/admin/integrations/analytics/reconsent";

function payload(
  overrides: {
    measurementId?: string | null;
    consentBannerEnabled?: boolean;
    bannerMessage?: string;
    consentRevision?: number;
    status?: AnalyticsIntegrationStatus;
    privacyPublished?: boolean;
  } = {},
) {
  const consentBannerEnabled = overrides.consentBannerEnabled ?? true;
  const measurementId =
    overrides.measurementId === undefined
      ? "G-ABCDE12345"
      : overrides.measurementId;
  return {
    settings: {
      measurementId,
      consentBannerEnabled,
      bannerMessage: overrides.bannerMessage ?? DEFAULT_ANALYTICS_BANNER_MESSAGE,
      consentRevision: overrides.consentRevision ?? 1,
      updatedAt: "2026-08-01T00:00:00.000Z",
      updatedByMemberId: "mem_1",
    },
    status:
      overrides.status ??
      (measurementId
        ? consentBannerEnabled
          ? "configured_with_banner"
          : "configured_without_banner"
        : "setup_required"),
    defaultBannerMessage: DEFAULT_ANALYTICS_BANNER_MESSAGE,
    privacyPolicy: {
      exists: overrides.privacyPublished ?? true,
      published: overrides.privacyPublished ?? true,
      publicPath: "/privacy",
      adminHref: "/admin/page-content",
    },
  };
}

/** GET resolves with `body`; anything else fails the test loudly. */
function stubSettings(body: unknown, ok = true) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === SETTINGS_ENDPOINT && (init?.method ?? "GET") === "GET") {
      return {
        ok,
        status: ok ? 200 : 500,
        json: async () => body,
      } as unknown as Response;
    }
    if (url === RECONSENT_ENDPOINT && init?.method === "POST") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          settings: { ...payload().settings, consentRevision: 2 },
          status: "configured_with_banner",
        }),
      } as unknown as Response;
    }
    throw new Error(`unexpected fetch: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function openDialog(body: unknown = payload(), ok = true) {
  const fetchMock = stubSettings(body, ok);
  render(<AnalyticsIntegrationCard />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  fireEvent.click(
    screen.getByRole("button", { name: /(Set up|Manage) Google Analytics/ }),
  );
  return fetchMock;
}

beforeEach(() => {
  hookMock.canEdit = true;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the card itself", () => {
  it.each([
    ["setup_required", "Set up Google Analytics"],
    ["configured_with_banner", "Manage Google Analytics"],
    ["configured_without_banner", "Manage Google Analytics"],
    ["invalid_configuration", "Manage Google Analytics"],
  ] as const)("shows the %s status label", async (status, buttonLabel) => {
    stubSettings(payload({ status }));
    render(<AnalyticsIntegrationCard />);

    const chip = await screen.findByTestId("analytics-integration-status");
    expect(chip.textContent).toBe(ANALYTICS_STATUS_LABELS[status]);
    expect(screen.getByRole("button", { name: buttonLabel })).toBeTruthy();
  });
});

describe("Edit inside the dialog (#4115)", () => {
  it("leaves focus in the dialog, not on the card hidden behind it", async () => {
    await openDialog();
    const dialog = await screen.findByRole("dialog");
    const edit = await screen.findByRole("button", { name: "Edit" });
    // The card is the section's region, but the modal hides it.
    const card = screen.getByRole("region", { name: "Google Analytics", hidden: true });
    expect(card.closest('[aria-hidden="true"]')).not.toBeNull();

    // A keyboard user: Edit holds focus, and pressing it unmounts it.
    edit.focus();
    fireEvent.click(edit);
    await screen.findByRole("button", { name: "Cancel" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The shared reveal would have focused the aria-hidden card, so it acts in
    // the dialog that holds Edit instead. The dialog's own focus scope does not
    // do it: Edit is not removed, React reuses it as the disabled Save, and a
    // browser then drops focus to the page behind the modal (#5183; jsdom 30
    // kept focus on that disabled button, so this test once passed by accident).
    expect(document.activeElement).not.toBe(card);
    expect(card.contains(document.activeElement)).toBe(false);
    expect(dialog.contains(document.activeElement)).toBe(true);
    // And it is the first control Edit made editable, as everywhere else (#4115).
    expect(document.activeElement).toBe(
      screen.getByLabelText("GA4 measurement ID"),
    );
  });
});

describe("the mandated privacy and legal wording (owner section 10)", () => {
  it("shows the prominent warning and the closing disclaimer", async () => {
    await openDialog();

    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(
      "your organisation should disclose its use of Google Analytics in the website privacy policy",
    );
    expect(dialog.textContent).toContain(
      "Check the current New Zealand privacy requirements, and any other laws that apply to your visitors, before relying on this setting.",
    );
    // The guard against ever describing a mode as compliant: the disclaimer says
    // outright that the application does not make that assessment.
    expect(dialog.textContent).toContain(
      "This application does not determine whether your selected configuration is legally compliant.",
    );
  });

  it("never describes a consent mode as compliant, approved or exempt", async () => {
    await openDialog();

    const dialog = await screen.findByRole("dialog");
    // "legally compliant" appears exactly once, inside the disclaimer that denies it.
    expect(dialog.textContent?.match(/compliant/g)).toHaveLength(1);
    expect(dialog.textContent).not.toMatch(/\b(approved|exempt|compliance)\b/i);
  });

  it("warns when no privacy policy page is published, without blocking setup", async () => {
    await openDialog(payload({ privacyPublished: false }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("No published privacy policy");
    expect(dialog.textContent).toContain("You can still finish this setup first.");
    // Setup is still reachable: the fields and the Edit action are present.
    expect(screen.getByLabelText("GA4 measurement ID")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
  });
});

describe("the consent-mode choice", () => {
  it("marks the banner-enabled option as recommended (owner section 3)", async () => {
    await openDialog();

    expect(
      await screen.findByText("Show the consent banner (recommended)"),
    ).toBeTruthy();
  });

  it("warns about banner-off mode as soon as it is SELECTED, before any save", async () => {
    // Owner section 4: "The administrator must receive a clear warning BEFORE saving
    // this mode." Gated on the draft, so it appears on selection.
    const fetchMock = await openDialog();

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect(screen.queryByText(/without asking visitors/i)).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: /Do not show the consent banner/ }));

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain(
      "Analytics will load without asking visitors",
    );
    expect(dialog.textContent).toContain(
      "Google Analytics will load automatically on eligible public pages without asking visitors first.",
    );
    expect(dialog.textContent).toContain(
      "Visitors who previously declined through the banner will start being measured again",
    );
    // Selecting a radio stages a draft and persists nothing.
    expect(
      fetchMock.mock.calls.filter((call) => call[1]?.method === "PUT"),
    ).toHaveLength(0);
  });

  it("tells the admin to switch Google's own history page views off, and why it is not optional", async () => {
    // The app enforces one sanitised page view per ELIGIBLE address; the GA property
    // option that bypasses both halves of that is not controllable from gtag, so the
    // admin is told. Pinned because the first version of this text gave double
    // counting as the only reason, which an admin who does not mind duplicate numbers
    // can rationally skip — while the consequence they were not told about is a page
    // view leaving for a login, member or dashboard address that owner section 7
    // excludes outright.
    await openDialog();

    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(
      "Page changes based on browser history events",
    );
    expect(dialog.textContent).toContain("Required:");
    // The disclosure consequence, in the admin's own terms.
    expect(dialog.textContent).toContain(
      "Google records a page view for it",
    );
    expect(dialog.textContent).toMatch(
      /may carry the address as the browser has it/,
    );
    // Double counting stays mentioned, but demoted rather than deleted.
    expect(dialog.textContent).toContain("counted twice");
  });
});

describe("Ask visitors to choose again (owner section 6, clarification 2)", () => {
  it("is offered while the banner is enabled and bumps the revision once confirmed", async () => {
    await openDialog();

    fireEvent.click(
      await screen.findByRole("button", { name: "Ask visitors to choose again" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Yes, ask visitors to choose again" }),
    );

    await waitFor(() =>
      expect(screen.getByRole("dialog").textContent).toContain(
        "Consent revision is now 2.",
      ),
    );
  });

  it("is hidden in banner-off mode", async () => {
    await openDialog(payload({ consentBannerEnabled: false }));

    await screen.findByRole("dialog");
    expect(
      screen.queryByRole("button", { name: "Ask visitors to choose again" }),
    ).toBeNull();
  });

  it("follows the SAVED mode, not an unsaved draft switch", async () => {
    // Deliberate, and the direction matters: availability tracks what the SERVER
    // would accept. The route refuses re-consent only when the STORED mode is
    // banner-off, so while banner-on is still the stored mode the action stays
    // offered even though the admin has staged a switch away from it — and staging
    // banner-off does not withdraw an action that still works.
    await openDialog();

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.click(
      screen.getByRole("radio", { name: /Do not show the consent banner/ }),
    );

    expect(
      screen.getByRole("button", { name: "Ask visitors to choose again" }),
    ).toBeTruthy();
  });
});

describe("a failed settings read", () => {
  it("shows the error and a retry rather than stranding on Loading settings…", async () => {
    const fetchMock = await openDialog(null, false);

    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(dialog.textContent).toContain(
        "Could not load the Google Analytics settings.",
      ),
    );
    expect(dialog.textContent).not.toContain("Loading settings…");

    // And the admin can recover in place: Try again re-runs the load.
    const getCallsBefore = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.length).toBeGreaterThan(getCallsBefore),
    );
  });
});

describe("view-only access", () => {
  it("explains the restriction once and disables the write actions", async () => {
    hookMock.canEdit = false;
    await openDialog();

    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(
      "Google Analytics settings need finance edit access.",
    );
    expect(
      (screen.getByRole("button", { name: "Edit" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
