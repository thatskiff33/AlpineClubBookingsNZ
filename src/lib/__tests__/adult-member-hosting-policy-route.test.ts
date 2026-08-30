import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  transaction: vi.fn(),
  findUnique: vi.fn(),
  findMany: vi.fn(),
  txFindMany: vi.fn(),
  create: vi.fn(),
  updateMany: vi.fn(),
  lodgeFindUnique: vi.fn(),
  executeRaw: vi.fn(),
  logAudit: vi.fn(),
  revalidate: vi.fn(),
  enqueuePolicyReconciliation: vi.fn(),
  settleHostingCoverage: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/audit", () => ({ logAudit: mocks.logAudit }));
vi.mock("@/lib/public-content-revalidation", () => ({
  revalidatePublicPageContent: mocks.revalidate,
}));
vi.mock("@/lib/adult-member-hosting-policy-reconciliation", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/adult-member-hosting-policy-reconciliation")
  >("@/lib/adult-member-hosting-policy-reconciliation");
  return {
    ...actual,
    enqueueActiveHostingIncidentPolicyReconciliation:
      mocks.enqueuePolicyReconciliation,
  };
});
vi.mock("@/lib/adult-member-hosting-coverage-drain", () => ({
  settleHostingCoverageAfterCommit: mocks.settleHostingCoverage,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    adultMemberHostingPolicy: {
      findUnique: mocks.findUnique,
      // #2569 — the GET and the save body both read BOTH candidate rows, because
      // the card shows what is EFFECTIVE at the scope and only the resolver can
      // say that. `findMany` is fed from whatever `findUnique` was given, so every
      // existing test keeps describing its fixture in one place.
      findMany: mocks.findMany,
    },
  },
}));

import {
  GET,
  PUT,
} from "@/app/api/admin/booking-policies/adult-member-hosting/route";
import { STALE_ADULT_MEMBER_HOSTING_POLICY_MESSAGE } from "@/lib/adult-member-hosting-policy-set";

const stored = {
  id: "policy-1",
  scopeKey: "club-wide",
  lodgeId: null,
  mode: "ADMIN_REVIEW_REQUIRED",
  capacityMode: "HOLD",
  // #2569 — an existing row carries NULL host scopes, which is what makes the
  // upgrade a no-op: the resolver reads them as "this row did not decide" and
  // falls back to the built-in same-booking-only default.
  hostScopeSameBooking: null,
  hostScopeSameBookingOwner: null,
  // #3037's column too: NULL on an existing row, read as OFF, so an upgrading
  // club's Group Trip cover is off until it ticks the box.
  hostScopeSameGroupTrip: null,
  version: 4,
};

