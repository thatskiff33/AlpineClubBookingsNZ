/**
 * The life of an AI app connection (ALP-653, `INV-MCP-004`).
 *
 * A connection (`McpGrant`) is ACTIVE from the moment a member approves it and
 * ends once, as REVOKED (someone or something ended it) or EXPIRED (the sign-in
 * behind it ended, or the app never collected its approval). Ending is a
 * status-guarded claim: the first writer wins and a later one changes nothing.
 * The connection's tokens and codes are deleted in the same step, so nothing
 * that could still be presented outlives it.
 *
 * `docs/STATE_MACHINES.md` ("AI app connection lifecycle") lists every reason.
 */
import type { McpGrantScope, Prisma, PrismaClient } from "@prisma/client";

import { prisma } from "@/lib/prisma";

export type McpGrantEndStatus = "REVOKED" | "EXPIRED";

export const MCP_GRANT_END_REASONS = {
  /** The member disconnected the app on their profile. */
  memberRevoked: "member-revoked",
  /** An officer disconnected it on the AI connections screen. */
  adminRevoked: "admin-revoked",
  /** The app gave the connection up through the revocation endpoint. */
  appRevoked: "app-revoked",
  /** The member approved the same app again; the newer approval replaces it. */
  replaced: "replaced",
  /** A refresh token that had already been used was presented again. */
  refreshReuse: "refresh-reuse",
  /** An approval code that had already been used was presented again. */
  codeReuse: "code-reuse",
  /** The sign-in that approved the connection is no longer valid. */
  sessionEnded: "session-ended",
  /** The app never exchanged its approval code before the code expired. */
  neverCompleted: "never-completed",
} as const;

export type McpGrantEndReason =
  (typeof MCP_GRANT_END_REASONS)[keyof typeof MCP_GRANT_END_REASONS];

const END_STATUS_BY_REASON: Record<McpGrantEndReason, McpGrantEndStatus> = {
  "member-revoked": "REVOKED",
  "admin-revoked": "REVOKED",
  "app-revoked": "REVOKED",
  replaced: "REVOKED",
  "refresh-reuse": "REVOKED",
  "code-reuse": "REVOKED",
  "session-ended": "EXPIRED",
  "never-completed": "EXPIRED",
};

type McpGrantWriter = Pick<PrismaClient, "mcpGrant" | "mcpToken" | "mcpAuthCode">;

/**
 * Ends every ACTIVE connection `where` selects, for one reason. Returns how
 * many it ended; zero means each was already over and nothing changed.
 */
export async function endMcpGrants(
  where: Prisma.McpGrantWhereInput,
  reason: McpGrantEndReason,
  db: McpGrantWriter = prisma,
): Promise<number> {
  const active = await db.mcpGrant.findMany({
    where: { AND: [where, { status: "ACTIVE" }] },
    select: { id: true },
  });
  if (active.length === 0) return 0;

  const ids = active.map((grant) => grant.id);
  const claimed = await db.mcpGrant.updateMany({
    where: { id: { in: ids }, status: "ACTIVE" },
    data: {
      status: END_STATUS_BY_REASON[reason],
      endedReason: reason,
      endedAt: new Date(),
    },
  });
  // Deleting by id is safe whoever won the claim: a connection that is no
  // longer ACTIVE keeps no tokens under any reason.
  await db.mcpToken.deleteMany({ where: { grantId: { in: ids } } });
  await db.mcpAuthCode.deleteMany({ where: { grantId: { in: ids } } });
  return claimed.count;
}

export function endMcpGrant(
  grantId: string,
  reason: McpGrantEndReason,
  db: McpGrantWriter = prisma,
): Promise<number> {
  return endMcpGrants({ id: grantId }, reason, db);
}

const MCP_GRANT_LIST_SELECT = {
  id: true,
  scope: true,
  createdAt: true,
  lastUsedAt: true,
  client: { select: { name: true } },
  // Each approval creates its own grant and code; the code stays until the
  // grant ends. Registered alternatives do not identify the approved app.
  authCodes: { select: { redirectUri: true }, take: 1 },
} as const;

