import type { BookingCashCover } from "@/lib/booking-cash-evidence";
import type { ClubFormat } from "@/lib/club-format";
import { formatCents as formatMoneyCents } from "@/lib/utils";

/**
 * #4069 (`INV-PAY-159`): the approval email's payment line, one per cash-cover
 * answer. Composed by the sender, never conditionally in the body: the render
 * path has no conditional syntax, so a token that is sometimes empty must
 * arrive as a whole line or as nothing (see composeOptionalEmailLine).
 *
 * - owes: the amount, and a held-bed sentence that is true for this booking -
 *   a CONFIRMED booking on a bed-holding bank transfer holds its beds while it
 *   owes;
 * - covered: nothing;
 * - organiser pays: says so, and asks the member for nothing;
 * - unknown, or unread: the neutral line - no amount, no "paid" (owner
 *   decision 3, 16 Oct 2026).
 *
 * `amount` is the raw figure behind the line for an override: what is owed
 * when the records prove it (zero once covered), and empty when they cannot -
 * never "$0.00" for a balance nobody can vouch for.
 */
export function bookingPolicyExceptionApprovedPaymentNote(
  args: { cover: BookingCashCover | null; bedsHeld: boolean },
  format: ClubFormat,
): { paymentNote: string; amount: string } {
  const { cover } = args;
  switch (cover?.kind) {
    case "owes": {
      const amount = formatMoneyCents(cover.cents, format);
      return {
        amount,
        paymentNote: args.bedsHeld
          ? `There is ${amount} to pay on this booking. Your beds are held for now; open it from your account to pay or to see the payment details.`
          : `There is ${amount} to pay on this booking. Open it from your account to pay now — the beds are not held until it is paid.`,
      };
    }
    case "covered":
      return { amount: formatMoneyCents(0, format), paymentNote: "" };
    case "organiser_pays":
      return {
        amount: "",
        paymentNote: "Your group organiser pays for this stay.",
      };
    case "unknown":
    case undefined:
      return {
        amount: "",
        paymentNote:
          "To see whether anything is still to pay on this booking, open it from your account or contact the club.",
      };
  }
}