function put(body: unknown) {
  return new NextRequest(
    "https://example.test/api/admin/booking-policies/adult-member-hosting",
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function get(lodgeId?: string) {
  return new NextRequest(
    lodgeId
      ? `https://example.test/api/admin/booking-policies/adult-member-hosting?lodgeId=${lodgeId}`
      : "https://example.test/api/admin/booking-policies/adult-member-hosting",
  );
}

describe("adult-member hosting policy route (#2364)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-1" } },
    });
    mocks.executeRaw.mockResolvedValue(1);
    mocks.lodgeFindUnique.mockResolvedValue({ id: "lodge-1", active: true });
    // Mirror the singleton read into the two-row read the effective view needs.
    mocks.findUnique.mockResolvedValue(null);
    mocks.findMany.mockImplementation(async () => {
      const row = await mocks.findUnique();
      return row ? [row] : [];
    });
    mocks.txFindMany.mockResolvedValue([]);
    mocks.enqueuePolicyReconciliation.mockResolvedValue(0);
    mocks.settleHostingCoverage.mockResolvedValue(undefined);
    mocks.transaction.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          $executeRaw: mocks.executeRaw,
          adultMemberHostingPolicy: {
            findUnique: mocks.findUnique,
            findMany: mocks.txFindMany,
            create: mocks.create,
            updateMany: mocks.updateMany,
          },
          lodge: { findUnique: mocks.lodgeFindUnique },
        }),
    );
  });

  it("synthesises the built-in default for a scope with no row, and says so", async () => {
    mocks.findUnique.mockResolvedValue(null);

    const club = await (await GET(get())).json();
    expect(club).toMatchObject({
      scopeKey: "club-wide",
      lodgeId: null,
      mode: "DISABLED",
      // No automatic capacity choice for a new policy (D-R6).
      capacityMode: null,
      version: 0,
      configured: false,
    });

    const lodge = await (await GET(get("lodge-1"))).json();
    expect(lodge).toMatchObject({
      scopeKey: "lodge-1",
      lodgeId: "lodge-1",
      mode: "INHERIT",
      configured: false,
    });
  });

  it("reports a stored row as configured", async () => {
    mocks.findUnique.mockResolvedValue(stored);
    const body = await (await GET(get())).json();
    expect(body).toMatchObject({
      ...stored,
      configured: true,
      // The row did not decide the second dimension, so it inherits (#2569 §2).
      hostScopes: null,
      effective: {
        mode: "ADMIN_REVIEW_REQUIRED",
        modeSource: "CLUB_WIDE",
        hostScopes: { sameBooking: true, sameBookingOwner: false },
        hostScopeSource: "BUILT_IN_DEFAULT",
      },
    });
  });

  it("reports and stores Group Trip coverage, and treats turning it on as a real change (#3037)", async () => {
    // Three things break silently if the new column is not carried the whole way
    // through this route, and each of them looks like success to the admin.
    const groupTripOff = {
      ...stored,
      hostScopeSameBooking: true,
      hostScopeSameBookingOwner: false,
      hostScopeSameGroupTrip: false,
    };

    // 1. The GET has to REPORT the stored value. If it does not, the checkbox
    //    renders unticked and the admin's saved setting looks reverted.
    mocks.findUnique.mockResolvedValue({
      ...groupTripOff,
      hostScopeSameGroupTrip: true,
    });
    const body = await (await GET(get())).json();
    expect(body.hostScopes).toEqual({
      sameBooking: true,
      sameBookingOwner: false,
      sameGroupTrip: true,
    });
    expect(body.effective.hostScopes.sameGroupTrip).toBe(true);

    // 2. Turning it on has to be MATERIAL. Mode and capacity are unchanged here,
    //    so a comparison that ignores the scope returns "unchanged": the admin is
    //    told it saved, nothing is written, no audit entry, no reconciliation and
    //    no cache bust.
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-1" } },
    });
    mocks.executeRaw.mockResolvedValue(1);
    mocks.txFindMany.mockResolvedValue([]);
    mocks.enqueuePolicyReconciliation.mockResolvedValue(0);
    mocks.settleHostingCoverage.mockResolvedValue(undefined);
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.findUnique
      .mockResolvedValueOnce(groupTripOff)
      .mockResolvedValue({ ...groupTripOff, hostScopeSameGroupTrip: true, version: 5 });
    mocks.findMany.mockResolvedValue([
      { ...groupTripOff, hostScopeSameGroupTrip: true, version: 5 },
    ]);
    const saved = await PUT(
      put({
        mode: "ADMIN_REVIEW_REQUIRED",
        capacityMode: "HOLD",
        version: 4,
        hostScopes: {
          sameBooking: true,
          sameBookingOwner: false,
          sameGroupTrip: true,
        },
      }),
    );
    expect(saved.status).toBe(200);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { scopeKey: "club-wide", version: 4 },
      data: {
        mode: "ADMIN_REVIEW_REQUIRED",
        capacityMode: "HOLD",
        hostScopeSameBooking: true,
        hostScopeSameBookingOwner: false,
        hostScopeSameGroupTrip: true,
        version: 5,
      },
    });
    expect(mocks.logAudit).toHaveBeenCalled();
    expect(mocks.revalidate).toHaveBeenCalled();

    // 3. The CONTROL: re-saving the identical set is still an unchanged no-op, so
    //    the assertion above is about the scope moving and not about every write
    //    being classified as material.
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-1" } },
    });
    mocks.executeRaw.mockResolvedValue(1);
    mocks.txFindMany.mockResolvedValue([]);
    const unchangedRow = {
      ...groupTripOff,
      hostScopeSameGroupTrip: true,
      version: 5,
    };
    mocks.findUnique.mockResolvedValue(unchangedRow);
    mocks.findMany.mockResolvedValue([unchangedRow]);
    const again = await PUT(
      put({
        mode: "ADMIN_REVIEW_REQUIRED",
        capacityMode: "HOLD",
        version: 5,
        hostScopes: {
          sameBooking: true,
          sameBookingOwner: false,
          sameGroupTrip: true,
        },
      }),
    );
    expect(again.status).toBe(200);
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.logAudit).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it("gates reads on bookings:view and writes on bookings:edit", async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    });
    expect((await GET(get())).status).toBe(403);
    expect(
      (await PUT(put({ mode: "DISABLED", capacityMode: "HOLD" }))).status,
    ).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenNthCalledWith(1, {
      permission: { area: "bookings", level: "view" },
    });
    expect(mocks.requireAdmin).toHaveBeenNthCalledWith(2, {
      permission: { area: "bookings", level: "edit" },
    });
  });

  it("requires an explicit capacity mode on every write (D-R6)", async () => {
    const response = await PUT(put({ mode: "DISABLED" }));
    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a club-wide INHERIT, which has nothing to inherit from", async () => {
    const response = await PUT(put({ mode: "INHERIT", capacityMode: "HOLD" }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/cannot inherit/i);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("takes the policy-set lock before every set read and reconciliation", async () => {
    mocks.findUnique.mockResolvedValue(null);
    mocks.create.mockResolvedValue({ ...stored, version: 1 });
    const order: string[] = [];
    mocks.executeRaw.mockImplementation(() => {
      order.push("lock");
      return Promise.resolve(1);
    });
    mocks.txFindMany.mockImplementation(() => {
      order.push("policy-set-read");
      return Promise.resolve([]);
    });
    mocks.findUnique.mockImplementation(() => {
      order.push("row-read");
      return Promise.resolve(null);
    });
    mocks.enqueuePolicyReconciliation.mockImplementation(async () => {
      order.push("reconcile");
      return 0;
    });

    await PUT(put({ mode: "DISABLED", capacityMode: "NO_HOLD" }));
    // The second read is #2569's: after the write commits, the response is built
    // from a FRESH resolution of both candidate rows, because a lodge saving
    // "inherit" has to be told what it is now inheriting. It happens AFTER the
    // transaction, so the lock-before-read ordering this test guards is unchanged.
    expect(order[0]).toBe("lock");
    expect(order.indexOf("policy-set-read")).toBeGreaterThan(
      order.indexOf("lock"),
    );
    expect(order.indexOf("row-read")).toBeGreaterThan(order.indexOf("lock"));
    expect(order.indexOf("reconcile")).toBeGreaterThan(
      order.indexOf("policy-set-read"),
    );
  });

  it("creates a first row at version 1 when the editor knew of none", async () => {
    mocks.findUnique.mockResolvedValue(null);
    mocks.create.mockResolvedValue({ ...stored, version: 1 });
    const response = await PUT(
      put({ mode: "ADMIN_REVIEW_REQUIRED", capacityMode: "HOLD" }),
    );
    expect(response.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith({
      data: {
        scopeKey: "club-wide",
        lodgeId: null,
        mode: "ADMIN_REVIEW_REQUIRED",
        capacityMode: "HOLD",
        // Absent `hostScopes` means "this row does not decide the second
        // dimension", stored as both columns NULL — the inherit option (#2569 §2).
        hostScopeSameBooking: null,
        hostScopeSameBookingOwner: null,
        hostScopeSameGroupTrip: null,
        version: 1,
      },
    });
    expect((await response.json()).configured).toBe(true);
    expect(mocks.revalidate).toHaveBeenCalled();
  });

  it("refuses to resurrect a row a concurrent import deleted", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const response = await PUT(
      put({ mode: "DISABLED", capacityMode: "HOLD", version: 4 }),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe(
      STALE_ADULT_MEMBER_HOSTING_POLICY_MESSAGE,
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("compare-and-swaps on the loaded revision and refuses a stale one", async () => {
    mocks.findUnique.mockResolvedValue(stored);
    const stale = await PUT(
      put({ mode: "DISABLED", capacityMode: "HOLD", version: 3 }),
    );
    expect(stale.status).toBe(409);
    expect(mocks.updateMany).not.toHaveBeenCalled();

    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.findUnique
      .mockResolvedValueOnce(stored)
      .mockResolvedValueOnce({ ...stored, mode: "DISABLED", version: 5 });
    const ok = await PUT(
      put({ mode: "DISABLED", capacityMode: "HOLD", version: 4 }),
    );
    expect(ok.status).toBe(200);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { scopeKey: "club-wide", version: 4 },
      data: {
        mode: "DISABLED",
        capacityMode: "HOLD",
        hostScopeSameBooking: null,
        hostScopeSameBookingOwner: null,
        // Null WITH the pair, which is what the migration's CHECK requires: the
        // Group Trip column may be set only on a row that decided the rest.
        hostScopeSameGroupTrip: null,
        version: 5,
      },
    });
    expect(await ok.json()).toMatchObject({ version: 5, configured: true });
  });

  it("refuses when the row moved between the read and the swap", async () => {
    mocks.findUnique.mockResolvedValue(stored);
    mocks.updateMany.mockResolvedValue({ count: 0 });
    const response = await PUT(
      put({ mode: "DISABLED", capacityMode: "HOLD", version: 4 }),
    );
    expect(response.status).toBe(409);
  });

  it("does not write, audit or bust caches for an unchanged re-save (#2143)", async () => {
    mocks.findUnique.mockResolvedValue(stored);
    const response = await PUT(
      put({
        mode: "ADMIN_REVIEW_REQUIRED",
        capacityMode: "HOLD",
        version: 4,
      }),
    );
    expect(response.status).toBe(200);
    expect(mocks.updateMany).not.toHaveBeenCalled();
    // The audit entry and the revalidation belong to a real change; this is a
    // read that happened to arrive as a PUT. An operator asking "who changed
    // the hosting rule, and when" must not be handed a list of admins who
    // opened the card and saved it unchanged — and the public page's cache must
    // not be purged for a write that did not happen (#2143).
    expect(mocks.logAudit).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
    expect(mocks.enqueuePolicyReconciliation).not.toHaveBeenCalled();
    expect(mocks.settleHostingCoverage).not.toHaveBeenCalled();
    // The row still comes back, so the card refreshes to the stored truth.
    expect(await response.json()).toMatchObject({
      version: 4,
      mode: "ADMIN_REVIEW_REQUIRED",
      configured: true,
    });
  });

  it("audits and revalidates for a real change, so the guard above is not vacuous", async () => {
    mocks.findUnique
      .mockResolvedValueOnce(stored)
      .mockResolvedValueOnce({ ...stored, mode: "DISABLED", version: 5 });
    mocks.updateMany.mockResolvedValue({ count: 1 });
    const response = await PUT(
      put({ mode: "DISABLED", capacityMode: "HOLD", version: 4 }),
    );
    expect(response.status).toBe(200);
    expect(mocks.logAudit).toHaveBeenCalledTimes(1);
    expect(mocks.revalidate).toHaveBeenCalledTimes(1);
  });

  it("enqueues affected incidents in the policy transaction and drains only after commit", async () => {
    const order: string[] = [];
    mocks.findUnique
      .mockResolvedValueOnce(stored)
      .mockResolvedValueOnce({ ...stored, mode: "DISABLED", version: 5 });
    mocks.txFindMany.mockResolvedValue([stored]);
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.enqueuePolicyReconciliation.mockImplementation(async () => {
      order.push("enqueue-in-transaction");
      return 1;
    });
    mocks.transaction.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        const result = await fn({
          $executeRaw: mocks.executeRaw,
          adultMemberHostingPolicy: {
            findUnique: mocks.findUnique,
            findMany: mocks.txFindMany,
            create: mocks.create,
            updateMany: mocks.updateMany,
          },
          lodge: { findUnique: mocks.lodgeFindUnique },
        });
        order.push("committed");
        return result;
      },
    );
    mocks.settleHostingCoverage.mockImplementation(async () => {
      order.push("post-commit-drain");
    });

    const response = await PUT(
      put({ mode: "DISABLED", capacityMode: "HOLD", version: 4 }),
    );

    expect(response.status).toBe(200);
    expect(order).toEqual([
      "enqueue-in-transaction",
      "committed",
      "post-commit-drain",
    ]);
    expect(mocks.enqueuePolicyReconciliation).toHaveBeenCalledWith(
      { beforePolicies: [stored] },
      expect.objectContaining({
        adultMemberHostingPolicy: expect.any(Object),
      }),
    );
    expect(mocks.settleHostingCoverage).toHaveBeenCalledWith({ limit: 5 });
  });

  it("audits and revalidates the FIRST save, which creates the row", async () => {
    mocks.findUnique.mockResolvedValue(null);
    mocks.create.mockResolvedValue({ ...stored, version: 1 });
    const response = await PUT(
      put({ mode: "ADMIN_REVIEW_REQUIRED", capacityMode: "HOLD" }),
    );
    expect(response.status).toBe(200);
    expect(mocks.logAudit).toHaveBeenCalledTimes(1);
    expect(mocks.revalidate).toHaveBeenCalledTimes(1);
  });

  it("stores an explicit scope set, same-owner coverage included (#2576)", async () => {
    // The scope is SAVEABLE, not refused-for-later: #2576 replaced the nominated-host
    // workflow with this narrower same-account rule, so a club that permits split
    // bookings under one account can turn it on from the card.
    mocks.findUnique.mockResolvedValue(null);
    mocks.create.mockResolvedValue({ ...stored, version: 1 });
    const response = await PUT(
      put({
        mode: "ADMIN_REVIEW_REQUIRED",
        capacityMode: "HOLD",
        hostScopes: { sameBooking: true, sameBookingOwner: true },
      }),
    );
    expect(response.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith({
      data: {
        scopeKey: "club-wide",
        lodgeId: null,
        mode: "ADMIN_REVIEW_REQUIRED",
        capacityMode: "HOLD",
        hostScopeSameBooking: true,
        hostScopeSameBookingOwner: true,
        // #3037. THE BODY DID NOT NAME IT, and it is stored as an explicit
        // `false` rather than NULL. That is the whole default-OFF contract at the
        // write boundary: a client that predates the scope — a browser tab loaded
        // from the previous colour during a blue/green window — cannot turn Group
        // Trip cover on by omission, and cannot leave the column in the "did not
        // decide" state on a row that decided everything else either.
        hostScopeSameGroupTrip: false,
        version: 1,
      },
    });
  });

  it("refuses an explicit scope set with nothing ticked (#2569 §16)", async () => {
    const response = await PUT(
      put({
        mode: "ADMIN_REVIEW_REQUIRED",
        capacityMode: "HOLD",
        hostScopes: { sameBooking: false, sameBookingOwner: false },
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/at least one kind/i);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("refuses a body naming a scope the owner removed from the model", async () => {
    // #2575 and #2576 are removals, not deferrals. A caller written against the old
    // shape must be a 400 rather than a silently dropped key, which would store the
    // remaining half of a set the operator did not choose.
    for (const hostScopes of [
      { sameBooking: false, anyMemberAtLodge: true, sameBookingOwner: false },
      { sameBooking: true, nominatedHost: true, sameBookingOwner: false },
    ]) {
      const response = await PUT(
        put({ mode: "ADMIN_REVIEW_REQUIRED", capacityMode: "HOLD", hostScopes }),
      );
      expect(response.status).toBe(400);
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.updateMany).not.toHaveBeenCalled();
    }
  });

  it("refuses a lodge override for a lodge that is gone or inactive", async () => {
    mocks.lodgeFindUnique.mockResolvedValue({ id: "lodge-1", active: false });
    const response = await PUT(
      put({ mode: "DISABLED", capacityMode: "HOLD", lodgeId: "lodge-1" }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/not active/i);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
