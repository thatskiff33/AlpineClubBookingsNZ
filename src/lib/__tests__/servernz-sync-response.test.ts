import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createAuditLog: vi.fn() }));

vi.mock("@/lib/audit", () => ({ createAuditLog: mocks.createAuditLog }));

import {
  ServerNzApiError,
  ServerNzNotConfiguredError,
  ServerNzVersionMismatchError,
} from "@/lib/servernz-api";
import { SERVER_VERSION_MISMATCH_CODE } from "@/lib/servernz-api-version";
import { respondToSyncError } from "@/lib/servernz-sync-response";

/**
 * The Upload/Download routes' one error mapper. #49 adds the version pause:
 * a 409 like the not-configured case, but audited (an admin pressed a button
 * and nothing happened) and carrying both numbers for the page.
 */

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createAuditLog.mockResolvedValue(undefined);
});

describe("respondToSyncError", () => {
  it("answers a version pause with 409, the machine code and both numbers, and audits a failure", async () => {
    const res = await respondToSyncError(
      new ServerNzVersionMismatchError("2.0", "2.1"),
      "member-1",
      "upload",
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: SERVER_VERSION_MISMATCH_CODE,
      expected: "2.0",
      serverVersion: "2.1",
    });
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "alpine_server.other_lodges.upload",
        category: "lodge",
        outcome: "failure",
        memberId: "member-1",
        details: "this site is built for 2.0; the server reports 2.1",
      }),
    );
  });

  it("still answers not-configured with a bare 409 and no audit row", async () => {
    const res = await respondToSyncError(
      new ServerNzNotConfiguredError("No key."),
      "member-1",
      "download",
    );
    expect(res.status).toBe(409);
    expect(await res.json()).not.toHaveProperty("code");
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("still maps a remote error to an audited 502", async () => {
    const res = await respondToSyncError(new ServerNzApiError(500, "boom"), "member-1", "download");
    expect(res.status).toBe(502);
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ details: "server responded 500: boom" }),
    );
  });
});
