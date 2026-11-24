"use client";

import { useState } from "react";
import type { McpGrantScope } from "@prisma/client";
import { Eye, Loader2, Pencil } from "lucide-react";

import { FocusedActionError } from "@/components/focused-action-error";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { OptionCard, OptionCardGroup } from "@/components/ui/option-card";
import { useActionFailure } from "@/hooks/use-action-failure";
import { apiErrorMessageFromBody, readApiObjectOrEmpty } from "@/lib/api-error-message";
import type { McpAuthorizeParams } from "@/lib/mcp/oauth";
import { MCP_SCOPE_LABELS } from "@/lib/mcp/scope-labels";

type Decision = "approve" | "deny";

const FAILURE_FALLBACK =
  "That did not go through. Nothing was shared with the app. Please try again.";

/**
 * The two buttons on the approval screen (ALP-653, `INV-MCP-002`).
 *
 * The app's name is whatever the app called itself, so the screen leads with
 * the one fact the club checked: where the approval is sent. "View only" is
 * the choice already made when the screen opens, and "View and change" is
 * offered only when the app asked for it and the club allows it; the route
 * applies both limits again whatever this form sends. An officer is also told
 * the app can act as an officer, and the form says it showed them that: only
 * such an approval lets the connection run officer actions (`INV-MCP-009`).
 */
export function ApprovalForm({
  appName,
  appHost,
  onThisDevice,
  askedToChange,
  mayChange,
  officer,
  params,
}: {
  appName: string;
  /** The host the approval is delivered to. */
  appHost: string;
  /** The app receives the approval on this computer, not on a website. */
  onThisDevice: boolean;
  askedToChange: boolean;
  mayChange: boolean;
  /** The member holds an admin area: the screen says the app can also act as an officer. */
  officer: boolean;
  /** The request exactly as it arrived, sent back so the route re-checks it. */
  params: McpAuthorizeParams;
}) {
  const [scope, setScope] = useState<McpGrantScope>("READ");
  const [pending, setPending] = useState<Decision | null>(null);
  const failure = useActionFailure();

  async function decide(decision: Decision) {
    setPending(decision);
    failure.clear();
    try {
      const response = await fetch("/api/member/mcp-grants", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, scope, officerNoticeShown: officer, params }),
      });
      const body = await readApiObjectOrEmpty(response);
      if (!response.ok || typeof body.redirectTo !== "string") {
        failure.fail(apiErrorMessageFromBody(body, FAILURE_FALLBACK));
        setPending(null);
        return;
      }
      // Back to the app, which collects the approval (or the refusal) there.
      // `pending` stays set: the buttons must not be pressed twice on the way.
      window.location.assign(body.redirectTo);
    } catch {
      failure.fail(FAILURE_FALLBACK);
      setPending(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle headingLevel={2} className="break-words">
          {appName} wants to connect to your account
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5 text-sm">
        <dl className="rounded-md border bg-muted px-3 py-2">
          <dt className="text-xs text-muted-foreground">If you allow it, the app is sent back to</dt>
          <dd className="break-all font-medium" data-testid="mcp-app-host">
            {onThisDevice ? `An app running on this computer (${appHost})` : appHost}
          </dd>
        </dl>
        <p className="text-muted-foreground">
          The name above is what the app calls itself. Only continue if you started
          this from an AI app you use and the address is the one you expect.
        </p>

        {mayChange ? (
          <OptionCardGroup label="What may this app do?">
            <OptionCard
              icon={Eye}
              selected={scope === "READ"}
              onSelect={() => setScope("READ")}
              title={MCP_SCOPE_LABELS.READ}
              disabled={pending !== null}
            >
              See what you can see when you are signed in. It cannot change anything.
            </OptionCard>
            <OptionCard
              icon={Pencil}
              selected={scope === "READ_WRITE"}
              onSelect={() => setScope("READ_WRITE")}
              title={MCP_SCOPE_LABELS.READ_WRITE}
              disabled={pending !== null}
            >
              Also make changes for you, such as starting or cancelling a booking.
            </OptionCard>
          </OptionCardGroup>
        ) : (
          <div>
            <p className="font-medium text-foreground">{MCP_SCOPE_LABELS.READ}</p>
            <p className="text-muted-foreground">
              The app can see what you can see when you are signed in. It cannot
              change anything.
              {askedToChange
                ? " It asked to make changes too, and this club allows view-only connections."
                : ""}
            </p>
          </div>
        )}

        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          <li>The app acts as you. What you ask it, and what it reads, goes to the company that runs it.</li>
          {officer ? (
            <li data-testid="mcp-officer-notice">
              {/* General on purpose: one approval covers every officer area, later ones
                  included (owner decision, #5305 comment 7131483847). The app is told to
                  ask first by the server's instructions, which cover every change. */}
              {mayChange
                ? "As a club officer, the app can also see the club records your admin role gives you, such as other members' bookings and details and the club's booking settings. If you choose View and change, it can change them too, and it is told to ask you first."
                : "As a club officer, the app can also see the club records your admin role gives you, such as other members' bookings and details and the club's booking settings."}
            </li>
          ) : null}
          <li>Paying by card and changing your password or sign-in stay on this website.</li>
          <li>You can disconnect the app at any time on your profile, under Connected AI apps.</li>
        </ul>

        <FocusedActionError
          id="mcp-approval-error"
          error={failure.error}
          attentionKey={failure.attentionKey}
        />

        <div className="flex flex-wrap gap-3">
          <Button type="button" onClick={() => void decide("approve")} disabled={pending !== null}>
            {pending === "approve" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Allow
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => void decide("deny")}
            disabled={pending !== null}
          >
            {pending === "deny" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Don&apos;t allow
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
