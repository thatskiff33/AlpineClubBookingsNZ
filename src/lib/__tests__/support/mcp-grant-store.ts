/**
 * An in-memory double for the AI-connection tables (ALP-653): connections
 * (`McpGrant`), their tokens and their approval codes. `where` clauses go
 * through the shared evaluator (`prisma-where.ts`), with a connection's
 * `tokens` and `authCodes` resolved as relations, so a test that says "someone
 * else's connection is not ended" is answered the way PostgreSQL would.
 */
import { vi } from "vitest";

import { matchesWhere, type WhereInput, type WhereRow } from "./prisma-where";

export interface StoredMcpGrant {
  id: string;
  memberId: string;
  clientId: string;
  scope: "READ" | "READ_WRITE";
  status: "ACTIVE" | "REVOKED" | "EXPIRED";
  endedReason: string | null;
  endedAt: Date | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  sessionIssuedAt: Date;
  twoFactorVerified: boolean;
  officerConsentAt: Date | null;
  client: { name: string; redirectUris: string[] };
  member: { firstName: string; lastName: string };
}

export interface StoredMcpToken {
  id: string;
  grantId: string;
  kind: "ACCESS" | "REFRESH";
  usedAt?: Date | null;
  expiresAt?: Date;
}

/** A refresh token the app can still use: unspent, expiring after the frozen clock's today. */
export function liveRefreshToken(id: string, grantId: string): StoredMcpToken {
  return { id, grantId, kind: "REFRESH", usedAt: null, expiresAt: new Date("2026-07-31T00:00:00.000Z") };
}

export interface StoredMcpAuthCode {
  id: string;
  grantId: string;
  expiresAt: Date;
  codeHash?: string;
  redirectUri?: string;
  codeChallenge?: string;
}

export function mcpGrant(overrides: Partial<StoredMcpGrant> & { id: string }): StoredMcpGrant {
  return {
    memberId: "member-1",
    clientId: "client-1",
    scope: "READ",
    status: "ACTIVE",
    endedReason: null,
    endedAt: null,
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    lastUsedAt: null,
    sessionIssuedAt: new Date("2026-06-30T00:00:00.000Z"),
    twoFactorVerified: false,
    officerConsentAt: null,
    client: { name: "Example Assistant", redirectUris: ["https://claude.ai/callback"] },
    member: { firstName: "Ana", lastName: "Reid" },
    ...overrides,
  };
}

export function createMcpGrantStore(seed: {
  grants?: StoredMcpGrant[];
  tokens?: StoredMcpToken[];
  codes?: StoredMcpAuthCode[];
}) {
  const state = {
    grants: [...(seed.grants ?? [])],
    tokens: [...(seed.tokens ?? [])],
    codes: [...(seed.codes ?? [])],
  };
  let created = 0;

  const grantMatches = (row: StoredMcpGrant, where: WhereInput | undefined) =>
    matchesWhere(row, where, {
      label: "mcp grant store (grant)",
      relation: (candidate: WhereRow, key: string) => {
        if (key === "tokens") {
          return { related: state.tokens.filter((token) => token.grantId === candidate.id) };
        }
        if (key === "authCodes") {
          return { related: state.codes.filter((code) => code.grantId === candidate.id) };
        }
        return undefined;
      },
    });

  function removeWhere<T extends object>(rows: T[], where: WhereInput, label: string): number {
    const keep = rows.filter((row) => !matchesWhere(row, where, { label }));
    const removed = rows.length - keep.length;
    rows.splice(0, rows.length, ...keep);
    return removed;
  }

  const db = {
    mcpGrant: {
      count: vi.fn(async ({ where }: { where?: WhereInput }) =>
        state.grants.filter((grant) => grantMatches(grant, where)).length,
      ),
      findMany: vi.fn(async ({ where, skip = 0, take }: { where?: WhereInput; skip?: number; take?: number }) =>
        state.grants.filter((grant) => grantMatches(grant, where))
          .slice(skip, take === undefined ? undefined : skip + take)
          .map((grant) => ({
            ...grant,
            authCodes: state.codes.filter((code) => code.grantId === grant.id),
          })),
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const grant = state.grants.find((candidate) => candidate.id === where.id);
        return grant ? { ...grant } : null;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: WhereInput; data: Partial<StoredMcpGrant> }) => {
        const matched = state.grants.filter((grant) => grantMatches(grant, where));
        for (const grant of matched) Object.assign(grant, data);
        return { count: matched.length };
      }),
      create: vi.fn(async ({ data }: { data: Partial<StoredMcpGrant> }) => {
        created += 1;
        const grant = mcpGrant({ ...data, id: `grant-new-${created}`, createdAt: new Date() });
        state.grants.push(grant);
        return { id: grant.id };
      }),
    },
    mcpToken: {
      deleteMany: vi.fn(async ({ where }: { where: WhereInput }) => ({
        count: removeWhere(state.tokens, where, "mcp grant store (token)"),
      })),
    },
    mcpAuthCode: {
      findFirst: vi.fn(async ({ where }: { where: WhereInput }) => {
        const code = state.codes.find((candidate) => matchesWhere(candidate, where, { label: "mcp grant store (code)" }));
        return code ? { ...code } : null;
      }),
      deleteMany: vi.fn(async ({ where }: { where: WhereInput }) => ({
        count: removeWhere(state.codes, where, "mcp grant store (code)"),
      })),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        // Every column the writer sent is kept, so a test can read back what was stored.
        state.codes.push({ id: `code-${state.codes.length + 1}`, ...data } as StoredMcpAuthCode);
        return {};
      }),
    },
  };

  return { db, state };
}

export type McpGrantStore = ReturnType<typeof createMcpGrantStore>;
