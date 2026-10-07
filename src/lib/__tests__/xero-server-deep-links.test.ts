import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * #2314: every Xero deep link built on the SERVER must land the admin in this
 * club's Xero organisation.
 *
 * #2283 gave the client-rendered links the organisation short code. Everything
 * built server-side was left out and still produced short-code-less URLs, so an
 * admin whose Xero login covers more than one organisation landed in whichever
 * organisation their session last used — another club's books. The owner's
 * decision (1 Aug 2026) was to resolve the short code server-side in EVERY
 * producer, keep the two persisted `xeroObjectUrl` columns organisation-agnostic
 * (correct after a reconnect to a different organisation) and apply the short
 * code at render time, and stamp emailed links at send time.
 *
 * These tests use the REAL `xero-links` builders — a stubbed builder would let
 * the short code vanish without anyone noticing — and mock only the short-code
 * read and the database.
 */

const ORG_SHORT_CODE = "!aBc12";

const mocks = vi.hoisted(() => ({
  getXeroOrgShortCode: vi.fn(),
  operationFindMany: vi.fn(),
  operationCount: vi.fn(),
  operationGroupBy: vi.fn(),
  inboundEventFindMany: vi.fn(),
  inboundEventCount: vi.fn(),
  objectLinkFindMany: vi.fn(),
  memberFindUnique: vi.fn(),
  memberFindMany: vi.fn(),
  getContacts: vi.fn(),
  paymentFindUnique: vi.fn(),
  bookingFindUnique: vi.fn(),
  bookingModificationFindUnique: vi.fn(),
  subscriptionFindUnique: vi.fn(),
  resolveFailedXeroOperationStates: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/xero-link-short-code", () => ({
  getXeroOrgShortCode: mocks.getXeroOrgShortCode,
}));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: async () => ({ ok: true as const, session: { user: { id: "admin-1" } } }),
  requireActiveSessionUser: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({ logAudit: vi.fn(), createAuditLog: vi.fn() }));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    xeroSyncOperation: {
      findMany: mocks.operationFindMany,
      count: mocks.operationCount,
      groupBy: mocks.operationGroupBy,
    },
    xeroInboundEvent: {
      findMany: mocks.inboundEventFindMany,
      count: mocks.inboundEventCount,
    },
    xeroObjectLink: { findMany: mocks.objectLinkFindMany },
    member: {
      findUnique: mocks.memberFindUnique,
      findMany: mocks.memberFindMany,
    },
    payment: { findUnique: mocks.paymentFindUnique },
    booking: { findUnique: mocks.bookingFindUnique },
    bookingModification: { findUnique: mocks.bookingModificationFindUnique },
    memberSubscription: { findUnique: mocks.subscriptionFindUnique },
  },
}));

vi.mock("@/lib/xero-admin-failures", () => ({
  resolveFailedXeroOperationStates: mocks.resolveFailedXeroOperationStates,
}));

vi.mock("@/lib/xero-operation-retry", () => ({
  getXeroOperationRetryMeta: () => ({ supported: false, reason: null }),
}));

// The Xero client itself is never touched — no live provider in tests.
vi.mock("@/lib/xero-api-client", () => ({
  getAuthenticatedXeroClient: async () => ({
    xero: { accountingApi: { getContacts: mocks.getContacts } },
    tenantId: "tenant-1",
  }),
  callXeroApi: async (fn: () => Promise<unknown>) => fn(),
  XeroDailyLimitError: class XeroDailyLimitError extends Error {},
}));

import { GET as listOperations } from "@/app/api/admin/xero/operations/route";
import { GET as listInboundEvents } from "@/app/api/admin/xero/inbound-events/route";
import { getXeroRecordActivity } from "@/lib/xero-record-activity";
import { findPotentialXeroContactsForMember } from "@/lib/xero-duplicate-contacts";
import {
  applyXeroOrgShortCode,
  buildXeroContactUrl,
  buildXeroInvoiceUrl,
} from "@/lib/xero-links";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

/** What a stored `xeroObjectUrl` looks like: generic, no organisation. */
const STORED_INVOICE_URL = buildXeroInvoiceUrl("xero-inv-1");
/** The same invoice, scoped to this club. */
const SCOPED_INVOICE_URL = buildXeroInvoiceUrl("xero-inv-1", {
  shortCode: ORG_SHORT_CODE,
});

function operationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "op_1",
    direction: "OUTBOUND",
    entityType: "INVOICE",
    operationType: "CREATE",
    localModel: "Payment",
    localId: "pay_1",
    status: "SUCCEEDED",
    idempotencyKey: "idem_1",
    correlationKey: "corr_1",
    attemptCount: 1,
    replayable: false,
    lastErrorCode: null,
    lastErrorMessage: null,
    requestPayload: null,
    responsePayload: null,
    xeroObjectType: "INVOICE",
    xeroObjectId: "xero-inv-1",
    xeroObjectNumber: "INV-001",
    xeroObjectUrl: STORED_INVOICE_URL,
    createdByMemberId: null,
    startedAt: new Date("2026-05-01T00:00:00.000Z"),
    completedAt: new Date("2026-05-01T00:01:00.000Z"),
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    updatedAt: new Date("2026-05-01T00:01:00.000Z"),
    ...overrides,
  };
}

function inboundEventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_1",
    source: "webhook",
    eventCategory: "INVOICE",
    eventType: "UPDATE",
    resourceId: "xero-inv-1",
    correlationKey: "corr_evt_1",
    payload: {},
    status: "PROCESSED",
    errorMessage: null,
    processedAt: new Date("2026-05-01T02:00:00.000Z"),
    createdAt: new Date("2026-05-01T02:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getXeroOrgShortCode.mockResolvedValue(ORG_SHORT_CODE);
  mocks.resolveFailedXeroOperationStates.mockResolvedValue(new Map());
});

// -------------------------------------------------------------------------
// Render site 1: the Xero Sync page's operations panel
// -------------------------------------------------------------------------

describe("GET /api/admin/xero/operations", () => {
  function request() {
    return new NextRequest("http://localhost/api/admin/xero/operations");
  }

  it("scopes the STORED generic url to the club's organisation", async () => {
    mocks.operationFindMany.mockResolvedValue([operationRow()]);
    mocks.operationCount.mockResolvedValue(1);

    const body = await (await listOperations(request())).json();

    expect(body.data[0].xeroObjectUrl).toBe(SCOPED_INVOICE_URL);
    expect(body.data[0].xeroObjectUrl).toContain(
      `shortcode=${ORG_SHORT_CODE}`,
    );
  });

  it("scopes the rebuilt url when no url was stored", async () => {
    mocks.operationFindMany.mockResolvedValue([
      operationRow({ xeroObjectUrl: null }),
    ]);
    mocks.operationCount.mockResolvedValue(1);

    const body = await (await listOperations(request())).json();

    expect(body.data[0].xeroObjectUrl).toBe(SCOPED_INVOICE_URL);
  });

  // Degrade, never hide: Xero disconnected, the organisation read failed, or
  // Xero reported no short code all land here, and the generic link is live.
  it("falls back to the generic link when no short code is available", async () => {
    mocks.getXeroOrgShortCode.mockResolvedValue(null);
    mocks.operationFindMany.mockResolvedValue([operationRow()]);
    mocks.operationCount.mockResolvedValue(1);

    const body = await (await listOperations(request())).json();

    expect(body.data[0].xeroObjectUrl).toBe(STORED_INVOICE_URL);
  });

  it("leaves an operation with no Xero object linkless", async () => {
    mocks.operationFindMany.mockResolvedValue([
      operationRow({
        xeroObjectUrl: null,
        xeroObjectType: null,
        xeroObjectId: null,
      }),
    ]);
    mocks.operationCount.mockResolvedValue(1);

    const body = await (await listOperations(request())).json();

    expect(body.data[0].xeroObjectUrl).toBeNull();
  });
});

// -------------------------------------------------------------------------
// Render site 2: the inbound-events panel
// -------------------------------------------------------------------------

describe("GET /api/admin/xero/inbound-events", () => {
  function request() {
    return new NextRequest("http://localhost/api/admin/xero/inbound-events");
  }

  it("scopes the event's Xero link to the club's organisation", async () => {
    mocks.inboundEventFindMany.mockResolvedValue([inboundEventRow()]);
    mocks.inboundEventCount.mockResolvedValue(1);

    const body = await (await listInboundEvents(request())).json();

    expect(body.data[0].xeroObjectUrl).toBe(SCOPED_INVOICE_URL);
  });

  it("falls back to the generic link when no short code is available", async () => {
    mocks.getXeroOrgShortCode.mockResolvedValue(null);
    mocks.inboundEventFindMany.mockResolvedValue([inboundEventRow()]);
    mocks.inboundEventCount.mockResolvedValue(1);

    const body = await (await listInboundEvents(request())).json();

    expect(body.data[0].xeroObjectUrl).toBe(STORED_INVOICE_URL);
  });
});

// -------------------------------------------------------------------------
// Render sites 3-5: the per-record activity panel (operations, links, events)
// -------------------------------------------------------------------------

