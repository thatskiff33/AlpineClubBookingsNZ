import { NextResponse } from "next/server";
import { z } from "zod";

import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import { normaliseClubTimeZone } from "@/lib/club-time-zone";
import {
  stateFromResolved,
  stateFromRow,
} from "@/lib/club-time-zone-admin-state";
import {
  CLUB_TIME_SETTINGS_ID,
  CLUB_TIME_SETTINGS_SELECT,
  resolveClubTimeZoneWithSource,
} from "@/lib/club-time-zone-settings";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

/**
 * The club-timezone maintenance API (CT-1, #2989; epic #2988).
 *
 * FULL ADMIN ON BOTH VERBS, AND NOT BY AREA LEVEL. `requireAdmin({ permission:
 * false })` is the guard's "only a full administrator" shape (see
 * `RequireAdminOptions` in `src/lib/session-guards.ts`). The two other shapes
 * are both wrong here and both look right at a glance: an OMITTED `permission`
 * infers the requirement from the path, which for these prefixes is `support`,
 * so a support editor would be admitted; `"any-admin"` widens to every admitted
 * administrator. `/admin/club-time` and `/api/admin/club-time-zone` are
 * registered under `support` in `ROUTE_AREA_PREFIXES` only so the route-map
 * drift guard and the sidebar matrix resolve them to a concrete area instead of
 * the `overview` catch-all; that AREA decides who can reach the surface at all,
 * and the `permission: false` here is what enforces Full Admin.
 *
 * THE CONFIRMATION IS ENFORCED HERE, not only in the panel. A checkbox in a
 * browser is a courtesy to the operator, and the panel is not the only caller.
 *
 * THE TRANSACTION TOUCHES EXACTLY TWO TABLES — `ClubTimeSettings` and
 * `AuditLog` — and that is a contract, not an implementation detail. Changing
 * the club timezone rewrites NO historical instant and NO date-only value: a
 * lodge night keeps its calendar date and a stored timestamp keeps its instant.
 * A write here reaching a booking, a payment or a member's dates would be that
 * promise broken, so the route's test enumerates the delegates and fails if any
 * other one is called.
 *
 * SERIALIZABLE, AND NO ADVISORY LOCK. A single-row configuration upsert
 * composes no capacity claim, no settlement money and no lifecycle transition,
 * which is what `docs/CONCURRENCY_AND_LOCKING.md` reserves the lock tiers for —
 * but it does need its recorded BEFORE value to be true. At Prisma's default
 * READ COMMITTED a `findUnique` takes no row lock, so two administrators saving
 * at once could each read Auckland, both write, and leave a trail claiming two
 * changes FROM Auckland: the intermediate value the trail exists to show is
 * simply lost, and the dirty gate can miss a re-save that had already happened.
 * Serializable aborts the loser instead, which writes nothing at all and is
 * answered a retryable 503.
 */

/**
 * Retryable failures of the transaction below, answered 503 rather than 500.
 * P2028 (transaction API error, including an exhausted `maxWait`/`timeout`) and
 * P2034 (write conflict, deadlock, or the serialisation failure Serializable
 * deliberately provokes) are the shared shape `/api/admin/site-style` uses.
 * P2002 joins them here and only here: on a one-row singleton whose id is a
 * constant, a primary-key collision can only be this upsert's create arm losing
 * a race with another administrator recording the zone for the first time.
 *
 * That reasoning rests on a fact worth stating rather than leaving implicit,
 * because it is what a future schema change would silently break: the ONLY other
 * table this transaction writes is `AuditLog`, whose primary key is a `cuid`
 * generated per row and which carries no other unique constraint, and the audit
 * builder emits a flat `data` payload with no nested creates. So no P2002 can
 * originate there today. Add a unique index to `AuditLog` and a duplicate-audit
 * bug starts being answered "try again shortly" — a retryable 503 for something
 * retrying cannot fix — so this set must be revisited if that ever changes.
 */
const TRANSACTION_CONTENTION_CODES = new Set(["P2002", "P2028", "P2034"]);

function isTransactionContentionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && TRANSACTION_CONTENTION_CODES.has(code);
}

export async function GET() {
  const guard = await requireAdmin({ permission: false });
  if (!guard.ok) return guard.response;

  const resolved = await resolveClubTimeZoneWithSource();
  return NextResponse.json({ state: await stateFromResolved(resolved) });
}

