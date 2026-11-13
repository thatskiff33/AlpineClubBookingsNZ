/**
 * Opening-credit batches (#4988, `INV-PAY-153`): the credit balances a club
 * carries over from its old system, posted from one CSV in one approval.
 *
 *  - **Preview writes nothing.** It matches each row to a member and totals the
 *    cents; a file with any unmatched or invalid row cannot be posted, so a
 *    corrected re-upload never doubles the rows that did match.
 *  - **One confirmation posts the whole file atomically**: one
 *    `OpeningCreditBatch` row, one `ADMIN_ADJUSTMENT` credit per member taken
 *    under that member's `lockMemberCreditLedger` (sorted ids,
 *    `INV-LOCK-002`), and one audit row carrying the total.
 *  - **The same file posts once.** The batch key is a hash of what the file
 *    posts; its unique index is the claim, so a second confirm — concurrent or
 *    later — is refused and no balance moves.
 *  - **No side effects leave the app.** No email, no Xero document (no
 *    admin-grant credit note is queued) and no Stripe call: an opening credit
 *    restates a balance the old system already accounted for.
 *  - **Reversal is whole-batch and refuses a spent credit.** Every credit must
 *    still be wholly free; the reversal posts a negative row per credit (credit
 *    rows are insert-only, `INV-MONEY-035`) and stamps the batch reversed.
 */

import { CreditType, type Prisma } from "@prisma/client";

import { ApiError } from "@/lib/api-error";
import { createAuditLog, type StructuredAuditEvent } from "@/lib/audit";
import { assertDeductionLeavesNotedCreditUntouched } from "@/lib/admin-grant-credit-note";
import { clubFormatValues } from "@/lib/club-format-server";
import logger from "@/lib/logger";
import { getMemberCreditBalance, lockMemberCreditLedger } from "@/lib/member-credit";
import { memberName } from "@/lib/member-serialization";
import { OPENING_CREDIT_REVERSAL_REASON_MAX_LENGTH, parseOpeningCreditCsv } from "@/lib/opening-credit-csv";
import { MemberCreditValidationError } from "@/lib/policies/member-credit";
import { prisma } from "@/lib/prisma";
import { compareOrdinal } from "@/lib/ordinal-order";
import { normalizePersonNamePart } from "@/lib/person-name-normalization";
import { stableDigest } from "@/lib/stable-digest";
import { isPrismaUniqueConstraintError } from "@/lib/prisma-errors";
import { formatCents } from "@/lib/utils";
import { loadFreeCreditLots } from "@/lib/xero-applied-credit-lots";
import { MAX_INTEGER_CENTS } from "@/lib/money-input";

export type OpeningCreditPreviewRow = {
  lineNumber: number;
  memberId: string | null;
  memberName: string | null;
  memberEmail: string | null;
  amountCents: number | null;
  description: string;
  errors: string[];
};

export type OpeningCreditPreview = {
  rows: OpeningCreditPreviewRow[];
  matchedCount: number;
  errorCount: number;
  skippedZeroRows: number;
  /** The cents the file would post: the matched, valid rows only. */
  totalCents: number;
  /** Present only when every row can post; confirm must echo it back. */
  batchKey: string | null;
  alreadyPosted: { batchId: string; postedAt: Date; reversedAt: Date | null } | null;
};

type PreviewResult = { ok: true; preview: OpeningCreditPreview } | { ok: false; error: string };

type MatchCandidate = { id: string; email: string; firstName: string; lastName: string };

function sameName(a: string | null, b: string) {
  return a === null || normalizePersonNamePart(a) === normalizePersonNamePart(b);
}

/** The posted content, canonical and sorted, so the same file always hashes the same. */
export function openingCreditBatchKey(rows: readonly { memberId: string; amountCents: number; description: string }[]) {
  const canonical = [...rows]
    .map((row) => [row.memberId, row.amountCents, row.description] as const)
    .sort((a, b) => compareOrdinal(a[0], b[0]));
  return stableDigest(canonical);
}

const OPENING_CREDIT_ALREADY_HELD =
  "already has an opening credit from an earlier batch that has not been reversed; reverse that batch first or leave this member out";

