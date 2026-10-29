import "server-only";
import { prisma } from "@/lib/prisma";
import { isXeroConnected } from "@/lib/xero-token-store";
import { isEffectiveModuleEnabled } from "@/lib/admin-modules";

export const DEFAULT_SILENT_WEBHOOK_HOURS = 24;

export function isXeroWebhookSilent({ connected, lastReceivedAt, connectedAt, hours, now }: {
  connected: boolean; lastReceivedAt: Date | null; connectedAt: Date | null; hours: number; now: Date;
}) {
  if (!connected) return false;
  const since = lastReceivedAt ?? connectedAt;
  return since !== null && now.getTime() - since.getTime() > hours * 60 * 60 * 1000;
}

/** Signed, structurally valid receipt only; ITR verification remains separate. */
export async function recordXeroWebhookReceived(now = new Date()) {
  // Upsert without a stamp first, then advance monotonically: an older delivery
  // finishing later can never make the club look quieter than it is.
  await prisma.xeroInboundSettings.upsert({ where: { id: "default" }, create: { id: "default" }, update: {} });
  await prisma.xeroInboundSettings.updateMany({
    where: { id: "default", OR: [{ lastWebhookReceivedAt: null }, { lastWebhookReceivedAt: { lt: now } }] },
    data: { lastWebhookReceivedAt: now },
  });
}

export async function getXeroWebhookHealth(now = new Date()) {
  const [settings, moduleEnabled] = await Promise.all([
    prisma.xeroInboundSettings.findUnique({ where: { id: "default" } }),
    isEffectiveModuleEnabled("xeroIntegration"),
  ]);
  const connected = moduleEnabled && await isXeroConnected();
  const connection = connected ? await prisma.xeroConnection.findUnique({ where: { id: "default" }, select: { createdAt: true } }) : null;
  const hours = settings?.silentWebhookHours ?? DEFAULT_SILENT_WEBHOOK_HOURS;
  const lastReceivedAt = settings?.lastWebhookReceivedAt ?? null;
  const silent = isXeroWebhookSilent({ connected, lastReceivedAt, connectedAt: connection?.createdAt ?? null, hours, now });
  return { connected, silent, hours, lastReceivedAt: lastReceivedAt?.toISOString() ?? null };
}
