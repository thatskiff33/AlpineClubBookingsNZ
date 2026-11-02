import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

/**
 * #4647 (`INV-INT-032`, `INV-INT-033`): ONE owner for retrying the alert about a
 * Stripe payment no app path settled. When no recipient received it, the
 * once-ever claim is given back and the webhook fails, so Stripe's redelivery
 * sends it again. The email retry cron must not ALSO replay the FAILED EmailLog
 * row that failed send left, or the alert goes out twice.
 *
 * Everything from the alert claim to the transport is real: the record and
 * claim (`unrecognised-stripe-payment.ts`, `admin-alert-once.ts`,
 * `alert-cooldown.ts`), the unmuteable sender, `sendEmail` with its EmailLog
 * row and retention rule, and `retryFailedEmails`. The doubles are the store
 * (in-memory tables keyed and filtered as the queries ask), the mail transport
 * (counts what went out), the Checkout read, and the club's settings.
 */
type EmailLogRow = Record<string, unknown> & { id: string };

const state = vi.hoisted(() => ({
  stripeRows: new Map<string, Record<string, unknown> & { id: string; stripePaymentIntentId: string }>(),
  cooldowns: new Map<string, Date>(),
  emailLogs: new Map<string, Record<string, unknown> & { id: string }>(),
  delivered: [] as { to: string; subject: string }[],
  transportDown: false,
  /** #4670: how many coming claim releases fail. */
  releaseFailures: 0,
  /** #4670: how many coming `alertedAt` writes fail. */
  stampFailures: 0,
}));

/** A field filter the queries under test use; anything else fails loudly rather than matching silently. */
function matchesField(value: unknown, filter: unknown): boolean {
  if (filter === null || typeof filter !== "object" || filter instanceof Date) {
    return filter instanceof Date
      ? value instanceof Date && value.getTime() === filter.getTime()
      : value === filter;
  }
  const ops = filter as Record<string, unknown>;
  return Object.entries(ops).every(([op, operand]) => {
    if (op === "in") return (operand as unknown[]).includes(value);
    if (op === "gt") return (value as number) > (operand as number);
    if (op === "lt") return value instanceof Date ? value < (operand as Date) : (value as number) < (operand as number);
    if (op === "gte") return value instanceof Date ? value >= (operand as Date) : (value as number) >= (operand as number);
    if (op === "not") return operand === null ? value != null : !matchesField(value, operand);
    throw new Error(`unsupported filter operator ${op}`);
  });
}

function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, filter]) => {
    if (key === "OR") return (filter as Record<string, unknown>[]).some((branch) => matchesWhere(row, branch));
    return matchesField(row[key] ?? null, filter);
  });
}

