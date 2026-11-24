import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { expectDefaultInvalidJsonAnswer, MALFORMED_JSON_BODY } from "./helpers/invalid-json-body";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  transaction: vi.fn(),
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  updateMany: vi.fn(),
  executeRaw: vi.fn(),
  logAudit: vi.fn(),
  revalidate: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/audit", () => ({ logAudit: mocks.logAudit }));
vi.mock("@/lib/public-content-revalidation", () => ({
  revalidatePublicPageContent: mocks.revalidate,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));

import {
  DELETE,
  PUT,
} from "@/app/api/admin/booking-policies/minimum-stay/[id]/route";
import { DUPLICATE_MINIMUM_STAY_POLICY_NAME_MESSAGE } from "@/lib/minimum-stay-policy-set";

const policy = {
  id: "policy-1",
  name: "Winter weekends",
  startDate: new Date("2026-06-01T00:00:00.000Z"),
  endDate: new Date("2026-09-30T00:00:00.000Z"),
  triggerDays: [5, 6],
  minimumNights: 2,
  capacityMode: "HOLD",
  active: true,
  lodgeId: "lodge-1",
  version: 4,
};

function request(method: "PUT" | "DELETE", body: unknown) {
  return new NextRequest("https://example.test/api/policy/policy-1", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const context = { params: Promise.resolve({ id: "policy-1" }) };

describe("minimum-stay policy versioned writes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-1" } },
    });
    mocks.executeRaw.mockResolvedValue(1);
    // #2363 duplicate-name guard; default is "no other ACTIVE row uses it".
    mocks.findFirst.mockResolvedValue(null);
    mocks.transaction.mockImplementation((callback) =>
      callback({
        minimumStayPolicy: {
          findUnique: mocks.findUnique,
          findFirst: mocks.findFirst,
          updateMany: mocks.updateMany,
        },
        $executeRaw: mocks.executeRaw,
      }),
    );
  });

  it("rejects a stale PUT with the current version and no side effects", async () => {
    mocks.findUnique.mockResolvedValue({ ...policy, version: 5 });

    const response = await PUT(request("PUT", { version: 4, name: "Changed" }), context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "This policy changed since it was loaded. Reload it and try again.",
      code: "POLICY_VERSION_CONFLICT",
      currentVersion: 5,
    });
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.executeRaw).toHaveBeenCalledTimes(1);
    expect(mocks.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.findUnique.mock.invocationCallOrder[0],
    );
    expect(mocks.logAudit).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it("does not increment, audit or revalidate a pristine PUT", async () => {
    mocks.findUnique.mockResolvedValue(policy);

    const response = await PUT(request("PUT", { version: 4, name: policy.name }), context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ id: "policy-1", version: 4 }),
    );
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.logAudit).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it("guards a material PUT by version and increments exactly once", async () => {
    mocks.findUnique
      .mockResolvedValueOnce(policy)
      .mockResolvedValueOnce({ ...policy, capacityMode: "NO_HOLD", version: 5 });
    mocks.updateMany.mockResolvedValue({ count: 1 });

    const response = await PUT(
      request("PUT", { version: 4, capacityMode: "NO_HOLD" }),
      context,
    );

    expect(response.status).toBe(200);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "policy-1", version: 4 },
      data: {
        capacityMode: "NO_HOLD",
        version: { increment: 1 },
      },
    });
    expect(mocks.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.findUnique.mock.invocationCallOrder[0],
    );
    expect(mocks.logAudit).toHaveBeenCalledTimes(1);
    expect(mocks.revalidate).toHaveBeenCalledTimes(1);
  });

  it("refuses a rename onto another ACTIVE policy's name in the same scope (#2363)", async () => {
    mocks.findUnique.mockResolvedValue(policy);
    mocks.findFirst.mockResolvedValue({ id: "policy-2" });

    const response = await PUT(
      request("PUT", { version: 4, name: "Summer holidays" }),
      context,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: DUPLICATE_MINIMUM_STAY_POLICY_NAME_MESSAGE,
      code: "POLICY_NAME_CONFLICT",
    });
    // Same partition, ACTIVE only, and never counting the row being edited.
    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: {
        id: { not: "policy-1" },
        lodgeId: "lodge-1",
        name: "Summer holidays",
        active: true,
      },
      select: { id: true },
    });
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.logAudit).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it("refuses a REACTIVATE that would bring a duplicate name back into use", async () => {
    mocks.findUnique.mockResolvedValue({ ...policy, active: false });
    mocks.findFirst.mockResolvedValue({ id: "policy-2" });

    const response = await PUT(request("PUT", { version: 4, active: true }), context);

    expect(response.status).toBe(409);
    expect(mocks.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ name: policy.name, active: true }),
      }),
    );
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("does not ask the name question at all when the row stays INACTIVE", async () => {
    mocks.findUnique
      .mockResolvedValueOnce({ ...policy, active: false })
      .mockResolvedValueOnce({ ...policy, active: false, name: "Renamed", version: 5 });
    mocks.updateMany.mockResolvedValue({ count: 1 });

    const response = await PUT(
      request("PUT", { version: 4, name: "Renamed" }),
      context,
    );

    expect(response.status).toBe(200);
    expect(mocks.findFirst).not.toHaveBeenCalled();
  });

  it("requires a version for deactivation and guards the material write", async () => {
    const invalid = await DELETE(request("DELETE", {}), context);
    expect(invalid.status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();

    mocks.findUnique.mockResolvedValue(policy);
    mocks.updateMany.mockResolvedValue({ count: 1 });
    const response = await DELETE(request("DELETE", { version: 4 }), context);

    expect(response.status).toBe(200);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "policy-1", version: 4, active: true },
      data: { active: false, version: { increment: 1 } },
    });
    expect(mocks.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.findUnique.mock.invocationCallOrder[0],
    );
  });

  // #5407 item 27: the read sat inside the try that also wraps the transaction,
  // whose catch knows only the policy errors and ZodError, so a body that was
  // not JSON fell through to its 500. It is now the shared invalid-JSON 400,
  // before the transaction; a body of the wrong shape keeps its ZodError 400.
  it.each(["PUT", "DELETE"] as const)(
    "answers a %s body that is not JSON with the shared 400 and opens no transaction (#5407)",
    async (method) => {
      const handler = method === "PUT" ? PUT : DELETE;
      const response = await handler(
        new NextRequest("https://example.test/api/policy/policy-1", {
          method,
          headers: { "content-type": "application/json" },
          body: MALFORMED_JSON_BODY,
        }),
        context,
      );

      await expectDefaultInvalidJsonAnswer(response);
      expect(mocks.transaction).not.toHaveBeenCalled();
    },
  );

  it("keeps the ZodError answer for a PUT body of the wrong shape (#5407)", async () => {
    const response = await PUT(request("PUT", { version: "four" }), context);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "Validation failed" });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
