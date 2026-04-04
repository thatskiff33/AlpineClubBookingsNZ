import type { Metadata } from "next";
import Link from "next/link";
import { Users, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = {
  title: "Join the Club",
  description:
    "Join the Tokoroa Alpine Club. Family memberships available with concessions for children under 13. Enjoy the lowest lodge fees on Mt Ruapehu.",
};

const membershipTypes = [
  {
    name: "Adult",
    description: "Ages 18 and over",
    features: [
      "Lowest nightly lodge rates",
      "Online booking with instant confirmation",
      "Voting rights at AGM",
      "Access to working bees and club events",
    ],
  },
  {
    name: "Youth",
    description: "Ages 13 to 17",
    features: [
      "Reduced membership fee",
      "Member lodge rates",
      "Club event participation",
      "Must be accompanied by an adult member",
    ],
  },
  {
    name: "Child",
    description: "Under 13",
    features: [
      "Free with family membership",
      "Member lodge rates",
      "Must be accompanied by a parent/guardian",
      "No separate membership required",
    ],
  },
  {
    name: "Family",
    description: "Household group",
    features: [
      "Cheaper than equivalent individual memberships",
      "Covers all family members in the household",
      "Concessions for dependent children under 13",
      "One membership, one annual fee",
    ],
    highlighted: true,
  },
];

export default function JoinPage() {
  return (
    <>
      {/* Header */}
      <section className="bg-gradient-to-br from-slate-800 to-slate-900 text-white py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            Join the Club
          </h1>
          <p className="mt-4 text-lg text-slate-300 max-w-2xl">
            Become a member and enjoy the lowest lodge rates on Mt Ruapehu, plus
            access to club events and working bees.
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
                  {/* TODO: Add actual fee amounts once confirmed with committee */}
                  <ul className="space-y-2">
                    {type.features.map((feature) => (
                      <li
                        key={feature}
                        className="flex items-start gap-2 text-sm text-slate-600"
                      >
                        <Check className="h-4 w-4 text-blue-600 mt-0.5 shrink-0" />
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

      {/* How to join */}
      <section className="bg-slate-50 py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="max-w-3xl mx-auto text-center">
            <Users className="h-10 w-10 text-blue-600 mx-auto mb-4" />
            <h2 className="text-2xl font-bold text-slate-900 mb-4">
              How to Join
            </h2>
            <p className="text-slate-600 mb-8">
              Register for an account online and your membership will be set up
              for the current season. Annual subscriptions run from April to March
              and are managed through Xero.
            </p>
            <div className="flex flex-wrap gap-4 justify-center">
              <Button size="lg" asChild>
                <Link href="/register">Register Online</Link>
              </Button>
              <Button size="lg" variant="outline" asChild>
                <Link href="/contact">Contact Us</Link>
              </Button>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