describe("getXeroRecordActivity", () => {
  beforeEach(() => {
    mocks.paymentFindUnique.mockResolvedValue({
      id: "pay_1",
      amountCents: 12345,
      booking: {
        id: "book_1",
        checkIn: new Date("2026-05-01T00:00:00.000Z"),
        checkOut: new Date("2026-05-03T00:00:00.000Z"),
        member: { firstName: "Riley", lastName: "Chen" },
      },
    });
    mocks.operationFindMany.mockResolvedValue([operationRow()]);
    mocks.operationCount.mockResolvedValue(1);
    mocks.operationGroupBy.mockResolvedValue([
      { status: "SUCCEEDED", _count: 1 },
    ]);
    mocks.objectLinkFindMany.mockResolvedValue([
      {
        id: "link_1",
        localModel: "Payment",
        localId: "pay_1",
        xeroObjectType: "INVOICE",
        xeroObjectId: "xero-inv-1",
        xeroObjectNumber: "INV-001",
        xeroObjectUrl: STORED_INVOICE_URL,
        role: "PRIMARY_INVOICE",
        active: true,
        metadata: null,
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
        updatedAt: new Date("2026-05-01T00:00:00.000Z"),
      },
    ]);
    mocks.inboundEventFindMany.mockResolvedValue([inboundEventRow()]);
  });

  it("scopes the operation, link and inbound-event links together", async () => {
    const result = await getXeroRecordActivity("Payment", "pay_1", CLUB_FORMAT_TEST, 25);

    expect(result?.operations[0].xeroObjectUrl).toBe(SCOPED_INVOICE_URL);
    expect(result?.links[0].xeroObjectUrl).toBe(SCOPED_INVOICE_URL);
    expect(result?.inboundEvents[0].xeroObjectUrl).toBe(SCOPED_INVOICE_URL);
  });

  // The organisation read is cached and shared, but a panel that resolved the
  // short code once per row would still turn one page into N cache lookups.
  it("resolves the short code once for the whole panel", async () => {
    await getXeroRecordActivity("Payment", "pay_1", CLUB_FORMAT_TEST, 25);

    expect(mocks.getXeroOrgShortCode).toHaveBeenCalledTimes(1);
  });

  it("falls back to generic links when no short code is available", async () => {
    mocks.getXeroOrgShortCode.mockResolvedValue(null);

    const result = await getXeroRecordActivity("Payment", "pay_1", CLUB_FORMAT_TEST, 25);

    expect(result?.operations[0].xeroObjectUrl).toBe(STORED_INVOICE_URL);
    expect(result?.links[0].xeroObjectUrl).toBe(STORED_INVOICE_URL);
    expect(result?.inboundEvents[0].xeroObjectUrl).toBe(STORED_INVOICE_URL);
  });

  // Decision 2's real test: a stored row written while the club was connected
  // to a DIFFERENT Xero organisation must not keep sending admins there.
  it("re-points a stored link left over from another organisation", async () => {
    mocks.objectLinkFindMany.mockResolvedValue([
      {
        id: "link_1",
        localModel: "Payment",
        localId: "pay_1",
        xeroObjectType: "INVOICE",
        xeroObjectId: "xero-inv-1",
        xeroObjectNumber: "INV-001",
        xeroObjectUrl: buildXeroInvoiceUrl("xero-inv-1", {
          shortCode: "!old99",
        }),
        role: "PRIMARY_INVOICE",
        active: true,
        metadata: null,
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
        updatedAt: new Date("2026-05-01T00:00:00.000Z"),
      },
    ]);

    const result = await getXeroRecordActivity("Payment", "pay_1", CLUB_FORMAT_TEST, 25);

    expect(result?.links[0].xeroObjectUrl).toBe(SCOPED_INVOICE_URL);
    expect(result?.links[0].xeroObjectUrl).not.toContain("!old99");
  });
});

// -------------------------------------------------------------------------
// Render site: the suggested-contact card on member detail
//
// `xero-duplicate-contacts.ts` was the in-tree contradiction #2314 called out:
// one function passed a short code, the other did not. Both now resolve it the
// same way.
// -------------------------------------------------------------------------

describe("findPotentialXeroContactsForMember", () => {
  beforeEach(() => {
    mocks.memberFindUnique.mockResolvedValue({
      id: "mem_1",
      firstName: "Riley",
      lastName: "Chen",
      email: "riley@example.org",
    });
    mocks.getContacts.mockResolvedValue({
      body: {
        contacts: [
          {
            contactID: "contact-1",
            name: "Riley Chen",
            emailAddress: "riley@example.org",
          },
        ],
      },
    });
    mocks.memberFindMany.mockResolvedValue([]);
  });

  it("scopes the suggested contact's link to the club's organisation", async () => {
    const matches = await findPotentialXeroContactsForMember("mem_1");

    expect(matches).toHaveLength(1);
    expect(matches[0].xeroLink).toBe(
      buildXeroContactUrl("contact-1", { shortCode: ORG_SHORT_CODE }),
    );
    expect(matches[0].xeroLink).toContain(`shortcode=${ORG_SHORT_CODE}`);
  });

  it("falls back to the generic link when no short code is available", async () => {
    mocks.getXeroOrgShortCode.mockResolvedValue(null);

    const matches = await findPotentialXeroContactsForMember("mem_1");

    expect(matches[0].xeroLink).toBe(buildXeroContactUrl("contact-1"));
  });
});

// -------------------------------------------------------------------------
// The pure render-time rewrite the stored columns depend on
// -------------------------------------------------------------------------

describe("stored URLs stay organisation-agnostic", () => {
  it("keeps a contact link scoped only at render time", () => {
    const stored = buildXeroContactUrl("contact-1");

    // What the database holds names no organisation at all …
    expect(stored).toBe("https://go.xero.com/Contacts/View/contact-1");
    expect(stored).not.toContain("shortcode");
    // … and reading it under a given connection scopes it to that club.
    expect(applyXeroOrgShortCode(stored, { shortCode: ORG_SHORT_CODE })).toBe(
      buildXeroContactUrl("contact-1", { shortCode: ORG_SHORT_CODE }),
    );
  });
});
