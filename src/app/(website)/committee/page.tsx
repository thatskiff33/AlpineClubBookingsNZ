import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Phone, Mail } from "lucide-react";
import { CLUB_NAME } from "@/config/club-identity";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Committee",
  description:
    `Meet the ${CLUB_NAME} committee members who volunteer their time to run the club and maintain the lodge.`,
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
        <section className="bg-gradient-to-br from-brand-charcoal to-brand-deep py-16 text-brand-snow sm:py-20">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <h1 className="font-heading text-4xl font-bold tracking-tight sm:text-5xl">
              Committee
            </h1>
          </div>
        </section>
        <section className="bg-brand-snow py-16 sm:py-20">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 text-center">
            <p className="text-brand-deep/75">Committee information coming soon.</p>
          </div>
        </section>
      </>
    );
  }

  return (
    <>
      {/* Header */}
      <section className="bg-gradient-to-br from-brand-charcoal to-brand-deep py-16 text-brand-snow sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <span className="website-eyebrow mb-4">Volunteer leadership</span>
          <h1 className="font-heading text-4xl font-bold tracking-tight sm:text-5xl">
            Committee
          </h1>
          <p className="mt-4 max-w-2xl text-lg text-brand-snow/80">
            The club is run entirely by volunteers. Meet the committee members
            who keep things going.
          </p>
        </div>
      </section>

      {/* Committee list */}
      <section className="bg-brand-snow py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {committeeMembers.map((member) => (
              <Card
                key={member.id}
                className="border-brand-ridge/20 bg-brand-snow/90 shadow-[0_20px_45px_-35px_rgba(47,47,43,0.45)]"
              >
                <CardContent className="pt-6">
                  <p className="mb-1 text-xs font-semibold uppercase tracking-[0.2em] text-brand-charcoal">
                    {member.role}
                  </p>
                  <h3 className="font-heading text-lg font-semibold text-brand-charcoal">
                    {member.name}
                  </h3>
                  <p className="mt-2 text-sm text-brand-deep/75">
                    {member.description}
                  </p>
                  <div className="mt-4 flex flex-col gap-2">
                    <a
                      href={`tel:${member.phone.replace(/\s/g, "")}`}
                      className="inline-flex items-center gap-2 text-sm text-brand-deep/78 transition-colors hover:text-brand-charcoal"
                    >
                      <Phone className="h-4 w-4 text-brand-gold" />
                      {member.phone}
                    </a>
                    {member.contactKey && (
                      <Link
                        href={`/contact?recipient=${member.contactKey}`}
                        className="inline-flex items-center gap-2 text-sm font-medium text-brand-charcoal underline decoration-brand-gold/70 decoration-2 underline-offset-4 transition-colors hover:text-brand-deep hover:decoration-brand-safety"
                      >
                        <Mail className="h-4 w-4 text-brand-gold" />
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
      <section className="bg-brand-mist/55 py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 text-center sm:px-6 lg:px-8">
          <h2 className="mb-4 font-heading text-2xl font-bold text-brand-charcoal">
            Get in Touch
          </h2>
          <p className="mx-auto mb-8 max-w-xl text-brand-deep/75">
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
