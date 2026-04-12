import type { Metadata } from "next";
import Link from "next/link";
import { Users, UserPlus, Hammer, ClipboardCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { prisma } from "@/lib/prisma";
import { formatCents } from "@/lib/utils";
import { AGE_TIER_DEFAULTS } from "@/lib/age-tier";

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
  const [seasons, ageTierSettings] = await Promise.all([
    prisma.season.findMany({
      where: { active: true },
      include: { rates: true },
      orderBy: { startDate: "asc" },
    }),
    prisma.ageTierSetting
      .findMany({ orderBy: { sortOrder: "asc" } })
      .catch(() => AGE_TIER_DEFAULTS),
  ]);
  return (
    <>
      {/* Header */}
      <section className="bg-gradient-to-br from-brand-charcoal to-brand-deep py-16 text-brand-snow sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <span className="website-eyebrow mb-4">Membership</span>
          <h1 className="font-heading text-4xl font-bold tracking-tight sm:text-5xl">
            Becoming a Member
          </h1>
          <p className="mt-4 max-w-2xl text-lg text-brand-snow/80">
            The Tokoroa Alpine Club is a members&apos; club. New members are
            nominated by existing members and welcomed into the club community.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild size="lg" className="bg-brand-gold text-brand-charcoal hover:bg-brand-gold/90">
              <Link href="/join/apply">Apply for Membership</Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="border-brand-snow/30 bg-transparent text-brand-snow hover:bg-brand-snow/10">
              <Link href="/contact">Talk to the Committee</Link>
            </Button>
          </div>
        </div>
      </section>

      {/* How to join steps */}
      <section className="bg-brand-snow py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <span className="website-eyebrow mb-4">Step by step</span>
            <h2 className="font-heading text-2xl font-bold text-brand-charcoal">
              How to Join
            </h2>
            <p className="mx-auto mt-3 max-w-2xl text-brand-deep/78">
              Membership is by nomination. Here&apos;s how the process works.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {steps.map((step) => (
              <Card
                key={step.number}
                className="relative border-brand-ridge/20 bg-brand-snow/90 shadow-[0_22px_46px_-34px_rgba(47,47,43,0.38)]"
              >
                <CardContent className="pt-6">
                  <div className="flex items-center gap-3 mb-3">
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-gold text-brand-charcoal font-bold text-sm">
                      {step.number}
                    </span>
                    <step.icon className="h-5 w-5 text-brand-charcoal" />
                  </div>
                  <h3 className="mb-2 font-heading text-lg font-semibold text-brand-charcoal">
                    {step.title}
                  </h3>
                  <p className="text-sm text-brand-deep/75">{step.description}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Working bee expectations */}
      <section className="bg-brand-charcoal py-12 text-brand-snow sm:py-16">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8 text-center">
          <Hammer className="mx-auto mb-4 h-8 w-8 text-brand-gold" />
          <h2 className="mb-3 font-heading text-xl font-bold text-brand-snow">
            Working Bee Commitment
          </h2>
          <p className="text-brand-snow/78">
            New members are expected to attend at least two working bees during
            their first three years of membership. Working bees are how we
            maintain the lodge and are a great way to get to know fellow
            members. Members are credited with one night&apos;s free
            accommodation for each weekend working bee they attend.
          </p>
        </div>
      </section>

      {/* Membership types */}
      <section className="bg-brand-snow py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <span className="website-eyebrow mb-4">Membership options</span>
            <h2 className="font-heading text-2xl font-bold text-brand-charcoal">
              Membership Types
            </h2>
            <p className="mx-auto mt-3 max-w-2xl text-brand-deep/78">
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
                    ? "border-brand-gold bg-brand-gold/10 ring-1 ring-brand-gold/30"
                    : "border-brand-ridge/20 bg-brand-snow/90"
                }
              >
                <CardHeader>
                  {type.highlighted && (
                    <span className="mb-1 text-xs font-semibold uppercase tracking-[0.2em] text-brand-charcoal">
                      Most Popular
                    </span>
                  )}
                  <CardTitle className="font-heading text-lg text-brand-charcoal">{type.name}</CardTitle>
                  <p className="text-sm text-brand-deep/65">{type.description}</p>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-2">
                    {type.features.map((feature) => (
                      <li
                        key={feature}
                        className="flex items-start gap-2 text-sm text-brand-deep/75"
                      >
                        <span className="mt-0.5 shrink-0 text-brand-gold">&#10003;</span>
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
        <section className="bg-brand-mist/55 py-16 sm:py-20">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="text-center mb-12">
              <span className="website-eyebrow mb-4">Current pricing</span>
              <h2 className="font-heading text-2xl font-bold text-brand-charcoal">
                Lodge Rates
              </h2>
              <p className="mx-auto mt-3 max-w-2xl text-brand-deep/78">
                Nightly rates per person. Members enjoy significantly lower
                rates. Non-member guests must be accompanied by a member.
              </p>
            </div>
            <div className="space-y-8">
              {seasons.map((season) => (
                <div key={season.id}>
                  <h3 className="mb-3 font-heading text-lg font-semibold text-brand-charcoal">
                    {season.name}
                    <span className="ml-2 text-sm font-normal text-brand-deep/65">
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
                    <table className="website-data-table">
                      <thead>
                        <tr>
                          <th>
                            Age Group
                          </th>
                          <th>
                            Member Rate
                          </th>
                          <th>
                            Non-Member Guest Rate
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {ageTierSettings.map((tier) => (
                          <tr key={tier.tier}>
                            <td className="font-medium text-brand-charcoal">
                              {tier.label}
                            </td>
                            <td className="font-semibold text-brand-charcoal">
                              {getRate(season.rates, tier.tier, true)}
                            </td>
                            <td>
                              {getRate(season.rates, tier.tier, false)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {season.type === "WINTER" ? (
                      <p className="mt-3 text-sm text-brand-deep/75">
                        <span className="font-semibold text-brand-charcoal">Catered:</span>{" "}
                        Winter stays include breakfast and dinner in the nightly rate.
                      </p>
                    ) : (
                      <p className="mt-3 text-sm text-brand-deep/75">
                        <span className="font-semibold text-brand-charcoal">Self-catered:</span>{" "}
                        Summer stays have kitchen facilities available; meals are not included.
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Interested CTA */}
      <section className="bg-brand-snow py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="max-w-3xl mx-auto text-center">
            <Users className="mx-auto mb-4 h-10 w-10 text-brand-gold" />
            <h2 className="mb-4 font-heading text-2xl font-bold text-brand-charcoal">
              Interested in Joining?
            </h2>
            <p className="mb-4 text-brand-deep/78">
              If you don&apos;t know any current members, get in touch and
              we can help connect you. We&apos;re always happy to hear from
              people who share a love of the mountains.
            </p>
            <p className="mb-8 text-brand-deep/78">
              Annual subscriptions run from April to March and are managed
              through Xero invoicing. Members must have a current subscription
              to book at member rates.
            </p>
            <div className="flex flex-wrap gap-4 justify-center">
              <Button size="lg" asChild>
                <Link href="/contact">Contact Us</Link>
              </Button>
              <Button
                size="lg"
                variant="outline"
                asChild
                className="border-brand-charcoal/20 bg-transparent text-brand-charcoal hover:bg-brand-mist/45 hover:text-brand-charcoal"
              >
                <Link href="/about">About the Club</Link>
              </Button>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
