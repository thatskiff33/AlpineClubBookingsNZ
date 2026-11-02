import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { matchesWhere } from "./support/prisma-where";

/**
 * #4669: one retry owner per lost copy of a caller-retried admin alert - the
 * settlement-figure alert (#4446, the marker retries it) and the two Stripe
 * payment alerts (#4647, Stripe's redelivery retries them).
 *
 * - One recipient's copy fails while another's goes out: the owner sees "sent"
 *   and never retries, so the email retry cron replays exactly that copy, once.
 * - Every copy fails: the attempt's rows are released before the owner hears
 *   about it, so the cron replays nothing and the owner's retry sends one copy
 *   to each recipient.
 * - The cron claims a copy before the release (a send that hung past its
 *   backoff): the release rolls back, the cron owns every copy, and the owner
 *   keeps its claim.
 *
 * Real from the owner to the transport: the owners (`raiseCashSettlementAlert`,
 * `recordUnrecognisedStripePayment`, `recordUnmatchedAppStripePayment`), the
 * unmuteable sender, `sendEmail` and its EmailLog rows, the release, and
 * `retryFailedEmails`. The doubles are the store (in-memory tables filtered by
 * the shared `matchesWhere`, with a transaction that rolls back on a throw),
 * the transport (fails per recipient, counts what went out), and settings.
 */
type Row = Record<string, unknown> & { id: string };

const TREASURER = "treasurer@example.test";
const DEPUTY = "deputy.treasurer@example.test";

const state = vi.hoisted(() => ({
  emailLogs: new Map<string, Record<string, unknown> & { id: string }>(),
  stripeRows: new Map<string, Record<string, unknown> & { id: string; stripePaymentIntentId: string }>(),
  cooldowns: new Map<string, Date>(),
  markers: new Map<string, { id: string; snapshot: unknown }>(),
  /** Every message the transport accepted; each test sends one alert. */
  delivered: [] as string[],
  failFor: new Set<string>(),
  /** A send to this recipient waits for `release` before it fails. */
  hang: null as null | { to: string; until: Promise<void> },
}));

function emailLogDelegate(store: Map<string, Row>) {
  return {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row: Row = {
        id: `email_${store.size + 1}`,
        htmlBody: null,
        bookingRetryHtmlBody: null,
        bookingId: null,
        bookingDetailLinkIncluded: null,
        bookingBodyOverrideApplied: null,
        bookingRecipientMemberId: null,
        deliveryBlockReason: null,
        errorMessage: null,
        messageId: null,
        sentAt: null,
        attempts: 1,
        createdAt: new Date(),
        ...data,
      };
      store.set(row.id, row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = store.get(where.id);
      if (!row) throw new Error("missing EmailLog row");
      return Object.assign(row, data);
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      let count = 0;
      for (const row of store.values()) {
        if (!matchesWhere(row, where)) continue;
        Object.assign(row, data);
        count += 1;
      }
      return { count };
    },
    findMany: async ({ where, take }: { where: Record<string, unknown>; take?: number }) =>
      [...store.values()].filter((row) => matchesWhere(row, where)).slice(0, take),
    count: async ({ where }: { where: Record<string, unknown> }) =>
      [...store.values()].filter((row) => matchesWhere(row, where)).length,
  };
}

