import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { BOOKING_FINANCIAL_HISTORY_RELATIONS } from "@/lib/booking-financial-history";
import { MEMBER_MONEY_RELATIONS } from "@/lib/member-money-tables";

/**
 * #4514 (Ledger M2; decision D1 on #4482, `INV-MONEY-043`): FINANCIAL HISTORY
 * OUTLIVES ITS BOOKING, and the schema says so.
 *
 * Two questions about `prisma/schema.prisma` that no behaviour test asks:
 *
 *  1. Can any referential action reach a money line? Every key the legacy
 *     booking ledger and the member journal hold must be RESTRICT on delete AND
 *     on update. A cascade deletes a line, and a SET NULL or an update cascade
 *     rewrites one, with the table owner's rights, past the application role's
 *     INSERT/SELECT grant (#4453).
 *  2. Is every relation into `Booking` (and `BookingModification` and
 *     `GroupBooking`, which go with it) classified? It is financial history, named in
 *     `BOOKING_FINANCIAL_HISTORY_RELATIONS` and RESTRICT, or it is operational,
 *     listed below with its action and the reason. A new booking child fails
 *     here until somebody decides which it is.
 *
 * The database half — that the migrated keys really are RESTRICT, and that an
 * application-role delete is refused — is `database-roles.realdb.test.ts`.
 */

type Relation = {
  model: string;
  field: string;
  target: string;
  /** The first local key column; a relation is named `Model.column`. */
  column: string;
  onDelete: string | null;
  onUpdate: string | null;
};

const MONEY_LINE_MODELS: readonly string[] = ["BookingLedgerLine", ...MEMBER_MONEY_RELATIONS];

/** Booking children that are not financial history, with the action each has and why. */
const OPERATIONAL_BOOKING_RELATIONS: Readonly<Record<string, { onDelete: string; reason: string }>> = {
  "Booking.parentBookingId": { onDelete: "SetNull", reason: "group parent pointer; the child booking stays" },
  "BookingEvent.bookingId": { onDelete: "Restrict", reason: "lifecycle events; a draft's cleanup removes its own first" },
  "BookingModification.bookingId": { onDelete: "Restrict", reason: "change history; a draft's cleanup removes its own first" },
  "BookingChangeRequest.bookingId": { onDelete: "Restrict", reason: "change requests; a draft's cleanup removes its own first" },
  "BookingGuest.bookingId": { onDelete: "Cascade", reason: "the party; personal data anonymised under #4457, lines keep guestNames" },
  "BookingGuestNightAdjustment.bookingId": { onDelete: "Cascade", reason: "promotion build-up; the ledger's PROMOTION lines post the money" },
  "PromoRedemption.bookingId": { onDelete: "Cascade", reason: "promotion build-up, released with a draft" },
  "PromoRedemptionAllocation.bookingId": { onDelete: "Cascade", reason: "promotion build-up, released with a draft" },
  "PromoRedemptionGuestTarget.bookingId": { onDelete: "Cascade", reason: "promotion build-up, released with a draft" },
  "GroupBooking.organiserBookingId": { onDelete: "Cascade", reason: "group container; its settlement is RESTRICT, so a settled group stops the delete" },
  "GroupBookingJoin.groupBookingId": { onDelete: "Cascade", reason: "join records of the group" },
  "GroupBookingJoin.bookingId": { onDelete: "SetNull", reason: "join record pointer to the child booking" },
  "BookingRequest.convertedBookingId": { onDelete: "SetNull", reason: "enquiry pointer; the enquiry outlives a draft" },
  "BookingRequest.heldBookingId": { onDelete: "SetNull", reason: "enquiry pointer; the enquiry outlives a draft" },
  "BookingRequestPendingAdultReservationNight.bookingId": { onDelete: "Cascade", reason: "capacity reservation rows" },
  "PaymentLink.bookingId": { onDelete: "Cascade", reason: "payment access token, not money" },
  "BedAllocation.bookingId": { onDelete: "Cascade", reason: "bed placement" },
  "ChoreAssignment.bookingId": { onDelete: "Cascade", reason: "chore roster" },
  "BookingWaitlistAlternateLodge.bookingId": { onDelete: "Cascade", reason: "waitlist preference" },
  "HostingCoverageIncident.bookingId": { onDelete: "Cascade", reason: "hosting review work item" },
  "EditReviewChargeRaiseClaim.bookingModificationId": { onDelete: "Cascade", reason: "idempotency claim for a review task" },
  "BookingChangeRequest.linkedModificationId": { onDelete: "SetNull", reason: "request pointer to the change it made" },
};

/**
 * Booking, and the booking children that go when it does: a modification (a
 * draft's cleanup deletes it outright) and a group (it cascades with its
 * organiser's booking). A financial row keyed to either is booking history.
 */
const BOOKING_PARENTS = new Set(["Booking", "BookingModification", "GroupBooking"]);

const RELATION_LINE = /^\s*(\w+)\s+(\w+)(\?|\[\])?\s+@relation\((.*)\)\s*$/;

