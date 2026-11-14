import "server-only";
import { prisma } from "@/lib/prisma";
import { PRIVACY_HOSTING_DEFAULTS, type PrivacyHostingValues } from "@/lib/privacy-hosting";

export const PRIVACY_HOSTING_SELECT = { hostingProvider: true, dataLocation: true } as const;

/** An absent row means no disclosure supplied, never a guess from server config. */
export async function getPrivacyHostingSettings(): Promise<PrivacyHostingValues> {
  return await prisma.privacyHostingSettings.findUnique({
    where: { id: "default" }, select: PRIVACY_HOSTING_SELECT,
  }) ?? { ...PRIVACY_HOSTING_DEFAULTS };
}
