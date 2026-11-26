/**
 * #5241: the one answer to "is an officer's credit deduction changing this Xero
 * note?" for every reader that compares a note's Xero state with the ledger
 * (the outside-spend mirror, the spent-outside converge and its flag; `INV-SSOT`).
 *
 * While a correction is RESERVED, the ledger already holds its write-down but
 * Xero may not yet show the void or the allocated invoice, so a comparison would
 * read the reserved cents as missing from Xero and restore them. Those readers
 * skip the note and look again later. A note voided by a COMPLETED correction is
 * the app's own change, not one an officer must be told about.
 */
import type { Prisma } from "@prisma/client";

type Db = Pick<Prisma.TransactionClient, "adminCreditDeductionCorrectionLine">;

/** Notes, among these, with a deduction correction still RESERVED. */
export async function notesWithOpenDeductionCorrection(db: Db, noteIds: readonly string[]): Promise<Set<string>> {
  if (noteIds.length === 0) return new Set();
  const lines = await db.adminCreditDeductionCorrectionLine.findMany({
    where: { xeroCreditNoteId: { in: [...noteIds] }, correction: { status: "RESERVED" } },
    select: { xeroCreditNoteId: true },
  });
  return new Set(lines.map((line) => line.xeroCreditNoteId));
}

export async function noteHasOpenDeductionCorrection(db: Db, noteId: string): Promise<boolean> {
  return (await notesWithOpenDeductionCorrection(db, [noteId])).has(noteId);
}

/** True when a COMPLETED correction voided this note: the void is the app's own. */
export async function noteVoidedByDeductionCorrection(db: Db, noteId: string): Promise<boolean> {
  const line = await db.adminCreditDeductionCorrectionLine.findFirst({
    where: { xeroCreditNoteId: noteId, mode: "VOID", correction: { status: "COMPLETED" } },
    select: { id: true },
  });
  return line !== null;
}
