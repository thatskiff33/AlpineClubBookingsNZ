/**
 * Who a bulk member communication reaches (#4964, #4987).
 *
 * The single recipient query behind Admin → Members → Communications. Both the
 * read-only count the page shows beside the compose form and in its
 * confirmation step (GET
 * `/api/admin/communications/send?recipientFilter=…&category=…`) and the send
 * itself (POST on the same route) call {@link selectBulkCommunicationRecipients},
 * so the number the officer confirms is the number the send selects
 * (`INV-SSOT`). Never copy the `where` clause or the preference rule into a
 * caller: who each category reaches is decided only by `partitionBulkAudience`
 * (INV-PRIV-026).
 */
import "server-only";
import { prisma } from "@/lib/prisma";
import { MEMBER_LEVEL_ROLE_VALUES } from "@/lib/member-roles";
import {
  BULK_EMAIL_PREFERENCE_SELECT,
  partitionBulkAudience,
  type BulkEmailCategory,
} from "@/lib/email/bulk-audience";

export const BULK_RECIPIENT_FILTERS = [
  "all",
  "members-only",
  "admins-only",
  "custom",
] as const;

export type BulkRecipientFilter = (typeof BULK_RECIPIENT_FILTERS)[number];

export interface BulkCommunicationRecipient {
  id: string;
  email: string;
}

export interface BulkCommunicationSelection {
  total: BulkCommunicationRecipient[];
  eligible: BulkCommunicationRecipient[];
  optedOut: BulkCommunicationRecipient[];
  neverOptedIn: BulkCommunicationRecipient[];
}

/**
 * Active accounts matching the filter (`total`), split by the category's
 * preference rule into the accounts a send emails (`eligible`), those whose
 * saved preferences exclude the category (`optedOut`) and those with no saved
 * preferences that an opt-in category excludes (`neverOptedIn`).
 *
 * - `clubNotice` is opt-out: every account is eligible unless its saved row has
 *   Club notices off, so an account with no row is sent it.
 * - `newsletter` is opt-in: only accounts with Club newsletters on are
 *   eligible, so an account with no row is not sent it.
 *
 * - `all`: every active account, whatever its role.
 * - `members-only`: active member-level accounts (`MEMBER_LEVEL_ROLE_VALUES`),
 *   so `Member.role` ADMIN accounts are not included.
 * - `admins-only`: active `Member.role` ADMIN accounts. That is the Full Admin
 *   access role only (`legacyRoleFromAccessRoles`): officers on other admin
 *   roles keep `Member.role` USER, so `members-only` reaches them.
 * - `custom`: the active accounts among `memberIds`; none when it is empty.
 *
 * The page, the guide's Audiences table and the changelog describe these in
 * words; the route tests pin the facts those words rest on.
 */
export async function selectBulkCommunicationRecipients(
  recipientFilter: BulkRecipientFilter,
  memberIds: readonly string[] | undefined,
  category: BulkEmailCategory,
): Promise<BulkCommunicationSelection> {
  const whereClause: Record<string, unknown> = { active: true };
  if (recipientFilter === "members-only") {
    whereClause.role = { in: [...MEMBER_LEVEL_ROLE_VALUES] };
  } else if (recipientFilter === "admins-only") {
    whereClause.role = "ADMIN";
  } else if (recipientFilter === "custom") {
    whereClause.id = { in: [...(memberIds ?? [])] };
  }

  const recipients = await prisma.member.findMany({
    where: whereClause,
    select: {
      id: true,
      email: true,
      notificationPreference: { select: BULK_EMAIL_PREFERENCE_SELECT },
    },
  });

  const toRecipient = ({ id, email }: BulkCommunicationRecipient) => ({
    id,
    email,
  });
  const partition = partitionBulkAudience(recipients, category);
  return {
    total: recipients.map(toRecipient),
    eligible: partition.eligible.map(toRecipient),
    optedOut: partition.optedOut.map(toRecipient),
    neverOptedIn: partition.neverOptedIn.map(toRecipient),
  };
}

/** The counts the count route and the send both report; never addresses. */
export function bulkCommunicationCounts(selection: BulkCommunicationSelection) {
  return {
    totalRecipients: selection.total.length,
    eligibleRecipients: selection.eligible.length,
    optedOut: selection.optedOut.length,
    neverOptedIn: selection.neverOptedIn.length,
  };
}
