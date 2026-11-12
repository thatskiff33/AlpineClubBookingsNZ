// @vitest-environment jsdom

/*
  #4975 (ALP-577) — the site-style and lodge setup wizards, and the Alpine
  server's lodge download: a failed save, upload or download takes focus, and
  takes it AGAIN when the same failure repeats word for word. The lodge
  wizard's failed load stays passive and moves nothing.
*/

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectRecoveryAlertToHoldFocus } from "@/lib/__tests__/helpers/focus";
import { SiteStyleWizard } from "../website/site-style/site-style-wizard";
import LodgeSetupWizardPage from "../lodges/[id]/setup/page";
import { useLodgeLinkStep } from "../alpine-server/setup/server-connect-step";
import { DEFAULT_CLUB_THEME_VALUES } from "@/lib/club-theme-schema";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useParams: () => ({ id: "lodge-2" }),
  usePathname: () => "/admin/setup",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    status: "authenticated",
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

vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")),
  useAdminAreaEditAccess: () => true,
}));

// The site-style wizard renders in full; jsdom routinely needs more than the
// 5s default under parallel load (as its sibling suites note).
vi.setConfig({ testTimeout: 45_000 });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const failing = (message: string, status = 500) => ({
  ok: false,
  status,
  json: async () => ({ error: message }),
});

/** Moves focus back to `control`, as an admin returning to it would. */
function refocus(control: HTMLElement) {
  control.focus();
  expect(document.activeElement).toBe(control);
}

describe("site style wizard", () => {
  function renderWizard() {
    render(
      <SiteStyleWizard
        initialTheme={{
          ...DEFAULT_CLUB_THEME_VALUES,
          completedAt: null,
          contrastWarnings: [],
        }}
      />,
    );
  }

  it("focuses a failed save, and focuses it again when it repeats", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => failing("Theme not stored.")));
    renderWizard();
    const alert = document.getElementById("site-style-action-error");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const save = screen.getByRole("button", { name: "Save and next" });
      refocus(save);
      fireEvent.click(save);
      await waitFor(() => expect(alert).toHaveTextContent("Theme not stored."));
      await expectRecoveryAlertToHoldFocus(alert);
    }
  });

  it("focuses an oversized logo each time one is chosen", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderWizard();
    fireEvent.click(screen.getByRole("button", { name: "Logo" }));
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const alert = document.getElementById("site-style-action-error");
    const oversized = new File([new Uint8Array(2 * 1024 * 1024 + 1)], "logo.png", {
      type: "image/png",
    });

    // The clear and the identical failure land in one tick, so only the
    // attention key tells the alert this is a new failure.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      refocus(input);
      fireEvent.change(input, { target: { files: [oversized] } });
      await waitFor(() => expect(alert).toHaveTextContent("Logo must be 2MB or smaller."));
      await expectRecoveryAlertToHoldFocus(alert);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("lodge setup wizard", () => {
  const lodge = {
    id: "lodge-2",
    name: "River Lodge",
    slug: "river-lodge",
    active: true,
    doorCode: null,
    travelNote: null,
  };

  function stubFetch(options: { loadFails?: boolean; saveError?: string } = {}) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json });
        if (url === "/api/admin/lodges") {
          return options.loadFails ? failing("unavailable") : ok({ lodges: [lodge] });
        }
        if (url === "/api/admin/modules") return ok({ settings: { bedAllocation: false } });
        if (url.startsWith("/api/admin/lodges/") && init?.method === "PATCH") {
          return options.saveError ? failing(options.saveError) : ok({ lodge });
        }
        if (url.startsWith("/api/admin/lodge-settings")) {
          return ok({ capacity: 12, setUpForBookings: true, resolvedCapacity: 12 });
        }
        return ok({});
      }),
    );
  }

  it("shows a failed load without moving focus", async () => {
    stubFetch({ loadFails: true });
    render(<LodgeSetupWizardPage />);

    expect(await screen.findByText("Failed to load lodges")).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(document.body));
    expect(document.getElementById("lodge-setup-action-error")).toBeNull();
  });

  it("focuses a missing name each time Save is pressed", async () => {
    stubFetch();
    render(<LodgeSetupWizardPage />);
    const nameField = await screen.findByLabelText("Name");
    await waitFor(() => expect(nameField).toHaveValue("River Lodge"));
    fireEvent.change(nameField, { target: { value: " " } });
    const alert = document.getElementById("lodge-setup-action-error");

    // Nothing clears the message between presses, so only the attention key
    // tells the alert the same failure happened again.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const save = screen.getByRole("button", { name: "Save and continue" });
      refocus(save);
      fireEvent.click(save);
      await waitFor(() => expect(alert).toHaveTextContent("Lodge name is required"));
      await expectRecoveryAlertToHoldFocus(alert);
    }
  });

  it("focuses a failed save, and focuses it again when it repeats", async () => {
    stubFetch({ saveError: "Lodge not stored." });
    render(<LodgeSetupWizardPage />);
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("River Lodge"));
    const alert = document.getElementById("lodge-setup-action-error");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const save = screen.getByRole("button", { name: "Save and continue" });
      refocus(save);
      fireEvent.click(save);
      await waitFor(() => expect(alert).toHaveTextContent("Lodge not stored."));
      await expectRecoveryAlertToHoldFocus(alert);
    }
  });
});

describe("Alpine server lodge download", () => {
  function LodgeLinkHarness() {
    const { run, statusLine } = useLodgeLinkStep();
    return (
      <>
        <button type="button" onClick={() => void run()}>
          Download
        </button>
        {statusLine}
      </>
    );
  }

  it("focuses a failed download, and focuses it again when it repeats", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => failing("The central server is unreachable.", 502)));
    render(<LodgeLinkHarness />);
    const alert = document.getElementById("lodge-link-error");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const download = screen.getByRole("button", { name: "Download" });
      refocus(download);
      fireEvent.click(download);
      await waitFor(() =>
        expect(alert).toHaveTextContent("The central server is unreachable."),
      );
      await expectRecoveryAlertToHoldFocus(alert);
      expect(screen.queryByTestId("lodge-link-status")).toBeNull();
    }
  });
});
