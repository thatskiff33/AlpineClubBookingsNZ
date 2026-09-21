/**
 * THE ITEMISED LINES ON A BOOKING-EDIT XERO DOCUMENT (#3530 stage 2b,
 * programme #3527; `INV-MOD-058`).
 *
 * A supplementary invoice and the two modification credit notes carried one
 * line - `Booking modification - price adjustment (Booking xxxx)` at the net
 * figure - which told the treasurer nothing about what changed. Stage 2a
 * stores the lines behind every exactly-priced edit on the modification row;
 * this module renders those rows as Xero line items, one per stored line,
 * with the same sentence the booking's history and audit row show
 * (`renderModificationLineDescription`, `INV-SSOT`).
 *
 * WHAT THIS DOES NOT DO. It never decides WHETHER a document is itemised -
 * `selectModificationDocumentLines` does, and a builder calls it first. It
 * never changes an amount: quantity × unit price reproduces each stored line's
 * money to the cent by the parser's own rule (`amountCents = sign × unitCents
 * × quantity`), and the change-fee line is the one the document always had.
 * Idempotency keys, links and payload shapes are untouched (`INV-PAY-070`).
 *
 * CODING (`INV-ADDPAY-017`, #1356): a night ADDED posts to `hutFeesIncome`
 * with the guest's own hut-fee item code - the original invoice's precedence,
 * `xero-hut-fee-line-codes.ts`; a night REMOVED posts to `hutFeeRefunds`, as
 * the signed price-adjustment line does today; the promotion delta takes the
 * promo's own codes with the original invoice's fallback. On a credit note
 * every sign inverts: removed nights are the positive lines, added nights and
 * the change fee are negative, and the note totals what it returns.
 *
 * REVIEW SHARES (stage 2c). A parked edit stores no lines; what its documents
 * bill is what an officer settled on each `EDIT_FINANCIAL_REVIEW` task. Each
 * COMPLETED share anchored on the modification is one line,
 * `Adjustment agreed with member: <the officer's note>`, at the task's own
 * figure - a charge coded as today's single price-adjustment line is, a
 * refund as a give-back. Never a guest-night line invented from the figure:
 * the adjustment is named for what it is (owner direction on #3527).
 */
import type { LineItem } from "xero-node";
import { prisma } from "./prisma";
import logger from "@/lib/logger";
import {
  renderModificationLineDescription,
  type ModificationLine,
} from "@/lib/booking-modification-lines";
import {
  selectModificationDocumentLines,
  type ModificationDocumentLinesFallbackReason,
} from "@/lib/booking-modification-document-lines";
import {
  getHutFeeItemCodeMap,
  getHutFeeSeasonType,
  getResolvedAccountMapping,
  type HutFeeItemCodeResolver,
  type ResolvedAccountMapping,
} from "./xero-mappings";
import {
  applyHutFeeLineCodes,
  resolveHutFeeLineItemCode,
  resolvePromoLineCodes,
} from "@/lib/xero-hut-fee-line-codes";
import {
  editReviewSettledShareTaskSelect,
  editReviewSettledShareTaskWhere,
  editReviewSettledSharesByAnchor,
  type EditReviewSettledShare,
} from "@/lib/edit-financial-review-charge-shape";

export type ModificationDocumentKind = "SUPPLEMENTARY_INVOICE" | "MODIFICATION_CREDIT_NOTE";

/** The change-fee line's words, on every document that carries one. */
export const CHANGE_FEE_LINE_DESCRIPTION = "Late notice booking change fee";

/** A settled review share's words: the officer's note, or the bare sentence. */
export function renderEditReviewShareDescription(share: Pick<EditReviewSettledShare, "note">): string {
  const note = share.note?.trim();
  return note ? `Adjustment agreed with member: ${note}` : "Adjustment agreed with member";
}

