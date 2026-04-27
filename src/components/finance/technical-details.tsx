import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";

export interface FinanceTechnicalLink {
  href: string;
  label: string;
  description: string;
}

export function FinanceTechnicalDetails({
  title = "Technical details",
  description = "Manager-only technical links for support and troubleshooting.",
  actions,
}: {
  title?: string;
  description?: string;
  actions: FinanceTechnicalLink[];
}) {
  if (actions.length === 0) {
    return null;
  }

  return (
    <Accordion type="single" collapsible className="rounded-xl border border-slate-200 px-4">
      <AccordionItem value="technical" className="border-b-0">
        <AccordionTrigger className="text-left text-sm font-semibold text-slate-900 hover:no-underline">
          <span>
            <span className="block">{title}</span>
            <span className="mt-1 block text-xs font-normal leading-5 text-slate-500">
              {description}
            </span>
          </span>
        </AccordionTrigger>
        <AccordionContent className="space-y-3 pb-4">
          {actions.map((action) => (
            <Button
              key={action.href}
              asChild
              variant="outline"
              className="w-full justify-between"
            >
              <Link href={action.href} target="_blank" rel="noreferrer">
                <span className="text-left">
                  <span className="block text-sm font-medium">{action.label}</span>
                  <span className="block text-xs text-slate-500">
                    {action.description}
                  </span>
                </span>
                <ArrowUpRight className="ml-3 h-4 w-4 shrink-0" />
              </Link>
            </Button>
          ))}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