/** Of these members, those holding a credit from a batch not yet reversed. */
async function membersHoldingOpeningCredit(db: Pick<Prisma.TransactionClient, "memberCredit">, memberIds: string[]) {
  if (memberIds.length === 0) return new Set<string>();
  const held = await db.memberCredit.findMany({
    where: {
      memberId: { in: [...new Set(memberIds)] },
      amountCents: { gt: 0 },
      openingCreditBatch: { is: { reversedAt: null } },
    },
    select: { memberId: true },
  });
  return new Set(held.map((row) => row.memberId));
}

const OPENING_CREDIT_SELF_ROW =
  "is you; a second administrator must post your own opening credit, or approve it as a credit adjustment";

/**
 * Match the file to live members and total it. Reads only. A row naming the
 * posting administrator is refused, keeping the second-admin rule that every
 * other credit adjustment has (`INV-PAY-153`).
 */
export async function buildOpeningCreditPreview(
  csvText: string,
  {
    postingAdminId = null,
    db = prisma,
  }: {
    postingAdminId?: string | null;
    db?: Pick<Prisma.TransactionClient, "member" | "memberCredit" | "openingCreditBatch">;
  } = {},
): Promise<PreviewResult> {
  const parsed = parseOpeningCreditCsv(csvText);
  if (!parsed.ok) return parsed;

  const ids = [...new Set(parsed.rows.flatMap((row) => (row.memberId ? [row.memberId] : [])))];
  const emails = [...new Set(parsed.rows.flatMap((row) => (!row.memberId && row.email ? [row.email] : [])))];
  const live = { deletedAt: null, archivedAt: null } as const;
  const select = { id: true, email: true, firstName: true, lastName: true } as const;
  const [byIdRows, byEmailRows] = await Promise.all([
    ids.length > 0 ? db.member.findMany({ where: { id: { in: ids }, ...live }, select }) : [],
    emails.length > 0
      ? db.member.findMany({ where: { email: { in: emails, mode: "insensitive" }, ...live }, select })
      : [],
  ]);
  const byId = new Map<string, MatchCandidate>(byIdRows.map((member) => [member.id, member]));
  const byEmail = new Map<string, MatchCandidate[]>();
  for (const member of byEmailRows) {
    const key = member.email.toLowerCase();
    byEmail.set(key, [...(byEmail.get(key) ?? []), member]);
  }

  const rows: OpeningCreditPreviewRow[] = parsed.rows.map((row) => {
    const errors = [...row.errors];
    let member: MatchCandidate | null = null;
    if (row.memberId) {
      member = byId.get(row.memberId) ?? null;
      if (!member) errors.push(`no current member has the Member ID "${row.memberId}"`);
    } else if (row.email) {
      const candidates = (byEmail.get(row.email) ?? []).filter(
        (candidate) => sameName(row.firstName, candidate.firstName) && sameName(row.lastName, candidate.lastName),
      );
      const [only] = candidates;
      if (candidates.length === 1 && only) {
        member = only;
      } else if (candidates.length === 0) {
        errors.push(`no current member matches "${row.email}"${row.firstName || row.lastName ? " with that name" : ""}`);
      } else {
        errors.push(
          `${candidates.length} members share "${row.email}"; add First Name and Last Name columns, or use a Member ID column`,
        );
      }
    }
    if (member && member.id === postingAdminId) errors.push(OPENING_CREDIT_SELF_ROW);
    return {
      lineNumber: row.lineNumber,
      memberId: member?.id ?? null,
      memberName: member ? memberName(member) : null,
      memberEmail: member?.email ?? null,
      amountCents: row.amountCents,
      description: row.description,
      errors,
    };
  });

  // A member twice in one file is almost always a copy-paste slip; summing it
  // silently would post the wrong balance.
  const lines = new Map<string, number[]>();
  for (const row of rows) {
    if (row.memberId) lines.set(row.memberId, [...(lines.get(row.memberId) ?? []), row.lineNumber]);
  }
  for (const row of rows) {
    const shared = row.memberId ? (lines.get(row.memberId) ?? []) : [];
    if (shared.length > 1) {
      row.errors.push(`names the same member as line ${shared.filter((line) => line !== row.lineNumber).join(", ")}`);
    }
  }

  const tally = () => {
    const valid = rows.filter(
      (row): row is OpeningCreditPreviewRow & { memberId: string; amountCents: number } =>
        row.errors.length === 0 && row.memberId !== null && row.amountCents !== null,
    );
    return { valid, errorCount: rows.length - valid.length };
  };
  let { valid, errorCount } = tally();
  let batchKey = errorCount === 0 ? openingCreditBatchKey(valid) : null;
  const existing = batchKey
    ? await db.openingCreditBatch.findUnique({
        where: { batchKey },
        select: { id: true, postedAt: true, reversedAt: true },
      })
    : null;

  // A corrected file is a new batch, so a member it shares with an earlier,
  // unreversed batch would be credited twice. Re-previewing that same file
  // reports it as already posted instead.
  if (!existing) {
    const holders = await membersHoldingOpeningCredit(
      db,
      rows.flatMap((row) => (row.memberId ? [row.memberId] : [])),
    );
    for (const row of rows) {
      if (row.memberId && holders.has(row.memberId)) row.errors.push(OPENING_CREDIT_ALREADY_HELD);
    }
    if (holders.size > 0) ({ valid, errorCount } = tally());
    batchKey = errorCount === 0 ? openingCreditBatchKey(valid) : null;
  }
  const totalCents = valid.reduce((sum, row) => sum + row.amountCents, 0);
  if (totalCents > MAX_INTEGER_CENTS) {
    return { ok: false, error: "The file's total is larger than one batch can record; split it into two files" };
  }

  return {
    ok: true,
    preview: {
      rows,
      matchedCount: valid.length,
      errorCount,
      skippedZeroRows: parsed.skippedZeroRows,
      totalCents,
      batchKey,
      alreadyPosted: existing ? { batchId: existing.id, postedAt: existing.postedAt, reversedAt: existing.reversedAt } : null,
    },
  };
}

