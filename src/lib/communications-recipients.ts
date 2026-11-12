import "server-only";

import { z } from "zod";
import {
  BULK_EMAIL_CATEGORIES,
  BULK_EMAIL_PREFERENCE_SELECT,
  partitionBulkAudience,
  type BulkAudiencePartition,
  type BulkEmailCategory,
  type BulkEmailPreference,
} from "@/lib/email/bulk-audience";
import { MEMBER_LEVEL_ROLE_VALUES } from "@/lib/member-roles";
import { prisma } from "@/lib/prisma";

/**
 * The Communications recipient query (#4987). The send route and the pre-send
 * preview both resolve their audience here, then partition it with the shared
 * bulk-email rule, so the preview count is the count that is sent.
 */

export const communicationRecipientFilterSchema = z.enum([
  "all",
  "members-only",
  "admins-only",
  "custom",
]);

export type CommunicationRecipientFilter = z.infer<
  typeof communicationRecipientFilterSchema
>;

export const bulkEmailCategorySchema = z.enum(BULK_EMAIL_CATEGORIES);

export type CommunicationRecipient = {
  id: string;
  email: string;
  notificationPreference: BulkEmailPreference | null;
};

export type CommunicationRecipients =
  | {
      ok: true;
      total: number;
      partition: BulkAudiencePartition<CommunicationRecipient>;
    }
  | { ok: false; error: string };

export async function resolveCommunicationRecipients(input: {
  recipientFilter: CommunicationRecipientFilter;
  memberIds?: string[];
  category: BulkEmailCategory;
}): Promise<CommunicationRecipients> {
  const where: Record<string, unknown> = { active: true };
  if (input.recipientFilter === "members-only") {
    where.role = { in: [...MEMBER_LEVEL_ROLE_VALUES] };
  } else if (input.recipientFilter === "admins-only") {
    where.role = "ADMIN";
  } else if (input.recipientFilter === "custom") {
    if (!input.memberIds || input.memberIds.length === 0) {
      return { ok: false, error: "memberIds required for custom filter" };
    }
    where.id = { in: input.memberIds };
  }
  // "all" uses just { active: true }

  const members = await prisma.member.findMany({
    where,
    select: {
      id: true,
      email: true,
      notificationPreference: { select: BULK_EMAIL_PREFERENCE_SELECT },
    },
  });

  return {
    ok: true,
    total: members.length,
    partition: partitionBulkAudience(members, input.category),
  };
}

/** The counts both routes report; never addresses. */
export function communicationRecipientCounts(
  total: number,
  partition: BulkAudiencePartition<unknown>,
) {
  return {
    totalRecipients: total,
    eligibleRecipients: partition.eligible.length,
    optedOut: partition.optedOut.length,
    neverOptedIn: partition.neverOptedIn.length,
  };
}
