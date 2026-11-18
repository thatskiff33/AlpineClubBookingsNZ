// @vitest-environment jsdom

import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODULE_SETTINGS } from "@/config/modules";
import { ADMIN_FORBIDDEN_SAVE_REASON } from "@/components/admin/view-only-action";

// The support-area edit gate is mocked so each test can pin the tri-state.
const hookMock = vi.hoisted(() => ({ canEdit: true as boolean | undefined }));
vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: () => hookMock.canEdit,
  ADMIN_VIEW_ONLY_ACTION_REASON: "View-only reason",
}));

import { MagicLinkSecurityCard } from "@/components/admin/magic-link-security-card";

// Edit-gated Login & Security magic-link card (#2103). Loads read-only; the
// enable toggle and link expiry stage behind Edit → Save/Cancel; nothing
// auto-persists; Save writes the modules route (GET-fresh-then-merge) and/or the
// TTL route, once each.

const NOTICE_RE = /can view login & security settings but cannot change them/i;

function renderCard(
  overrides: {
    magicLink?: boolean;
    initialTtlMinutes?: number;
  } = {},
) {
  return render(
    <MagicLinkSecurityCard
      moduleSettings={{
        ...DEFAULT_MODULE_SETTINGS,
        magicLink: overrides.magicLink ?? false,
      }}
      initialTtlMinutes={overrides.initialTtlMinutes ?? 15}
    />,
  );
}

function toggle() {
  return screen.getByRole("checkbox", {
    name: /enable email sign-in link/i,
  }) as HTMLInputElement;
}

function editButton() {
  return screen.getByRole("button", { name: "Edit" }) as HTMLButtonElement;
}

describe("MagicLinkSecurityCard (#2103)", () => {
  beforeEach(() => {
    hookMock.canEdit = true;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("loads read-only: the toggle is disabled and there is no Save button", () => {
    renderCard({ magicLink: true });
    expect(toggle().checked).toBe(true);
    expect(toggle().disabled).toBe(true);
    expect(editButton().disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("Edit enables the controls and reveals Save/Cancel", () => {
    renderCard();
    fireEvent.click(editButton());
    expect(toggle().disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("toggling in edit mode fires NO fetch and flags unsaved changes", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderCard();
    fireEvent.click(editButton());
    fireEvent.click(toggle());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/unsaved changes/i)).toBeTruthy();
  });

  it("Save merges the staged toggle over the FRESH modules GET and PUTs once", async () => {
    // Fresh server state differs from the render-time snapshot in another key
    // (twoFactor). The PUT must carry the fresh twoFactor, proving the merge is
    // over the fresh GET and not the stale prop snapshot.
    const freshSettings = {
      ...DEFAULT_MODULE_SETTINGS,
      magicLink: false,
      twoFactor: true,
    };
    const fetchMock = vi.fn(
      async (url: string, init?: RequestInit) => {
        if (url === "/api/admin/modules" && !init?.method) {
          return new Response(JSON.stringify({ settings: freshSettings }), {
            status: 200,
          });
        }
        if (url === "/api/admin/modules" && init?.method === "PUT") {
          return new Response(null, { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url} ${init?.method ?? "GET"}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    renderCard({ magicLink: false });
    fireEvent.click(editButton());
    fireEvent.click(toggle()); // stage magicLink -> true

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy(),
    );

    const getCalls = fetchMock.mock.calls.filter(
      ([url, init]) => url === "/api/admin/modules" && !init?.method,
    );
    const putCalls = fetchMock.mock.calls.filter(
      ([url, init]) => url === "/api/admin/modules" && init?.method === "PUT",
    );
    expect(getCalls).toHaveLength(1);
    expect(putCalls).toHaveLength(1);
    // No TTL route call — the expiry was unchanged.
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes("/api/admin/security/magic-link"),
      ),
    ).toBe(false);

    const body = JSON.parse(String(putCalls[0][1]?.body));
    expect(body.settings.magicLink).toBe(true);
    expect(body.settings.twoFactor).toBe(true); // merged over FRESH, not snapshot
    // Success exits edit mode.
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByText(/settings saved/i)).toBeTruthy();
  });

  it("Save persists only a changed TTL via the magic-link route (one PUT, no modules write)", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/admin/security/magic-link" && init?.method === "PUT") {
        return new Response(JSON.stringify({ policy: {} }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url} ${init?.method ?? "GET"}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderCard({ magicLink: true, initialTtlMinutes: 15 });
    fireEvent.click(editButton());
    fireEvent.change(screen.getByLabelText(/link expiry/i), {
      target: { value: "30" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/admin/security/magic-link");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual({ magicLinkTtlMinutes: 30 });
  });

  it("Cancel reverts the staged toggle with zero fetches and exits edit mode", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderCard({ magicLink: false });
    fireEvent.click(editButton());
    fireEvent.click(toggle()); // stage -> true
    expect(toggle().checked).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(toggle().checked).toBe(false); // reverted
    expect(toggle().disabled).toBe(true); // back to read-only
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
  });

  it("surfaces the forbidden-save reason on a 403 from the modules PUT", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/admin/modules" && !init?.method) {
        return new Response(
          JSON.stringify({ settings: DEFAULT_MODULE_SETTINGS }),
          { status: 200 },
        );
      }
      if (url === "/api/admin/modules" && init?.method === "PUT") {
        return new Response(null, { status: 403 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderCard({ magicLink: false });
    fireEvent.click(editButton());
    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(screen.getByText(ADMIN_FORBIDDEN_SAVE_REASON)).toBeTruthy(),
    );
    // Still in edit mode; the change did not persist.
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  // A write that never got an answer rejects with the browser's own words. Each
  // step names its own failure: an offline expiry save must not read as the
  // email sign-in link setting failing (ALP-650).
  it("words an unanswered expiry save as the expiry failure, not the toggle failure", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    renderCard({ magicLink: true, initialTtlMinutes: 15 });
    fireEvent.click(editButton());
    fireEvent.change(screen.getByLabelText(/link expiry/i), {
      target: { value: "30" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(screen.getByText("Could not update the link expiry.")).toBeTruthy(),
    );
    expect(screen.queryByText(/failed to fetch/i)).toBeNull();
    expect(
      screen.queryByText("Could not update the email sign-in link setting."),
    ).toBeNull();
    // Still in edit mode; the change did not persist.
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  it("words an unanswered toggle write as the sign-in link failure", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/admin/modules" && !init?.method) {
        return new Response(
          JSON.stringify({ settings: DEFAULT_MODULE_SETTINGS }),
          { status: 200 },
        );
      }
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    renderCard({ magicLink: false });
    fireEvent.click(editButton());
    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(
        screen.getByText("Could not update the email sign-in link setting."),
      ).toBeTruthy(),
    );
    expect(screen.queryByText(/failed to fetch/i)).toBeNull();
    expect(screen.queryByText("Could not update the link expiry.")).toBeNull();
  });

  it("canEdit=false disables Edit and shows the view-only notice", () => {
    hookMock.canEdit = false;
    renderCard();
    expect(editButton().disabled).toBe(true);
    expect(screen.getByText(NOTICE_RE)).toBeTruthy();
  });

  it("canEdit=undefined (resolving) disables Edit and shows NO notice", () => {
    hookMock.canEdit = undefined;
    renderCard();
    expect(editButton().disabled).toBe(true);
    expect(screen.queryByText(NOTICE_RE)).toBeNull();
  });
});