/**
 * A batch locks and checks every member in one transaction, so a migration
 * file of hundreds of rows needs longer than Prisma's five-second default.
 */
const OPENING_CREDIT_TRANSACTION_OPTIONS = { maxWait: 30_000, timeout: 120_000 } as const;

export class OpeningCreditBatchAlreadyPostedError extends ApiError {
  constructor() {
    super("This file has already been posted as an opening-credit batch; no balance was changed", 409);
    this.name = "OpeningCreditBatchAlreadyPostedError";
  }
}

/**
 * Post a previewed file. The file is matched again here, and refused unless it
 * still has no row in error and still hashes and totals to what the officer
 * confirmed.
 */
export async function postOpeningCreditBatch(input: {
  csvText: string;
  expectedBatchKey: string;
  expectedTotalCents: number;
  adminId: string;
  request?: StructuredAuditEvent["request"];
}) {
  const built = await buildOpeningCreditPreview(input.csvText, { postingAdminId: input.adminId });
  if (!built.ok) throw new ApiError(built.error, 400);
  const { preview } = built;
  if (preview.batchKey === null) {
    throw new ApiError("Every row must match a member and carry a valid amount before the file can be posted", 400);
  }
  if (preview.batchKey !== input.expectedBatchKey || preview.totalCents !== input.expectedTotalCents) {
    throw new ApiError("The file or the members it matches changed after the preview; preview it again", 409);
  }
  if (preview.alreadyPosted) throw new OpeningCreditBatchAlreadyPostedError();

  const credits = preview.rows
    .flatMap((row) =>
      row.memberId !== null && row.amountCents !== null
        ? [{ memberId: row.memberId, amountCents: row.amountCents, description: row.description }]
        : [],
    )
    .sort((a, b) => compareOrdinal(a.memberId, b.memberId));
  const batchKey = preview.batchKey;
  // Before the transaction and its ledger locks (#3565).
  const format = await clubFormatValues();

  try {
    const batch = await prisma.$transaction(async (tx) => {
      for (const credit of credits) {
        await lockMemberCreditLedger(credit.memberId, tx);
      }
      // Credit rows are insert-only. Counting deductions under the locks records
      // ledger order; createdAt records transaction start and can predate a post
      // even when that transaction spends the credit after it.
      const negativeCreditCountAtPost = await tx.memberCredit.count({
        where: { memberId: { in: credits.map((credit) => credit.memberId) }, amountCents: { lt: 0 } },
      });
      // The unique key claims the file before any credit or audit side effect.
      const created = await tx.openingCreditBatch.create({
        data: { batchKey, totalCents: preview.totalCents, rowCount: credits.length, negativeCreditCountAtPost, postedById: input.adminId },
        select: { id: true, postedAt: true },
      });
      // Re-read under the locks: another batch may have credited a member since
      // the preview. This batch's own row is not yet a holder.
      const holders = await membersHoldingOpeningCredit(
        tx,
        credits.map((credit) => credit.memberId),
      );
      if (holders.size > 0) {
        throw new ApiError(
          `${holders.size} member(s) in this file ${OPENING_CREDIT_ALREADY_HELD}; preview it again`,
          409,
        );
      }
      await tx.memberCredit.createMany({
        data: credits.map((credit) => ({
          memberId: credit.memberId,
          amountCents: credit.amountCents,
          type: CreditType.ADMIN_ADJUSTMENT,
          description: credit.description,
          approvedById: input.adminId,
          openingCreditBatchId: created.id,
        })),
      });
      await createAuditLog(
        {
          action: "member.credit.opening_batch.post",
          category: "payment",
          entityType: "OpeningCreditBatch",
          entityId: created.id,
          memberId: input.adminId,
          summary: `Opening-credit batch posted: ${credits.length} credits, ${formatCents(preview.totalCents, format)}`,
          details: `Posted opening-credit batch ${created.id}: ${credits.length} member credits totalling ${formatCents(preview.totalCents, format)}. No email, Xero document or Stripe call was made.`,
          metadata: { batchKey, totalCents: preview.totalCents, rowCount: credits.length },
          ipAddress: input.request?.ipAddress ?? null,
          requestId: input.request?.id ?? null,
          userAgent: input.request?.userAgent ?? null,
        },
        tx,
      );
      return created;
    }, OPENING_CREDIT_TRANSACTION_OPTIONS);
    logger.info(
      { batchId: batch.id, totalCents: preview.totalCents, rowCount: credits.length, adminId: input.adminId },
      "Opening-credit batch posted",
    );
    return { batchId: batch.id, postedAt: batch.postedAt, totalCents: preview.totalCents, rowCount: credits.length };
  } catch (error) {
    if (isPrismaUniqueConstraintError(error)) throw new OpeningCreditBatchAlreadyPostedError();
    throw error;
  }
}

