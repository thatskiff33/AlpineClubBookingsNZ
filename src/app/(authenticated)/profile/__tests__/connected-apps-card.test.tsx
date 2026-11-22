// @vitest-environment jsdom

/**
 * Profile "Connected AI apps" (ALP-653, `INV-MCP-004`): each connected app
 * with a Disconnect that ends it at once, and the address to connect another
 * when the club lets this account connect.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConnectedAppsCard, type ConnectedAppRow } from "@/app/(authenticated)/profile/connected-apps-card";

const rows: ConnectedAppRow[] = [
  {
    id: "grant-1",
    appName: "Example Assistant",
    appHost: "claude.ai",
    scope: "READ",
    connectedLabel: "20 Jun 2026",
    lastUsedLabel: null,
  },
  {
    id: "grant/2",
    appName: "Desk Helper",
    appHost: "chatgpt.com",
    scope: "READ_WRITE",
    connectedLabel: "25 Jun 2026",
    lastUsedLabel: "30 Jun 2026, 9:15 am",
  },
];

const ADDRESS = "https://club.example.test/api/mcp";
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderCard(connectAddress: string | null = ADDRESS, initial = rows) {
  return render(<ConnectedAppsCard initialConnections={initial} connectAddress={connectAddress} />);
}

const disconnectButton = (appName: string) =>
  screen.getByRole("button", { name: `Disconnect ${appName}` }) as HTMLButtonElement;

describe("ConnectedAppsCard", () => {
  it("lists each connected app with what it may do and when it was last used", () => {
    renderCard();
    expect(screen.getByText("Example Assistant")).toBeTruthy();
    expect(screen.getByText("View only")).toBeTruthy();
    expect(screen.getByText(/claude\.ai · Connected 20 Jun 2026 · Not used yet/)).toBeTruthy();
    expect(screen.getByText("Desk Helper")).toBeTruthy();
    expect(screen.getByText("View and change")).toBeTruthy();
    expect(screen.getByText(/Last used 30 Jun 2026, 9:15 am/)).toBeTruthy();
    expect(screen.getByText(ADDRESS)).toBeTruthy();
  });

  it("says so when nothing is connected", () => {
    renderCard(ADDRESS, []);
    expect(screen.getByText("No AI apps are connected to your account.")).toBeTruthy();
  });

  it("disconnects an app, removes it from the list and says it can no longer act", async () => {
    renderCard();
    fireEvent.click(disconnectButton("Desk Helper"));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "Desk Helper is disconnected. It can no longer use your account.",
      ),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/member/mcp-grants/grant%2F2",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(screen.queryByText("Desk Helper")).toBeNull();
    expect(screen.getByText("Example Assistant")).toBeTruthy();
  });

  it("treats a connection that had already ended as gone", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "Not found" }, { status: 404 }));
    renderCard();
    fireEvent.click(disconnectButton("Example Assistant"));
    await waitFor(() => expect(screen.queryByText("Example Assistant")).toBeNull());
    expect(screen.getByRole("status").textContent).toContain("is disconnected");
    expect(screen.getByRole("alert").textContent).toBe("");
  });

  it("keeps the app listed and shows why when the disconnect fails", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "Account is deactivated" }, { status: 403 }));
    renderCard();
    fireEvent.click(disconnectButton("Example Assistant"));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Account is deactivated"),
    );
    expect(screen.getByText("Example Assistant")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("");
    expect(disconnectButton("Example Assistant").disabled).toBe(false);
  });

  it("keeps the app listed when the request never got an answer", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    renderCard();
    fireEvent.click(disconnectButton("Example Assistant"));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "Example Assistant could not be disconnected",
      ),
    );
    expect(screen.getByText("Example Assistant")).toBeTruthy();
  });

  it("says the club does not allow this account to connect, and still offers Disconnect", () => {
    renderCard(null);
    expect(screen.getByText("Your club does not allow your account to connect an AI app.")).toBeTruthy();
    expect(screen.queryByText(ADDRESS)).toBeNull();
    expect(disconnectButton("Example Assistant").disabled).toBe(false);
  });
});
