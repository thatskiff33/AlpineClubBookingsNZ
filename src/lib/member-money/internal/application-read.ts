import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { decodeRawRows } from "../../raw-sql-rows";
import { MemberMoneyApplicationState, type ApplicationState } from "./application-state";
import { MemberMoneyPlanError } from "./plan";
type Db = Prisma.TransactionClient;

/** Payment is the mutable serialization point; immutable journal rows are never locked. */
export async function lockMemberMoneyPayment(db: Db, bookingId: string): Promise<void> {
  const rows = await db.$executeRaw`SELECT 1 FROM "Payment" WHERE "bookingId" = ${bookingId} FOR NO KEY UPDATE`;
  if (rows !== 1) throw new MemberMoneyPlanError([`booking ${bookingId} has no unique Payment row`]);
}

/** Exact source and family projections, scoped to a booking; no receipt is selected by amount or time. */
export async function readMemberMoneyApplicationState(db: Db, bookingId: string): Promise<ApplicationState> {
  const rows = await db.$queryRaw`SELECT public.member_money_application_state(${bookingId}::text) AS state`;
  return decodeRawRows(rows, z.object({ state: MemberMoneyApplicationState }), "member money application state")[0]!.state;
}

