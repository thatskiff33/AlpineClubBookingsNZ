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
 * answer with more than the member's own records and fail the test. That
 * check means something only where the route has an officer branch (an
 * on-behalf target, an officer-only field, another member's record, such as
 * the booking, cancel and profile routes); a route that reads the signed-in
 * member's own id and nothing else answers the same either way, and its test
 * pins the member id the loader was called with instead.
 *
 * Every nested shape must be exercised: a null or an empty list where the
 * shape names fields fails, so a fixture cannot hide a leaked field.
 *
 * A route with more than one success answer (ALP-794: one promo code or
 * several, a same-lodge or a cross-lodge waitlist offer) has a `returns` that
 * names the fields of every answer, and no one answer carries them all. Its
 * tests pass `oneOfSeveralAnswers`: the answer may then leave out a field, or
 * leave a nested value null or empty, but it still may carry no field the
 * shape does not name. Each answer is run by its own test.
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

/**
 * The request and route context the dispatcher's loopback call hands
 * `action`'s handler for `args`, built from the catalogue entry alone (method,
 * path, and where each argument goes), with the principal header only when
 * `viaConnection`. The arguments must pass the action's own schema. For a
 * test that cannot use `expectActionContract`, such as an answer whose keys
 * vary by outcome, so it still sends only what the app could send.
 */
export function buildActionRequest(
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

/** `exact`: every field of the shape, every nested shape filled. `within`: no field outside the shape. */
type Strictness = "exact" | "within";

function expectField(value: unknown, field: ConnectionField, path: string, strictness: Strictness): void {
  if (field === true) {
    const plain = (item: unknown) =>
      item === null || ["string", "number", "boolean"].includes(typeof item);
    expect(plain(value) || (Array.isArray(value) && value.every(plain)), `${path} is a plain value`).toBe(true);
    return;
  }
  // A nested shape is checked only where the fixture fills it: a null or an
  // empty list would let any field through unseen, so the fixture must carry
  // at least one full entry, unless another answer of the action fills it.
  if (strictness === "within" && (value === null || (Array.isArray(value) && value.length === 0))) return;
  expect(value, `${path} carries a value the shape can be checked against`).not.toBeNull();
  if (Array.isArray(value)) {
    expect(value.length, `${path} carries at least one entry the shape can be checked against`).toBeGreaterThan(0);
    value.forEach((item, index) => expectField(item, field, `${path}[${index}]`, strictness));
    return;
  }
  expect(typeof value, `${path} is an object`).toBe("object");
  const record = value as Record<string, unknown>;
  const entryField = Object.getOwnPropertySymbols(field).map(
    (symbol) => (field as unknown as Record<symbol, ConnectionField>)[symbol],
  )[0];
  if (entryField !== undefined) {
    for (const [key, inner] of Object.entries(record)) expectField(inner, entryField, `${path}.${key}`, strictness);
    return;
  }
  expectShape(record, field as ConnectionShape, path, strictness);
}

function expectShape(value: Record<string, unknown>, shape: ConnectionShape, path: string, strictness: Strictness): void {
  if (strictness === "exact") {
    expect(Object.keys(value).sort(), `${path} has exactly the fields the action returns`).toEqual(
      Object.keys(shape).sort(),
    );
  } else {
    const outside = Object.keys(value).filter((key) => !Object.prototype.hasOwnProperty.call(shape, key));
    expect(outside, `${path} has no field the action does not return`).toEqual([]);
  }
  for (const [key, field] of Object.entries(shape)) {
    if (strictness === "within" && !(key in value)) continue;
    expectField(value[key], field, `${path}.${key}`, strictness);
  }
}

/**
 * Runs `actionId`'s route as a connection and as a browser. Fixtures should
 * carry every field the action returns, and more, so the comparison is exact.
 */
export async function expectActionContract(options: {
  actionId: string;
  handler: RouteHandler;
  args?: Readonly<Record<string, unknown>>;
  /** The route has several success answers and this is one of them (see the module note). */
  oneOfSeveralAnswers?: true;
}): Promise<{ connection: unknown; browser: unknown }> {
  const action = findMcpAction(options.actionId);
  expect(action, `${options.actionId} is in the catalogue`).toBeDefined();
  const run = async (viaConnection: boolean) => {
    const { request, context } = buildActionRequest(action!, options.args ?? {}, viaConnection);
    const call = options.handler as unknown as (r: Request, c: unknown) => Promise<Response>;
    const response = await call(request, context);
    expect(response.status, `${options.actionId} succeeds`).toBeLessThan(300);
    return response.json() as Promise<unknown>;
  };
  const connection = await run(true);
  expect(connection, `${options.actionId} answers with an object`).toEqual(expect.any(Object));
  expectShape(
    connection as Record<string, unknown>,
    action!.returns,
    options.actionId,
    options.oneOfSeveralAnswers ? "within" : "exact",
  );
  const browser = await run(false);
  return { connection, browser };
}
