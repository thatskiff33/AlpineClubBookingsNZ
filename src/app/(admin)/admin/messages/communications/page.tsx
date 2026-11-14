"use client";

import { useState, useEffect, useRef } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { useConfirm } from "@/components/confirm-dialog";
import { ACCESS_ROLE_LABELS } from "@/lib/access-roles";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { BulkRecipientFilter } from "@/lib/bulk-communication-recipients";
import { SendHistoryCard } from "./_components/send-history-card";
import { useCommunicationsData } from "./_hooks/use-communications-data";

type OfferedAudience = Exclude<BulkRecipientFilter, "custom">;

// What each audience reaches today, in the words the officer confirms against
// (#4964). `selectBulkCommunicationRecipients` is the authority and these are
// prose over it, which a client component cannot import (it is server-only).
// `Member.role` is ADMIN only for the Full Admin access role: other admin roles
// (Membership Officer, Treasurer, ...) leave it USER, so Members Only reaches
// them. A pin test in the route's tests fails if the role scope changes; update
// these, the guide's Audiences table and the changelog fragment with it.
const FULL_ADMIN = ACCESS_ROLE_LABELS.ADMIN;
const OTHER_ADMIN_ROLES = `${ACCESS_ROLE_LABELS.ADMIN_MEMBERSHIP} or ${ACCESS_ROLE_LABELS.FINANCE_ADMIN}`;

const AUDIENCES: Record<
  OfferedAudience,
  { label: string; description: string }
> = {
  all: {
    label: "All Active Members",
    description:
      "Every active account, including admin, lodge, school and non-member booking contact accounts.",
  },
  "members-only": {
    label: "Members Only",
    description: `Active ordinary member accounts. Accounts with the ${FULL_ADMIN} role are not included. Accounts on other admin roles, such as ${OTHER_ADMIN_ROLES}, are.`,
  },
  "admins-only": {
    label: "Admins Only",
    description: `Active ${FULL_ADMIN} accounts only.`,
  },
};

const OFFERED_AUDIENCES = Object.keys(AUDIENCES) as OfferedAudience[];

function peopleCount(count: number) {
  return `${count} ${count === 1 ? "person" : "people"}`;
}

