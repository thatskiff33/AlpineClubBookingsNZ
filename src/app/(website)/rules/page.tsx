import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Club Rules & Info",
  description:
    "Tokoroa Alpine Club membership classes, lodge booking rules, cancellation policy, and general information for members and guests.",
};

export default function RulesPage() {
  return (
    <>
      {/* Header */}
      <section className="bg-gradient-to-br from-slate-800 to-slate-900 text-white py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            Club Rules & Info
          </h1>
          <p className="mt-4 text-lg text-slate-300 max-w-2xl">
            Important information about membership, lodge bookings, and staying at
            the club lodge.
          </p>
        </div>
      </section>

      {/* Content */}
      <section className="bg-white py-16 sm:py-20">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8 space-y-12">
          {/* Membership classes */}
          <div>
            <h2 className="text-2xl font-bold text-slate-900 mb-4">
              Membership Classes
            </h2>
            <div className="space-y-3 text-slate-600">
              <p>
                <strong className="text-slate-800">Adult members:</strong> Aged 18
                years and over. Full voting rights at the AGM.
              </p>
              <p>
                <strong className="text-slate-800">Youth members:</strong> Aged 13
                to 17 years. Reduced membership fee. Must be accompanied by an
                adult member when staying at the lodge.
              </p>
              <p>
                <strong className="text-slate-800">Child members:</strong> Under 13
                years. Included as part of a family membership at no additional
                cost. Must be accompanied by a parent or guardian.
              </p>
              <p>
                <strong className="text-slate-800">Family membership:</strong>{" "}
                Covers all members of a household. Cheaper than equivalent
                individual memberships and is the recommended option for families.
              </p>
              <p className="text-sm text-slate-500">
                Note: &quot;Reserved Membership&quot; was discontinued in May 2000.
              </p>
            </div>
          </div>

          {/* Lodge booking rules */}
          <div>
            <h2 className="text-2xl font-bold text-slate-900 mb-4">
              Lodge Booking Rules
            </h2>
            <div className="space-y-3 text-slate-600">
              <p>
                The lodge accommodates up to 29 guests per night. Bookings are
                capacity-based (not room-based) and managed through the online
                booking system.
              </p>
              <ul className="list-disc pl-5 space-y-2">
                <li>
                  <strong className="text-slate-800">Member bookings</strong> with
                  all-member guests are confirmed immediately upon payment.
                </li>
                <li>
                  <strong className="text-slate-800">
                    Bookings with non-member guests
                  </strong>{" "}
                  made more than 7 days before check-in are held as pending. Card
                  details are collected but not charged until 7 days before arrival.
                </li>
                <li>
                  <strong className="text-slate-800">Member priority:</strong> If
                  the lodge fills up, pending non-member bookings may be bumped to
                  make room for member bookings. Bumped bookings are not charged.
                </li>
                <li>
                  Members can change or cancel bookings up to 14 days before their
                  stay for a full refund.
                </li>
                <li>
                  The Booking Officer reviews non-member bookings and confirms
                  availability 7 days before the stay.
                </li>
              </ul>
            </div>
          </div>

          {/* Cancellation policy */}
          <div>
            <h2 className="text-2xl font-bold text-slate-900 mb-4">
              Cancellation Policy
            </h2>
            <div className="space-y-3 text-slate-600">
              <p>Refunds for confirmed bookings are based on notice given:</p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm border border-slate-200 rounded-lg overflow-hidden">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="text-left px-4 py-2 font-semibold text-slate-700">
                        Notice Period
                      </th>
                      <th className="text-left px-4 py-2 font-semibold text-slate-700">
                        Refund
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-t border-slate-200">
                      <td className="px-4 py-2">14 or more days before stay</td>
                      <td className="px-4 py-2">100% refund</td>
                    </tr>
                    <tr className="border-t border-slate-200">
                      <td className="px-4 py-2">7 to 13 days before stay</td>
                      <td className="px-4 py-2">50% refund</td>
                    </tr>
                    <tr className="border-t border-slate-200">
                      <td className="px-4 py-2">Less than 7 days before stay</td>
                      <td className="px-4 py-2">No refund</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="text-sm text-slate-500">
                Cancellation policy is configured by the committee and may change.
                The policy at the time of booking applies.
              </p>
            </div>
          </div>

          {/* General conduct */}
          <div>
            <h2 className="text-2xl font-bold text-slate-900 mb-4">
              Lodge Conduct
            </h2>
            <div className="space-y-3 text-slate-600">
              <ul className="list-disc pl-5 space-y-2">
                <li>
                  All guests are expected to participate in daily chores as
                  assigned by the roster system.
                </li>
                <li>
                  Leave the lodge clean and tidy for the next guests. Clean up
                  after yourself in the kitchen and common areas.
                </li>
                <li>
                  Children must be supervised by their parent or guardian at all
                  times.
                </li>
                <li>
                  Respect other guests &mdash; keep noise to reasonable levels,
                  especially after 10 PM.
                </li>
                <li>
                  Report any damage or maintenance issues to the committee.
                </li>
              </ul>
            </div>
          </div>

          {/* Subscriptions */}
          <div>
            <h2 className="text-2xl font-bold text-slate-900 mb-4">
              Annual Subscriptions
            </h2>
            <div className="space-y-3 text-slate-600">
              <p>
                The club&apos;s financial year runs from April to March.
                Subscriptions are due at the start of each season and are managed
                through Xero invoicing.
              </p>
              <p>
                Members must have a current subscription to book at member rates.
                Unpaid members may still book as non-member guests at the standard
                rate.
              </p>
              <p>
                For questions about your membership or subscription status,{" "}
                <Link href="/contact" className="text-blue-600 hover:underline">
                  contact the club
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
