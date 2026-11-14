/**
 * Who a bulk member communication reaches (#4964).
 *
 * The single recipient query behind Admin → Members → Communications. Both the
 * read-only count the page shows in its confirmation step (GET
 * `/api/admin/communications/send?recipientFilter=…`) and the send itself (POST
 * on the same route) call {@link selectBulkCommunicationRecipients}, so the
 * number the officer confirms is the number the send selects (`INV-SSOT`).
 * Never copy the `where` clause or the opt-in filter into a caller.
 */
import "server-only";
import { prisma } from "@/lib/prisma";
import { MEMBER_LEVEL_ROLE_VALUES } from "@/lib/member-roles";

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

/**
 * Active accounts matching the filter (`total`), and the subset that opted in
 * to marketing email (`eligible`) — the only accounts a send emails.
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
  memberIds?: readonly string[],
): Promise<{
  total: BulkCommunicationRecipient[];
  eligible: BulkCommunicationRecipient[];
}> {
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
      notificationPreference: {
        select: { marketingEmails: true },
      },
    },
  });

  // No preference record means marketingEmails is false, so those are excluded.
  const toRecipient = ({ id, email }: BulkCommunicationRecipient) => ({
    id,
    email,
  });
  return {
    total: recipients.map(toRecipient),
    eligible: recipients
      .filter((r) => r.notificationPreference?.marketingEmails === true)
      .map(toRecipient),
  };
}
