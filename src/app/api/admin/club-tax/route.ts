import { NextResponse } from "next/server";
import { z } from "zod";

import { countBookingsKeepingTreatmentFrom, readClubTaxAdminState } from "@/lib/club-tax-admin-state";
import { MAX_TAX_RATE_BASIS_POINTS } from "@/lib/club-tax-settings";
import {
  cancelScheduledClubTaxChange,
  scheduleClubTaxChange,
  type ClubTaxWriteRefusal,
} from "@/lib/club-tax-settings-write";
import { parseCalendarDate } from "@/lib/club-time";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";

/**
 * The club's GST / tax treatment (#4632; `INV-CONFIG-007`), behind the "GST /
 * tax treatment" card on the Xero page.
 *
 * FINANCE READS; ONLY A FULL ADMIN CHANGES (the #3596 precedent: any admin who
 * may see club-wide money facts reads them, and changing how a club's money is
 * recorded is Full Admin). `GET` is `finance:view`, the area the path is
 * registered under. `PUT` and `DELETE` are `requireAdmin({ permission: false
 * })`, stricter than the map's `finance:edit`, and declared as such in
 * `REVIEWED_PERMISSION_DIVERGENCES`: a wrong save changes the tax on every new
 * Xero document and journal leg, so it is not a finance editor's call.
 *
 * THE CONFIRMATION IS ENFORCED HERE, not only in the card: the card is not the
 * only caller. The rules on WHAT may change — future dates only, never the
 * baseline or a started period, a Xero code Xero carries — and the transaction
 * are `club-tax-settings-write.ts`, the one writer.
 */

/**
 * Retryable failures, answered 503: P2028 (transaction API error) and P2034
 * (the serialisation failure Serializable provokes in the loser of two saves).
 * P2002 joins them because the only unique keys the writer can hit are the
 * period's start date, which it checks inside the same Serializable
 * transaction, and its random id: a collision is a concurrent save of the same
 * date that slipped past, and retrying is safe because the loser wrote nothing.
 */
const TRANSACTION_CONTENTION_CODES = new Set(["P2002", "P2028", "P2034"]);

function isTransactionContentionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && TRANSACTION_CONTENTION_CODES.has(code);
}

const calendarDate = z.string().max(10).transform((value, context) => {
  const date = parseCalendarDate(value);
  if (!date) {
    context.addIssue({ code: "custom", message: "not a date" });
    return z.NEVER;
  }
  return date;
});

export async function GET(request: Request) {
  const guard = await requireAdmin({ permission: { area: "finance", level: "view" } });
  if (!guard.ok) return guard.response;

  // `?from=` asks how many bookings a change starting then would leave on the old treatment.
  const fromParam = new URL(request.url).searchParams.get("from");
  const from = fromParam === null ? null : calendarDate.safeParse(fromParam);
  if (from && !from.success) return NextResponse.json({ error: "Invalid date" }, { status: 400 });

  const [state, keepingOldTreatment] = await Promise.all([
    readClubTaxAdminState(),
    from ? countBookingsKeepingTreatmentFrom(from.data) : Promise.resolve(null),
  ]);
  return NextResponse.json({ state, keepingOldTreatment });
}

const scheduleSchema = z
  .object({
    gstRegistered: z.boolean(),
    taxRateBasisPoints: z.number().int().min(0).max(MAX_TAX_RATE_BASIS_POINTS),
    xeroTaxType: z.string().max(50).nullable(),
    effectiveFrom: calendarDate,
    confirmed: z.boolean().optional(),
  })
  .strict();

const cancelSchema = z.object({ effectiveFrom: calendarDate, confirmed: z.boolean().optional() }).strict();

const UNCONFIRMED_MESSAGE =
  "Changing how the club is taxed has to be confirmed before it is saved: tick that you understand what it changes.";

function refusalResponse(refusal: ClubTaxWriteRefusal) {
  switch (refusal.refused) {
    case "not-future":
      return NextResponse.json(
        { error: `A change can start on ${refusal.earliest} at the earliest. A date that has started is history and cannot change.` },
        { status: 400 },
      );
    case "xero-code":
      return NextResponse.json({ error: refusal.message }, { status: 400 });
    case "xero-unreadable":
      return NextResponse.json(
        { error: "Xero's tax rates could not be read, so the code cannot be checked. Check the Xero connection and try again." },
        { status: 503 },
      );
    case "already-scheduled":
      return NextResponse.json(
        { error: "A change is already scheduled from that date. Cancel it first, then schedule the new one." },
        { status: 409 },
      );
    case "unchanged":
      return NextResponse.json(
        { error: "That is already the club's tax treatment on that date, so there is nothing to change." },
        { status: 400 },
      );
    case "not-found":
      return NextResponse.json({ error: "No change is scheduled from that date." }, { status: 404 });
  }
}

async function readBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

async function answerWrite(run: () => Promise<Awaited<ReturnType<typeof scheduleClubTaxChange>>>) {
  try {
    const outcome = await run();
    if ("refused" in outcome) return refusalResponse(outcome);
    return NextResponse.json({ changed: true, state: await readClubTaxAdminState() });
  } catch (error) {
    if (!isTransactionContentionError(error)) throw error;
    logger.warn({ err: error }, "Club tax treatment save hit write contention");
    return NextResponse.json({ error: "Another update is in progress — try again shortly." }, { status: 503 });
  }
}

export async function PUT(request: Request) {
  const guard = await requireAdmin({ permission: false });
  if (!guard.ok) return guard.response;

  const body = await readBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  const parsed = scheduleSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  if (parsed.data.confirmed !== true) return NextResponse.json({ error: UNCONFIRMED_MESSAGE }, { status: 400 });
  const { confirmed: _confirmed, ...change } = parsed.data;
  if (change.gstRegistered && !change.xeroTaxType?.trim()) {
    return NextResponse.json({ error: "Choose the Xero tax code a GST-registered club's sales carry." }, { status: 400 });
  }

  return answerWrite(() => scheduleClubTaxChange({ change, actingMemberId: guard.session.user.id, request }));
}

export async function DELETE(request: Request) {
  const guard = await requireAdmin({ permission: false });
  if (!guard.ok) return guard.response;

  const body = await readBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  const parsed = cancelSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  if (parsed.data.confirmed !== true) {
    return NextResponse.json({ error: "Cancelling a scheduled tax change has to be confirmed." }, { status: 400 });
  }

  return answerWrite(() =>
    cancelScheduledClubTaxChange({ effectiveFrom: parsed.data.effectiveFrom, actingMemberId: guard.session.user.id, request }));
}
