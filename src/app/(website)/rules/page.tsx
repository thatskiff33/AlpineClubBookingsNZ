import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Club Rules & Info",
  description:
    "Tokoroa Alpine Club membership classes, lodge booking rules, tramping party rules, hut leader instructions, cancellation policy, and general information for members and guests.",
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
            Important information about membership, lodge bookings, tramping
            parties, and staying at the club lodge.
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
                <strong className="text-slate-800">Family membership:</strong> A
                family concession is granted to a family group living at the same
                address which consists of one or two adult members plus any
                nominated dependent children under the age of 13. Dependent
                children enjoy the same privileges as members and can transfer to
                youth membership upon reaching the age of 13. Cheaper than
                equivalent individual memberships and is the recommended option for
                families.
              </p>
              <p className="text-sm text-slate-500">
                Note: &quot;Reserved Membership&quot; was discontinued in May 2000.
              </p>
            </div>
          </div>

          {/* Tramping Party Rules */}
          <div>
            <h2 className="text-2xl font-bold text-slate-900 mb-4">
              Tramping Party Rules
            </h2>
            <div className="space-y-3 text-slate-600">
              <p>
                The following rules apply to organised club tramping trips:
              </p>
              <ol className="list-decimal pl-5 space-y-2">
                <li>
                  The Party Leader is responsible for the trip. Your co-operation,
                  good temper, and good manners are essential.
                </li>
                <li>
                  For the safety of all members, keep together at all times.
                </li>
                <li>
                  The Party Leader shall decide if trampers are adequately equipped
                  for the trip and may refuse to take people who are not. If in
                  doubt, ask.
                </li>
                <li>
                  Trip leaders will obtain permission, in advance, for access to
                  properties both private and state.
                </li>
                <li>
                  No dogs or firearms can be taken on trips unless prior permission
                  is given.
                </li>
                <li>
                  All members must notify the Party Leader in advance if intending
                  to go on their trip. The leader organises the transport and will
                  notify you of any variations from the advertised trips or times.
                  Travelling expenses are to be shared with the driver.
                </li>
              </ol>
              <p className="text-sm text-slate-500">
                The club is not responsible for accidents, however caused, although
                all due care and attention will be taken.
              </p>
            </div>
          </div>

          {/* Lodge booking rules */}
          <div>
            <h2 className="text-2xl font-bold text-slate-900 mb-4">
              Waldvogel Lodge Rules
            </h2>
            <div className="space-y-3 text-slate-600">
              <p>
                The lodge accommodates up to 29 guests per night. All guests must
                have a formal confirmed paid booking. The only exception is a work
                party, where the work party leader will make a group booking with
                the Booking Officer.
              </p>

              <h3 className="text-lg font-semibold text-slate-800 mt-6 mb-2">
                Bookings
              </h3>
              <ul className="list-disc pl-5 space-y-2">
                <li>
                  All bookings must be made via the website and paid for as soon as
                  they are confirmed.
                </li>
                <li>
                  <strong className="text-slate-800">Member bookings</strong> with
                  all-member guests are confirmed immediately upon payment.
                </li>
                <li>
                  <strong className="text-slate-800">
                    Bookings with non-member guests
                  </strong>{" "}
                  can only be confirmed 7 days before the start date of the
                  booking. Card details are collected but not charged until 7 days
                  before arrival.
                </li>
                <li>
                  <strong className="text-slate-800">Member priority:</strong> If
                  the lodge fills up, pending non-member bookings may be bumped to
                  make room for member bookings. Bumped bookings are not charged.
                </li>
                <li>
                  It is recommended that you book early, especially for school
                  holidays, to avoid disappointment.
                </li>
                <li>
                  The Booking Officer&apos;s decision on bookings is final. Any
                  complaints about bookings are to be made in writing to the
                  committee.
                </li>
              </ul>

              <h3 className="text-lg font-semibold text-slate-800 mt-6 mb-2">
                At the Lodge
              </h3>
              <ul className="list-disc pl-5 space-y-2">
                <li>
                  The Booking Officer shall appoint a senior member as the Hut
                  Leader for busy weekends. The Hut Leader is responsible for
                  opening and closing the lodge and overseeing start-up and
                  shut-down procedures.
                </li>
                <li>
                  Members must assist the Hut Leader by carrying out tasks which
                  may be assigned to them for the safety and good order of the
                  lodge.
                </li>
                <li>
                  Members should familiarise themselves with the emergency
                  evacuation procedures as noted on the notice board at the lodge.
                  No member shall be allowed to stay on their own until competent
                  in these procedures.
                </li>
                <li>
                  All members need to familiarise themselves with the lodge
                  start-up and shut-down procedures and learn how to check the
                  water tank levels and transfer the water pump to another tank if
                  needed.
                </li>
                <li>
                  As the lodge is totally dependent on rainwater for its water
                  supply, please conserve water at all times. Shower times should
                  be minimised and do not shower at the end of the day when
                  vacating the lodge.
                </li>
                <li>
                  Members must be prepared to collect any food or provisions that
                  the Booking Officer or Hut Leader may request them to collect.
                </li>
                <li>
                  Any keys provided shall be returned to the Booking Officer
                  promptly.
                </li>
              </ul>

              <h3 className="text-lg font-semibold text-slate-800 mt-6 mb-2">
                General Conduct
              </h3>
              <ul className="list-disc pl-5 space-y-2">
                <li>
                  Members under 18 are not permitted to stay at the lodge unless
                  accompanied by an adult member who accepts responsibility for
                  them.
                </li>
                <li>
                  All members must leave the lodge in a clean and tidy condition.
                </li>
                <li>Report any damage to the committee.</li>
                <li>
                  Failure to obey the club rules may result in the committee taking
                  disciplinary action against the member concerned. Serious
                  offences will result in termination of membership.
                </li>
              </ul>

              <h3 className="text-lg font-semibold text-slate-800 mt-6 mb-2">
                Working Bees
              </h3>
              <ul className="list-disc pl-5 space-y-2">
                <li>
                  Members are expected to take part in at least one official
                  working bee per year to assist with the maintenance of the lodge.
                </li>
                <li>
                  Members are credited with one night&apos;s free accommodation for
                  each weekend working bee that they attend.
                </li>
                <li>
                  Those members who are unable to attend an annual working bee are
                  expected to make a financial donation to the club&apos;s funds.
                </li>
              </ul>
            </div>
          </div>

          {/* Hut Leader Instructions */}
          <div>
            <h2 className="text-2xl font-bold text-slate-900 mb-4">
              Hut Leader Instructions
            </h2>
            <div className="space-y-3 text-slate-600">
              <p>
                Hut Leaders are appointed by the Booking Officer and committee to
                look after the lodge. All club members and visitors to the lodge
                are expected to co-operate with the Hut Leader in carrying out
                their duties.
              </p>

              <h3 className="text-lg font-semibold text-slate-800 mt-6 mb-2">
                General Responsibilities
              </h3>
              <ul className="list-disc pl-5 space-y-2">
                <li>
                  Checking that those staying at the lodge are on the list
                  provided by the Booking Officer.
                </li>
                <li>
                  Supervising the use of the club&apos;s supplies of food to avoid
                  waste.
                </li>
                <li>
                  Supervising the use of firewood, power, and water to avoid
                  waste.
                </li>
                <li>
                  Supervising the careful use of the building and club&apos;s
                  equipment.
                </li>
                <li>
                  Reporting damage and wants of repair to the committee.
                </li>
                <li>Allocating bunks if necessary.</li>
                <li>
                  Maintaining harmony amongst people staying at the lodge.
                </li>
              </ul>

              <h3 className="text-lg font-semibold text-slate-800 mt-6 mb-2">
                Specific Duties
              </h3>
              <ol className="list-decimal pl-5 space-y-2">
                <li>
                  Check incoming people with the Booking Officer&apos;s list.
                </li>
                <li>Allocate lodge duties daily.</li>
                <li>
                  Organise the collection of any food orders from the RAL store at
                  the Top of the Bruce.
                </li>
                <li>
                  Bring out food required and keep the storeroom locked.
                </li>
                <li>
                  Take stock of food and notify the Catering Officer before
                  handing over to the next Leader.
                </li>
                <li>Check that the fire alarm is working.</li>
                <li>
                  Stress fire danger and remind members to use the drying room and
                  not bedroom heaters for drying clothes.
                </li>
                <li>
                  Switch off bedroom heaters at the main each morning, and on
                  again each evening.
                </li>
                <li>
                  Ensure that the last person to bed checks that the building is
                  secure and electrical appliances are off.
                </li>
                <li>
                  Ensure the outside door of the ski room is locked at all times.
                </li>
                <li>
                  Ensure the water system is operative and check that water tanks
                  are full. If you are required to change tanks: remove the power
                  plug from the pump, unscrew the hose coupling, then lift out the
                  submersible pump. Take the pump to a full tank, hook up the pump
                  and connect the water hose and power. Make sure the directional
                  valve is open and the other two valves are closed.
                </li>
                <li>
                  If no members are staying on, ensure the water system is
                  emptied, doors and windows are locked, power is off, food and
                  rubbish is removed, and keys are returned to the Booking Officer.
                </li>
              </ol>
              <p className="text-sm text-slate-500 mt-3">
                Any member can expect to be asked to take on the duties of Hut
                Leader. Make yourself familiar with these duties so that you can
                take over when requested.
              </p>
            </div>
          </div>

          {/* Lodge Etiquette */}
          <div>
            <h2 className="text-2xl font-bold text-slate-900 mb-4">
              Lodge Etiquette
            </h2>
            <div className="space-y-3 text-slate-600">
              <p>
                A few practical reminders to help keep the lodge running smoothly
                for everyone:
              </p>
              <ul className="list-disc pl-5 space-y-2">
                <li>
                  If you see the entrance door open, close it.
                </li>
                <li>
                  If you use the drying room, leave the dehumidifier in the open
                  and close the door.
                </li>
                <li>
                  If you are vacating your bunkroom, turn off the heater, close
                  the window, and turn off the light.
                </li>
                <li>
                  If you are given a duty, please ensure it is carried out.
                </li>
                <li>
                  If you are leaving the lodge, consider whether you need to
                  shower &mdash; conserve water where possible.
                </li>
                <li>
                  If water is in short supply, conserve wisely.
                </li>
                <li>
                  If you do not intend to use food leftovers, please dispose of
                  them.
                </li>
                <li>
                  If you are vacating the lodge, please ensure you have all your
                  belongings.
                </li>
                <li>
                  Do not store equipment in the battery room &mdash; it will be
                  removed.
                </li>
                <li>
                  If you find a defect that you cannot easily repair, advise the
                  committee. If you have a suggestion to improve lodge life, notify
                  the committee.
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