/** The modification row's columns a document reads: one `select`, spread by every reader. */
export const MODIFICATION_DOCUMENT_LINES_SELECT = {
  priceLines: true,
  priceDiffCents: true,
  changeFeeCents: true,
} as const;

/** Everything the renderer needs to code a line; loaded once per document. */
export type ModificationDocumentCodingContext = {
  incomeMapping: ResolvedAccountMapping;
  refundMapping: ResolvedAccountMapping;
  itemCodeResolver: HutFeeItemCodeResolver;
  seasonType: string | null;
  promo: { xeroItemCode: string | null; xeroAccountCode: string | null } | null;
  firstGuest: { ageTier: string; isMember: boolean; rateMembershipTypeId: string | null } | null;
};

/**
 * The mappings, resolver, season and promotion the original invoice codes
 * its lines with, read for this booking. Called only once a document has
 * been selected for itemisation, so a fallback document costs no extra read.
 */
export async function loadModificationDocumentCodingContext(
  bookingId: string,
): Promise<ModificationDocumentCodingContext> {
  const booking = await prisma.booking.findUniqueOrThrow({
    where: { id: bookingId },
    select: {
      checkIn: true,
      lodgeId: true,
      promoRedemption: {
        select: { promoCode: { select: { xeroItemCode: true, xeroAccountCode: true } } },
      },
      guests: { select: { ageTier: true, isMember: true, rateMembershipTypeId: true } },
    },
  });
  const [incomeMapping, refundMapping, itemCodeResolver, seasonType] = await Promise.all([
    getResolvedAccountMapping("hutFeesIncome"),
    getResolvedAccountMapping("hutFeeRefunds"),
    getHutFeeItemCodeMap(),
    // The booking's current check-in season, exactly as the original invoice
    // keys its item codes; a stay moved across a season boundary is coded to
    // the season it now starts in, as that invoice's own update would be.
    getHutFeeSeasonType(new Date(booking.checkIn), booking.lodgeId),
  ]);
  return {
    incomeMapping,
    refundMapping,
    itemCodeResolver,
    seasonType,
    promo: booking.promoRedemption?.promoCode ?? null,
    firstGuest: booking.guests[0] ?? null,
  };
}

/**
 * One Xero line per stored line, plus the change-fee line when there is a
 * fee, signed for the document. Pure: the caller loaded the context and
 * selected the lines.
 */
