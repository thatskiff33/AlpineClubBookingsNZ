import type { Metadata } from "next";
import Link from "next/link";
import { CLUB_NAME } from "@/config/club-identity";
import { APP_CURRENCY } from "@/config/operational";
import { getLodgeCapacity } from "@/lib/lodge-capacity";

export const metadata: Metadata = {
  title: "Terms of Service",
  description:
    `Terms of service for the ${CLUB_NAME} booking and membership system, covering booking rules, payment, cancellation, and liability.`,
};

const LAST_UPDATED = "1 April 2026";
const EFFECTIVE_DATE = "1 April 2026";

export default async function TermsPage() {
  const lodgeCapacity = await getLodgeCapacity();

  return (
    <>
      <section className="bg-gradient-to-br from-brand-charcoal to-brand-deep py-16 text-brand-snow sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <span className="website-eyebrow mb-4">Policy</span>
          <h1 className="font-heading text-4xl font-bold tracking-tight sm:text-5xl">
            Terms of Service
          </h1>
          <p className="mt-4 max-w-2xl text-lg text-brand-snow/80">
            Please read these terms carefully before using the booking system.
          </p>
          <p className="mt-2 text-sm text-brand-snow/60">
            Effective {EFFECTIVE_DATE} &mdash; Last updated {LAST_UPDATED}
          </p>
        </div>
      </section>

      <section className="bg-brand-snow py-16 sm:py-20">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
          <div className="website-legal-copy">

            <div>
              <h2>1. Agreement to Terms</h2>
              <p>
                By registering an account or using the {CLUB_NAME} Incorporated
                (&ldquo;we&rdquo;, &ldquo;us&rdquo;, &ldquo;our&rdquo;) booking and membership system (&ldquo;the System&rdquo;), you agree to be bound
                by these Terms of Service. If you do not agree, do not use the System.
              </p>
              <p className="mt-3">
                These terms apply to all users of the System, including club members, non-member
                guests, and any other visitors.
              </p>
            </div>

            <div>
              <h2>2. Eligibility</h2>
              <ul className="list-disc pl-6 space-y-2">
                <li>You must be 18 years or older to create an account.</li>
                <li>
                  Children and youth members must be managed by a parent or guardian who holds an
                  account.
                </li>
                <li>
                  Membership is subject to approval by the {CLUB_NAME} committee. Creating an account does not
                  constitute membership.
                </li>
                <li>
                  You must provide accurate and truthful information when registering. False information
                  may result in account suspension.
                </li>
              </ul>
            </div>

            <div>
              <h2>3. Booking Rules</h2>
              <ul className="list-disc pl-6 space-y-2">
                <li>
                  Lodge bookings are for accommodation at Waldvogel Lodge, Iwikau Village, Mt Ruapehu.
                  The lodge sleeps a maximum of {lodgeCapacity} guests.
                </li>
                <li>
                  Bookings must be made through the System. Verbal or informal bookings are not accepted.
                </li>
                <li>
                  Members may book for themselves and invite non-member guests. The booking member must
                  be present during the stay of any non-member guests.
                </li>
                <li>
                  Non-member bookings more than 7 days in advance are held as &ldquo;Pending&rdquo; and may be
                  bumped if capacity is required for member bookings. See Section 5 for details.
                </li>
                <li>
                  All guests must participate in the lodge chore roster. Chore assignments are
                  allocated by the hut leader for each night.
                </li>
                <li>
                  Guests must treat the lodge, equipment, and other guests with respect. The committee
                  reserves the right to refuse future bookings to guests who cause damage or behave
                  inappropriately.
                </li>
                <li>
                  The lodge is a shared facility. Quiet hours are from 10pm to 7am. Alcohol consumption
                  must be responsible and is not permitted in common areas after quiet hours.
                </li>
              </ul>
            </div>

            <div>
              <h2>4. Payment Terms</h2>
              <ul className="list-disc pl-6 space-y-2">
                <li>
                  Lodge accommodation fees are charged per person per night based on age group and
                  membership status. Current rates are published on the{" "}
                  <Link href="/join" className="website-link">
                    Join page
                  </Link>
                  .
                </li>
                <li>
                  For confirmed bookings (members only, or bookings within 7 days of check-in), payment
                  is collected immediately via Stripe at the time of booking.
                </li>
                <li>
                  For pending bookings (non-member guests, more than 7 days in advance), a payment
                  method is saved but not charged until the booking is confirmed approximately 7 days
                  before check-in.
                </li>
                <li>
                  Annual membership subscriptions are invoiced separately through Xero and must be
                  current to access member booking rates.
                </li>
                <li>
                  All prices are in {APP_CURRENCY} inclusive of GST where applicable.
                </li>
                <li>
                  Payment processing is handled by Stripe. {CLUB_NAME} does not store credit card details.
                </li>
              </ul>
            </div>

            <div>
              <h2>5. Non-Member Priority System</h2>
              <p>
                The {CLUB_NAME} is a members&apos; club. Members have priority access to the lodge.
                The following rules apply to bookings that include non-member guests:
              </p>
              <ul className="list-disc pl-6 mt-3 space-y-2">
                <li>
                  Bookings including non-members made more than 7 days before check-in are held as
                  &ldquo;Pending&rdquo;.
                </li>
                <li>
                  If a member booking requires capacity that a pending non-member booking occupies, the
                  most recently made pending bookings are cancelled (&ldquo;bumped&rdquo;) until sufficient capacity
                  is available.
                </li>
                <li>
                  Bumped bookings receive a full refund and immediate email notification.
                </li>
                <li>
                  {CLUB_NAME} accepts no liability for costs incurred by guests (e.g. travel, equipment hire)
                  as a result of a booking being bumped.
                </li>
              </ul>
            </div>

            <div>
              <h2>6. Cancellation and Refunds</h2>
              <p>
                Refunds are calculated based on the cancellation policy set by the {CLUB_NAME} committee.
                Current tiers are shown on the{" "}
                <Link href="/rules" className="website-link">
                  Club Rules
                </Link>{" "}
                page. General principles:
              </p>
              <ul className="list-disc pl-6 mt-3 space-y-2">
                <li>Cancellations with 14 or more days&apos; notice: full refund.</li>
                <li>Cancellations with 7 to 13 days&apos; notice: partial refund (as per current policy).</li>
                <li>Cancellations with less than 7 days&apos; notice: no refund.</li>
                <li>
                  A change fee may apply to date modifications made within the late-notice period.
                </li>
                <li>
                  Refunds are processed to the original payment method within 5&ndash;10 business days.
                </li>
                <li>
                  {CLUB_NAME} reserves the right to cancel a booking due to circumstances beyond our control
                  (e.g. natural disaster, lodge damage) and will provide a full refund in such cases.
                </li>
              </ul>
            </div>

            <div>
              <h2>7. Member Conduct</h2>
              <ul className="list-disc pl-6 space-y-2">
                <li>
                  You are responsible for the conduct of all guests on your booking.
                </li>
                <li>
                  You must not make bookings on behalf of others without their knowledge and consent.
                </li>
                <li>
                  Any damage to lodge property caused by you or your guests may be invoiced to you.
                </li>
                <li>
                  Abuse of the booking system (e.g. making and cancelling bookings repeatedly to block
                  dates) may result in account suspension.
                </li>
                <li>
                  New members must attend their first stay accompanied by their nominating members for
                  lodge induction.
                </li>
              </ul>
            </div>

            <div>
              <h2>8. Account Security</h2>
              <ul className="list-disc pl-6 space-y-2">
                <li>
                  You are responsible for keeping your account credentials confidential. Do not share
                  your password with others.
                </li>
                <li>
                  If you suspect your account has been compromised, change your password immediately and
                  contact us.
                </li>
                <li>
                  {CLUB_NAME} accepts no liability for losses resulting from unauthorised access to your account
                  due to your failure to maintain credential security.
                </li>
              </ul>
            </div>

            <div>
              <h2>9. Limitation of Liability</h2>
              <p>
                The {CLUB_NAME} is a volunteer-run, not-for-profit organisation. To the maximum
                extent permitted by New Zealand law:
              </p>
              <ul className="list-disc pl-6 mt-3 space-y-2">
                <li>
                  The System is provided &ldquo;as is&rdquo; without warranties of any kind, express or implied.
                </li>
                <li>
                  {CLUB_NAME} is not liable for any indirect, incidental, or consequential losses arising from
                  use of the System or the lodge.
                </li>
                <li>
                  {CLUB_NAME} is not responsible for personal injury, loss of property, or other incidents
                  occurring during your lodge stay. All guests are advised to hold appropriate personal
                  insurance.
                </li>
                <li>
                  Nothing in these terms excludes any rights you may have under the Consumer Guarantees
                  Act 1993 or the Fair Trading Act 1986.
                </li>
              </ul>
            </div>

            <div>
              <h2>10. Account Suspension and Termination</h2>
              <ul className="list-disc pl-6 space-y-2">
                <li>
                  {CLUB_NAME} may suspend or terminate an account for breach of these terms, unpaid membership
                  fees, or conduct that is harmful to the club or other members.
                </li>
                <li>
                  You may request deletion of your account from your Profile page. Deletion will cancel
                  any future bookings (with refunds per the cancellation policy) and anonymise your
                  personal data. Financial records required by law are retained.
                </li>
                <li>
                  Admin accounts cannot be deleted by the account holder &mdash; contact another
                  administrator.
                </li>
              </ul>
            </div>

            <div>
              <h2>11. Changes to These Terms</h2>
              <p>
                {CLUB_NAME} may update these Terms of Service from time to time. We will update the &ldquo;Last
                updated&rdquo; date at the top of this page. Continued use of the System after any changes
                constitutes acceptance of the updated terms.
              </p>
            </div>

            <div>
              <h2>12. Governing Law</h2>
              <p>
                These terms are governed by the laws of New Zealand. Any disputes will be subject to
                the exclusive jurisdiction of the New Zealand courts.
              </p>
            </div>

            <div>
              <h2>13. Contact Us</h2>
              <p>
                For questions about these terms, please{" "}
                <Link href="/contact" className="website-link">
                  contact us
                </Link>
                .
              </p>
            </div>

          </div>
        </div>
      </section>
    </>
  );
}
