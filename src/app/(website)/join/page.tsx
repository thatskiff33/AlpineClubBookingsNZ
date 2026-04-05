import type { Metadata } from "next";
import Link from "next/link";
import { Users, UserPlus, Hammer, ClipboardCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { prisma } from "@/lib/prisma";
import { formatCents } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Join the Club",
  description:
    "How to become a member of the Tokoroa Alpine Club. Nomination by two existing members, entrance fee, induction process, and membership details.",
};

const membershipTypes = [
  {
    name: "Adult",
    description: "Ages 18 and over",
    features: [
      "Full lodge booking access at member rates",
      "Voting rights at AGM",
      "Can invite non-member guests to stay",
      "Access to working bees and club events",
    ],
  },
  {
    name: "Youth",
    description: "Ages 10 to 17",
    features: [
      "Reduced membership fee",
      "Member lodge rates",
      "Club event participation",
      "Must be accompanied by an adult member",
    ],
  },
  {
    name: "Child",
    description: "Under 10",
    features: [
      "Included with family membership",
      "Member lodge rates",
      "Must be accompanied by a parent/guardian",
      "No separate membership required",
    ],
  },
  {
    name: "Family",
    description: "Household group",
    features: [
      "Covers all family members in the household",
      "Cheaper than equivalent individual memberships",
      "Concessions for dependent children under 10",
      "One membership, one annual fee",
    ],
    highlighted: true,
  },
];

const steps = [
  {
    number: "1",
    icon: Users,
    title: "Visit as a Guest",
    description:
      "Get to know a current member and arrange to stay at the lodge as their guest. This gives you a chance to experience the club and see if it's a good fit.",
  },
  {
    number: "2",
    icon: UserPlus,
    title: "Get Nominated",
    description:
      "If you'd like to join, two existing members need to nominate you for membership. Your nominators vouch for you to the committee.",
  },
  {
    number: "3",
    icon: ClipboardCheck,
    title: "Pay Entrance Fee & Subscription",
    description:
      "Once approved, pay your one-off entrance fee and first year's annual subscription. Subscriptions run April to March and are invoiced through Xero.",
  },
  {
    number: "4",
    icon: Hammer,
    title: "Induction & First Stay",
    description:
      "Your sponsoring members must accompany you on your first stay to ensure you are inducted and signed off on all lodge procedures.",
  },
];

function getRate(
  rates: { ageTier: string; isMember: boolean; pricePerNightCents: number }[],
  ageTier: string,
  isMember: boolean
): string {
  const rate = rates.find(
    (r) => r.ageTier === ageTier && r.isMember === isMember
  );
  return rate ? `${formatCents(rate.pricePerNightCents)}/night` : "\u2014";
}