vi.mock("@/lib/prisma", () => {
  const prisma: Record<string, unknown> = {
    emailLog: emailLogDelegate(state.emailLogs),
    unrecognisedStripePayment: {
      findUnique: async ({ where }: { where: { stripePaymentIntentId?: string; id?: string } }) => {
        if (where.stripePaymentIntentId) return state.stripeRows.get(where.stripePaymentIntentId) ?? null;
        return [...state.stripeRows.values()].find((row) => row.id === where.id) ?? null;
      },
      createMany: async ({ data }: { data: (Record<string, unknown> & { stripePaymentIntentId: string })[] }) => {
        let count = 0;
        for (const row of data) {
          if (state.stripeRows.has(row.stripePaymentIntentId)) continue;
          state.stripeRows.set(row.stripePaymentIntentId, { ...row, id: `usp_${state.stripeRows.size + 1}`, alertedAt: null });
          count += 1;
        }
        return { count };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = [...state.stripeRows.values()].find((item) => item.id === where.id);
        if (!row) throw new Error("missing row");
        return Object.assign(row, data);
      },
    },
    alertCooldown: {
      updateMany: async ({ where, data }: { where: Record<string, unknown> & { key: string }; data: { lastAlertedAt: Date } }) => {
        const held = state.cooldowns.get(where.key);
        if (!held || !matchesWhere({ key: where.key, lastAlertedAt: held }, where)) return { count: 0 };
        state.cooldowns.set(where.key, data.lastAlertedAt);
        return { count: 1 };
      },
      create: async ({ data }: { data: { key: string; lastAlertedAt: Date } }) => {
        if (state.cooldowns.has(data.key)) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002", clientVersion: "test" });
        }
        state.cooldowns.set(data.key, data.lastAlertedAt);
        return data;
      },
      deleteMany: async ({ where }: { where: { key: string; lastAlertedAt: Date } }) => {
        const held = state.cooldowns.get(where.key);
        if (!held || held.getTime() !== where.lastAlertedAt.getTime()) return { count: 0 };
        state.cooldowns.delete(where.key);
        return { count: 1 };
      },
      findMany: async ({ where }: { where: { key: { in: string[] }; lastAlertedAt: unknown } }) =>
        [...state.cooldowns]
          .map(([key, lastAlertedAt]) => ({ key, lastAlertedAt }))
          .filter((row) => matchesWhere(row, where)),
    },
    bookingEvent: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const marker = state.markers.get(where.id);
        return marker ? { snapshot: structuredClone(marker.snapshot) } : null;
      },
      update: async ({ where, data }: { where: { id: string }; data: { snapshot: unknown } }) => {
        const marker = state.markers.get(where.id);
        if (!marker) throw new Error("missing marker");
        marker.snapshot = data.snapshot;
        return marker;
      },
      updateMany: async ({ where, data }: { where: { id: string; snapshot: { equals: unknown } }; data: { snapshot: unknown } }) => {
        const marker = state.markers.get(where.id);
        if (!marker || JSON.stringify(marker.snapshot) !== JSON.stringify(where.snapshot.equals)) return { count: 0 };
        marker.snapshot = data.snapshot;
        return { count: 1 };
      },
    },
    member: {
      // Two Finance editors; `hasAdminAreaAccess` below admits them.
      findMany: async () => [
        { email: TREASURER, canLogin: true, accessRoles: [] },
        { email: DEPUTY, canLogin: true, accessRoles: [] },
      ],
    },
    environmentSafetySettings: { findUnique: async () => null },
    emailTemplateOverride: { findUnique: async () => null },
  };
  // All or nothing, as PostgreSQL: a throw puts every EmailLog row back.
  prisma.$transaction = async (work: (tx: typeof prisma) => Promise<unknown>) => {
    const before = new Map([...state.emailLogs].map(([id, row]) => [id, structuredClone(row)]));
    try {
      return await work(prisma);
    } catch (err) {
      state.emailLogs.clear();
      for (const [id, row] of before) state.emailLogs.set(id, row);
      throw err;
    }
  };
  return { prisma };
});

vi.mock("@/lib/admin-permissions", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/admin-permissions")),
  hasAdminAreaAccess: () => true,
}));

vi.mock("@/lib/email-admin-alert-escalation", () => ({
  recordAdminAlertDeliveryEscalation: vi.fn(async () => {}),
}));

vi.mock("@/lib/stripe", () => ({
  findCheckoutSessionForPaymentIntent: async () => null,
}));

vi.mock("@/lib/email/admin-alert-xero-links", () => ({
  stampXeroOrganisation: async (url: string | null) => url,
}));