export function buildModificationDocumentLineItems(args: {
  lines: ReadonlyArray<ModificationLine>;
  /** The settled review shares, one line each after the edit's lines (2c). */
  shares?: ReadonlyArray<EditReviewSettledShare>;
  changeFeeCents: number;
  document: ModificationDocumentKind;
  context: ModificationDocumentCodingContext;
}): LineItem[] {
  const { lines, shares = [], changeFeeCents, document, context } = args;
  // +1 renders the stored sign as it is (an invoice bills what was added);
  // -1 inverts it (a credit note returns what was removed).
  const orientation = document === "SUPPLEMENTARY_INVOICE" ? 1 : -1;
  const incomeCode = context.incomeMapping.code ?? "200";
  const refundCode = context.refundMapping.code ?? "200";

  const items: LineItem[] = lines.map((line): LineItem => {
    const base: LineItem = {
      description: renderModificationLineDescription(line, context.itemCodeResolver),
      quantity: line.kind === "PROMO_DELTA" ? 1 : line.quantity,
      // Xero uses dollars; the sign lives on the unit price so the quantity
      // stays the honest count of guest-nights.
      unitAmount:
        (line.kind === "PROMO_DELTA"
          ? orientation * line.amountCents
          : orientation * line.sign * line.unitCents) / 100,
      taxType: "OUTPUT2",
    };
    if (line.kind === "PROMO_DELTA") {
      return applyHutFeeLineCodes(
        base,
        resolvePromoLineCodes({
          promo: context.promo,
          firstGuest: context.firstGuest,
          itemCodeResolver: context.itemCodeResolver,
          seasonType: context.seasonType,
          hutFeeMapping: context.incomeMapping,
        }),
      );
    }
    // The stored sign, not the rendered one, picks the account: a removed
    // night is a give-back on whichever document it appears (#1356).
    return line.sign > 0
      ? applyHutFeeLineCodes(base, {
          itemCode: resolveHutFeeLineItemCode(line, {
            itemCodeResolver: context.itemCodeResolver,
            seasonType: context.seasonType,
            itemCode: context.incomeMapping.itemCode,
          }),
          accountCode: incomeCode,
          accountCodeExplicitlyConfigured: context.incomeMapping.codeExplicitlyConfigured,
        })
      : applyHutFeeLineCodes(base, {
          itemCode: context.refundMapping.itemCode,
          accountCode: refundCode,
          accountCodeExplicitlyConfigured: context.refundMapping.codeExplicitlyConfigured,
        });
  });

  // A share is coded by its sign exactly as the single price-adjustment line
  // it replaces: a charge to income with the flat item code, a refund as a
  // give-back (#1356). Its sign renders under the same orientation as a line.
  for (const share of shares) {
    items.push(
      applyHutFeeLineCodes(
        {
          description: renderEditReviewShareDescription(share),
          quantity: 1,
          unitAmount: (orientation * share.sign * share.amountCents) / 100,
          taxType: "OUTPUT2",
        },
        share.sign > 0
          ? {
              itemCode: context.incomeMapping.itemCode,
              accountCode: incomeCode,
              accountCodeExplicitlyConfigured: context.incomeMapping.codeExplicitlyConfigured,
            }
          : {
              itemCode: context.refundMapping.itemCode,
              accountCode: refundCode,
              accountCodeExplicitlyConfigured: context.refundMapping.codeExplicitlyConfigured,
            },
      ),
    );
  }

  if (changeFeeCents > 0) {
    items.push(
      applyHutFeeLineCodes(
        {
          description: CHANGE_FEE_LINE_DESCRIPTION,
          quantity: 1,
          unitAmount: (orientation * changeFeeCents) / 100,
          taxType: "OUTPUT2",
        },
        {
          itemCode: context.incomeMapping.itemCode,
          accountCode: incomeCode,
          accountCodeExplicitlyConfigured: context.incomeMapping.codeExplicitlyConfigured,
        },
      ),
    );
  }
  return items;
}

/** What the operation records beside the document (`INV-MONEY-030`'s shape). */
export type ModificationDocumentLinesRecord = {
  source: "STORED" | "FALLBACK_SINGLE_LINE";
  /**
   * The selector's reason, or `NARRATION_UNAVAILABLE` when a read the
   * itemisation needed (the row, the codes, the season) failed: the document
   * is sent as its single line rather than not at all.
   */
  reason: ModificationDocumentLinesFallbackReason | null;
  storedSumCents: number | null;
  /** The settled review shares' signed sum (2c); null when none. */
  sharesSumCents: number | null;
  billedCents: number;
  lineCount: number;
  shareCount: number;
};

/**
 * The COMPLETED review shares settled against one modification (2c): the
 * same rows `sumEditReviewChargeSharesCents` counts, in both directions,
 * found by booking and filtered on the anchor through the one parser.
 */
export async function loadEditReviewSettledShares(
  bookingId: string,
  bookingModificationId: string,
): Promise<EditReviewSettledShare[]> {
  const tasks = await prisma.manualRefundTask.findMany({
    where: { bookingId, ...editReviewSettledShareTaskWhere },
    select: editReviewSettledShareTaskSelect,
  });
  return editReviewSettledSharesByAnchor(tasks).get(bookingModificationId) ?? [];
}

/** The modification row's columns a document reads (`select` them by id). */
export type ModificationDocumentLinesRow = {
  priceLines: unknown;
  priceDiffCents: number;
  changeFeeCents: number;
};