/**
 * `confirmed` is OPTIONAL in the schema and required by the check below, so an
 * absent flag and an explicit `false` get the same plain-English refusal rather
 * than one of them falling out as a generic "invalid body".
 */
const changeSchema = z
  .object({
    timeZone: z.string().max(200),
    confirmed: z.boolean().optional(),
  })
  .strict();

const INVALID_ZONE_MESSAGE =
  "Enter a named IANA time zone such as Pacific/Auckland. Abbreviations " +
  "(NZT, EST) and fixed offsets (+12:00, Etc/GMT-12) are refused: they name " +
  "no place, so they carry no daylight-saving rules.";

export async function PUT(request: Request) {
  const guard = await requireAdmin({ permission: false });
  if (!guard.ok) return guard.response;
  const actingMemberId = guard.session.user.id;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = changeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  if (parsed.data.confirmed !== true) {
    return NextResponse.json(
      {
        error:
          "Changing the club time zone has to be confirmed before it is saved.",
      },
      { status: 400 },
    );
  }

  const timeZone = normaliseClubTimeZone(parsed.data.timeZone);
  if (!timeZone) {
    return NextResponse.json({ error: INVALID_ZONE_MESSAGE }, { status: 400 });
  }

  try {
    const outcome = await prisma.$transaction(
      async (tx) => {
        const before = await tx.clubTimeSettings.findUnique({
          where: { id: CLUB_TIME_SETTINGS_ID },
          select: CLUB_TIME_SETTINGS_SELECT,
        });

        /*
          DIRTY GATING (docs/ARCHITECTURE.md -> "Admin/member layer"). Re-saving
          the value already stored writes nothing at all: no row, no `updatedAt`
          bump and no audit row. A trail recording changes that never happened is
          worse than no trail, because the next reader cannot tell the
          difference. The isolation level above — not the fact that this read
          sits inside the transaction — is what keeps `before` true at commit
          time, so a concurrent save can neither slip past this gate nor make the
          audit row name a zone the club had already left.
        */
        if (before && before.timeZone === timeZone) {
          return { changed: false as const, row: before };
        }

        const row = await tx.clubTimeSettings.upsert({
          where: { id: CLUB_TIME_SETTINGS_ID },
          update: { timeZone, updatedByMemberId: actingMemberId },
          create: {
            id: CLUB_TIME_SETTINGS_ID,
            timeZone,
            updatedByMemberId: actingMemberId,
          },
          select: CLUB_TIME_SETTINGS_SELECT,
        });

        await tx.auditLog.create(
          buildStructuredAuditLogCreateArgs({
            action: "CLUB_TIME_ZONE_UPDATED",
            actor: { memberId: actingMemberId },
            entity: { type: "ClubTimeSettings", id: CLUB_TIME_SETTINGS_ID },
            // Installation configuration, like CLUB_IDENTITY_SETTINGS_UPDATED.
            category: "admin",
            severity: "important",
            outcome: "success",
            summary: "Club time zone updated",
            /*
              THE BEFORE AND AFTER ZONE, AND NOTHING ELSE (#2989 requirement 6:
              "do not audit unrelated settings payload"). `before: null` means
              nothing was persisted yet. No request echo, no settings blob, and
              nothing about the actor beyond the id the row already carries.
            */
            metadata: { before: before?.timeZone ?? null, after: timeZone },
            request: getAuditRequestContext(request),
          }),
        );

        return { changed: true as const, row };
      },
      { isolationLevel: "Serializable" },
    );

    return NextResponse.json({
      changed: outcome.changed,
      state: await stateFromRow(outcome.row),
    });
  } catch (error) {
    /*
      The loser of a real race, told to try again rather than handed a 500 — and
      it wrote nothing, so retrying is safe. Anything else rethrows: this route
      cannot tell what a broken database means, and dressing that up as a
      friendly "try again shortly" would hide it from whoever has to fix it.
    */
    if (!isTransactionContentionError(error)) throw error;
    logger.warn({ err: error }, "Club time zone save hit write contention");
    return NextResponse.json(
      { error: "Another update is in progress — try again shortly." },
      { status: 503 },
    );
  }
}