// How many opted-in accounts the audience reaches, from the same query the
// send uses. A GET: it sends nothing and spends none of the hourly quota.
async function fetchEligibleCount(
  audience: OfferedAudience,
): Promise<number | null> {
  try {
    const res = await fetch(
      `/api/admin/communications/send?recipientFilter=${encodeURIComponent(audience)}`,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { eligibleRecipients?: unknown };
    return typeof data.eligibleRecipients === "number"
      ? data.eligibleRecipients
      : null;
  } catch {
    return null;
  }
}

export default function CommunicationsPage() {
  // Bulk send writes the communications route, which the route-area matrix maps
  // to the membership area; a view-only membership admin cannot send (#1997).
  const canEdit = useAdminAreaEditAccess("membership");
  const { confirm, confirmDialog } = useConfirm();
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [recipientFilter, setRecipientFilter] =
    useState<OfferedAudience>("all");
  // A send runs checking (the recipient count) → confirming (the dialog) →
  // sending (the POST); the form takes no second submit until it settles.
  const [sendPhase, setSendPhase] = useState<
    "idle" | "checking" | "confirming" | "sending"
  >("idle");
  const [result, setResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  // The hourly limit and the send history, loaded on mount.
  const { history, loadingHistory, bulkSendLimit, refreshHistory } =
    useCommunicationsData();
  // Where focus goes once a cancelled confirmation has settled (below).
  const returnFocusTo = useRef<HTMLElement | null>(null);

  // `useConfirm` opens its dialog without a trigger element, so Radix has
  // nothing to return focus to when Cancel closes it. Do it here, once the
  // form is idle again: the submit button is disabled until then, and a
  // disabled button cannot take focus.
  useEffect(() => {
    if (sendPhase !== "idle") return;
    returnFocusTo.current?.focus();
    returnFocusTo.current = null;
  }, [sendPhase]);

  // Submitting the form (the button, or Enter in Subject) only opens the
  // confirmation step; nothing is sent until the officer confirms (#4964).
  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!canEdit || sendPhase !== "idle") return;
    // The control the officer used: the button, or Subject for Enter.
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    // Send exactly what was confirmed, whatever happens to the form meanwhile.
    const message = { subject, body, recipientFilter };
    const audience = AUDIENCES[message.recipientFilter];
    setSendPhase("checking");
    setResult(null);

    try {
      const eligible = await fetchEligibleCount(message.recipientFilter);
      if (eligible === null) {
        setResult({
          success: false,
          message:
            "Could not check how many people would receive this email, so nothing was sent. Please try again.",
        });
        return;
      }
      if (eligible === 0) {
        setResult({
          success: false,
          message: `Nobody in "${audience.label}" has opted in to marketing email, so nobody would receive this. Nothing was sent.`,
        });
        return;
      }

      setSendPhase("confirming");
      const confirmed = await confirm({
        title: `Send this email to ${peopleCount(eligible)}?`,
        description: `Audience: ${audience.label}. ${audience.description} Subject: "${message.subject}". Only people who opted in to marketing email are counted. Sending cannot be undone. The club can send ${bulkSendLimit} bulk email${bulkSendLimit === 1 ? "" : "s"} per hour, shared by all admins.`,
        confirmLabel: `Send to ${peopleCount(eligible)}`,
      });
      if (!confirmed) {
        returnFocusTo.current = opener;
        return;
      }

      setSendPhase("sending");
      const res = await fetch("/api/admin/communications/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message),
      });

      const data = await res.json();

      if (res.ok) {
        setResult({
          success: true,
          message: `Sent to ${data.eligibleRecipients} recipients (${data.filteredByPreference} opted out).`,
        });
        setSubject("");
        setBody("");
        refreshHistory();
      } else {
        setResult({ success: false, message: data.error });
      }
    } catch {
      setResult({
        success: false,
        message: "Failed to send. Please try again.",
      });
    } finally {
      setSendPhase("idle");
    }
  }

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before its
    content appears; a region injected already-populated is silently dropped by
    some screen-reader/browser pairings. It sits OUTSIDE the `space-y-*` stack so
    the empty wrapper an edit-capable admin gets costs no layout.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view communications but cannot send bulk emails to
      members.
    </AdminViewOnlySectionBanner>
  );

  return (
    <div>
      {viewOnlyBanner}
      {confirmDialog}
      <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Communications</h1>
        <p className="text-sm text-muted-foreground">
          Send bulk emails to club members. Respects notification preferences.
        </p>
      </div>

      {/* Compose Form */}
      <Card>
        <CardHeader>
          <CardTitle>Compose Message</CardTitle>
          <CardDescription>
            Only members who have opted in to marketing emails will receive this
            message. Rate limited to {bulkSendLimit} send
            {bulkSendLimit === 1 ? "" : "s"} per hour.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSend} className="space-y-4">
            <div>
              <Label htmlFor="subject">Subject</Label>
              <Input
                id="subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Email subject line"
                maxLength={200}
                required
              />
              <p className="text-xs text-muted-foreground mt-1">
                {subject.length}/200 characters
              </p>
            </div>

            <div>
              <Label htmlFor="recipientFilter">Recipients</Label>
              <Select
                value={recipientFilter}
                onValueChange={(value) =>
                  setRecipientFilter(value as OfferedAudience)
                }
              >
                <SelectTrigger
                  id="recipientFilter"
                  aria-describedby="recipientFilter-help"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OFFERED_AUDIENCES.map((audience) => (
                    <SelectItem key={audience} value={audience}>
                      {AUDIENCES[audience].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p
                id="recipientFilter-help"
                className="text-xs text-muted-foreground mt-1"
              >
                {AUDIENCES[recipientFilter].description} Only those who opted
                in to marketing email receive it.
              </p>
            </div>

            <div>
              <Label htmlFor="body">Message Body</Label>
              <Textarea
                id="body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Write your message here (plain text)"
                rows={8}
                maxLength={10000}
                required
              />
              <p className="text-xs text-muted-foreground mt-1">
                {body.length}/10,000 characters. Plain text only — HTML is
                escaped for security.
              </p>
            </div>

            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
              type="submit"
              disabled={sendPhase !== "idle" || !subject || !body}
            >
              {sendPhase === "checking"
                ? "Checking recipients..."
                : sendPhase === "sending"
                  ? "Sending..."
                  : "Send to Members"}
            </ViewOnlyActionButton>

            {/*
              Permanently mounted so screen readers announce the result: a live
              region injected already filled in is dropped by some pairings
              (the same reason as the view-only banner above).
            */}
            <div role="status" data-testid="send-result">
              {result && (
                <div
                  className={`rounded-md p-3 text-sm ${
                    result.success
                      ? "bg-success-3 text-success-11 border border-success-6"
                      : "bg-danger-3 text-danger-11 border border-danger-6"
                  }`}
                >
                  {result.message}
                </div>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      {/* History */}
      <SendHistoryCard history={history} loading={loadingHistory} />
      </div>
    </div>
  );
}
