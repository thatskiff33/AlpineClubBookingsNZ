// @vitest-environment jsdom

import { render, screen } from "@/lib/__tests__/support/club-time-render";
import { describe, expect, it, vi } from "vitest";
import { ConnectionStatusPanel } from "@/app/(admin)/admin/xero/_components/connection-status-panel";
import type { XeroStatus } from "@/app/(admin)/admin/xero/_components/types";

describe("ConnectionStatusPanel", () => {
  it("does not imply finance report scope readiness from token presence", () => {
    render(
      <ConnectionStatusPanel
        status={{
          connected: true,
          tenantId: "tenant-123",
          tokenExpiresAt: "2026-04-20T00:00:00.000Z",
        }}
        onConnect={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    );

    expect(
      screen.queryByText("Xero is connected and ready for syncing."),
    ).toBeNull();
    expect(
      screen.getByText(/Xero is connected for operational syncs/),
    ).toBeTruthy();
    expect(
      screen.getByText(/Finance report scope readiness is verified/),
    ).toBeTruthy();
  });

  it("disables the Disconnect control for a view-only (finance) admin (#2080 UX-F6)", () => {
    render(
      <ConnectionStatusPanel
        status={{
          connected: true,
          tenantId: "tenant-123",
          tokenExpiresAt: "2026-04-20T00:00:00.000Z",
        }}
        onConnect={vi.fn()}
        onDisconnect={vi.fn()}
        canEdit={false}
      />,
    );
    expect(
      (screen.getByRole("button", { name: /disconnect xero/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("gates the first-time Connect control on edit access (#2080 UX-F6)", () => {
    const { rerender } = render(
      <ConnectionStatusPanel
        status={{ connected: false, tenantId: null, tokenExpiresAt: null }}
        onConnect={vi.fn()}
        onDisconnect={vi.fn()}
        canEdit={false}
      />,
    );
    expect(
      (screen.getByRole("button", { name: /connect xero/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    // An edit-capable admin gets an enabled control.
    rerender(
      <ConnectionStatusPanel
        status={{ connected: false, tenantId: null, tokenExpiresAt: null }}
        onConnect={vi.fn()}
        onDisconnect={vi.fn()}
        canEdit={true}
      />,
    );
    expect(
      (screen.getByRole("button", { name: /connect xero/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  describe("advises the fix that works for each re-entry cause (#4456 review)", () => {
    const needsReentry = (reentryCause?: XeroStatus["reentryCause"]) =>
      render(
        <ConnectionStatusPanel
          status={{ connected: false, needsReentry: true, reentryCause, tenantId: "tenant-123", tokenExpiresAt: null }}
          onConnect={vi.fn()}
          onDisconnect={vi.fn()}
        />,
      );

    it.each([undefined, "tokens-unreadable"] as const)("offers a reconnect for unreadable tokens (cause %s)", (cause) => {
      needsReentry(cause);
      expect(screen.getByText(/can no longer be read/)).toBeTruthy();
      expect(screen.getByRole("button", { name: /reconnect xero/i })).toBeTruthy();
    });

    it.each([
      ["data-key-ring-missing", /DATA_ENCRYPTION_KEYS is not set on this server.*restore the key/],
      ["data-key-ring-invalid", /DATA_ENCRYPTION_KEYS on this server is invalid/],
      ["auth-secret-weak", /auth secret fails the strength check/],
    ] as const)("says to fix the server for %s, with no reconnect", (cause, advice) => {
      needsReentry(cause);
      expect(screen.getByText(advice)).toBeTruthy();
      expect(screen.getByText(/Reconnecting will not help until then/)).toBeTruthy();
      expect(screen.queryByRole("button", { name: /reconnect xero/i })).toBeNull();
    });
  });
});
