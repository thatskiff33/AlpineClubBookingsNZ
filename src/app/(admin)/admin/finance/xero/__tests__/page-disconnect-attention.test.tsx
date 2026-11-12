// @vitest-environment jsdom

/**
 * The Xero page's connection failures (#4975): a status read that failed is a
 * passive notice, while a Disconnect the admin pressed that failed takes focus,
 * again on every identical failure.
 */

import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { expectRecoveryAlertToHoldFocus } from "@/lib/__tests__/helpers/focus";

const mocks = vi.hoisted(() => ({ fetchWithRecentAuth: vi.fn() }));

vi.mock("@/components/confirm-its-you", () => ({
  fetchWithRecentAuth: mocks.fetchWithRecentAuth,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/xero",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ name: "Test Club" }),
}));

vi.mock("../_components/webhook-health-panel", () => ({ WebhookHealthPanel: () => null }));

// Only the connection panel's Disconnect wiring is under test; the rest stay quiet.
vi.mock("../_components/panels", async () => {
  const actual =
    (await vi.importActual("../_components/go-to-xero-button")) as typeof import("../_components/go-to-xero-button");
  const stub = () => null;
  return {
    GoToXeroButton: actual.GoToXeroButton,
    xeroLinkState: actual.xeroLinkState,
    ConnectionStatusPanel: ({ onDisconnect }: { onDisconnect: () => void }) => (
      <button type="button" onClick={onDisconnect}>
        Disconnect
      </button>
    ),
    ContactSyncPanel: stub,
    ErasedMemberContactsPanel: stub,
    HealthAndDiagnosticsPanels: stub,
    InboundEventsPanel: stub,
    MembershipSyncPanel: stub,
    MissingContactsPanel: stub,
    OperationsPanel: stub,
    SyncResultsPanel: stub,
    UsagePanel: stub,
  };
});

import XeroPage from "../page";

const CONNECTED = { connected: true, needsReentry: false, tenantId: "tenant-1", tokenExpiresAt: null };
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

function stubStatus(statusOk: boolean) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) =>
      String(input).startsWith("/api/admin/xero/status")
        ? { ok: statusOk, json: async () => (statusOk ? CONNECTED : {}) }
        : { ok: false, json: async () => ({}) },
    ),
  );
}

function actionAlert() {
  const alert = document.getElementById("xero-connection-action-error");
  if (!alert) throw new Error("no action alert");
  return alert;
}

beforeEach(() => {
  mocks.fetchWithRecentAuth.mockReset();
  vi.stubGlobal("confirm", () => true);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalScrollIntoView) {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: originalScrollIntoView,
    });
  } else {
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  }
});

describe("Xero page connection failure attention", () => {
  it("leaves focus alone when the connection status cannot be read", async () => {
    stubStatus(false);
    render(<XeroPage />);
    expect(await screen.findByText(/failed to (load|fetch)/i)).toBeInTheDocument();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.activeElement).toBe(document.body);
    expect(actionAlert()).toBeEmptyDOMElement();
  });

  it("focuses a failed disconnect every time it fails", async () => {
    stubStatus(true);
    mocks.fetchWithRecentAuth.mockResolvedValue({ ok: false, json: async () => ({}) });
    render(<XeroPage />);
    const disconnect = () => screen.getByRole("button", { name: "Disconnect" });
    await waitFor(() => expect(disconnect()).toBeInTheDocument());

    const alert = actionAlert();
    fireEvent.click(disconnect());
    await waitFor(() => expect(alert).toHaveTextContent("Failed to disconnect Xero"));
    await expectRecoveryAlertToHoldFocus(alert);

    act(() => disconnect().focus());
    fireEvent.click(disconnect());
    await expectRecoveryAlertToHoldFocus(alert);
    expect(alert).toHaveTextContent("Failed to disconnect Xero");
  });
});
