// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FamilyGroupsPage from "../page";

const searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-admin-area-edit-access")>()),
  useAdminAreaEditAccess: () => true,
}));
const group = {
  id: "g1", name: "Kea Family", members: [], memberCount: 0,
  inactiveCount: 0, pendingRequests: 0, createdAt: "2026-04-15T23:30:00.000Z",
};
let failure: unknown;
beforeEach(() => {
  failure = { error: "Family group not found" };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "DELETE") {
      if (failure === "network") throw new Error("Network failed");
      if (failure === "invalid-json") return new Response("Unavailable", { status: 503 });
      return Response.json(failure, { status: 404 });
    }
    if (url.endsWith("/requests")) return Response.json({ requests: [] });
    if (url.endsWith("/partner-invites")) return Response.json({ invites: [] });
    if (url === "/api/admin/family-groups") return Response.json({ familyGroups: [group] });
    throw new Error(url);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function openDelete() {
  render(<FamilyGroupsPage />);
  fireEvent.click(await screen.findByRole("button", { name: "Delete Kea Family" }));
  return screen.findByRole("dialog");
}
describe("family group deletion", () => {
  it("names the group and unlinked members; cancel sends nothing", async () => {
    const dialog = await openDelete();
    expect(dialog).toHaveTextContent("Delete Kea Family?");
    expect(dialog).toHaveTextContent("Members will be unlinked.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });
  it.each([
    [{ error: "Family group not found" }, "Family group not found"],
    [{}, "Failed to delete family group"],
    ["invalid-json", "Failed to delete family group"],
    ["network", "Failed to delete family group"],
  ])("shows a delete failure without opening the edit form (%j)", async (body, message) => {
    failure = body;
    const dialog = await openDelete();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete group" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("button", { name: "Delete Kea Family" })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/api/admin/family-groups/g1", { method: "DELETE" });
  });
});
