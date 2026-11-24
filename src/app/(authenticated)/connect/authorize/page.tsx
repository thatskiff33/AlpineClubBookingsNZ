import { notFound, redirect } from "next/navigation";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { auth } from "@/lib/auth";
import { mcpAuthorizeParamsFromQuery, resolveMcpApproval } from "@/lib/mcp/approval";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";

import { ApprovalForm } from "./approval-form";

export const metadata = {
  title: "Connect an AI app",
};

/**
 * The approval screen an AI app sends a member to (ALP-653, `INV-MCP-002`,
 * `INV-MCP-003`).
 *
 * It decides nothing itself. `resolveMcpApproval` checks the app, its return
 * address and whether this member may connect at all, and the route behind the
 * buttons runs the same check again before anything is recorded. Signing in,
 * a forced password change and two-factor are the signed-in layout's job, so
 * a member who must do any of those does it first and comes back here.
 *
 * The module flag is re-checked here as well as in the proxy: a module gate
 * that lived only there has shipped bypassed before (#2780).
 */
export default async function ConnectAuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session?.user?.id) {
    return null;
  }

  const modules = await loadEffectiveModuleFlags();
  if (!modules.mcpServer) {
    notFound();
  }

  const params = mcpAuthorizeParamsFromQuery(await searchParams);
  const approval = await resolveMcpApproval(params, session.user);

  if (approval.kind === "redirect") {
    redirect(approval.location);
  }

  return (
    <div className="mx-auto w-full max-w-xl">
      <h1 className="mb-6 text-2xl font-bold text-foreground">Connect an AI app</h1>
      {approval.kind === "refuse" ? (
        <Card>
          <CardHeader>
            <CardTitle headingLevel={2}>This app cannot be connected</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p role="alert">{approval.message}</p>
            <p className="text-muted-foreground">
              Nothing was shared with the app. You can close this window.
            </p>
          </CardContent>
        </Card>
      ) : (
        <ApprovalForm
          appName={approval.request.clientName}
          appHost={approval.request.redirectHost}
          onThisDevice={approval.request.loopback}
          askedToChange={approval.request.wantsWrite}
          mayChange={approval.mayChange}
          officer={approval.officer}
          params={params}
        />
      )}
    </div>
  );
}
