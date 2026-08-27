import "server-only";

import { prisma } from "@/lib/prisma";
import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";
import { sanitizePageContentHtml } from "@/lib/page-content-html";
import { resolveTextTokens } from "@/lib/page-content-embeds";
import { hasAdminAccess, type AccessRoleInput } from "@/lib/access-roles";

// Canonical display order for the three keyed documents.
export const LODGE_INSTRUCTION_KEYS = ["OPEN", "CLOSE", "DAY_TO_DAY"] as const;

type LodgeInstructionKeyValue = (typeof LODGE_INSTRUCTION_KEYS)[number];

// Re-exported: the multi-lodge admin editor route consumes these labels
// (post-#1519 cleanup, this export is live again).
export const LODGE_INSTRUCTION_LABELS: Record<
  LodgeInstructionKeyValue,
  { title: string; description: string }
> = {
  OPEN: {
    title: "Opening the Lodge",
    description: "Steps to open the lodge at the start of a stay or season.",
  },
  CLOSE: {
    title: "Closing the Lodge",
    description: "Steps to shut the lodge down safely before leaving.",
  },
  DAY_TO_DAY: {
    title: "Day-to-Day Running",
    description: "Daily routines and duties while the lodge is occupied.",
  },
};

export type LodgeInstructionDocument = {
  key: LodgeInstructionKeyValue;
  title: string;
  description: string;
  contentHtml: string;
  updatedAt: string | null;
};

/**
 * A member qualifies as a lodge-instructions reader while they hold a
 * current or upcoming hut leader assignment (endDate on or after today,
 * NZ date-only semantics). Expired assignments do not qualify.
 */
async function hasCurrentOrUpcomingHutLeaderAssignment(
  memberId: string,
): Promise<boolean> {
  const today = await clubTodayDateOnlyInstant();
  const count = await prisma.hutLeaderAssignment.count({
    where: {
      memberId,
      endDate: { gte: today },
    },
  });
  return count > 0;
}

/**
 * Reader access rule for the lodge instructions: admins always qualify;
 * members qualify with a current or upcoming hut leader assignment.
 * (The lodge kiosk surface uses the kiosk auth path instead.)
 */
export async function canReadLodgeInstructions(
  memberId: string,
  subject: AccessRoleInput,
): Promise<boolean> {
  if (hasAdminAccess(subject)) {
    return true;
  }
  return hasCurrentOrUpcomingHutLeaderAssignment(memberId);
}

/**
 * Returns all three documents in canonical order. Stored values are
 * sanitised on write, but every render path injects contentHtml with
 * dangerouslySetInnerHTML, so sanitise again on read (defence in depth,
 * matching getSanitizedPageContentByPath).
 *
 * Lodge scoping (docs/multi-lodge/lodge-scoping-contract.md): rows with a
 * null lodgeId are the club-wide documents; a row for [lodgeId, key]
 * REPLACES the club-wide document of that key for that lodge (replace,
 * never merge — the same rule as the booking-policy overrides). Pass the
 * lodge the reader is scoped to; omit it (or pass null) for the club-wide
 * documents only.
 *
 * When `resolveTokens` is set, text tokens such as {{club-name}} are
 * replaced after sanitising; resolveTextTokens HTML-escapes every
 * replacement value, so resolution cannot reintroduce unsafe markup.
 * Reader/kiosk routes resolve tokens; the admin editor route must not,
 * so editors round-trip the literal {{token}} text.
 *
 * Accepts either a bare lodgeId (legacy positional form) or an options
 * object carrying lodgeId and/or resolveTokens.
 */
export type GetLodgeInstructionsOptions = {
  lodgeId?: string | null;
  resolveTokens?: boolean;
};

export async function getSanitizedLodgeInstructions(
  lodgeIdOrOptions?: string | null | GetLodgeInstructionsOptions,
): Promise<LodgeInstructionDocument[]> {
  const options: GetLodgeInstructionsOptions =
    typeof lodgeIdOrOptions === "object" && lodgeIdOrOptions !== null
      ? lodgeIdOrOptions
      : { lodgeId: lodgeIdOrOptions ?? null };
  const lodgeId = options.lodgeId ?? null;
  const records = await prisma.lodgeInstruction.findMany({
    where: lodgeId ? { OR: [{ lodgeId: null }, { lodgeId }] } : { lodgeId: null },
    select: {
      key: true,
      contentHtml: true,
      updatedAt: true,
      lodgeId: true,
    },
  });

  // Per key, prefer the lodge's override row over the club-wide (null) row.
  // Loose null check: mocked or narrow rows may omit lodgeId entirely; a
  // missing lodgeId means club-wide, same as null.
  const byKey = new Map<string, (typeof records)[number]>();
  for (const record of records) {
    const existing = byKey.get(record.key);
    if (!existing || record.lodgeId != null) {
      byKey.set(record.key, record);
    }
  }

  return Promise.all(
    LODGE_INSTRUCTION_KEYS.map(async (key) => {
      const record = byKey.get(key);
      let contentHtml = record
        ? sanitizePageContentHtml(record.contentHtml)
        : "";
      if (options?.resolveTokens && contentHtml) {
        contentHtml = await resolveTextTokens(contentHtml);
      }
      return {
        key,
        title: LODGE_INSTRUCTION_LABELS[key].title,
        description: LODGE_INSTRUCTION_LABELS[key].description,
        contentHtml,
        updatedAt: record ? record.updatedAt.toISOString() : null,
      };
    }),
  );
}
