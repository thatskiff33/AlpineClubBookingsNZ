"use client";

import { useState, useEffect } from "react";
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
import { useClubTime } from "@/components/club-time-provider";
import { requireInstant } from "@/lib/club-time";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Radio } from "@/components/ui/radio";
import {
  BULK_EMAIL_CATEGORIES,
  BULK_EMAIL_CATEGORY_LABELS,
  type BulkEmailCategory,
} from "@/lib/email/bulk-audience";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface HistoryEntry {
  id: string;
  sentBy: string;
  subject: string;
  recipientFilter: string;
  totalRecipients: number;
  eligibleRecipients: number;
  queued: number;
  sentAt: string;
}

interface RecipientCounts {
  totalRecipients: number;
  eligibleRecipients: number;
  optedOut: number;
  neverOptedIn: number;
}

/**
 * #4987: "opted out" is only said of members who turned the category off; a
 * member with no saved preferences "never opted in". Shared by the pre-send
 * preview and the post-send confirmation so the two always read alike.
 */
function describeExcluded({ optedOut, neverOptedIn }: RecipientCounts) {
  const parts: string[] = [];
  if (optedOut > 0) parts.push(`${optedOut} opted out`);
  if (neverOptedIn > 0) parts.push(`${neverOptedIn} never opted in`);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

function recipientNoun(count: number) {
  return count === 1 ? "member" : "members";
}

export default function CommunicationsPage() {
  // When a communication was sent — real INSTANTS, projected through the club's persisted zone rather
  // than the viewer's or the build's (CT-4, #2870; INV-CONFIG-002).
  const clubTime = useClubTime();
  // Bulk send writes the communications route, which the route-area matrix maps
  // to the membership area; a view-only membership admin cannot send (#1997).
  const canEdit = useAdminAreaEditAccess("membership");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [recipientFilter, setRecipientFilter] = useState("all");
  // #4987: no default — the sender chooses club notice or newsletter for every
  // message, because the two reach different members.
  const [category, setCategory] = useState<BulkEmailCategory | null>(null);
  const [preview, setPreview] = useState<RecipientCounts | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [bulkSendLimit, setBulkSendLimit] = useState<number>(1);

  useEffect(() => {
    fetchRateLimit();
    fetchHistory();
  }, []);

  useEffect(() => {
    if (!category) return;
    let stale = false;
    setPreview(null);
    setPreviewError(false);
    const params = new URLSearchParams({ recipientFilter, category });
    fetch(`/api/admin/communications/preview?${params}`)
      .then(async (res) => {
        if (!res.ok) throw new Error("preview failed");
        return (await res.json()) as RecipientCounts;
      })
      .then((counts) => {
        if (!stale) setPreview(counts);
      })
      .catch(() => {
        if (!stale) setPreviewError(true);
      });
    return () => {
      stale = true;
    };
  }, [recipientFilter, category]);

  async function fetchRateLimit() {
    try {
      const res = await fetch("/api/admin/communications/send");
      if (!res.ok) return;
      const data = (await res.json()) as { limit?: number };
      if (typeof data.limit === "number" && data.limit > 0) {
        setBulkSendLimit(data.limit);
      }
    } catch {
      // ignore and keep fallback value
    }
  }

  async function fetchHistory() {
    try {
      const res = await fetch("/api/admin/communications/history");
      if (res.ok) {
        const data = await res.json();
        setHistory(data.history);
      }
    } catch {
      // ignore
    } finally {
      setLoadingHistory(false);
    }
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!canEdit || !category) return;
    setSending(true);
    setResult(null);

    try {
      const res = await fetch("/api/admin/communications/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, body, recipientFilter, category }),
      });

      const data = await res.json();

      if (res.ok) {
        setResult({
          success: true,
          message: `Sent to ${data.eligibleRecipients} ${recipientNoun(data.eligibleRecipients)}${describeExcluded(data)}.`,
        });
        setSubject("");
        setBody("");
        fetchHistory();
      } else {
        setResult({ success: false, message: data.error });
      }
    } catch {
      setResult({
        success: false,
        message: "Failed to send. Please try again.",
      });
    } finally {
      setSending(false);
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
      <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Communications</h1>
        <p className="text-sm text-muted-foreground">
          Send club notices or newsletters to members. Respects each member&apos;s
          notification preferences.
        </p>
      </div>

      {/* Compose Form */}
      <Card>
        <CardHeader>
          <CardTitle>Compose Message</CardTitle>
          <CardDescription>
            Choose whether this is a club notice or a newsletter: each reaches
            different members. Rate limited to {bulkSendLimit} send
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
                onValueChange={setRecipientFilter}
              >
                <SelectTrigger id="recipientFilter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Active Members</SelectItem>
                  <SelectItem value="members-only">Members Only</SelectItem>
                  <SelectItem value="admins-only">Admins Only</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Kind of message</legend>
              {BULK_EMAIL_CATEGORIES.map((option) => (
                <label
                  key={option}
                  htmlFor={`category-${option}`}
                  className="flex items-start gap-2 text-sm"
                >
                  <Radio
                    id={`category-${option}`}
                    name="category"
                    className="mt-0.5"
                    value={option}
                    checked={category === option}
                    onChange={() => setCategory(option)}
                  />
                  <span>
                    <span className="font-medium">
                      {BULK_EMAIL_CATEGORY_LABELS[option].label}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {BULK_EMAIL_CATEGORY_LABELS[option].description}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>

            <p
              className="text-sm text-muted-foreground"
              data-testid="communications-recipient-preview"
              aria-live="polite"
            >
              {!category
                ? "Choose the kind of message to see who will receive it."
                : previewError
                  ? "Could not count recipients. The send still applies each member's preferences."
                  : preview
                    ? `Will be sent to ${preview.eligibleRecipients} of ${preview.totalRecipients} ${recipientNoun(preview.totalRecipients)}${describeExcluded(preview)}.`
                    : "Counting recipients..."}
            </p>

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

            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
              type="submit"
              disabled={sending || !subject || !body || !category}
            >
              {sending ? "Sending..." : "Send to Members"}
            </ViewOnlyActionButton>
          </form>
        </CardContent>
      </Card>

      {/* History */}
      <Card>
        <CardHeader>
          <CardTitle>Send History</CardTitle>
          <CardDescription>Previous bulk communications</CardDescription>
        </CardHeader>
        <CardContent>
          {loadingHistory ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : history.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No bulk communications sent yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="pb-2 pr-4">Date</th>
                    <th className="pb-2 pr-4">Subject</th>
                    <th className="pb-2 pr-4">Filter</th>
                    <th className="pb-2 pr-4">Recipients</th>
                    <th className="pb-2">Sent</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((entry) => (
                    <tr key={entry.id} className="border-b">
                      <td className="py-2 pr-4 text-muted-foreground">
                        {clubTime.instantDate(requireInstant(entry.sentAt))}
                      </td>
                      <td className="py-2 pr-4 font-medium">{entry.subject}</td>
                      <td className="py-2 pr-4 text-muted-foreground">
                        {entry.recipientFilter}
                      </td>
                      <td className="py-2 pr-4 text-muted-foreground">
                        {entry.totalRecipients}
                      </td>
                      <td className="py-2 text-muted-foreground">
                        {entry.eligibleRecipients}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
      </div>
    </div>
  );
}
