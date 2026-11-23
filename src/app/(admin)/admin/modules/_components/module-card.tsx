"use client";

/**
 * One module's card on the Modules page: its switch, readiness and
 * dependencies. The AI Diagnostics card also states where Diagnostics sends
 * data (#5243), with the acknowledgement tick when the page asks for it.
 */
import Link from "next/link";
import { AlertCircle, ArrowRight, CheckCircle2 } from "lucide-react";

import { AiDiagnosticsDisclosure } from "@/components/admin/ai-diagnostics-disclosure";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import type { ModuleKey } from "@/config/modules";
import { adminHref } from "@/lib/admin-hubs";

type ModuleReadinessStatus =
  | "ready"
  | "admin_disabled"
  // #2306 added a `not_available_yet` state for the memberGuests flag, which
  // gated nothing in that release. #2307 shipped the behaviour, removing the
  // only producer, so the state and its branches go with it.
  | "credentials_missing";

export interface ModuleStatus {
  key: ModuleKey;
  label: string;
  description: string;
  adminEnabled: boolean;
  effectiveEnabled: boolean;
  readiness: {
    status: ModuleReadinessStatus;
    message: string;
    dependencies: string[];
  };
}

function readinessVariant(
  status: ModuleReadinessStatus,
): BadgeProps["variant"] {
  if (status === "ready") return "success";
  if (status === "credentials_missing") return "warning";
  return "secondary";
}

function readinessLabel(status: ModuleReadinessStatus) {
  if (status === "ready") return "Enabled";
  if (status === "credentials_missing") return "Needs setup";
  return "Disabled";
}

// Modules whose "Needs setup" state has somewhere to deep-link to (#2080). C4/C5
// add their providers here as their wizards land.
//
// `analytics` points at the Integrations HUB rather than at a setup route of its
// own, because it has none by design: the owner's #2573 decision put Google
// Analytics on that hub as a peer card whose configuration opens in place, and
// expressly ruled out a dedicated analytics setup route. Without this entry
// analytics was the one module in the tree that could report `credentials_missing`
// with no clickable route to its configuration — on the screen where the #2573
// hard cutover is most likely to be discovered by an operator who has not read the
// release note, and two rows away from the Xero and Google sign-in cards that do
// show the affordance.
const MODULE_SETUP_HREFS: Partial<Record<ModuleKey, string>> = {
  xeroIntegration: adminHref("xero-setup"),
  googleLogin: "/admin/google/setup",
  analytics: "/admin/integrations",
  // The Alpine Central Server setup lives on the Integrations hub (as a card
  // opening /admin/alpine-server/setup); the module's "Set up" affordance points
  // at the hub, matching the analytics pattern.
  alpineCentralServer: "/admin/integrations",
};


interface ModuleCardProps {
  module: ModuleStatus;
  onEnabledChange: (enabled: boolean) => void;
  disabled: boolean;
  /** The disclosure tick, passed only while a save would switch Diagnostics on. */
  aiDiagnosticsAcknowledgement?: {
    checked: boolean;
    onChange: (checked: boolean) => void;
    disabled: boolean;
  };
}

export function ModuleCard({
  module,
  onEnabledChange,
  disabled,
  aiDiagnosticsAcknowledgement,
}: ModuleCardProps) {
  const checkboxId = `module-${module.key}`;
  const statusIcon = module.effectiveEnabled ? (
    <CheckCircle2 className="h-4 w-4 text-success-11" />
  ) : (
    <AlertCircle className="h-4 w-4 text-warning-11" />
  );

  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex items-start gap-3">
          <Checkbox
            id={checkboxId}
            checked={module.adminEnabled}
            onCheckedChange={(checked) =>
              onEnabledChange(checked === true)
            }
            disabled={disabled}
            className="mt-1"
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-base">
                <label htmlFor={checkboxId}>{module.label}</label>
              </CardTitle>
              <Badge variant={module.adminEnabled ? "success" : "secondary"}>
                {module.adminEnabled ? "Enabled" : "Disabled"}
              </Badge>
            </div>
            <CardDescription className="mt-1">
              {module.description}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* ADR-006 §2 (#5243): where Diagnostics sends data is stated
            on its card before it can be switched on, and the tick is
            asked for only by a save that switches it on. */}
        {module.key === "aiDiagnostics" ? (
          <AiDiagnosticsDisclosure acknowledgement={aiDiagnosticsAcknowledgement} />
        ) : null}
        <div className="flex items-start gap-2 rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
          {statusIcon}
          <div>
            <Badge
              variant={readinessVariant(module.readiness.status)}
              className="mb-2"
            >
              {readinessLabel(module.readiness.status)}
            </Badge>
            <p>{module.readiness.message}</p>
            {module.readiness.status === "credentials_missing" &&
            MODULE_SETUP_HREFS[module.key] ? (
              <Link
                href={MODULE_SETUP_HREFS[module.key] as string}
                className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-foreground underline decoration-brand-gold/70 decoration-2 underline-offset-4"
              >
                Set up
                <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            ) : null}
          </div>
        </div>

        {module.readiness.dependencies.length > 0 && (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Dependencies
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {module.readiness.dependencies.map((dependency) => (
                <li key={dependency}>{dependency}</li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