/** The transport: fails for `failFor`, holds a `hang` recipient, counts every message that goes out. */
vi.mock("@/lib/email/internal", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/email/internal")),
  getEmailTransporter: async () => ({
    transporter: {
      sendMail: async (message: { to: string }) => {
        if (state.hang?.to === message.to) {
          const { until } = state.hang;
          state.hang = null;
          await until;
          throw new Error("SMTP timed out");
        }
        if (state.failFor.has(message.to)) throw new Error("SMTP throttled");
        state.delivered.push(message.to);
        return { messageId: `msg_${state.delivered.length}` };
      },
    },
    modeLabel: "test",
  }),
  logDeliveredTransport: () => {},
}));

vi.mock("@/lib/email-message-settings", async (importOriginal) => {
  const settings = {
    clubName: "Test Club",
    bookingsName: "Test Club Bookings",
    lodgeName: "Test Lodge",
    emailFromName: "Test Club",
    supportEmail: "support@example.test",
    contactEmail: "contact@example.test",
    publicUrl: "https://bookings.example.test",
    lodgeTravelNote: "",
    doorCode: null,
  };
  return {
    ...((await importOriginal()) as typeof import("@/lib/email-message-settings")),
    applyEmailMessageSettingsToHtml: (html: string) => html,
    applyEmailMessageSettingsToSubject: (subject: string) => subject,
    formatEmailFromAddressWithSettings: () => "Club <club@example.test>",
    loadEmailMessageSettings: async () => settings,
    loadEmailMessageSettingsForLodge: async () => settings,
  };
});

vi.mock("@/lib/email-theme", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/email-theme")),
  emailPalette: () => ({
    gold: "#e7b83f",
    charcoal: "#374151",
    deep: "#1f2937",
    mist: "#e5e7eb",
    snow: "#ffffff",
    ridge: "#6b7280",
  }),
  ensureEmailPaletteReady: async () => ({ source: "club-theme" as const }),
  renderEmailHtml: async <T,>(build: () => T) => build(),
}));

vi.mock("@/lib/email-suppression", () => ({
  getActiveEmailSuppression: async () => null,
  normalizeEmailAddress: (value: string) => value.trim().toLowerCase(),
}));

vi.mock("@/lib/email-delivery", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/email-delivery")),
  resolveEmailDeliveryConfig: () => ({ ok: true, transportOptions: { host: "smtp.example.test" }, issues: [] }),
  resolveEmailTransportKind: () => "live-provider",
}));

vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { retryFailedEmails } from "@/lib/cron-email-retry";
import { IB_SETTLEMENT_FIGURE_CHECK_EVENT_KIND } from "@/lib/manual-settlement-reversal-event";
import {
  recordUnmatchedAppStripePayment,
  recordUnrecognisedStripePayment,
  UnrecognisedStripePaymentAlertNotSentError,
} from "@/lib/unrecognised-stripe-payment";
import { raiseCashSettlementAlert } from "@/lib/xero-inbound/settle-from-cash-notice";
import { declareEnvironmentRole, undeclareEnvironmentRole } from "./helpers/environment-role";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const MINUTE = 60_000;
const CREATED = Date.parse("2026-06-30T21:00:00.000Z") / 1000;

/**
 * One alert and its owner. `deliver` is the owner's first send; `retry` is
 * its own retry (Stripe's redelivery, or the inbound cron's pass over a pending
 * marker); `retried` says the owner will retry, `kept` that it will not.
 */
interface Owner {
  name: string;
  template: string;
  deliver: () => Promise<void>;
  retry: () => Promise<void>;
  /** The owner holds its claim: it will not send this alert again. */
  kept: () => boolean;
}

