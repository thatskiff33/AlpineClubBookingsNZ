import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ level: "edit", findUnique: vi.fn(), upsert: vi.fn(), audit: vi.fn(), revalidate: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "officer" } }) }));
vi.mock("@/lib/admin-permissions", () => ({
  hasAdminAreaAccess: (_user: unknown, permission: { area: string; level: string }) => permission.area === "content" && (mocks.level === "edit" || (mocks.level === "view" && permission.level === "view")),
  hasAdminPortalAccess: () => true,
}));
vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock,
  requireActiveSessionUser: async () => null,
}));
vi.mock("@/lib/prisma", () => {
  const tx = { privacyHostingSettings: { findUnique: mocks.findUnique, upsert: mocks.upsert }, auditLog: { create: mocks.audit } };
  return { prisma: { ...tx, $transaction: async (fn: (tx: unknown) => unknown) => fn(tx) } };
});
vi.mock("@/lib/audit", () => ({ buildStructuredAuditLogCreateArgs: (v: unknown) => v, getAuditRequestContext: () => ({}) }));
vi.mock("@/lib/public-content-revalidation", () => ({ revalidatePublicPageContent: mocks.revalidate }));
import { GET, PUT } from "@/app/api/admin/privacy-hosting/route";
const put = (body: unknown) => PUT(new Request("http://localhost/api/admin/privacy-hosting", { method: "PUT", body: JSON.stringify(body) }));
beforeEach(() => {
  vi.clearAllMocks(); mocks.level = "edit";
  mocks.findUnique.mockResolvedValue(null);
  mocks.upsert.mockImplementation(async ({ create }: { create: { hostingProvider: string | null; dataLocation: string | null } }) => ({ hostingProvider: create.hostingProvider, dataLocation: create.dataLocation }));
});
it("reads an absent row as not set", async () => {
  expect(await (await GET()).json()).toEqual({ settings: { hostingProvider: null, dataLocation: null } });
});
it.each(["view", "none"])("refuses writes by %s permission without effects", async level => {
  mocks.level = level;
  expect((await put({ hostingProvider: "Example", dataLocation: null })).status).toBe(403);
  expect(mocks.upsert).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled(); expect(mocks.revalidate).not.toHaveBeenCalled();
});
it("allows content view reads and forbids unrelated admins", async () => {
  mocks.level = "view"; expect((await GET()).status).toBe(200);
  mocks.level = "none"; expect((await GET()).status).toBe(403);
});
it("saves trimmed plain text, records before/after once and refreshes pages", async () => {
  const before = { hostingProvider: "Old", dataLocation: "Old place" };
  mocks.findUnique.mockResolvedValue(before);
  const response = await put({ hostingProvider: " Example & <Host> ", dataLocation: " " });
  expect(response.status).toBe(200);
  const after = { hostingProvider: "Example & <Host>", dataLocation: null };
  expect(await response.json()).toEqual({ settings: after });
  expect(mocks.upsert).toHaveBeenCalledTimes(1);
  expect(mocks.audit).toHaveBeenCalledTimes(1);
  expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ category: "admin", metadata: { before, after } }));
  expect(mocks.revalidate).toHaveBeenCalledTimes(1);
});
it.each([{}, { hostingProvider: "a\nb", dataLocation: null }, { hostingProvider: "a".repeat(121), dataLocation: null }, { hostingProvider: null, dataLocation: null, extra: true }])("rejects invalid input without writing", async body => {
  expect((await put(body)).status).toBe(400); expect(mocks.upsert).not.toHaveBeenCalled();
});
it("rejects malformed JSON", async () => {
  expect((await PUT(new Request("http://localhost", { method: "PUT", body: "{" }))).status).toBe(400);
  expect(mocks.upsert).not.toHaveBeenCalled();
});