export default async function JoinPage() {
  const seasons = await prisma.season.findMany({
    where: { active: true },
    include: { rates: true },
    orderBy: { startDate: "asc" },
  });
  return (
    <>
      {/* Header */}
      <section className="bg-gradient-to-br from-slate-800 to-slate-900 text-white py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            Becoming a Member
          </h1>
          <p className="mt-4 text-lg text-slate-300 max-w-2xl">
            The Tokoroa Alpine Club is a members&apos; club. New members are
            nominated by existing members and welcomed into the club community.
          </p>
        </div>
      </section>

      {/* How to join steps */}
      <section className="bg-white py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 className="text-2xl font-bold text-slate-900">
              How to Join
            </h2>
            <p className="mt-3 text-slate-600 max-w-2xl mx-auto">
              Membership is by nomination. Here&apos;s how the process works.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {steps.map((step) => (
              <Card key={step.number} className="border-slate-200 relative">
                <CardContent className="pt-6">
                  <div className="flex items-center gap-3 mb-3">
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-100 text-blue-700 font-bold text-sm">
                      {step.number}
                    </span>
                    <step.icon className="h-5 w-5 text-blue-600" />
                  </div>
                  <h3 className="font-semibold text-slate-900 mb-2">
                    {step.title}
                  </h3>
                  <p className="text-sm text-slate-600">{step.description}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Working bee expectations */}
      <section className="bg-blue-50 py-12 sm:py-16">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8 text-center">
          <Hammer className="h-8 w-8 text-blue-600 mx-auto mb-4" />
          <h2 className="text-xl font-bold text-slate-900 mb-3">
            Working Bee Commitment
          </h2>
          <p className="text-slate-600">
            New members are expected to attend at least two working bees during
            their first three years of membership. Working bees are how we
            maintain the lodge and are a great way to get to know fellow
            members. Members are credited with one night&apos;s free
            accommodation for each weekend working bee they attend.
          </p>
        </div>
      </section>

      {/* Membership types */}
      <section className="bg-white py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 className="text-2xl font-bold text-slate-900">
              Membership Types
            </h2>
            <p className="mt-3 text-slate-600 max-w-2xl mx-auto">
              Family membership is encouraged and works out cheaper than
              equivalent individual memberships.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {membershipTypes.map((type) => (
              <Card
                key={type.name}
                className={
                  type.highlighted
                    ? "border-blue-300 ring-2 ring-blue-100"
                    : "border-slate-200"
                }
              >
                <CardHeader>
                  {type.highlighted && (
                    <span className="text-xs font-semibold text-blue-600 uppercase tracking-wide mb-1">
                      Most Popular
                    </span>
                  )}
                  <CardTitle className="text-lg">{type.name}</CardTitle>
                  <p className="text-sm text-slate-500">{type.description}</p>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-2">
                    {type.features.map((feature) => (
                      <li
                        key={feature}
                        className="flex items-start gap-2 text-sm text-slate-600"
                      >
                        <span className="text-blue-600 mt-0.5 shrink-0">&#10003;</span>
                        {feature}
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Lodge Rates */}
      {seasons.length > 0 && (
        <section className="bg-slate-50 py-16 sm:py-20">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="text-center mb-12">
              <h2 className="text-2xl font-bold text-slate-900">
                Lodge Rates
              </h2>
              <p className="mt-3 text-slate-600 max-w-2xl mx-auto">
                Nightly rates per person. Members enjoy significantly lower
                rates. Non-member guests must be accompanied by a member.
              </p>
            </div>
            <div className="space-y-8">
              {seasons.map((season) => (
                <div key={season.id}>
                  <h3 className="text-lg font-semibold text-slate-800 mb-3">
                    {season.name}
                    <span className="text-sm font-normal text-slate-500 ml-2">
                      {new Date(season.startDate).toLocaleDateString("en-NZ", {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })}
                      {" \u2013 "}
                      {new Date(season.endDate).toLocaleDateString("en-NZ", {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })}
                    </span>
                  </h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm border border-slate-200 rounded-lg overflow-hidden">
                      <thead className="bg-white">
                        <tr>
                          <th className="text-left px-4 py-2 font-semibold text-slate-700">
                            Age Group
                          </th>
                          <th className="text-left px-4 py-2 font-semibold text-slate-700">
                            Member Rate
                          </th>
                          <th className="text-left px-4 py-2 font-semibold text-slate-700">
                            Non-Member Guest Rate
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr className="border-t border-slate-200">
                          <td className="px-4 py-2 font-medium text-slate-800">
                            Adult (18+)
                          </td>
                          <td className="px-4 py-2 text-blue-700 font-medium">
                            {getRate(season.rates, "ADULT", true)}
                          </td>
                          <td className="px-4 py-2">
                            {getRate(season.rates, "ADULT", false)}
                          </td>
                        </tr>
                        <tr className="border-t border-slate-200">
                          <td className="px-4 py-2 font-medium text-slate-800">
                            Youth (10\u201317)
                          </td>
                          <td className="px-4 py-2 text-blue-700 font-medium">
                            {getRate(season.rates, "YOUTH", true)}
                          </td>
                          <td className="px-4 py-2">
                            {getRate(season.rates, "YOUTH", false)}
                          </td>
                        </tr>
                        <tr className="border-t border-slate-200">
                          <td className="px-4 py-2 font-medium text-slate-800">
                            Child (under 10)
                          </td>
                          <td className="px-4 py-2 text-blue-700 font-medium">
                            {getRate(season.rates, "CHILD", true)}
                          </td>
                          <td className="px-4 py-2">
                            {getRate(season.rates, "CHILD", false)}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Interested CTA */}
      <section className="bg-slate-50 py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="max-w-3xl mx-auto text-center">
            <Users className="h-10 w-10 text-blue-600 mx-auto mb-4" />
            <h2 className="text-2xl font-bold text-slate-900 mb-4">
              Interested in Joining?
            </h2>
            <p className="text-slate-600 mb-4">
              If you don&apos;t know any current members, get in touch and
              we can help connect you. We&apos;re always happy to hear from
              people who share a love of the mountains.
            </p>
            <p className="text-slate-600 mb-8">
              Annual subscriptions run from April to March and are managed
              through Xero invoicing. Members must have a current subscription
              to book at member rates.
            </p>
            <div className="flex flex-wrap gap-4 justify-center">
              <Button size="lg" asChild>
                <Link href="/contact">Contact Us</Link>
              </Button>
              <Button size="lg" variant="outline" asChild>
                <Link href="/about">About the Club</Link>
              </Button>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
