// @vitest-environment jsdom

/**
 * Admin, Help & system: AI app connections (ALP-653, `INV-MCP-002`). The
 * club's policy opens read-only and changes only through Edit then Save,
 * which sends the four settings behind a fresh proof of who the officer is;
 * every connection is listed with a Disconnect. A support viewer can read
 * both and change neither.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";

const { hook, recentAuthFetch } = vi.hoisted(() => ({
  hook: { canEdit: true as boolean | undefined },
  recentAuthFetch: vi.fn(),
}));
vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: () => hook.canEdit,
  ADMIN_VIEW_ONLY_ACTION_REASON: "View-only reason",
}));
vi.mock("@/components/confirm-its-you", () => ({ fetchWithRecentAuth: recentAuthFetch }));

import { AiConnectionsClient } from "@/app/(admin)/admin/system/ai-connections/ai-connections-client";

const SETTINGS = {
  membersMayConnect: true,
  officersMayConnect: false,
  maxScope: "READ",
  allowedRedirectHosts: ["claude.ai", "chatgpt.com"],
};

const CONNECTIONS = [
  {
    id: "grant-1",
    memberId: "member-1",
    memberName: "Ana Reid",
    appName: "Example Assistant",
    appHost: "claude.ai",
    scope: "READ",
    connectedAt: "2026-06-20T00:00:00.000Z",
    lastUsedAt: null,
  },
  {
    id: "grant-2",
    memberId: "member-2",
    memberName: "Ben Hale",
    appName: "Desk Helper",
    appHost: "chatgpt.com",
    scope: "READ_WRITE",
    connectedAt: "2026-06-25T00:00:00.000Z",
    lastUsedAt: "2026-06-30T21:15:00.000Z",
  },
];

let fetchMock: ReturnType<typeof vi.fn>;
let deleteStatus: number;
let remainingConnections: typeof CONNECTIONS;

beforeEach(() => {
  hook.canEdit = true;
  deleteStatus = 200;
  remainingConnections = [...CONNECTIONS];
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/admin/mcp/settings") return Response.json(SETTINGS);
    if (url.startsWith("/api/admin/mcp/grants?")) {
      return Response.json({ connections: remainingConnections, page: 1, pageSize: 25, total: remainingConnections.length });
    }
    if (url.startsWith("/api/admin/mcp/grants/") && init?.method === "DELETE") {
      if (deleteStatus === 200 || deleteStatus === 404) {
        remainingConnections = remainingConnections.filter((row) => !url.endsWith(`/${row.id}`));
      }
      return deleteStatus === 200
        ? Response.json({ ok: true })
        : Response.json({ error: "Forbidden by the server" }, { status: deleteStatus });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  recentAuthFetch.mockImplementation(async (_url: string, init: RequestInit) =>
    Response.json(JSON.parse(init.body as string)),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderPage() {
  render(<AiConnectionsClient connectAddress="https://club.example.test/api/mcp" />);
  await screen.findByText("Ana Reid");
  await screen.findByRole("button", { name: "Edit" });
}

const membersBox = () =>
  screen.getByRole("checkbox", { name: "Members may connect an AI app" }) as HTMLInputElement;
const officersBox = () =>
  screen.getByRole("checkbox", { name: "Officers may connect an AI app" }) as HTMLInputElement;
const hostsBox = () => screen.getByRole("textbox", { name: "Approved AI apps" }) as HTMLTextAreaElement;

describe("AiConnectionsClient: the club's settings", () => {
  it("opens read-only with the saved settings and the address members connect to", async () => {
    await renderPage();
    expect(membersBox().checked).toBe(true);
    expect(officersBox().checked).toBe(false);
    expect(hostsBox().value).toBe("claude.ai\nchatgpt.com");
    for (const control of [membersBox(), officersBox(), hostsBox()]) {
      expect(control.disabled).toBe(true);
    }
    expect(screen.queryByRole("button", { name: "Save AI app settings" })).toBeNull();
    expect(screen.getByText("https://club.example.test/api/mcp")).toBeTruthy();
    expect(recentAuthFetch).not.toHaveBeenCalled();
  });

  it("saves the four settings behind a fresh proof, with one approved app per line", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(officersBox());
    fireEvent.change(hostsBox(), { target: { value: "claude.ai\n\nexample.org" } });
    fireEvent.click(screen.getByRole("button", { name: "Save AI app settings" }));

    await waitFor(() => expect(recentAuthFetch).toHaveBeenCalledTimes(1));
    const [url, init] = recentAuthFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/admin/mcp/settings");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({
      membersMayConnect: true,
      officersMayConnect: true,
      maxScope: "READ",
      allowedRedirectHosts: ["claude.ai", "", "example.org"],
    });
    expect(await screen.findByText("AI app settings saved.")).toBeTruthy();
    expect(officersBox().disabled).toBe(true);
    expect(officersBox().checked).toBe(true);
  });

  it("shows the server's reason when a save is refused, and stays in edit", async () => {
    recentAuthFetch.mockResolvedValue(
      Response.json({ error: '"not a host" is not a website address.' }, { status: 400 }),
    );
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(hostsBox(), { target: { value: "not a host" } });
    fireEvent.click(screen.getByRole("button", { name: "Save AI app settings" }));
    await waitFor(() =>
      expect(screen.getAllByRole("alert").map((node) => node.textContent).join(" ")).toContain(
        "is not a website address",
      ),
    );
    expect(hostsBox().disabled).toBe(false);
    expect(hostsBox().value).toBe("not a host");
  });

  it("Cancel puts back what was saved and writes nothing", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(membersBox());
    fireEvent.change(hostsBox(), { target: { value: "other.example" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(membersBox().checked).toBe(true);
    expect(hostsBox().value).toBe("claude.ai\nchatgpt.com");
    expect(membersBox().disabled).toBe(true);
    expect(recentAuthFetch).not.toHaveBeenCalled();
  });

  it("lets a support viewer read the settings but not open them for editing", async () => {
    hook.canEdit = false;
    await renderPage();
    expect((screen.getByRole("button", { name: "Edit" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/cannot\s+change them/i)).toBeTruthy();
    expect(hostsBox().value).toBe("claude.ai\nchatgpt.com");
  });
});

describe("AiConnectionsClient: the club's connections", () => {
  const disconnect = (name: string) =>
    screen.getByRole("button", { name: `Disconnect ${name}` }) as HTMLButtonElement;

  it("lists every connection with whose it is, the app and when it was used", async () => {
    await renderPage();
    expect(screen.getByText("Ben Hale")).toBeTruthy();
    expect(screen.getByText(/Example Assistant · claude\.ai · Connected .* · Not used yet/)).toBeTruthy();
    expect(screen.getByText(/Desk Helper · chatgpt\.com · Connected .* · Last used /)).toBeTruthy();
  });

  it("reaches connections beyond the first page and shows the total", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/admin/mcp/settings") return Response.json(SETTINGS);
      const page = new URL(url, "https://club.example.test").searchParams.get("page");
      return Response.json({
        connections: page === "2" ? [CONNECTIONS[1]] : [CONNECTIONS[0]],
        page: Number(page), pageSize: 1, total: 2,
      });
    });
    await renderPage();
    expect(screen.getByText("Showing 1–1 of 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText("Ben Hale");
    expect(screen.queryByText("Ana Reid")).toBeNull();
    expect(screen.getByText("Showing 2–2 of 2")).toBeTruthy();
  });

  it("steps back when disconnecting the only connection on the last page", async () => {
    let removed = false;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/admin/mcp/settings") return Response.json(SETTINGS);
      if (init?.method === "DELETE") {
        removed = true;
        return Response.json({ ok: true });
      }
      const page = new URL(url, "https://club.example.test").searchParams.get("page");
      return Response.json({
        connections: page === "2" ? (removed ? [] : [CONNECTIONS[1]]) : [CONNECTIONS[0]],
        page: Number(page), pageSize: 1, total: removed ? 1 : 2,
      });
    });
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText("Ben Hale");
    fireEvent.click(disconnect("Desk Helper for Ben Hale"));
    await screen.findByText("Ana Reid");
    expect(screen.queryByText("Ben Hale")).toBeNull();
    expect(screen.getByText("Showing 1–1 of 1")).toBeTruthy();
  });

  it("disconnects one connection and removes only that row", async () => {
    await renderPage();
    fireEvent.click(disconnect("Desk Helper for Ben Hale"));
    await waitFor(() =>
      expect(screen.getAllByRole("status").map((node) => node.textContent)).toContain(
        "Disconnected Desk Helper for Ben Hale.",
      ),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/mcp/grants/grant-2",
      expect.objectContaining({ method: "DELETE" }),
    );
    // The list re-reads after the disconnect; the row goes when that read lands.
    await waitFor(() => expect(screen.queryByText("Ben Hale")).toBeNull());
    expect(screen.getByText("Ana Reid")).toBeTruthy();
  });

  it("treats a connection that had already ended as gone", async () => {
    deleteStatus = 404;
    await renderPage();
    fireEvent.click(disconnect("Example Assistant for Ana Reid"));
    await waitFor(() => expect(screen.queryByText("Ana Reid")).toBeNull());
  });

  it("keeps the row and shows why when the disconnect is refused", async () => {
    deleteStatus = 403;
    await renderPage();
    fireEvent.click(disconnect("Example Assistant for Ana Reid"));
    await waitFor(() =>
      expect(screen.getAllByRole("alert").map((node) => node.textContent).join(" ")).toContain(
        "Forbidden by the server",
      ),
    );
    expect(screen.getByText("Ana Reid")).toBeTruthy();
  });

  it("lets a support viewer see the connections but not disconnect them", async () => {
    hook.canEdit = false;
    await renderPage();
    expect(disconnect("Example Assistant for Ana Reid").disabled).toBe(true);
    expect(disconnect("Desk Helper for Ben Hale").disabled).toBe(true);
  });
});
