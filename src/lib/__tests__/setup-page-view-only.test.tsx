// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODULE_KEYS } from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";
import { emptyAdminPermissionMatrix } from "@/lib/admin-permissions";
import { ADMIN_VIEW_ONLY_SECTION_HEADING } from "@/components/admin/view-only-action";
import { SetupPageClient } from "@/app/(admin)/admin/setup/setup-page-client";

const mocks = vi.hoisted(() => ({ canEdit: false as boolean | undefined }));
vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")),
  useAdminAreaEditAccess: vi.fn(() => mocks.canEdit),
}));
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";

const features = Object.fromEntries(MODULE_KEYS.map((key) => [key, false])) as FeatureFlags;
const permissionMatrix = { ...emptyAdminPermissionMatrix(), support: "view" as const };
const providers = ["stripe", "smtp", "sentry", "xero"] as const;

function setupBody() {
  return {
    readiness: {
      status: "warning",
      summary: { total: 5, complete: 1, warning: 4, blocked: 0, skipped: 0 },
      categories: [{
        id: "providers", title: "Providers", description: "Check connections.", status: "warning",
        checks: [
          ...providers.map((provider) => ({
            id: provider, title: `${provider} connection`, description: "Provider readiness.",
            status: "warning", required: false, message: "Ready for a test.", details: [],
            progress: "open", action: { provider, label: `Test ${provider}` },
            href: "/admin/setup/foundations",
          })),
          {
            id: "reviewed", title: "Reviewed step", description: "Previously acknowledged.",
            status: "complete", required: false, message: "Already reviewed.", details: [],
            progress: "completed",
          },
        ],
      }],
    },
    progress: { completedStepIds: ["reviewed"], skippedStepIds: [], completedAt: null as string | null, completedByMemberId: null },
  };
}

function response(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

let body: ReturnType<typeof setupBody>;
const fetchMock = vi.fn<typeof fetch>();
function renderSetup() {
  return render(<SetupPageClient features={features} permissionMatrix={permissionMatrix} />);
}
async function loaded() {
  await screen.findByRole("heading", { name: "Readiness checks" });
}
function writeButtons() {
  return screen.getAllByRole("button", { name: /^(Acknowledge|Skip|Reopen|Test .+|Mark Setup Complete)$/ });
}

beforeEach(() => {
  mocks.canEdit = false;
  body = setupBody();
  fetchMock.mockReset().mockImplementation(async () => response(body));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Setup support edit access (#4971)", () => {
  it("states the view-only reason once and prevents every write, while preserving read actions", async () => {
    renderSetup();
    await loaded();
    expect(useAdminAreaEditAccess).toHaveBeenCalledWith("support");
    expect(screen.getByTestId("admin-view-only-banner")).toHaveAttribute("role", "status");
    expect(screen.getAllByText(`${ADMIN_VIEW_ONLY_SECTION_HEADING}.`)).toHaveLength(1);
    expect(writeButtons()).toHaveLength(15);
    for (const button of writeButtons()) {
      expect(button).toBeDisabled();
      expect(button).not.toHaveAttribute("title");
      expect(button).not.toHaveAttribute("aria-describedby");
      fireEvent.click(button);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
    expect(screen.getAllByRole("link", { name: "Open" })).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });

  it.each([false, true])("keeps the same banner region through initial loading and a failed load (failure: %s)", async (fails) => {
    let settle!: (value: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise((resolve) => { settle = resolve; }));
    renderSetup();
    const banner = screen.getByTestId("admin-view-only-banner");
    const alert = screen.getByRole("alert");
    expect(alert).toBeEmptyDOMElement();
    expect(banner).toHaveTextContent(ADMIN_VIEW_ONLY_SECTION_HEADING);
    expect(screen.getByText("Loading setup readiness")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Setup Wizard" })).toBeInTheDocument();
    await act(async () => { settle(response(fails ? { error: "Readiness unavailable" } : body, !fails)); });
    expect(screen.getByTestId("admin-view-only-banner")).toBe(banner);
    expect(screen.getByRole("alert")).toBe(alert);
    if (fails) expect(alert).toHaveTextContent("Readiness unavailable");
    else await loaded();
  });

  it.each([false, true])("stays neutral until access resolves to %s", async (resolved) => {
    mocks.canEdit = undefined;
    const { rerender } = renderSetup();
    const banner = screen.getByTestId("admin-view-only-banner");
    expect(banner).toBeEmptyDOMElement();
    await loaded();
    for (const button of writeButtons()) expect(button).toBeDisabled();
    mocks.canEdit = resolved;
    rerender(<SetupPageClient features={features} permissionMatrix={permissionMatrix} />);
    expect(screen.getByTestId("admin-view-only-banner")).toBe(banner);
    if (resolved) expect(banner).toBeEmptyDOMElement();
    else expect(banner).toHaveTextContent(ADMIN_VIEW_ONLY_SECTION_HEADING);
    for (const button of writeButtons()) {
      if (resolved) expect(button).toBeEnabled();
      else expect(button).toBeDisabled();
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Acknowledge", "/api/admin/setup/progress", { action: "complete", stepId: "stripe" }],
    ["Skip", "/api/admin/setup/progress", { action: "skip", stepId: "stripe" }],
    ["Reopen", "/api/admin/setup/progress", { action: "reopen", stepId: "reviewed" }],
    ["Mark Setup Complete", "/api/admin/setup/progress", { action: "finish" }],
    ...providers.map((provider) => [`Test ${provider}`, "/api/admin/setup/provider-test", { provider }] as const),
  ])("lets editors use %s and keeps its pending state", async (label, url, payload) => {
    mocks.canEdit = true;
    let settle!: (value: Response) => void;
    fetchMock.mockImplementation(async (_input, options) => {
      if (options?.method) return new Promise<Response>((resolve) => { settle = resolve; });
      return response(body);
    });
    renderSetup();
    await loaded();
    for (const button of writeButtons()) expect(button).toBeEnabled();
    expect(screen.getByTestId("admin-view-only-banner")).toBeEmptyDOMElement();
    const button = screen.getAllByRole("button", { name: label })[0]!;
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledWith(url, expect.objectContaining({
      method: "provider" in payload ? "POST" : "PATCH", body: JSON.stringify(payload),
    }));
    await act(async () => { settle(response({ ok: true, message: "Test passed" })); });
    await waitFor(() => expect(button).toBeEnabled());
  });

  it("keeps completion disabled while readiness loads, for required blockers, and after completion", async () => {
    mocks.canEdit = true;
    let settle!: (value: Response) => void;
    body.readiness.categories[0]!.checks[0]!.required = true;
    body.readiness.categories[0]!.checks[0]!.status = "blocked";
    fetchMock.mockReturnValueOnce(new Promise((resolve) => { settle = resolve; }));
    renderSetup();
    expect(screen.getByRole("button", { name: "Mark Setup Complete" })).toBeDisabled();
    await act(async () => { settle(response(body)); });
    await loaded();
    expect(screen.getByRole("button", { name: "Mark Setup Complete" })).toBeDisabled();
    body = setupBody();
    body.progress.completedAt = "2026-07-01T00:00:00.000Z";
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("button", { name: "Setup Complete" })).toBeDisabled();
  });
});
