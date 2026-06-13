import "server-only";

import { prisma } from "@/lib/prisma";
import { getTodayDateOnly } from "@/lib/date-only";
import { sanitizePageContentHtml } from "@/lib/page-content-html";

// Canonical display order for the three keyed documents.
export const LODGE_INSTRUCTION_KEYS = ["OPEN", "CLOSE", "DAY_TO_DAY"] as const;

export type LodgeInstructionKeyValue = (typeof LODGE_INSTRUCTION_KEYS)[number];

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

export function isLodgeInstructionKey(
  value: string,
): value is LodgeInstructionKeyValue {
  return (LODGE_INSTRUCTION_KEYS as readonly string[]).includes(value);
}

/**
 * A member qualifies as a lodge-instructions reader while they hold a
 * current or upcoming hut leader assignment (endDate on or after today,
 * NZ date-only semantics). Expired assignments do not qualify.
 */
export async function hasCurrentOrUpcomingHutLeaderAssignment(
  memberId: string,
): Promise<boolean> {
  const today = getTodayDateOnly();
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
  role: string,
): Promise<boolean> {
  if (role === "ADMIN") {
    return true;
  }
  return hasCurrentOrUpcomingHutLeaderAssignment(memberId);
}

/**
 * Returns all three documents in canonical order. Stored values are
 * sanitised on write, but every render path injects contentHtml with
 * dangerouslySetInnerHTML, so sanitise again on read (defence in depth,
 * matching getSanitizedPageContentByPath).
 */
export async function getSanitizedLodgeInstructions(): Promise<
  LodgeInstructionDocument[]
> {
  const records = await prisma.lodgeInstruction.findMany({
    select: {
      key: true,
      contentHtml: true,
      updatedAt: true,
    },
  });

  const byKey = new Map(records.map((record) => [record.key, record]));

  return LODGE_INSTRUCTION_KEYS.map((key) => {
    const record = byKey.get(key);
    return {
      key,
      title: LODGE_INSTRUCTION_LABELS[key].title,
      description: LODGE_INSTRUCTION_LABELS[key].description,
      contentHtml: record ? sanitizePageContentHtml(record.contentHtml) : "",
      updatedAt: record ? record.updatedAt.toISOString() : null,
    };
  });
}
