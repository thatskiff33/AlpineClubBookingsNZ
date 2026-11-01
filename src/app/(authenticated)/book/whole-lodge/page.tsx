import { memberWholeLodgeChoosesPaymentMethod } from "@/lib/booking-payment-flow";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { getMemberCreditBalance } from "@/lib/member-credit";
import { WholeLodgeRequestForm } from "./_components/whole-lodge-request-form";

export const metadata = {
  title: "Book the whole lodge",
};

/**
 * Member-facing whole-lodge request form (#2263).
 *
 * A separate page from the four-step booking wizard, which is untouched. It asks
 * for dates, an approximate headcount, who the group is and any notes — and
 * deliberately shows NO availability calendar, NO capacity pre-check, NO price
 * and NO quote. Each of those would answer "is the lodge free that week?", which
 * is the question a member may not be answered (ADR-001 decision 6).
 *
 * The one figure it does show is the member's OWN account-credit balance, so
 * they can ask for it to be put towards the booking if the request is
 * approved — the same election the ordinary review step offers. It is a fact
 * about the member, not about the calendar.
 */
export default async function WholeLodgeRequestPage() {
  const session = await auth();
  // The election is offered only when approval will leave the payment method
  // to the member (#4019); with either module off the approval keeps its
  // legacy shape and would ignore it, so it is not shown (the one rule:
  // `memberWholeLodgeChoosesPaymentMethod`).
  const offersCreditElection = memberWholeLodgeChoosesPaymentMethod(
    await loadEffectiveModuleFlags(),
  );
  const availableCreditCents =
    offersCreditElection && session?.user?.id
      ? await getMemberCreditBalance(session.user.id)
      : 0;
  return (
    <div className="max-w-2xl space-y-6">
      <div className="space-y-1">
        <Link
          href="/book"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          &larr; Back to Book a Stay
        </Link>
        <h1 className="text-3xl font-bold">Book the whole lodge</h1>
        <p className="text-muted-foreground">
          Planning a course, a club trip or a family gathering that needs the
          lodge to yourselves? Send the booking officer a request and they will
          come back to you.
        </p>
      </div>

      <WholeLodgeRequestForm availableCreditCents={availableCreditCents} />
    </div>
  );
}
