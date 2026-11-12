// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODULE_SETTINGS } from "@/config/modules";
import { ADMIN_FORBIDDEN_SAVE_REASON } from "@/components/admin/view-only-action";
import { expectToHoldFocus } from "@/lib/__tests__/helpers/focus";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  canEdit: true,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));
vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")),
  useAdminAreaEditAccess: () => mocks.canEdit,
}));
vi.mock("@/components/confirm-its-you", () => ({
  fetchWithRecentAuth: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
}));

import AdminModulesPage from "@/app/(admin)/admin/modules/page";

function payload(waitlist = false) {
  return {
    settings: { ...DEFAULT_MODULE_SETTINGS, waitlist },
    modules: [{
      key: "waitlist",
      label: "Waitlist",
      description: "Queue for full nights.",
      adminEnabled: waitlist,
      effectiveEnabled: waitlist,
      readiness: {
        status: waitlist ? "ready" : "admin_disabled",
        message: waitlist ? "Waitlist is enabled." : "Waitlist is disabled.",
        dependencies: [],
      },
    }],
    updatedAt: null,
    updatedByMemberId: null,
  };
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  mocks.refresh.mockReset();
  mocks.canEdit = true;
  fetchMock.mockReset().mockResolvedValueOnce(response(payload()));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function editModules() {
  const view = render(<AdminModulesPage />);
  fireEvent.click(await screen.findByRole("checkbox", { name: "Waitlist" }));
  return view;
}

describe("Modules layout refresh", () => {
  it("refreshes once after saving and preserves the saved state and attention on a passive render", async () => {
    // The server response differs from the draft: it is the saved source of truth.
    fetchMock.mockResolvedValueOnce(response(payload(false)));
    const view = await editModules();
    expect(mocks.refresh).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const message = await screen.findByText("Module settings saved.");
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe("/api/admin/modules");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual({
      settings: { ...DEFAULT_MODULE_SETTINGS, waitlist: true },
    });
    expect(screen.getByRole("checkbox", { name: "Waitlist" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    const page = screen.getByRole("heading", { name: "Modules" }).parentElement?.parentElement?.parentElement;
    await expectToHoldFocus(page);
    expect(page).toContainElement(message);

    // A server-layout refresh keeps this client component mounted. A passive
    // render must neither fetch over the saved draft nor reclaim keyboard focus.
    const refreshButton = screen.getByRole("button", { name: "Refresh" });
    refreshButton.focus();
    view.rerender(<AdminModulesPage />);
    await expectToHoldFocus(refreshButton);
    expect(screen.getByText("Module settings saved.")).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "Waitlist" })).not.toBeChecked();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["forbidden", 403, {}, ADMIN_FORBIDDEN_SAVE_REASON],
    ["server error", 500, { error: "Could not save" }, "Could not save"],
    ["missing settings", 200, { modules: [] }, "Failed to save modules"],
    ["missing modules", 200, { settings: DEFAULT_MODULE_SETTINGS }, "Failed to save modules"],
  ])("does not refresh after a %s save", async (_name, status, body, error) => {
    fetchMock.mockResolvedValueOnce(response(body, status));
    await editModules();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(error);
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(screen.getByRole("checkbox", { name: "Waitlist" })).toBeChecked();
  });

  it("does not refresh after a network error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("Connection lost"));
    await editModules();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Connection lost");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("reloads saved settings and refreshes the layout when Refresh is pressed", async () => {
    fetchMock.mockResolvedValueOnce(response(payload(true)));
    render(<AdminModulesPage />);
    await screen.findByRole("checkbox", { name: "Waitlist" });
    expect(mocks.refresh).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Waitlist" })).toBeChecked());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("keeps Save disabled for support:view without triggering a refresh", async () => {
    mocks.canEdit = false;
    render(<AdminModulesPage />);
    expect(await screen.findByRole("checkbox", { name: "Waitlist" })).toBeDisabled();
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
