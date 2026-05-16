import type { Metadata } from "next";
import Link from "next/link";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { CLUB_NAME } from "@/config/club-identity";
import faqSections from "@/data/faq";

export const metadata: Metadata = {
  title: "Frequently Asked Questions",
  description:
    `Answers to common questions about the ${CLUB_NAME} lodge, bookings, membership, and general club information.`,
};

export default function FaqPage() {
  return (
    <>
      <section className="bg-gradient-to-br from-brand-charcoal to-brand-deep py-16 text-brand-snow sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <span className="website-eyebrow mb-4">Common questions</span>
          <h1 className="font-heading text-4xl font-bold tracking-tight sm:text-5xl">
            Frequently Asked Questions
          </h1>
          <p className="mt-4 max-w-2xl text-lg text-brand-snow/80">
            Common questions about the lodge, bookings, and membership.
          </p>
        </div>
      </section>

      <section className="bg-brand-snow py-16 sm:py-20">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
          <div className="space-y-12">
            {faqSections.map((section) => (
              <div key={section.title}>
                <h2 className="mb-4 border-b border-brand-ridge/20 pb-2 font-heading text-lg font-bold text-brand-charcoal">
                  {section.title}
                </h2>
                <Accordion type="single" collapsible className="w-full">
                  {section.items.map((item, index) => (
                    <AccordionItem
                      key={index}
                      value={`${section.title}-${index}`}
                      className="border-brand-ridge/20"
                    >
                      <AccordionTrigger className="text-left text-brand-charcoal hover:text-brand-deep hover:no-underline">
                        {item.question}
                      </AccordionTrigger>
                      <AccordionContent className="leading-relaxed text-brand-deep/78">
                        {item.answer}
                      </AccordionContent>
                    </AccordionItem>
                  ))}
                </Accordion>
              </div>
            ))}
          </div>

          <div className="mt-16 rounded-3xl border border-brand-gold/15 bg-brand-charcoal p-6 text-center text-brand-snow">
            <h2 className="mb-2 font-heading text-lg font-semibold text-brand-snow">
              Still have a question?
            </h2>
            <p className="mb-4 text-sm text-brand-snow/76">
              Can&apos;t find what you&apos;re looking for? Get in touch and we&apos;ll help.
            </p>
            <Link
              href="/contact"
              className="inline-flex items-center justify-center rounded-md bg-brand-gold px-5 py-2.5 text-sm font-medium text-brand-charcoal shadow-sm transition-colors hover:bg-[#e0b304]"
            >
              Contact Us
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
