import { beforeEach, describe, expect, it, vi } from "vitest";

const { send, audit, release } = vi.hoisted(() => ({ send: vi.fn(), audit: vi.fn(), release: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/mcp/loopback", () => ({ sendMcpLoopbackRequest: send }));
vi.mock("@/lib/mcp/audit", () => ({ recordMcpAudit: audit }));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn() } }));
vi.mock("@/lib/mcp/principal", () => ({
  MCP_PRINCIPAL_HEADER: "x-mcp-principal",
  issueMcpPrincipal: (grantId: string) => ({ value: `signed:${grantId}`, release }),
}));

import { findMcpAction, findMcpWebsiteOnlyAction, type McpAction } from "@/lib/mcp/catalogue";
import {
  MCP_RESULT_MAX_CHARS,
  runMcpAction,
  websiteOnlyAnswer,
  type McpCaller,
} from "@/lib/mcp/dispatch";
import { MCP_SCOPE_LABELS } from "@/lib/mcp/scope-labels";

const caller: McpCaller = {
  grantId: "grant-1",
  memberId: "member-1",
  clientName: "Example Assistant",
  scope: "READ_WRITE",
  officerConsent: true,
  clientIp: "203.0.113.9",
  userAgent: "example-agent/1.0",
};
const viewOnly: McpCaller = { ...caller, scope: "READ" };

function action(id: string): McpAction {
  const found = findMcpAction(id);
  if (!found) throw new Error(`No action ${id}`);
  return found;
}

function answer(status: number, body: unknown, extra: Record<string, unknown> = {}) {
  return {
    status,
    contentType: "application/json",
    body: typeof body === "string" ? body : JSON.stringify(body),
    truncated: false,
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXTAUTH_URL", "https://club.example.test");
  send.mockResolvedValue(answer(200, { ok: true }));
  audit.mockResolvedValue(undefined);
});

