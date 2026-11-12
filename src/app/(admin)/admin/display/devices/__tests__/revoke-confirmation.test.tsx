// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DevicesPage from "../page";

const access = vi.hoisted(() => ({ canEdit: true }));
vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-admin-area-edit-access")>()),
  useAdminAreaEditAccess: () => access.canEdit,
}));
const device = {
  id: "device-1", name: "Lobby TV", lodgeId: "lodge-1", lodgeName: "Main Lodge",
  templateId: null, templateName: null, pollSeconds: null, paired: true,
  pairingArmedUntil: null, lastSeenAt: null, revoked: false,
};
beforeEach(() => {
  access.canEdit = true;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/revoke")) return Response.json({});
    if (url === "/api/admin/display/devices") return Response.json({ devices: [device] });
    if (url === "/api/admin/display/templates") return Response.json({ templates: [] });
    if (url === "/api/admin/lodges") return Response.json({ lodges: [] });
    throw new Error(url);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Revoke confirmation", () => {
  it("names the device, explains pairing, and cancels without a request", async () => {
    render(<DevicesPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Revoke Lobby TV?");
    expect(dialog).toHaveTextContent(/return to pairing.*paired again at the lodge/i);
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });
  it("sends one revoke request after confirming", async () => {
    render(<DevicesPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/admin/display/devices/device-1/revoke", { method: "POST" }));
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it("does not open the dialog for a view-only admin", async () => {
    access.canEdit = false;
    render(<DevicesPage />);
    const button = await screen.findByRole("button", { name: "Revoke" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
