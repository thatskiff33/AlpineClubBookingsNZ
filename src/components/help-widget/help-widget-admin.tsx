"use client";

import { useCallback } from "react";
import { canonicalAdminPathname } from "@/lib/admin-hubs";
import { getContextualHelp } from "@/lib/contextual-help";
import type { HelpPageContent } from "@/lib/help/types";
import { HelpWidget } from "./help-widget";

/**
 * Admin / finance help widget. Resolves against the existing
 * `@/lib/contextual-help` registry (the admin+finance corpus) — the ONLY corpus
 * this wrapper imports, so it pulls neither the member nor the public corpus.
 */
export function HelpWidgetAdmin({
  scope,
  llmEnabled,
  chatEndpoint,
  diagnostics,
}: {
  scope: "admin" | "finance";
  llmEnabled: boolean;
  chatEndpoint?: string;
  /**
   * AI Diagnostics (AID-7, #2378). Passed straight through: its PRESENCE is the
   * permission, decided by the server-rendered layout that supplied it. See
   * `HelpWidgetProps.diagnostics` for why there is no check on this side.
   */
  diagnostics?: { moduleEnabled: boolean };
}) {
  const resolveHelp = useCallback(
    (pathname: string): HelpPageContent => getContextualHelp(pathname, scope),
    [scope],
  );

  return (
    <HelpWidget
      surface={scope}
      llmEnabled={llmEnabled}
      resolveHelp={resolveHelp}
      // Help keys stay on OLD admin paths: a moved page's hub path reads as its
      // old path, on the server and in the browser alike (C3 #4800).
      normalisePathname={canonicalAdminPathname}
      position="app"
      chatEndpoint={chatEndpoint}
      diagnostics={diagnostics}
    />
  );
}
