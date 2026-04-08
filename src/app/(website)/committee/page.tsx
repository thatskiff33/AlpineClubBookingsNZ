import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Phone, Mail } from "lucide-react";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Committee",
  description:
    "Meet the Tokoroa Alpine Club committee members who volunteer their time to run the club and maintain the lodge.",
};

export const dynamic = "force-dynamic";

export default async function CommitteePage() {
  const committeeMembers = await prisma.committeeMember.findMany({
    where: { active: true },
    orderBy: { sortOrder: "asc" },
  });

  if (committeeMembers.length === 0) {
    return (
      <>
        <section className="bg-gradient-to-br from-slate-800 to-slate-900 text-white py-16 sm:py-20">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
              Committee
            </h1>
          </div>
        </section>
        <section className="bg-white py-16 sm:py-20">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 text-center">
            <p className="text-slate-600">Committee information coming soon.</p>
          </div>
        </section>
      </>
    );
  }

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
              <Card key={member.id} className="border-slate-200">
                <CardContent className="pt-6">
                  <p className="text-xs font-semibold text-blue-600 uppercase tracking-wide mb-1">
                    {member.role}
                  </p>
                  <h3 className="font-semibold text-slate-900 text-lg">
                    {member.name}
                  </h3>
                  <p className="text-sm text-slate-600 mt-2">
                    {member.description}
                  </p>
                  <div className="mt-4 flex flex-col gap-2">
                    <a
                      href={`tel:${member.phone.replace(/\s/g, "")}`}
                      className="inline-flex items-center gap-2 text-sm text-slate-700 hover:text-blue-600"
                    >
                      <Phone className="h-4 w-4" />
                      {member.phone}
                    </a>
                    {member.contactKey && (
                      <Link
                        href={`/contact?recipient=${member.contactKey}`}
                        className="inline-flex items-center gap-2 text-sm text-blue-600 hover:text-blue-800 hover:underline"
                      >
                        <Mail className="h-4 w-4" />
                        Send a message
                      </Link>
                    )}
                  </div>
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
            Have a general question about the club, the lodge, or booking a
            stay?
          </p>
          <Button size="lg" asChild>
            <Link href="/contact">Contact Us</Link>
          </Button>
        </div>
      </section>
    </>
  );
}
