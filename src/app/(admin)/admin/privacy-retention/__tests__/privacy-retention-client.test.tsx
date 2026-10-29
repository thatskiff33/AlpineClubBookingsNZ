// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClubTimeProvider } from "@/components/club-time-provider";
import { DEFAULT_PRIVACY_RETENTION_SETTINGS } from "@/lib/privacy-retention-shared";
import { SENTRY_REPLAY_POLICY_CHANGED } from "@/lib/privacy-retention-replay";

const mocks = vi.hoisted(() => ({ canEdit: true as boolean | undefined, push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: () => mocks.canEdit,
  ADMIN_VIEW_ONLY_ACTION_REASON: "Your admin role can view this area but cannot make changes.",
}));
import { PrivacyRetentionClient } from "../privacy-retention-client";
const empty = { count: 0, rows: [] };
const PAYLOAD = {
  settings: DEFAULT_PRIVACY_RETENTION_SETTINGS,
  preview: {
    emailLogs: { count: 26, rows: [{ id: "email-1", date: "2023-06-01T00:00:00Z" }] },
    rejectedApplications: empty,
    formerMembers: { count: 1, rows: [{ id: "member-1", date: "2018-06-01T00:00:00Z" }] },
    blockedMembers: { count: 1, rows: [{ id: "blocked-1", date: "2018-06-01T00:00:00Z", reasons: ["Has account credit"] }] },
    undatedMembers: { count: 1, rows: [{ id: "undated-1", date: null }] },
  },
  pageSize: 25,
  canViewMembership: true,
};
function json(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status }); }
let fetchMock: ReturnType<typeof vi.fn>;
function renderClient(page = 1, zone = "Pacific/Auckland") {
  return render(<ClubTimeProvider zone={zone} locale="en-NZ"><PrivacyRetentionClient page={page} /></ClubTimeProvider>);
}
async function loaded() { await screen.findByText("Email logs to delete (26)"); }

beforeEach(() => {
  mocks.canEdit = true;
  mocks.push.mockReset();
  fetchMock = vi.fn(async () => json(PAYLOAD));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("privacy retention settings and dry run", () => {
  it("shows saved defaults read-only with separate blocked and undated lists", async () => {
    renderClient(); await loaded();
    expect(screen.getByLabelText("Email logs (years)")).toBeDisabled();
    expect(screen.getByLabelText("Email logs (years)")).toHaveValue(2);
    expect(screen.getByLabelText("Enable former-member anonymisation")).not.toBeChecked();
    expect(screen.getByLabelText("Enable Sentry Session Replay")).not.toBeChecked();
    expect(screen.getByText(/Name Sentry Session Replay/)).toBeInTheDocument();
    expect(screen.getByText("Has account credit")).toBeInTheDocument();
    expect(screen.getByText("no leaving date — set one to include")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "undated-1" })).toHaveAttribute("href", "/admin/members/undated-1");
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });
  it("keeps leaving dates as calendar days while projecting log instants into the club zone", async () => {
    renderClient(1, "America/Denver"); await loaded();
    expect(screen.getByText("31 May 2023")).toBeInTheDocument();
    expect(screen.getAllByText("1 Jun 2018")).toHaveLength(2);
  });
  it("prevents saving a period outside the shared schema bounds", async () => {
    renderClient(); await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Email logs (years)"), { target: { value: "0" } });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("stages changes, dirty-gates Save, and Cancel restores all values without writing", async () => {
    renderClient(); await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Email logs (years)"), { target: { value: "3" } });
    fireEvent.click(screen.getByLabelText("Enable former-member anonymisation"));
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByLabelText("Email logs (years)")).toHaveValue(2);
    expect(screen.getByLabelText("Enable former-member anonymisation")).not.toBeChecked();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("saves once and refreshes the preview using authoritative returned settings", async () => {
    const policyChanged = vi.fn();
    window.addEventListener(SENTRY_REPLAY_POLICY_CHANGED, policyChanged, { once: true });
    const saved = { ...DEFAULT_PRIVACY_RETENTION_SETTINGS, emailLogRetentionYears: 4 };
    fetchMock.mockResolvedValueOnce(json(PAYLOAD)).mockResolvedValueOnce(json({ settings: saved })).mockResolvedValueOnce(json({ ...PAYLOAD, settings: saved }));
    renderClient(); await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Email logs (years)"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Privacy and retention settings saved.");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ ...DEFAULT_PRIVACY_RETENTION_SETTINGS, emailLogRetentionYears: 3 });
    expect(screen.getByLabelText("Email logs (years)")).toHaveValue(4);
    expect(screen.getByLabelText("Email logs (years)")).toBeDisabled();
    expect(policyChanged).toHaveBeenCalledOnce();
  });
  it.each([false, undefined])("gates edits for permission state %s", async (canEdit) => {
    mocks.canEdit = canEdit;
    renderClient(); await loaded();
    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
    expect(screen.getByLabelText("Enable Sentry Session Replay")).toBeDisabled();
    expect(screen.getByTestId("admin-view-only-banner")).toHaveTextContent(canEdit === false ? "You have view-only access to this area" : "");
  });
  it("leaves Edit open on rejected save and announces that nothing was saved", async () => {
    fetchMock.mockResolvedValueOnce(json(PAYLOAD)).mockResolvedValueOnce(json({}, 403));
    renderClient(); await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByLabelText("Enable Sentry Session Replay"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled());
    expect(screen.getAllByRole("alert").some((element) => /not saved/i.test(element.textContent ?? ""))).toBe(true);
  });
  it("shows permission guidance instead of member lists and uses URL pagination", async () => {
    fetchMock.mockResolvedValue(json({ ...PAYLOAD, canViewMembership: false, preview: { emailLogs: PAYLOAD.preview.emailLogs } }));
    renderClient(); await loaded();
    expect(screen.getByText(/Membership view access is required/)).toBeInTheDocument();
    expect(screen.queryByText("member-1")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(mocks.push).toHaveBeenCalledWith("?page=2");
  });
  it("keeps feedback regions mounted while loading and shows first-load failure", async () => {
    fetchMock.mockResolvedValue(json({}, 500));
    renderClient();
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    await screen.findByText(/Could not load the retention preview/);
    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
  });
});
