/**
 * Whether a request arrives as an AI app connection (ALP-653, `INV-MCP-006`).
 *
 * Presence of the internal principal header is enough: such a request is that
 * connection or nobody (`auth()` never falls back to a cookie), so a route
 * that narrows authority or sends a connection less may decide on presence
 * and lose nothing. Outside a request there are no headers and so no
 * connection.
 *
 * It lives outside `src/lib/mcp/` on purpose: an older route that sends a
 * connection less imports it, and a route importing `@/lib/mcp/` is read as
 * built on the module by `mcp-module-off.test.ts`.
 */
import "server-only";

import type { Session } from "next-auth";
import { headers } from "next/headers";
import { NextResponse } from "next/server";

import {
  isPrivilegedAccessRole,
  legacyRoleFromAccessRoles,
  resolveAccessRoles,
  type AccessRoleInput,
} from "@/lib/access-roles";
import { emptyAdminPermissionMatrix } from "@/lib/admin-permissions";
import { projectForConnection, type ConnectionShape } from "@/lib/connection-projection";
import { MCP_PRINCIPAL_HEADER } from "@/lib/mcp/principal";

/** For a handler that has the request. */
export function arrivesAsMcpConnection(request: Request): boolean {
  return request.headers.has(MCP_PRINCIPAL_HEADER);
}

/** For a handler with no `request` argument: reads the request being served. */
export async function servingMcpConnection(): Promise<boolean> {
  try {
    return (await headers()).has(MCP_PRINCIPAL_HEADER);
  } catch {
    return false;
  }
}

/**
 * The session user a route decides with (ALP-718, `INV-MCP-006`). A browser
 * gets the user unchanged. A connection always acts as the member and never
 * as an officer, whatever roles the person holds: it keeps only the
 * classifying access roles (`USER`, whether the account is a member, and
 * `ORG`, whether it is an organisation; `isPrivilegedAccessRole` draws the
 * line), its legacy role is the one those imply (`USER`, or `SCHOOL` for an
 * organisation), and its admin permission matrix is empty, so every officer
 * branch reads as refused.
 *
 * The classifying roles grant nothing; `ORG` takes things away (an
 * organisation is kept off the calendar and food orders), so dropping it
 * would lend an organisation's connection what the account itself is refused
 * (ALP-796). The legacy `SCHOOL` role is the same classification and is kept
 * for the same reason.
 *
 * Call it once, before any officer branch, and decide with what it returns.
 */
export function memberOnlySessionUser<U extends Session["user"] | MemberOnlyInput>(request: Request, user: U): U {
  if (!arrivesAsMcpConnection(request)) return user;
  // Read through the one role resolver, so either assignment shape keeps them,
  // and split on the one privileged/classifying boundary.
  const accessRoles = resolveAccessRoles(user).filter((role) => !isPrivilegedAccessRole(role));
  return {
    ...user,
    // The legacy role the kept roles imply (`SCHOOL` for an organisation),
    // and a legacy `SCHOOL` account stays one whatever its roles say.
    role: user.role === "SCHOOL" ? "SCHOOL" : legacyRoleFromAccessRoles(accessRoles),
    accessRoles,
    adminPermissionMatrix: emptyAdminPermissionMatrix(),
  };
}

/** A session user as `requireActiveSession` returns it: roles, matrix and the login flag. */
type MemberOnlyInput = AccessRoleInput & { id: string; role: string; adminPermissionMatrix?: unknown };

/**
 * The route's JSON answer. A connection's successful answer is projected
 * onto `shape`, the fields its catalogue action promises (`McpAction.returns`);
 * a refusal, and every answer to a browser, is sent unchanged.
 */
export function connectionJson(
  request: Request,
  body: unknown,
  shape: ConnectionShape,
  init?: ResponseInit,
): NextResponse {
  const status = init?.status ?? 200;
  const projected = status >= 200 && status < 300 && arrivesAsMcpConnection(request);
  return NextResponse.json(projected ? projectForConnection(body, shape) : body, init);
}

/**
 * A list route's answer, where the browser reads a bare array. A connection's
 * answer must be an object, so it gets the list under `key`, projected onto
 * `shape` (which names that key).
 */
export function connectionListJson(
  request: Request,
  list: readonly unknown[],
  key: string,
  shape: ConnectionShape,
): NextResponse {
  return connectionJson(request, arrivesAsMcpConnection(request) ? { [key]: list } : list, shape);
}