describe("runMcpAction: the request it sends", () => {
  it("sends a read through the front door as the member, with the public host and the caller's address", async () => {
    const outcome = await runMcpAction(
      action("get_availability"),
      { year: 2026, month: 6, lodgeId: "lodge 1" },
      caller,
    );

    expect(outcome).toEqual({ isError: false, text: '{"ok":true}' });
    expect(send).toHaveBeenCalledTimes(1);
    const request = send.mock.calls[0][0];
    expect(request.method).toBe("GET");
    expect(request.path).toBe("/api/availability?year=2026&month=6&lodgeId=lodge+1");
    expect(request.body).toBeNull();
    expect(request.headers).toMatchObject({
      host: "club.example.test",
      "x-forwarded-proto": "https",
      "x-forwarded-for": "203.0.113.9",
      "x-mcp-principal": "signed:grant-1",
    });
    expect(request.headers).not.toHaveProperty("cookie");
    expect(request.headers).not.toHaveProperty("authorization");
    expect(request.maxBodyChars).toBe(MCP_RESULT_MAX_CHARS);
    // A read leaves no audit row.
    expect(audit).not.toHaveBeenCalled();
  });

  it.each(["..", ".", "../admin/members?x=1", "a/b", "booking 1", ""])(
    "refuses the path argument %j, which could reach another route",
    async (id) => {
      // `..` survives URL encoding, and `/api/bookings/../cancel` is `/api/cancel`.
      for (const name of ["get_my_booking", "preview_cancel_booking"]) {
        const outcome = await runMcpAction(action(name), { id }, caller);
        expect(outcome.isError, name).toBe(true);
      }
      const cancel = await runMcpAction(action("cancel_my_booking"), { id, refundMethod: "credit" }, caller);
      expect(cancel.isError).toBe(true);
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("sends a record id as the one path segment it is", async () => {
    await runMcpAction(action("get_my_booking"), { id: "cm0booking_1-a" }, caller);
    expect(send.mock.calls[0][0].path).toBe("/api/bookings/cm0booking_1-a");
  });

  it("forwards the app's own values and always sets the fixed body fields", async () => {
    send.mockResolvedValue(answer(201, { id: "booking-9", status: "DRAFT" }));
    const outcome = await runMcpAction(
      action("create_draft_booking"),
      {
        checkIn: "2026-08-01",
        checkOut: "2026-08-03",
        guests: [{ firstName: "Ana", lastName: "Reid", ageTier: "ADULT", isMember: true }],
        // An app cannot turn a draft into a confirmed booking, or add fields.
        draft: false,
        confirmOverCapacity: true,
      },
      caller,
    );

    const request = send.mock.calls[0][0];
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/api/bookings");
    expect(request.headers["content-type"]).toBe("application/json");
    const body = JSON.parse(request.body);
    expect(body.draft).toBe(true);
    expect(body.checkIn).toBe("2026-08-01");
    expect(body).not.toHaveProperty("confirmOverCapacity");
    expect(outcome.isError).toBe(false);
    expect(outcome.text).toContain("https://club.example.test/bookings/booking-9");
  });

  it("refuses arguments the action does not accept, before anything is sent", async () => {
    const outcome = await runMcpAction(action("get_availability"), { year: "soon", month: 6 }, caller);
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("year");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("runMcpAction: what it refuses", () => {
  it("does not run a change through a view-only connection, and records the attempt", async () => {
    const outcome = await runMcpAction(
      action("cancel_my_booking"),
      { id: "booking-1", refundMethod: "credit" },
      viewOnly,
    );
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain(`"${MCP_SCOPE_LABELS.READ}"`);
    expect(send).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0][0]).toMatchObject({ succeeded: false, action: "MCP_ACTION_CALLED" });
  });

  it("still runs a read through a view-only connection", async () => {
    const outcome = await runMcpAction(action("list_my_bookings"), {}, viewOnly);
    expect(outcome.isError).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("never runs a fresh-proof route, even if the catalogue named one", async () => {
    const rogue: McpAction = {
      id: "change_modules",
      title: "Change modules",
      summary: "",
      method: "PUT",
      path: "/api/admin/modules",
      kind: "write",
      returns: {},
      core: false,
    };
    const outcome = await runMcpAction(rogue, {}, caller);
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("Nothing was done");
    expect(send).not.toHaveBeenCalled();
  });

  it("never runs a connection-management route", async () => {
    const rogue: McpAction = {
      id: "raise_scope",
      title: "Raise scope",
      summary: "",
      method: "PUT",
      path: "/api/admin/mcp/settings",
      kind: "write",
      returns: {},
      core: false,
    };
    expect((await runMcpAction(rogue, {}, caller)).isError).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("runMcpAction: what it returns and records", () => {
  it("records one audit row for a change: the action, the app and the status, never the arguments", async () => {
    send.mockResolvedValue(answer(200, { refunded: true }));
    await runMcpAction(
      action("cancel_my_booking"),
      { id: "booking-1", refundMethod: "credit" },
      caller,
    );

    expect(audit).toHaveBeenCalledTimes(1);
    const event = audit.mock.calls[0][0];
    expect(event).toMatchObject({
      action: "MCP_ACTION_CALLED",
      succeeded: true,
      actorMemberId: "member-1",
      grantId: "grant-1",
      metadata: { actionId: "cancel_my_booking", clientName: "Example Assistant", status: 200 },
    });
    const written = JSON.stringify(event);
    expect(written).not.toContain("booking-1");
    expect(written).not.toContain("refundMethod");
    expect(written).not.toContain("refunded");
  });

  it("names the member as the subject of a member action's row", async () => {
    send.mockResolvedValue(answer(200, { refunded: true }));
    await runMcpAction(action("cancel_my_booking"), { id: "booking-1", refundMethod: "credit" }, caller);
    expect(audit.mock.calls[0][0]).toMatchObject({ actorMemberId: "member-1", subjectMemberId: "member-1" });
  });

  it("names no subject on an officer action's row: the route's own row names the record", async () => {
    // INV-MCP-008: the officer acts on the club's records, not their own.
    send.mockResolvedValue(answer(200, { noEmails: true }));
    await runMcpAction(action("set_booking_no_emails"), { id: "booking-1", noEmails: true }, caller);
    expect(audit).toHaveBeenCalledTimes(1);
    const event = audit.mock.calls[0][0];
    expect(event).toMatchObject({ actorMemberId: "member-1", severity: "important" });
    expect(event.subjectMemberId).toBeUndefined();
  });

  it("passes the site's refusal back as an error and records it as a failure", async () => {
    send.mockResolvedValue(answer(403, { error: "Not your booking" }));
    const outcome = await runMcpAction(
      action("cancel_my_booking"),
      { id: "booking-2", refundMethod: "card" },
      caller,
    );
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("HTTP 403");
    expect(outcome.text).toContain("Not your booking");
    expect(audit.mock.calls[0][0]).toMatchObject({ succeeded: false, metadata: { status: 403 } });
  });

  it("says a long result was cut", async () => {
    send.mockResolvedValue(answer(200, "x".repeat(MCP_RESULT_MAX_CHARS), { truncated: true }));
    const outcome = await runMcpAction(action("list_my_bookings"), {}, caller);
    expect(outcome.isError).toBe(false);
    expect(outcome.text).toContain("was cut");
  });

  it("does not follow a redirect or hand back a page", async () => {
    send.mockResolvedValue(answer(307, "", { contentType: "" }));
    expect((await runMcpAction(action("list_my_bookings"), {}, caller)).isError).toBe(true);
    send.mockResolvedValue(answer(200, "<html></html>", { contentType: "text/html" }));
    expect((await runMcpAction(action("list_my_bookings"), {}, caller)).isError).toBe(true);
  });

  it("tells the app when a change may or may not have happened", async () => {
    send.mockRejectedValue(new Error("socket hang up"));
    const outcome = await runMcpAction(
      action("cancel_my_booking"),
      { id: "booking-1", refundMethod: "credit" },
      caller,
    );
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("not known whether");
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it("ends the internal sign-in value when the call answers and when it fails", async () => {
    await runMcpAction(action("get_my_booking"), { id: "booking-1" }, caller);
    expect(release).toHaveBeenCalledTimes(1);

    send.mockRejectedValue(new Error("socket hang up"));
    await runMcpAction(action("get_my_booking"), { id: "booking-1" }, caller);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("still answers when the audit write fails", async () => {
    audit.mockRejectedValue(new Error("db down"));
    const outcome = await runMcpAction(
      action("cancel_my_booking"),
      { id: "booking-1", refundMethod: "credit" },
      caller,
    );
    expect(outcome.isError).toBe(false);
  });
});

describe("websiteOnlyAnswer", () => {
  it("answers with the page and runs nothing", () => {
    const pay = findMcpWebsiteOnlyAction("pay_for_booking");
    if (!pay) throw new Error("missing");
    const outcome = websiteOnlyAnswer(pay, { id: "booking-7" });
    expect(outcome.isError).toBe(false);
    expect(outcome.text).toContain("https://club.example.test/bookings/booking-7");
    expect(outcome.text).toContain("Nothing was done");
    expect(send).not.toHaveBeenCalled();
    expect(websiteOnlyAnswer(pay, { id: "../../admin" }).isError).toBe(true);
  });
});
