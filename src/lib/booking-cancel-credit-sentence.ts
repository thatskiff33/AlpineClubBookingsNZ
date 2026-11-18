// The cancel narrative's returned-credit sentence, moved verbatim from
// `booking-cancel.ts` to keep that file under its size ceiling (#5145).
import type { ClubFormat } from "@/lib/club-format";
import { formatCents } from "@/lib/utils";

// #1547: every cancel branch that restores applied credit appends this line to
// the CANCELLED narrative event when a positive amount was returned, so the
// member/admin story reflects the restore. Money stays in cents internally; the
// sentence renders the club's configured currency (#3325).
export function appendReturnedCreditSentence(
  reason: string,
  creditRestoredCents: number,
  format: ClubFormat,
): string {
  return creditRestoredCents > 0
    ? `${reason} ${formatCents(creditRestoredCents, format)} of applied account credit was returned.`
    : reason;
}
