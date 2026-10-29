import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PRIVACY_RETENTION_SETTINGS } from "@/lib/privacy-retention-shared";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  hasAdminAreaAccess: vi.fn(),
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  preview: vi.fn(),
}));
vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/admin-permissions", () => ({ hasAdminAreaAccess: mocks.hasAdminAreaAccess }));
vi.mock("@/lib/privacy-retention-settings", () => ({ getPrivacyRetentionSettings: mocks.getSettings, savePrivacyRetentionSettings: mocks.saveSettings }));
vi.mock("@/lib/privacy-retention", () => ({ getPrivacyRetentionPreview: mocks.preview }));
import { GET, PUT } from "../route";

const groups = {
  emailLogs: { count: 1, rows: [{ id: "email-1", date: new Date("2023-06-01T00:00:00Z") }] },
  rejectedApplications: { count: 0, rows: [] },
  formerMembers: { count: 1, rows: [{ id: "former-1", date: new Date("2018-06-01T00:00:00Z") }] },
  blockedMembers: { count: 1, rows: [{ id: "blocked-1", date: new Date("2018-06-01T00:00:00Z"), reasons: ["Has account credit"] }] },
  undatedMembers: { count: 1, rows: [{ id: "undated-1", date: null }] },
};
const request = (query = "") => new Request(`https://club.example/api/admin/privacy-retention${query}`);
const put = (body: unknown) => new Request("https://club.example/api/admin/privacy-retention", { method: "PUT", body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "admin-1" } } });
  mocks.hasAdminAreaAccess.mockReturnValue(true);
  mocks.getSettings.mockResolvedValue(DEFAULT_PRIVACY_RETENTION_SETTINGS);
  mocks.saveSettings.mockResolvedValue(DEFAULT_PRIVACY_RETENTION_SETTINGS);
  mocks.preview.mockResolvedValue({ settings: DEFAULT_PRIVACY_RETENTION_SETTINGS, ...groups });
});

describe("privacy retention admin API", () => {
  it.each([401, 403])("honours GET/PUT guard rejection %s without reading or writing", async (status) => {
    mocks.requireAdmin.mockResolvedValue({ ok: false, response: new Response(null, { status }) });
    expect((await GET(request())).status).toBe(status);
    expect((await PUT(put(DEFAULT_PRIVACY_RETENTION_SETTINGS))).status).toBe(status);
    expect(mocks.getSettings).not.toHaveBeenCalled();
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.saveSettings).not.toHaveBeenCalled();
  });
  it("requires support view and delegates paged preview to the job selector", async () => {
    const response = await GET(request("?page=2"));
    expect(mocks.requireAdmin).toHaveBeenCalledWith({ permission: { area: "support", level: "view" } });
    expect(mocks.preview).toHaveBeenCalledWith({ page: 2, pageSize: 25, includeMembers: true });
    const payload = await response.json();
    expect(payload.settings).toEqual(DEFAULT_PRIVACY_RETENTION_SETTINGS);
    expect(mocks.getSettings).not.toHaveBeenCalled();
    expect(payload.preview.formerMembers.rows[0]).toEqual({ id: "former-1", date: "2018-06-01T00:00:00.000Z" });
    expect(payload.preview.blockedMembers.rows[0].reasons).toEqual(["Has account credit"]);
    expect(payload.preview.undatedMembers.rows[0].date).toBeNull();
    expect(payload.page).toBe(2);
  });
  it("omits every member group and disables their reads without membership view", async () => {
    mocks.hasAdminAreaAccess.mockReturnValue(false);
    const payload = await (await GET(request())).json();
    expect(mocks.hasAdminAreaAccess).toHaveBeenCalledWith({ id: "admin-1" }, { area: "membership", level: "view" });
    expect(mocks.preview).toHaveBeenCalledWith({ page: 1, pageSize: 25, includeMembers: false });
    expect(payload.canViewMembership).toBe(false);
    expect(Object.keys(payload.preview)).toEqual(["emailLogs"]);
    expect(JSON.stringify(payload)).not.toContain("former-1");
    expect(JSON.stringify(payload)).not.toContain("undated-1");
  });
  it.each(["0", "-1", "1.5", "abc", "Infinity", "9007199254740992"])("rejects invalid page %s before selection", async (page) => {
    expect((await GET(request(`?page=${page}`))).status).toBe(400);
    expect(mocks.preview).not.toHaveBeenCalled();
  });
  it("requires support edit and saves strict values with the acting member", async () => {
    const response = await PUT(put(DEFAULT_PRIVACY_RETENTION_SETTINGS));
    expect(response.status).toBe(200);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({ permission: { area: "support", level: "edit" } });
    expect(mocks.saveSettings).toHaveBeenCalledWith(DEFAULT_PRIVACY_RETENTION_SETTINGS, "admin-1");
    expect(await response.json()).toEqual({ settings: DEFAULT_PRIVACY_RETENTION_SETTINGS });
  });
  it.each([
    {},
    { ...DEFAULT_PRIVACY_RETENTION_SETTINGS, emailLogRetentionYears: 0 },
    { ...DEFAULT_PRIVACY_RETENTION_SETTINGS, anonymiseMembersEnabled: "true" },
    { ...DEFAULT_PRIVACY_RETENTION_SETTINGS, unexpected: true },
  ])("rejects invalid or unknown settings without saving", async (body) => {
    expect((await PUT(put(body))).status).toBe(400);
    expect(mocks.saveSettings).not.toHaveBeenCalled();
  });
  it("rejects malformed JSON without saving", async () => {
    const response = await PUT(new Request(request(), { method: "PUT", body: "{" }));
    expect(response.status).toBe(400);
    expect(mocks.saveSettings).not.toHaveBeenCalled();
  });
});
