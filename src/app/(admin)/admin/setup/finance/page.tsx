import Link from "next/link";
import { Landmark, Plug, RefreshCw } from "lucide-react";
import { BackLink } from "@/components/admin/back-link";
import { FinanceReportMappingsPanel } from "@/components/admin/finance-report-mappings-panel";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { isFeatureHrefVisible } from "@/config/feature-routes";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { loadAdminSetupPermissionMatrix } from "../permission-matrix";
import { adminHref } from "@/lib/admin-hubs";

const financeLinks = [
  {
    href: "/finance",
    title: "Finance Dashboard",
    description:
      "Open revenue, cost, sync health, and finance reporting views.",
    icon: Landmark,
  },
  {
    href: adminHref("xero-setup"),
    title: "Xero Setup",
    description:
      "Connect Xero and configure accounting settings used by finance workflows.",
    icon: Plug,
  },
  {
    href: `${adminHref("xero")}#xero-section-mappings`,
    title: "Xero Mappings",
    description:
      "Review account, item-code, and entrance-fee mappings used by Xero sync.",
    icon: RefreshCw,
  },
];

export default async function FinanceSetupPage() {
  const [features, permissionMatrix] = await Promise.all([
    loadEffectiveModuleFlags(),
    loadAdminSetupPermissionMatrix(),
  ]);
  const hasFinanceAccess = permissionMatrix.finance !== "none";
  const visibleLinks = hasFinanceAccess
    ? financeLinks.filter((link) => isFeatureHrefVisible(link.href, features))
    : [];
  const showReportMappings = hasFinanceAccess && features.financeDashboard;

  return (
    <div className="space-y-8">
      <div>
        <div className="mb-2">
          <BackLink href="/admin/setup" label="Setup Wizard" />
        </div>
        <h1 className="text-2xl font-bold text-foreground">Finance</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Open finance reporting, Xero setup, sync mappings, and the finance
          report mapping editor.
        </p>
      </div>

      {visibleLinks.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {visibleLinks.map(({ href, title, description, icon: Icon }) => (
            <Link key={href} href={href} className="group block">
              <Card className="h-full transition-colors hover:border-brand-gold/70">
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <Icon className="h-5 w-5 shrink-0 text-foreground" />
                    <CardTitle>{title}</CardTitle>
                  </div>
                  <CardDescription>{description}</CardDescription>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        <div className="rounded-md border bg-muted px-4 py-3 text-sm text-muted-foreground">
          Finance setup pages are not available for your current permissions
          and enabled modules.
        </div>
      )}

      {showReportMappings ? (
        <section className="space-y-3">
          <div>
            <h2 className="text-xl font-semibold text-foreground">
              Report mappings
            </h2>
            <p className="text-sm text-muted-foreground">
              Expand only when editing the report groups used by the finance
              dashboard.
            </p>
          </div>
          <Accordion type="single" collapsible>
            <AccordionItem value="finance-report-mappings">
              <AccordionTrigger>Finance Report Mappings</AccordionTrigger>
              <AccordionContent>
                <FinanceReportMappingsPanel />
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </section>
      ) : null}
    </div>
  );
}
