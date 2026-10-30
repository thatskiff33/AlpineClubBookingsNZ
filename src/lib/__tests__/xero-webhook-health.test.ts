import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ settings: vi.fn(), connected: vi.fn(), enabled: vi.fn(), connection: vi.fn(), upsert: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {
  xeroInboundSettings: { findUnique: h.settings, upsert: h.upsert, updateMany: h.update },
  xeroConnection: { findUnique: h.connection },
} }));
vi.mock("@/lib/xero-token-store", () => ({ isXeroConnected: h.connected }));
vi.mock("@/lib/admin-modules", () => ({ isEffectiveModuleEnabled: h.enabled }));
import { getXeroWebhookHealth, recordXeroWebhookReceived } from "@/lib/xero-webhook-health";

describe("Xero webhook health", () => {
  const at = new Date("2026-07-01T00:00:00.000Z");
  beforeEach(() => {
    h.upsert.mockResolvedValue({ createdAt: at, silentWebhookHours: 24, lastWebhookReceivedAt: null });
    h.enabled.mockResolvedValue(true); h.connected.mockResolvedValue(true);
    h.connection.mockResolvedValue({ createdAt: new Date(at.getTime() - 48 * 3600000) });
    h.settings.mockResolvedValue({ createdAt: at, silentWebhookHours: 24, lastWebhookReceivedAt: new Date(at.getTime() - 24 * 3600000) });
  });
  it("warns strictly after the club threshold, not at or just before it", async () => {
    expect((await getXeroWebhookHealth(new Date(at.getTime() - 1))).silent).toBe(false);
    expect((await getXeroWebhookHealth(at)).silent).toBe(false);
    expect((await getXeroWebhookHealth(new Date(at.getTime() + 1))).silent).toBe(true);
  });
  it("honours the saved hours and defaults to 24 without a row", async () => {
    h.settings.mockResolvedValue({ createdAt: at, silentWebhookHours: 48, lastWebhookReceivedAt: new Date(at.getTime() - 25 * 3600000) });
    expect((await getXeroWebhookHealth(at)).silent).toBe(false);
    h.settings.mockResolvedValue(null);
    expect(await getXeroWebhookHealth(at)).toMatchObject({ hours: 24, silent: false, lastReceivedAt: null });
  });
  it("gives a newly connected club its full threshold when no webhook was ever recorded", async () => {
    h.settings.mockResolvedValue({ createdAt: new Date(at.getTime() - 48 * 3600000), silentWebhookHours: 24, lastWebhookReceivedAt: null });
    h.connection.mockResolvedValue({ createdAt: at });
    expect((await getXeroWebhookHealth(at)).silent).toBe(false);
    expect((await getXeroWebhookHealth(new Date(at.getTime() + 24 * 3600000 + 1))).silent).toBe(true);
  });
  it("measures a NULL receipt from control creation, not a pre-existing connection", async () => {
    h.settings.mockResolvedValue({ createdAt: at, silentWebhookHours: 24, lastWebhookReceivedAt: null });
    expect(await getXeroWebhookHealth(at)).toMatchObject({ silent: false, lastReceivedAt: null });
    expect((await getXeroWebhookHealth(new Date(at.getTime() + 24 * 3600000 - 1))).silent).toBe(false);
    expect((await getXeroWebhookHealth(new Date(at.getTime() + 24 * 3600000))).silent).toBe(false);
    expect((await getXeroWebhookHealth(new Date(at.getTime() + 24 * 3600000 + 1))).silent).toBe(true);
  });
  it("persists a missing control row so the observation window does not reset", async () => {
    h.settings.mockResolvedValue(null);
    expect((await getXeroWebhookHealth(at)).silent).toBe(false);
    expect(h.upsert).toHaveBeenCalledWith({ where: { id: "default" }, create: { id: "default" }, update: {} });
    expect((await getXeroWebhookHealth(new Date(at.getTime() + 24 * 3600000 + 1))).silent).toBe(true);
  });
  it.each(["disconnected", "disabled"])("never warns while %s", async (state) => {
    h.settings.mockResolvedValue({ createdAt: new Date(at.getTime() - 48 * 3600000), silentWebhookHours: 24, lastWebhookReceivedAt: null });
    if (state === "disconnected") h.connected.mockResolvedValue(false);
    else h.enabled.mockResolvedValue(false);
    expect((await getXeroWebhookHealth(at)).silent).toBe(false);
  });
  it("advances receipts conditionally so late completion cannot regress the timestamp", async () => {
    await recordXeroWebhookReceived(at);
    expect(h.update).toHaveBeenCalledWith({ where: { id: "default", OR: [{ lastWebhookReceivedAt: null }, { lastWebhookReceivedAt: { lt: at } }] }, data: { lastWebhookReceivedAt: at } });
  });
});