vi.mock("@/lib/prisma", () => {
  const prisma = {
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
        if (state.stampFailures > 0) {
          state.stampFailures -= 1;
          throw new Error("database blip");
        }
        const row = [...state.stripeRows.values()].find((item) => item.id === where.id);
        if (!row) throw new Error("missing row");
        return Object.assign(row, data);
      },
    },
    alertCooldown: {
      updateMany: async ({ where, data }: { where: { key: string; lastAlertedAt: unknown }; data: { lastAlertedAt: Date } }) => {
        const held = state.cooldowns.get(where.key);
        if (!held || !matchesField(held, where.lastAlertedAt)) return { count: 0 };
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
        if (state.releaseFailures > 0) {
          state.releaseFailures -= 1;
          throw new Error("database blip");
        }
        const held = state.cooldowns.get(where.key);
        if (!held || held.getTime() !== where.lastAlertedAt.getTime()) return { count: 0 };
        state.cooldowns.delete(where.key);
        return { count: 1 };
      },
      findMany: async ({ where }: { where: { key: { in: string[] }; lastAlertedAt: unknown } }) =>
        [...state.cooldowns]
          .filter(([key, at]) => where.key.in.includes(key) && matchesField(at, where.lastAlertedAt))
          .map(([key, lastAlertedAt]) => ({ key, lastAlertedAt })),
    },
    emailLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row: EmailLogRow = {
          id: `email_${state.emailLogs.size + 1}`,
          htmlBody: null,
          bookingRetryHtmlBody: null,
          bookingId: null,
          bookingDetailLinkIncluded: null,
          bookingBodyOverrideApplied: null,
          bookingRecipientMemberId: null,
          deliveryBlockReason: null,
          attempts: 1,
          createdAt: new Date(),
          ...data,
        };
        state.emailLogs.set(row.id, row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = state.emailLogs.get(where.id);
        if (!row) throw new Error("missing EmailLog row");
        return Object.assign(row, data);
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let count = 0;
        for (const row of state.emailLogs.values()) {
          if (!matchesWhere(row, where)) continue;
          Object.assign(row, data);
          count += 1;
        }
        return { count };
      },
      findMany: async ({ where, take }: { where: Record<string, unknown>; take?: number }) =>
        [...state.emailLogs.values()].filter((row) => matchesWhere(row, where)).slice(0, take),
      count: async ({ where }: { where: Record<string, unknown> }) =>
        [...state.emailLogs.values()].filter((row) => matchesWhere(row, where)).length,
    },
    member: {
      // One Finance editor; `hasAdminAreaAccess` below admits them.
      findMany: async () => [{ email: "treasurer@example.test", canLogin: true, accessRoles: [] }],
    },
    environmentSafetySettings: { findUnique: async () => null },
    emailTemplateOverride: { findUnique: async () => null },
    // #4669: the release of an attempt nobody received, all or nothing.
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      const before = new Map([...state.emailLogs].map(([id, row]) => [id, structuredClone(row)]));
      try {
        return await work(prisma);
      } catch (err) {
        state.emailLogs.clear();
        for (const [id, row] of before) state.emailLogs.set(id, row);
        throw err;
      }
    },
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

