/**
 * The audit rows AI app connections leave (ALP-653, `INV-MCP-008`).
 *
 * One writer, so every row about a connection has the same category and the
 * same shape: who acted, whose connection, which app. Never an action's
 * arguments or its result (`INV-PRIV-011`).
 */
import "server-only";

import {
  createStructuredAuditLog,
  type AuditSeverity,
  type StructuredAuditEvent,
} from "@/lib/audit";

import { MCP_SETTINGS_ID } from "./settings";

export type McpAuditAction =
  | "MCP_ACTION_CALLED"
  | "MCP_CONNECTION_APPROVED"
  | "MCP_CONNECTION_REVOKED"
  | "MCP_SETTINGS_UPDATED";

export interface McpAuditEvent {
  readonly action: McpAuditAction;
  /** Who did it. For an action call, the member the connection acts for. */
  readonly actorMemberId: string;
  /** Whose connection it is. Absent for the club's settings. */
  readonly subjectMemberId?: string;
  readonly grantId?: string;
  readonly severity?: AuditSeverity;
  readonly succeeded?: boolean;
  readonly summary: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly request?: StructuredAuditEvent["request"];
}

type McpAuditWriter = Parameters<typeof createStructuredAuditLog>[1];

export async function recordMcpAudit(event: McpAuditEvent, db?: McpAuditWriter): Promise<void> {
  await createStructuredAuditLog(
    {
      action: event.action,
      actor: { memberId: event.actorMemberId },
      subject: event.subjectMemberId ? { memberId: event.subjectMemberId } : undefined,
      entity: event.grantId
        ? { type: "McpGrant", id: event.grantId }
        : { type: "McpSettings", id: MCP_SETTINGS_ID },
      category: "security",
      severity: event.severity ?? "info",
      outcome: event.succeeded === false ? "failure" : "success",
      summary: event.summary,
      metadata: event.metadata,
      request: event.request,
    },
    db,
  );
}
