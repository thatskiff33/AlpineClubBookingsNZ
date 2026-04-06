import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Committee",
  description:
    "Meet the Tokoroa Alpine Club committee members who volunteer their time to run the club and maintain the lodge.",
};

interface CommitteeMember {
  role: string;
  name: string;
  description?: string;
}

// TODO: Update with full committee list from club
const committeeMembers: CommitteeMember[] = [
  {
    role: "President",
    name: "TBC",
    description: "Chairs meetings and oversees club operations.",
  },
  {
    role: "Vice President",
    name: "TBC",
    description: "Supports the President and stands in when required.",
  },
  {
    role: "Secretary",
    name: "TBC",
    description: "Manages club correspondence and meeting minutes.",
  },
  {
    role: "Treasurer",
    name: "TBC",
    description: "Manages club finances, subscriptions, and accounts.",
  },
  {
    role: "Booking Officer",
    name: "Chris Duyvestyn",
    description:
      "Manages lodge bookings, confirms non-member stays, and handles booking enquiries.",
  },
  {
    role: "Communications Officer",
    name: "Wayne Peterson",
    description:
      "Manages club communications, newsletters, and public information.",
  },
  {
    role: "Lodge Maintenance",
    name: "TBC",
    description:
      "Coordinates lodge maintenance, working bees, and improvement projects.",
  },
  {
    role: "Committee Member",
    name: "TBC",
    description: "General committee member.",
  },
];

export default function CommitteePage() {
  return (
    <>
      {/* Header */}
      <section className="bg-gradient-to-br from-slate-800 to-slate-900 text-white py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            Committee
          </h1>
          <p className="mt-4 text-lg text-slate-300 max-w-2xl">
            The club is run entirely by volunteers. Meet the committee members
            who keep things going.
          </p>
        </div>
      </section>

      {/* Committee list */}
      <section className="bg-white py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {committeeMembers.map((member) => (
              <Card key={member.role} className="border-slate-200">
                <CardContent className="pt-6">
                  <p className="text-xs font-semibold text-blue-600 uppercase tracking-wide mb-1">
                    {member.role}
                  </p>
                  <h3 className="font-semibold text-slate-900 text-lg">
                    {member.name}
                  </h3>
                  {member.description && (
                    <p className="text-sm text-slate-600 mt-2">
                      {member.description}
                    </p>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Contact CTA */}
      <section className="bg-slate-50 py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 text-center sm:px-6 lg:px-8">
          <h2 className="text-2xl font-bold text-slate-900 mb-4">
            Get in Touch
          </h2>
          <p className="text-slate-600 mb-8 max-w-xl mx-auto">
            Have a question for the committee? Want to volunteer or get involved
            with the club?
          </p>
          <Button size="lg" asChild>
            <Link href="/contact">Contact Us</Link>
          </Button>
        </div>
      </section>
    </>
  );
}