function parseRelations(schema: string): Relation[] {
  const relations: Relation[] = [];
  let model: string | null = null;
  for (const line of schema.split(/\r?\n/)) {
    const opened = /^model\s+(\w+)\s*\{/.exec(line);
    if (opened) {
      model = opened[1];
      continue;
    }
    if (/^\}/.test(line)) {
      model = null;
      continue;
    }
    if (!model || line.trim().startsWith("//")) continue;
    const match = RELATION_LINE.exec(line);
    const args = match?.[4] ?? "";
    const fields = /fields:\s*\[\s*(\w+)/.exec(args);
    if (!match || !fields) continue;
    relations.push({
      model,
      field: match[1],
      target: match[2],
      column: fields[1],
      onDelete: /onDelete:\s*(\w+)/.exec(args)?.[1] ?? null,
      onUpdate: /onUpdate:\s*(\w+)/.exec(args)?.[1] ?? null,
    });
  }
  return relations;
}

const relations = parseRelations(readFileSync(path.join(process.cwd(), "prisma/schema.prisma"), "utf8"));
const key = (relation: Relation) => `${relation.model}.${relation.column}`;

describe("financial history outlives its booking: the schema (#4514, D1)", () => {
  it("lets no referential action reach a money line: every key they hold is Restrict both ways", () => {
    const moneyLineKeys = relations.filter((relation) => MONEY_LINE_MODELS.includes(relation.model));
    // Not vacuous: the legacy ledger's three keys and the journal's keys are all seen.
    expect(moneyLineKeys.filter((relation) => relation.model === "BookingLedgerLine").map(key).sort()).toEqual([
      "BookingLedgerLine.bookingId",
      "BookingLedgerLine.lodgeId",
      "BookingLedgerLine.reversesLineId",
    ]);
    // Every journal relation but the event, which holds no key: its actor is an identity string.
    expect(new Set(moneyLineKeys.map((relation) => relation.model))).toEqual(
      new Set(MONEY_LINE_MODELS.filter((model) => model !== "MemberMoneyEvent")),
    );
    const loose = moneyLineKeys.filter((relation) => relation.onDelete !== "Restrict" || relation.onUpdate !== "Restrict");
    expect(loose.map((relation) => `${key(relation)} onDelete=${relation.onDelete} onUpdate=${relation.onUpdate}`)).toEqual([]);
  });

  it("names a booking as financial history only through a Restrict key that really exists", () => {
    const byKey = new Map(relations.map((relation) => [key(relation), relation]));
    for (const name of BOOKING_FINANCIAL_HISTORY_RELATIONS) {
      const relation = byKey.get(name);
      expect(relation, `${name} is not a relation in schema.prisma`).toBeDefined();
      expect(BOOKING_PARENTS.has(relation!.target), `${name} does not reach a booking`).toBe(true);
      expect(relation!.onDelete, `${name} must be Restrict`).toBe("Restrict");
    }
  });

  it("classifies every relation into a booking, its modifications or its group as financial history or operational", () => {
    const financial = new Set<string>(BOOKING_FINANCIAL_HISTORY_RELATIONS);
    const intoBooking = relations.filter((relation) => BOOKING_PARENTS.has(relation.target));
    const unclassified = intoBooking.map(key).filter((name) => !financial.has(name) && !(name in OPERATIONAL_BOOKING_RELATIONS));
    expect(unclassified, "a new booking child: financial history (RESTRICT) or operational?").toEqual([]);
    // An operational child's action is part of its classification: changing it is a reviewed edit here.
    const drifted = intoBooking
      .filter((relation) => key(relation) in OPERATIONAL_BOOKING_RELATIONS)
      .filter((relation) => (relation.onDelete ?? "default") !== OPERATIONAL_BOOKING_RELATIONS[key(relation)].onDelete)
      .map(key);
    expect(drifted).toEqual([]);
    const stale = Object.keys(OPERATIONAL_BOOKING_RELATIONS).filter((name) => !intoBooking.some((relation) => key(relation) === name));
    expect(stale, "an operational entry names no relation").toEqual([]);
    expect([...financial].filter((name) => name in OPERATIONAL_BOOKING_RELATIONS)).toEqual([]);
  });

  it("FAILS on a cascading or update-cascading key, and parses what the schema writes (fixture proof)", () => {
    const fixture = [
      "model BookingLedgerLine {",
      "  booking Booking @relation(fields: [bookingId], references: [id], onDelete: Cascade)",
      "  lodge   Lodge   @relation(fields: [lodgeId], references: [id], onDelete: Restrict)",
      "  // booking Booking @relation(fields: [commented], references: [id], onDelete: Cascade)",
      "  reversedBy BookingLedgerLine? @relation(\"BookingLedgerReversal\")",
      "}",
      "model Fresh {",
      "  booking Booking? @relation(\"Fresh\", fields: [bookingId], references: [id], onDelete: SetNull, onUpdate: Restrict)",
      "}",
    ].join("\n");
    const parsed = parseRelations(fixture);
    expect(parsed).toEqual([
      { model: "BookingLedgerLine", field: "booking", target: "Booking", column: "bookingId", onDelete: "Cascade", onUpdate: null },
      { model: "BookingLedgerLine", field: "lodge", target: "Lodge", column: "lodgeId", onDelete: "Restrict", onUpdate: null },
      { model: "Fresh", field: "booking", target: "Booking", column: "bookingId", onDelete: "SetNull", onUpdate: "Restrict" },
    ]);
    // Both money-line keys would be refused, and Fresh.bookingId is unclassified.
    expect(parsed.filter((relation) => relation.onDelete !== "Restrict" || relation.onUpdate !== "Restrict")).toHaveLength(3);
    expect("Fresh.bookingId" in OPERATIONAL_BOOKING_RELATIONS).toBe(false);
  });
});