/**
 * Reverse a whole batch, only while every credit in it is wholly unspent: the
 * member's balance still covers it, no booking has drawn on it, and no
 * Xero-noted credit of the member's would be consumed by the deduction. One
 * spent credit refuses the reversal and writes nothing.
 */
export async function reverseOpeningCreditBatch(input: {
  batchId: string;
  reason: string;
  adminId: string;
  request?: StructuredAuditEvent["request"];
}) {
  const reason = input.reason.trim();
  if (!reason) throw new ApiError("A reason is required to reverse an opening-credit batch", 400);
  if (reason.length > OPENING_CREDIT_REVERSAL_REASON_MAX_LENGTH) {
    throw new ApiError(`The reason can be at most ${OPENING_CREDIT_REVERSAL_REASON_MAX_LENGTH} characters`, 400);
  }
  const format = await clubFormatValues();

  const result = await prisma.$transaction(async (tx) => {
    const batch = await tx.openingCreditBatch.findUnique({
      where: { id: input.batchId },
      select: {
        id: true,
        totalCents: true,
        negativeCreditCountAtPost: true,
        reversedAt: true,
        credits: {
          where: { amountCents: { gt: 0 } },
          select: {
            id: true,
            memberId: true,
            amountCents: true,
            member: { select: { firstName: true, lastName: true } },
          },
        },
      },
    });
    if (!batch) throw new ApiError("Opening-credit batch not found", 404);
    if (batch.reversedAt) throw new ApiError("This opening-credit batch has already been reversed", 409);

    // The same ordinal order as posting (INV-LOCK-002), not the database collation.
    batch.credits.sort((a, b) => compareOrdinal(a.memberId, b.memberId));
    for (const credit of batch.credits) {
      await lockMemberCreditLedger(credit.memberId, tx);
    }
    // A concurrent reversal that won the locks has already posted its rows;
    // say so rather than reporting them as a deduction.
    const current = await tx.openingCreditBatch.findUnique({ where: { id: batch.id }, select: { reversedAt: true } });
    if (current?.reversedAt) throw new ApiError("This opening-credit batch has already been reversed", 409);
    // After the locks, and before the claim stamps the batch reversed (a
    // reversed batch's credits are no longer lots): what each member holds now.
    const memberIds = batch.credits.map((credit) => credit.memberId);
    const lots = await loadFreeCreditLots(tx, memberIds);
    // Under the same member locks as posting and spending, any new negative
    // row means some credit may have been used. Do not infer order from dates:
    // PostgreSQL CURRENT_TIMESTAMP is the transaction's start, before its locks.
    const negativeCreditCount = await tx.memberCredit.count({
      where: { memberId: { in: memberIds }, amountCents: { lt: 0 } },
    });
    if (negativeCreditCount !== batch.negativeCreditCountAtPost) {
      throw new ApiError("This batch cannot be reversed because a member has had credit deducted since it posted", 409);
    }
    const spent: string[] = [];
    for (const credit of batch.credits) {
      const name = memberName(credit.member);
      const lot = lots.get(credit.memberId)?.lots.find((free) => free.memberCreditId === credit.id);
      const balance = await getMemberCreditBalance(credit.memberId, tx);
      if (
        !lot ||
        lot.remainingCents !== credit.amountCents ||
        balance < credit.amountCents
      ) {
        spent.push(`${name}: some of the ${formatCents(credit.amountCents, format)} has been used`);
        continue;
      }
      try {
        await assertDeductionLeavesNotedCreditUntouched(credit.memberId, -credit.amountCents, tx);
      } catch (error) {
        if (!(error instanceof MemberCreditValidationError)) throw error;
        spent.push(`${name}: ${error.message}`);
      }
    }
    if (spent.length > 0) {
      throw new ApiError(`This batch cannot be reversed because some credit is no longer unspent. ${spent.join("; ")}`, 409);
    }
    const claimed = await tx.openingCreditBatch.updateMany({
      where: { id: batch.id, reversedAt: null },
      data: { reversedAt: new Date(), reversedById: input.adminId, reversalReason: reason },
    });
    if (claimed.count !== 1) throw new ApiError("This opening-credit batch has already been reversed", 409);

    await tx.memberCredit.createMany({
      data: batch.credits.map((credit) => ({
        memberId: credit.memberId,
        amountCents: -credit.amountCents,
        type: CreditType.ADMIN_ADJUSTMENT,
        // Members see this description in their credit history; the officer's
        // reason stays on the batch and its audit row.
        description: "Opening credit reversed",
        approvedById: input.adminId,
        openingCreditBatchId: batch.id,
      })),
    });
    await createAuditLog(
      {
        action: "member.credit.opening_batch.reverse",
        category: "payment",
        entityType: "OpeningCreditBatch",
        entityId: batch.id,
        memberId: input.adminId,
        summary: `Opening-credit batch reversed: ${batch.credits.length} credits, ${formatCents(batch.totalCents, format)}`,
        details: `Reversed opening-credit batch ${batch.id}: ${batch.credits.length} member credits totalling ${formatCents(batch.totalCents, format)}. Reason: ${reason}`,
        metadata: { totalCents: batch.totalCents, rowCount: batch.credits.length },
        ipAddress: input.request?.ipAddress ?? null,
        requestId: input.request?.id ?? null,
        userAgent: input.request?.userAgent ?? null,
      },
      tx,
    );
    return { batchId: batch.id, totalCents: batch.totalCents, rowCount: batch.credits.length };
  }, OPENING_CREDIT_TRANSACTION_OPTIONS);

  logger.info({ ...result, adminId: input.adminId }, "Opening-credit batch reversed");
  return result;
}

/** The batches posted so far, newest first, for the Finance card. */
export async function listOpeningCreditBatches() {
  const batches = await prisma.openingCreditBatch.findMany({
    orderBy: { postedAt: "desc" },
    take: 50,
    select: {
      id: true,
      totalCents: true,
      rowCount: true,
      postedAt: true,
      reversedAt: true,
      reversalReason: true,
      postedBy: { select: { firstName: true, lastName: true } },
      reversedBy: { select: { firstName: true, lastName: true } },
    },
  });
  return batches.map((batch) => ({
    id: batch.id,
    totalCents: batch.totalCents,
    rowCount: batch.rowCount,
    postedAt: batch.postedAt.toISOString(),
    reversedAt: batch.reversedAt?.toISOString() ?? null,
    reversalReason: batch.reversalReason,
    postedBy: batch.postedBy ? memberName(batch.postedBy) : null,
    reversedBy: batch.reversedBy ? memberName(batch.reversedBy) : null,
  }));
}

export type OpeningCreditBatchListItem = Awaited<ReturnType<typeof listOpeningCreditBatches>>[number];