/**
 * A connection is listed while the app holds a refresh token it can still
 * use: unspent and unexpired. Before the app collects its approval there is
 * nothing it could use, and a member who closed the window would otherwise
 * see an app "connected" that never was. After an app stops renewing, its
 * last refresh token lapses (30 days) and the connection leaves the lists,
 * though nothing marks its row ended: it can never be used again, and the row
 * stays as the member's connection history (docs/PRIVACY_RETENTION.md).
 */
function connectedWhere(now: Date) {
  return {
    status: "ACTIVE",
    tokens: { some: { kind: "REFRESH", usedAt: null, expiresAt: { gt: now } } },
  } as const satisfies Prisma.McpGrantWhereInput;
}

export interface McpConnectionListItem {
  readonly id: string;
  readonly appName: string;
  /** The host the approval was delivered to: the checkable fact about the app. */
  readonly appHost: string;
  readonly scope: McpGrantScope;
  readonly connectedAt: string;
  readonly lastUsedAt: string | null;
}

function hostOf(redirectUri: string | undefined): string {
  if (!redirectUri) return "";
  try {
    return new URL(redirectUri).hostname;
  } catch {
    return "";
  }
}

function toListItem(grant: {
  id: string;
  scope: McpGrantScope;
  createdAt: Date;
  lastUsedAt: Date | null;
  client: { name: string };
  authCodes: { redirectUri: string }[];
}): McpConnectionListItem {
  return {
    id: grant.id,
    appName: grant.client.name,
    appHost: hostOf(grant.authCodes[0]?.redirectUri),
    scope: grant.scope,
    connectedAt: grant.createdAt.toISOString(),
    lastUsedAt: grant.lastUsedAt?.toISOString() ?? null,
  };
}

export async function listMcpConnectionsForMember(
  memberId: string,
): Promise<McpConnectionListItem[]> {
  const grants = await prisma.mcpGrant.findMany({
    where: { ...connectedWhere(new Date()), memberId },
    select: MCP_GRANT_LIST_SELECT,
    orderBy: { createdAt: "desc" },
  });
  return grants.map(toListItem);
}

export interface McpAdminConnectionListItem extends McpConnectionListItem {
  readonly memberId: string;
  readonly memberName: string;
}

/** Every live connection in the club, newest first, for the officers' screen. */
export async function listMcpConnectionsForAdmin({ page, pageSize }: {
  page: number;
  pageSize: number;
}): Promise<{ connections: McpAdminConnectionListItem[]; total: number }> {
  const connected = connectedWhere(new Date());
  const total = await prisma.mcpGrant.count({ where: connected });
  const grants = await prisma.mcpGrant.findMany({
    where: connected,
    select: {
      ...MCP_GRANT_LIST_SELECT,
      memberId: true,
      member: { select: { firstName: true, lastName: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: (page - 1) * pageSize,
    take: pageSize,
  });
  return { total, connections: grants.map((grant) => ({
    ...toListItem(grant),
    memberId: grant.memberId,
    memberName: `${grant.member.firstName} ${grant.member.lastName}`,
  })) };
}

/** How stale "last used" may be. One write per connection per window, not per call. */
const MCP_LAST_USED_RESOLUTION_MS = 5 * 60 * 1000;

/** Records that a connection was used, at most once per five minutes. */
export async function touchMcpGrantLastUsed(grantId: string, now: Date): Promise<void> {
  await prisma.mcpGrant.updateMany({
    where: {
      id: grantId,
      status: "ACTIVE",
      OR: [
        { lastUsedAt: null },
        { lastUsedAt: { lt: new Date(now.getTime() - MCP_LAST_USED_RESOLUTION_MS) } },
      ],
    },
    data: { lastUsedAt: now },
  });
}
