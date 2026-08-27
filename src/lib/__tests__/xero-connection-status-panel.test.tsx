// @vitest-environment jsdom

import { render, screen } from "@/lib/__tests__/support/club-time-render";
import { describe, expect, it, vi } from "vitest";
import { ConnectionStatusPanel } from "@/app/(admin)/admin/xero/_components/connection-status-panel";

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
});