/** The transport: down for the first send, then up; every message that goes out is counted. */
vi.mock("@/lib/email/internal", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/email/internal")),
  getEmailTransporter: async () => ({
    transporter: {
      sendMail: async (message: { to: string; subject: string }) => {
        if (state.transportDown) throw new Error("SMTP connection refused");
        state.delivered.push({ to: message.to, subject: message.subject });
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
import {
  recordUnmatchedAppStripePayment,
  recordUnrecognisedStripePayment,
  UnrecognisedStripePaymentAlertNotSentError,
} from "@/lib/unrecognised-stripe-payment";
import { declareEnvironmentRole } from "./helpers/environment-role";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const CREATED = Date.parse("2026-06-30T21:00:00.000Z") / 1000;
const MINUTE = 60_000;

function paymentIntent(id: string, metadata: Record<string, string>): Stripe.PaymentIntent {
  return {
    id,
    object: "payment_intent",
    amount: 5000,
    amount_received: 5000,
    currency: "nzd",
    created: CREATED,
    description: null,
    latest_charge: `ch_${id}`,
    metadata,
  } as unknown as Stripe.PaymentIntent;
}

function event(id: string): Stripe.Event {
  return { id, livemode: true, type: "payment_intent.succeeded", created: CREATED } as Stripe.Event;
}

describe("the unrecognised Stripe payment alert has one retry owner (#4647)", () => {
  let start: Date;

  beforeEach(() => {
    start = new Date();
    state.stripeRows.clear();
    state.cooldowns.clear();
    state.emailLogs.clear();
    state.delivered = [];
    state.transportDown = false;
    state.releaseFailures = 0;
    state.stampFailures = 0;
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXTAUTH_URL", "https://bookings.example.test");
    // A live installation, so the send and the retry cron both transmit.
    declareEnvironmentRole("production");
  });

  afterEach(() => {
    vi.setSystemTime(start);
    vi.unstubAllEnvs();
  });

  it.each([
    {
      name: "a payment the app did not create (#4532)",
      template: "admin-unrecognised-stripe-payment",
      record: (pi: Stripe.PaymentIntent, evt: Stripe.Event) => recordUnrecognisedStripePayment(pi, evt, CLUB_FORMAT_TEST),
      metadata: {} as Record<string, string>,
    },
    {
      name: "the app's own intent no payment transaction names (#4624)",
      template: "admin-unmatched-app-stripe-payment",
      record: (pi: Stripe.PaymentIntent, evt: Stripe.Event) =>
        recordUnmatchedAppStripePayment(pi, evt, CLUB_FORMAT_TEST, { bookingId: "booking-1", matchedKind: null }),
      metadata: { bookingId: "booking-1" },
    },
  ])("sends $name once across a failed send, the retry cron, and Stripe's redelivery", async ({ template, record, metadata }) => {
    const intent = paymentIntent("pi_4647", metadata);

    // 1. The transport is down: nobody receives it, the claim is given back and the webhook fails.
    // #4669: the row kept its body until the send failed, then was released.
    state.transportDown = true;
    await expect(record(intent, event("evt_4647"))).rejects.toBeInstanceOf(UnrecognisedStripePaymentAlertNotSentError);
    expect(state.delivered).toHaveLength(0);
    expect(state.cooldowns.size).toBe(0);
    const failed = [...state.emailLogs.values()];
    expect(failed).toEqual([expect.objectContaining({ templateName: template, status: "FAILED", htmlBody: null })]);

    // 2. The transport is back and the retry cron runs past its backoff: it has nothing of this alert's to replay.
    state.transportDown = false;
    vi.setSystemTime(new Date(start.getTime() + 16 * MINUTE));
    await retryFailedEmails();
    expect(state.delivered).toHaveLength(0);

    // 3. Stripe redelivers the event: the alert goes out, once.
    vi.setSystemTime(new Date(start.getTime() + 20 * MINUTE));
    await record(intent, event("evt_4647"));
    expect(state.delivered).toEqual([{ to: "treasurer@example.test", subject: expect.any(String) }]);
    expect(state.stripeRows.get("pi_4647")?.alertedAt).toBeInstanceOf(Date);

    // 4. Neither a later cron run nor a later redelivery sends it again.
    vi.setSystemTime(new Date(start.getTime() + 60 * MINUTE));
    await retryFailedEmails();
    await record(intent, event("evt_4647"));
    expect(state.delivered).toHaveLength(1);
  });
});

/**
 * #4670: exactly once across the writes around the send, through the real
 * once-ever helper and its real claim stamps.
 */
describe("the unrecognised Stripe payment alert across a failed write around the send (#4670)", () => {
  let start: Date;

  beforeEach(() => {
    start = new Date();
    state.stripeRows.clear();
    state.cooldowns.clear();
    state.emailLogs.clear();
    state.delivered = [];
    state.transportDown = false;
    state.releaseFailures = 0;
    state.stampFailures = 0;
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXTAUTH_URL", "https://bookings.example.test");
    declareEnvironmentRole("production");
  });

  afterEach(() => {
    vi.setSystemTime(start);
    vi.unstubAllEnvs();
  });

  const record = (eventId: string) => recordUnrecognisedStripePayment(paymentIntent("pi_4670", {}), event(eventId), CLUB_FORMAT_TEST);

  it("fails the webhook on its own leftover claim when giving it back failed, and Stripe's redelivery sends it once", async () => {
    state.transportDown = true;
    state.releaseFailures = 1;
    await expect(record("evt_4670")).rejects.toBeInstanceOf(UnrecognisedStripePaymentAlertNotSentError);
    expect(state.cooldowns.size).toBe(0);

    // A redelivery well inside the in-flight window: the claim was given back, so it claims afresh.
    state.transportDown = false;
    vi.setSystemTime(new Date(start.getTime() + 2 * MINUTE));
    await record("evt_4670");
    expect(state.delivered).toHaveLength(1);
    expect(state.stripeRows.get("pi_4670")?.alertedAt).toBeInstanceOf(Date);
  });

  it("completes when the alert went out but its alertedAt write failed, and no later delivery sends it again", async () => {
    state.stampFailures = 1;
    await record("evt_4670");
    expect(state.delivered).toHaveLength(1);
    expect(state.stripeRows.get("pi_4670")?.alertedAt).toBeNull();

    // Past the in-flight window, the kept claim with no alertedAt is not taken over.
    vi.setSystemTime(new Date(start.getTime() + 60 * MINUTE));
    await record("evt_4670_again");
    expect(state.delivered).toHaveLength(1);
  });
});
