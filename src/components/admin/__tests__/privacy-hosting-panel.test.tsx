// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
const mocks = vi.hoisted(() => ({ canEdit: vi.fn<() => boolean | undefined>(() => true) }));
vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: () => mocks.canEdit(),
  ADMIN_VIEW_ONLY_ACTION_REASON: "View-only reason",
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { PrivacyHostingPanel } from "@/components/admin/privacy-hosting-panel";
import { ADMIN_FORBIDDEN_SAVE_REASON } from "@/components/admin/view-only-action";
const loaded = { hostingProvider: "Example Hosting", dataLocation: null };
const fetchMock = vi.fn();
const provider = () => screen.getByLabelText("Hosting provider");
const location = () => screen.getByLabelText("Where your data is held");
const save = () => screen.getByRole("button", { name: "Save hosting details" });
const puts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT");
beforeEach(() => {
  vi.clearAllMocks(); mocks.canEdit.mockReturnValue(true);
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
    const settings = init?.method === "PUT" ? Object.fromEntries(Object.entries(JSON.parse(String(init.body))).map(([key, value]) => [key, String(value ?? "").trim() || null])) : loaded;
    return new Response(JSON.stringify({ settings }));
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function edit() {
  render(<PrivacyHostingPanel />);
  await screen.findByDisplayValue("Example Hosting");
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
}
describe("PrivacyHostingPanel staged settings", () => {
  it("loads read-only, stages both fields and ignores whitespace-only changes", async () => {
    render(<PrivacyHostingPanel />);
    await screen.findByDisplayValue("Example Hosting");
    expect(provider()).toBeDisabled(); expect(location()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(provider()).toBeEnabled(); expect(location()).toBeEnabled(); expect(save()).toBeDisabled();
    fireEvent.change(provider(), { target: { value: "Example Hosting  " } });
    fireEvent.change(location(), { target: { value: "  " } });
    expect(save()).toBeDisabled(); expect(puts()).toHaveLength(0);
    expect(screen.getByText(/database and backups.*different/i)).toBeVisible();
    expect(screen.getByText(/published privacy policy does not change/i)).toBeVisible();
  });
  it("saves both values once and reseeds the server snapshot", async () => {
    await edit();
    fireEvent.change(provider(), { target: { value: "  New Hosting  " } });
    fireEvent.change(location(), { target: { value: "Database: NZ; backups: Australia" } });
    fireEvent.click(save());
    await screen.findByText("Hosting details updated.");
    expect(puts()).toHaveLength(1);
    expect(puts()[0]?.[0]).toBe("/api/admin/privacy-hosting");
    expect(JSON.parse(String(puts()[0]?.[1]?.body))).toEqual({ hostingProvider: "New Hosting", dataLocation: "Database: NZ; backups: Australia" });
    expect(provider()).toHaveValue("New Hosting"); expect(provider()).toBeDisabled();
  });
  it("Cancel restores both saved fields without writing", async () => {
    await edit();
    fireEvent.change(provider(), { target: { value: "Other" } });
    fireEvent.change(location(), { target: { value: "NZ" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(provider()).toHaveValue("Example Hosting"); expect(location()).toHaveValue(""); expect(provider()).toBeDisabled(); expect(puts()).toHaveLength(0);
  });
  it("refuses an overlong value before sending", async () => {
    await edit();
    fireEvent.change(provider(), { target: { value: "a".repeat(121) } });
    fireEvent.click(save());
    await waitFor(() => expect(provider()).toHaveAttribute("aria-invalid", "true"));
    expect(save()).toBeDisabled(); expect(puts()).toHaveLength(0);
  });
  it("keeps the banner mounted through failed loading and retry", async () => {
    mocks.canEdit.mockReturnValue(false);
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    render(<PrivacyHostingPanel />);
    const banner = screen.getByText(/Content edit access is required/i).closest('[role="status"]');
    finish(new Response("{}", { status: 500 }));
    await screen.findByText("Could not load hosting details.");
    expect(banner).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByDisplayValue("Example Hosting");
    expect(banner).toBeInTheDocument(); expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled(); expect(provider()).toBeDisabled();
  });
  it("keeps the draft after a forbidden save and clears feedback on Cancel", async () => {
    await edit(); fetchMock.mockResolvedValueOnce(new Response("{}", { status: 403 }));
    fireEvent.change(provider(), { target: { value: "Changed" } }); fireEvent.click(save());
    await screen.findByText(ADMIN_FORBIDDEN_SAVE_REASON);
    expect(provider()).toHaveValue("Changed"); expect(provider()).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(ADMIN_FORBIDDEN_SAVE_REASON)).toBeNull(); expect(provider()).toHaveValue("Example Hosting");
  });
  it("keeps unresolved permissions neutral", async () => {
    mocks.canEdit.mockReturnValue(undefined); render(<PrivacyHostingPanel />);
    await screen.findByDisplayValue("Example Hosting");
    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled(); expect(screen.queryByText(/Content edit access is required/i)).toBeNull();
  });
});
