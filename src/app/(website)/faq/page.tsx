import type { Metadata } from "next";
import Link from "next/link";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import faqSections from "@/data/faq";

export const metadata: Metadata = {
  title: "Frequently Asked Questions",
  description:
    "Answers to common questions about the Tokoroa Alpine Club lodge, bookings, membership, and general club information.",
};

export default function FaqPage() {
  return (
    <>
      <section className="bg-gradient-to-br from-slate-800 to-slate-900 text-white py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            Frequently Asked Questions
          </h1>
          <p className="mt-4 text-lg text-slate-300 max-w-2xl">
            Common questions about the lodge, bookings, and membership.
          </p>
        </div>
      </section>

      <section className="bg-white py-16 sm:py-20">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
          <div className="space-y-12">
            {faqSections.map((section) => (
              <div key={section.title}>
                <h2 className="text-lg font-bold text-slate-900 mb-4 pb-2 border-b border-slate-200">
                  {section.title}
                </h2>
                <Accordion type="single" collapsible className="w-full">
                  {section.items.map((item, index) => (
                    <AccordionItem
                      key={index}
                      value={`${section.title}-${index}`}
                    >
                      <AccordionTrigger className="text-left text-slate-800 hover:text-blue-600 hover:no-underline">
                        {item.question}
                      </AccordionTrigger>
                      <AccordionContent className="text-slate-600 leading-relaxed">
                        {item.answer}
                      </AccordionContent>
                    </AccordionItem>
                  ))}
                </Accordion>
              </div>
            ))}
          </div>

          <div className="mt-16 rounded-lg bg-slate-50 border border-slate-200 p-6 text-center">
            <h2 className="text-lg font-semibold text-slate-900 mb-2">
              Still have a question?
            </h2>
            <p className="text-slate-600 mb-4 text-sm">
              Can&apos;t find what you&apos;re looking for? Get in touch and we&apos;ll help.
            </p>
            <Link
              href="/contact"
              className="inline-flex items-center justify-center rounded-md bg-blue-600 px-5 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700 transition-colors"
            >
              Contact Us
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
