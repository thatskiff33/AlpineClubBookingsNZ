/**
 * The contract an AI app action exposes (ALP-718, `INV-MCP-006`), checked by
 * calling its route handler the way the dispatcher's loopback call reaches it.
 *
 * `expectActionContract` builds the request from the catalogue entry itself
 * (method, path, and where each argument goes), so a test cannot pass a
 * request the app could never send. It runs the handler twice:
 *
 * - as a connection (the principal header present): the answer must be a
 *   success whose fields are exactly the action's `returns`, at every depth;
 * - as a browser (no header): the answer is handed back for the test to pin
 *   as unchanged.
 *
 * Tests sign the caller in with `officerMemberSession()`, a member who is
 * also a Full Admin, so a route that lent a connection officer reach would
 * answer with more than the member's own records and fail the test.
 */
import { NextRequest } from "next/server";
import { expect } from "vitest";

import type { ConnectionField, ConnectionShape } from "@/lib/connection-projection";
import { findMcpAction, mcpActionInputSchema, splitMcpActionArguments, type McpAction } from "@/lib/mcp/catalogue";
import { MCP_PRINCIPAL_HEADER } from "@/lib/mcp/principal";

import { adminSession } from "./sessions";

const ORIGIN = "https://club.example.test";

/** A member who also holds every officer power: what a connection must never be lent. */
export function officerMemberSession(id = "officer-1") {
  return adminSession({ id, accessRoles: ["USER", "ADMIN"] });
}

type RouteHandler = (request: never, context: never) => Promise<Response>;

function requestFor(
  action: McpAction,
  args: Readonly<Record<string, unknown>>,
  viaConnection: boolean,
): { request: Request; context: { params: Promise<Record<string, unknown>> } } {
  const parsed = mcpActionInputSchema(action).safeParse(args);
  expect(parsed.success, `${action.id}: the catalogue's schema accepts the arguments`).toBe(true);
  const { params, query, body } = splitMcpActionArguments(action, args);
  const path = action.path.replace(/\[([A-Za-z]+)\]/g, (_match, key: string) =>
    encodeURIComponent(String(params[key])),
  );
  const url = new URL(path, ORIGIN);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  const headers: Record<string, string> = { accept: "application/json" };
  if (viaConnection) headers[MCP_PRINCIPAL_HEADER] = "contract-test-principal";
  if (body !== null) headers["content-type"] = "application/json";
  return {
    // A NextRequest, as the App Router hands every handler.
    request: new NextRequest(url, {
      method: action.method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
    }),
    context: { params: Promise.resolve(params) },
  };
}

function expectField(value: unknown, field: ConnectionField, path: string): void {
  if (field === true) {
    const plain = (item: unknown) =>
      item === null || ["string", "number", "boolean"].includes(typeof item);
    expect(plain(value) || (Array.isArray(value) && value.every(plain)), `${path} is a plain value`).toBe(true);
    return;
  }
  if (value === null) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => expectField(item, field, `${path}[${index}]`));
    return;
  }
  expect(typeof value, `${path} is an object`).toBe("object");
  const record = value as Record<string, unknown>;
  const entryField = Object.getOwnPropertySymbols(field).map(
    (symbol) => (field as unknown as Record<symbol, ConnectionField>)[symbol],
  )[0];
  if (entryField !== undefined) {
    for (const [key, inner] of Object.entries(record)) expectField(inner, entryField, `${path}.${key}`);
    return;
  }
  expectExactShape(record, field as ConnectionShape, path);
}

function expectExactShape(value: Record<string, unknown>, shape: ConnectionShape, path: string): void {
  expect(Object.keys(value).sort(), `${path} has exactly the fields the action returns`).toEqual(
    Object.keys(shape).sort(),
  );
  for (const [key, field] of Object.entries(shape)) expectField(value[key], field, `${path}.${key}`);
}

/**
 * Runs `actionId`'s route as a connection and as a browser. Fixtures should
 * carry every field the action returns, and more, so the comparison is exact.
 */
export async function expectActionContract(options: {
  actionId: string;
  handler: RouteHandler;
  args?: Readonly<Record<string, unknown>>;
}): Promise<{ connection: unknown; browser: unknown }> {
  const action = findMcpAction(options.actionId);
  expect(action, `${options.actionId} is in the catalogue`).toBeDefined();
  const run = async (viaConnection: boolean) => {
    const { request, context } = requestFor(action!, options.args ?? {}, viaConnection);
    const call = options.handler as unknown as (r: Request, c: unknown) => Promise<Response>;
    const response = await call(request, context);
    expect(response.status, `${options.actionId} succeeds`).toBeLessThan(300);
    return response.json() as Promise<unknown>;
  };
  const connection = await run(true);
  expectExactShape(connection as Record<string, unknown>, action!.returns, options.actionId);
  const browser = await run(false);
  return { connection, browser };
}