function stripeOwner(name: string, template: string, metadata: Record<string, string>): Owner {
  const intent = {
    id: "pi_4669",
    object: "payment_intent",
    amount: 5000,
    amount_received: 5000,
    currency: "nzd",
    created: CREATED,
    description: null,
    latest_charge: "ch_4669",
    metadata,
  } as unknown as Stripe.PaymentIntent;
  const event = { id: "evt_4669", livemode: true, type: "payment_intent.succeeded", created: CREATED } as Stripe.Event;
  const record = () =>
    metadata.bookingId
      ? recordUnmatchedAppStripePayment(intent, event, CLUB_FORMAT_TEST, { bookingId: metadata.bookingId, matchedKind: null })
      : recordUnrecognisedStripePayment(intent, event, CLUB_FORMAT_TEST);
  return {
    name,
    template,
    deliver: async () => {
      await record().catch((err) => {
        // The webhook fails so Stripe redelivers: the owner's retry signal.
        if (!(err instanceof UnrecognisedStripePaymentAlertNotSentError)) throw err;
      });
    },
    retry: async () => {
      await record();
    },
    kept: () => state.stripeRows.get("pi_4669")?.alertedAt instanceof Date,
  };
}

const MARKER_ID = "marker_4669";
const booking = { checkIn: new Date("2026-07-10T00:00:00Z"), checkOut: new Date("2026-07-12T00:00:00Z") };
const raiseSettlement = () =>
  raiseCashSettlementAlert({
    payment: { id: "payment_4669", bookingId: "booking_4669", booking },
    memberName: "Test Member",
    marker: { id: MARKER_ID, snapshot: structuredClone(state.markers.get(MARKER_ID)!.snapshot) } as never,
    invoiceId: "invoice_4669",
    format: CLUB_FORMAT_TEST,
  });

const settlementOwner: Owner = {
  name: "the bank-transfer settlement figure alert (#4446)",
  template: "admin-bank-transfer-settlement-figure",
  deliver: raiseSettlement,
  retry: raiseSettlement,
  kept: () => typeof (state.markers.get(MARKER_ID)!.snapshot as { alertSentAt: unknown }).alertSentAt === "string",
};

const OWNERS: Owner[] = [
  settlementOwner,
  stripeOwner("the unrecognised Stripe payment alert (#4532)", "admin-unrecognised-stripe-payment", {}),
  stripeOwner("the unmatched app Stripe payment alert (#4624)", "admin-unmatched-app-stripe-payment", { bookingId: "booking-1" }),
];

const alertRows = (template: string) => [...state.emailLogs.values()].filter((row) => row.templateName === template);
const deliveredTo = () => [...state.delivered].sort();

/** Let in-flight sends run until `ready` holds; only `Date` is faked, so real ticks pass. */
async function until(ready: () => boolean) {
  for (let tick = 0; tick < 200 && !ready(); tick += 1) await new Promise((resolve) => setImmediate(resolve));
  expect(ready()).toBe(true);
}