/**
 * Select, then render: the one call a builder makes. `null` line items mean
 * "render today's single line" - the builder keeps that code exactly as it
 * was - and the record says why, on every answer.
 *
 * `billedFigures` are the figures the document bills. A supplementary invoice
 * passes its own `priceDiffCents` / `changeFeeCents` because a restated
 * operation (`INV-PAY-070`) bills raised figures the row's lines were never
 * about; a credit note bills from the row itself.
 *
 * NARRATION NEVER FAILS A DOCUMENT - the same rule 2a holds for the edit.
 * Every read this needs and did not exist before #3530 (the row, when the
 * caller did not already hold it; the settled shares; the codes; the season)
 * runs inside this guard, so a failure of one sends the document as its single line, logged
 * and recorded as `NARRATION_UNAVAILABLE`, rather than failing an operation
 * that would have succeeded before the lines existed.
 */
export async function resolveModificationDocumentLineItems(args: {
  bookingId: string;
  /** The row's lines and figures when the caller already read them; else read here. */
  row?: ModificationDocumentLinesRow | null;
  /** The anchor: the row is read by it when not supplied, and the shares always are. */
  bookingModificationId?: string | null;
  document: ModificationDocumentKind;
  billedCents: number;
  billedFigures?: { priceDiffCents: number; changeFeeCents: number };
  secondAsk?: boolean;
}): Promise<{ lineItems: LineItem[] | null; record: ModificationDocumentLinesRecord }> {
  try {
    const row =
      args.row !== undefined
        ? args.row
        : args.bookingModificationId
          ? await prisma.bookingModification.findUnique({
              where: { id: args.bookingModificationId },
              select: MODIFICATION_DOCUMENT_LINES_SELECT,
            })
          : null;
    const figures = args.billedFigures ?? {
      priceDiffCents: row?.priceDiffCents ?? 0,
      changeFeeCents: row?.changeFeeCents ?? 0,
    };
    // A second ask never itemises, so its shares are not read either.
    const shares =
      args.bookingModificationId && !args.secondAsk
        ? await loadEditReviewSettledShares(args.bookingId, args.bookingModificationId)
        : [];
    const selection = selectModificationDocumentLines({
      storedPriceLines: row?.priceLines ?? null,
      shares,
      priceDiffCents: figures.priceDiffCents,
      changeFeeCents: figures.changeFeeCents,
      billedCents: args.billedCents,
      document: args.document,
      secondAsk: args.secondAsk,
    });
    if (selection.source !== "STORED") {
      return {
        lineItems: null,
        record: {
          source: selection.source,
          reason: selection.reason,
          storedSumCents: selection.storedSumCents,
          sharesSumCents: selection.sharesSumCents,
          billedCents: selection.billedCents,
          lineCount: 0,
          shareCount: 0,
        },
      };
    }
    const context = await loadModificationDocumentCodingContext(args.bookingId);
    const lineItems = buildModificationDocumentLineItems({
      lines: selection.lines,
      shares: selection.shares,
      changeFeeCents: figures.changeFeeCents,
      document: args.document,
      context,
    });
    return {
      lineItems,
      record: {
        source: "STORED",
        reason: null,
        storedSumCents: selection.storedSumCents,
        sharesSumCents: selection.sharesSumCents,
        billedCents: selection.billedCents,
        lineCount: lineItems.length,
        shareCount: selection.shares.length,
      },
    };
  } catch (err) {
    logger.error(
      { err, bookingId: args.bookingId, document: args.document, billedCents: args.billedCents },
      "Booking-edit document could not read or render its itemised lines; sending the single line",
    );
    return {
      lineItems: null,
      record: {
        source: "FALLBACK_SINGLE_LINE",
        reason: "NARRATION_UNAVAILABLE",
        storedSumCents: null,
        sharesSumCents: null,
        billedCents: args.billedCents,
        lineCount: 0,
        shareCount: 0,
      },
    };
  }
}