describe("a caller-retried admin alert has one retry owner per lost copy (#4669)", () => {
  let start: Date;
  const at = (minutes: number) => vi.setSystemTime(new Date(start.getTime() + minutes * MINUTE));

  beforeEach(() => {
    start = new Date();
    state.emailLogs.clear();
    state.stripeRows.clear();
    state.cooldowns.clear();
    state.markers.clear();
    state.markers.set(MARKER_ID, {
      id: MARKER_ID,
      snapshot: {
        kind: IB_SETTLEMENT_FIGURE_CHECK_EVENT_KIND, invoiceId: "invoice_4669", invoiceNumber: "INV-4669",
        refusal: "folded-refund", recordedCents: 10000, cashCents: 12000, cashComplete: true,
        owedCents: null, hasSupplementaryInvoice: false, alertSentAt: null,
      },
    });
    state.delivered = [];
    state.failFor = new Set();
    state.hang = null;
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXTAUTH_URL", "https://bookings.example.test");
    declareEnvironmentRole("production");
  });

  afterEach(() => {
    vi.setSystemTime(start);
    vi.unstubAllEnvs();
  });

  it.each(OWNERS)("$name: the cron replays the one copy a recipient lost, once", async (owner) => {
    state.failFor = new Set([DEPUTY]);
    await owner.deliver();

    expect(deliveredTo()).toEqual([TREASURER]);
    expect(owner.kept()).toBe(true);
    const lost = alertRows(owner.template).find((row) => row.to === DEPUTY);
    expect(lost).toEqual(expect.objectContaining({ status: "FAILED", htmlBody: expect.any(String), attempts: 1 }));

    // The deputy's mailbox recovers; the cron runs past its backoff and replays that copy.
    state.failFor = new Set();
    at(16);
    await retryFailedEmails();
    expect(deliveredTo()).toEqual([DEPUTY, TREASURER].sort());

    // Neither a later cron run nor the owner sends anything more.
    at(60);
    await retryFailedEmails();
    await owner.retry();
    expect(deliveredTo()).toEqual([DEPUTY, TREASURER].sort());
  });

  it.each(OWNERS)("$name: when every copy fails the cron replays nothing and the owner's retry sends one each", async (owner) => {
    state.failFor = new Set([TREASURER, DEPUTY]);
    await owner.deliver();

    expect(deliveredTo()).toEqual([]);
    expect(owner.kept()).toBe(false);
    expect(alertRows(owner.template)).toEqual([
      expect.objectContaining({ status: "FAILED", htmlBody: null, attempts: 1 }),
      expect.objectContaining({ status: "FAILED", htmlBody: null, attempts: 1 }),
    ]);

    // The transport recovers. The cron, past its backoff, has nothing of this alert's to replay.
    state.failFor = new Set();
    at(16);
    await retryFailedEmails();
    expect(deliveredTo()).toEqual([]);

    // The owner's own retry (past the settlement claim's ten minutes) sends one copy to each.
    await owner.retry();
    expect(deliveredTo()).toEqual([DEPUTY, TREASURER].sort());
    expect(owner.kept()).toBe(true);

    at(60);
    await retryFailedEmails();
    await owner.retry();
    expect(deliveredTo()).toEqual([DEPUTY, TREASURER].sort());
  });

  it.each(OWNERS)("$name: a copy the cron claimed first keeps every copy with the cron, and the owner does not retry", async (owner) => {
    // The deputy's send hangs past the cron's backoff; the treasurer's fails at once.
    let release!: () => void;
    state.failFor = new Set([TREASURER, DEPUTY]);
    state.hang = { to: DEPUTY, until: new Promise<void>((resolve) => (release = resolve)) };
    const first = owner.deliver();
    await until(() => alertRows(owner.template).some((row) => row.to === TREASURER && row.status === "FAILED"));

    // Meanwhile the cron claims and delivers the treasurer's copy.
    state.failFor = new Set([DEPUTY]);
    at(16);
    await retryFailedEmails();
    expect(deliveredTo()).toEqual([TREASURER]);

    // The deputy's send now fails: nobody received the first attempt, but the cron holds a copy.
    release();
    await first;
    expect(owner.kept()).toBe(true);
    const deputyCopy = alertRows(owner.template).find((row) => row.to === DEPUTY);
    expect(deputyCopy).toEqual(expect.objectContaining({ status: "FAILED", htmlBody: expect.any(String), attempts: 1 }));

    // The cron replays the deputy's copy once; the owner sends nothing.
    state.failFor = new Set();
    at(32);
    await retryFailedEmails();
    at(60);
    await retryFailedEmails();
    await owner.retry();
    expect(deliveredTo()).toEqual([DEPUTY, TREASURER].sort());
  });

  it("releases an environment-withheld copy with a message naming its owner, and leaves it out of the review queue", async () => {
    const owner = OWNERS[1];
    // Nothing has declared the role: both copies are held back as a fault.
    undeclareEnvironmentRole();
    await owner.deliver();
    expect(owner.kept()).toBe(false);
    const rows = alertRows(owner.template);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toEqual(expect.objectContaining({ status: "FAILED", htmlBody: null, attempts: 1 }));
      expect(row.deliveryBlockReason).not.toBeNull();
      expect(row.errorMessage).toMatch(/sent again by the alert's own retry/);
    }

    // The role is declared; the cron has nothing to replay and the owner sends one each.
    declareEnvironmentRole("production");
    at(16);
    await retryFailedEmails();
    expect(deliveredTo()).toEqual([]);
    await owner.retry();
    expect(deliveredTo()).toEqual([DEPUTY, TREASURER].sort());
  });
});
