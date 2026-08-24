"use client";

import type { FamilyBillingMode } from "@prisma/client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, MailWarning, ReceiptText, RefreshCw } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { useConfirm } from "@/components/confirm-dialog";
import { AdminViewOnlySectionBanner, ViewOnlyActionButton } from "@/components/admin/view-only-action";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { formatCents } from "@/lib/utils";
import { useClubTime } from "@/components/club-time-provider";

type BillingData = {
  preview: {
    seasonYear: number;
    decisionDate: string;
    dueDays: number;
    totalCents: number;
    confirmationToken: string;
    entries: Array<{
      key: string;
      membershipTypeName: string;
      billingBasis: string;
      prorationRule: string;
      chargedAmountCents: number;
      coveredMonths: number;
      // #2161 (D2): present on a PER_FAMILY entry; identifies the family group an
      // operator can mark as already invoiced.
      familyGroupId: string | null;
      xeroAccountCode: string | null;
      xeroItemCode: string | null;
      recipient: { name: string };
      coveredMembers: Array<{ id: string; name: string }>;
    }>;
    exceptions: Array<{ fingerprint: string; message: string }>;
    // #2148 (D1): members exempt from a subscription by their age tier (no fee
    // required by design). Shown in a collapsed informational "Exempt" section,
    // never raised as MISSING_FEE_SCHEDULE. Optional so an older cached response
    // without the field still renders.
    exemptMembers?: Array<{
      memberId: string;
      memberName: string;
      ageTier: string | null;
    }>;
    // #2147 (D3): members suppressed from the preview because their season
    // subscription already holds a live Xero invoice. Shown in a collapsed
    // "Already invoiced" section with their invoice number, never re-billed.
    alreadyInvoiced: Array<{
      memberId: string;
      memberName: string;
      xeroInvoiceNumber: string | null;
      status: string;
    }>;
    // #2147 FINDING 1: family groups suppressed from a second PER_FAMILY charge
    // because a group member already holds a live season invoice or an active
    // coverage claim. Shown in the same "Already invoiced" section, labelled as
    // covering the whole family group, never re-billed.
    alreadyInvoicedFamilies?: Array<{
      familyGroupId: string;
      holderMemberId: string | null;
      holderName: string | null;
      xeroInvoiceNumber: string | null;
      status: string | null;
      membersCovered: number;
      // #2161 FINDING 1: true when the auto-detected holder suppressed the family
      // via the fail-closed path (its own billing basis could not be resolved).
      holderBasisUnresolvable?: boolean;
      // #2161 (D2): true when an operator marker suppresses the family. The marker
      // fields describe who marked it and any note.
      operatorMarked?: boolean;
      markerNote?: string | null;
      markedByName?: string | null;
      markedAt?: string | null;
    }>;
  };
  charges: Array<{
    id: string;
    status: string;
    membershipTypeName: string;
    chargedAmountCents: number;
    recipientName: string;
    xeroInvoiceNumber: string | null;
    lastErrorMessage: string | null;
    coverage: Array<{ memberName: string }>;
  }>;
  exceptions: Array<{ id: string; fingerprint: string; message: string }>;
  settings: { invoiceDueDays: number; familyBillingMode: FamilyBillingMode };
};

export function SubscriptionBillingPanel({ seasonYear }: { seasonYear: number }) {
  const { confirm, confirmDialog } = useConfirm();
  const canEditFinance = useAdminAreaEditAccess("finance");
  // The default decision date is the CLUB's today, not the build's
  // `NEXT_PUBLIC_TZ` — the server interprets it in club time, so seeding it from
  // a constant fixed at build time hides or invents a day whenever that constant
  // is not the club's persisted zone, which includes every deployment that sets
  // only `TZ` (CT-4, #2870; INV-CONFIG-002).
  const clubTime = useClubTime();
  const [decisionDate, setDecisionDate] = useState<string>(() =>
    clubTime.today(),
  );
  const [data, setData] = useState<BillingData | null>(null);
  const [dueDays, setDueDays] = useState("30");
  const [familyBillingMode, setFamilyBillingMode] = useState<FamilyBillingMode>("BILL_FAMILY_VIA_BILLING_MEMBER");
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  // #2161 (D2): the family entry whose "mark as already invoiced" note editor is
  // open, and the draft note. null = no editor open.
  const [markingFamilyGroupId, setMarkingFamilyGroupId] = useState<string | null>(null);
  const [markNote, setMarkNote] = useState("");
  const [loadFeedback, setLoadFeedback] = useState<{ kind: "error"; text: string } | null>(null);
  const [mutationFeedback, setMutationFeedback] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const loadGeneration = useRef(0);
  const selectionRef = useRef({ seasonYear, decisionDate });
  const visibleExceptions = data
    ? [...new Map([...data.preview.exceptions, ...data.exceptions].map((item) => [item.fingerprint, item])).values()]
    : [];

  const load = useCallback(async () => {
    const selection = selectionRef.current;
    const generation = ++loadGeneration.current;
    setLoading(true);
    setData(null);
    setLoadFeedback(null);
    try {
      const response = await fetch(`/api/admin/subscription-billing?seasonYear=${selection.seasonYear}&decisionDate=${selection.decisionDate}`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not load billing preview.");
      if (generation !== loadGeneration.current) return;
      setData(body);
      setDueDays(String(body.settings.invoiceDueDays));
      setFamilyBillingMode(body.settings.familyBillingMode);
    } catch (error) {
      if (generation !== loadGeneration.current) return;
      setData(null);
      setLoadFeedback({ kind: "error", text: error instanceof Error ? error.message : "Could not load billing preview." });
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, []);

  useLayoutEffect(() => {
    selectionRef.current = { seasonYear, decisionDate };
  }, [decisionDate, seasonYear]);

  useEffect(() => {
    void load();
  }, [load, decisionDate, seasonYear]);

  async function post(body: Record<string, unknown>) {
    setWorking(true);
    setMutationFeedback(null);
    try {
      const response = await fetch("/api/admin/subscription-billing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Billing action failed.");
      setMutationFeedback({ kind: "success", text: result.message || "Billing action completed." });
      await load();
    } catch (error) {
      setData(null);
      setMutationFeedback({ kind: "error", text: error instanceof Error ? error.message : "Billing action failed." });
    } finally {
      setWorking(false);
    }
  }

  // #2148 (D2): the Refresh button reconciles stale persisted exceptions for a
  // finance-EDIT user via the edit-gated POST action, and stays a plain
  // read-only reload for a finance-VIEW user. Mount-time and post-action reloads
  // always go through the read-only GET (load), so the view never mutates.
  async function refreshPreview() {
    if (canEditFinance) {
      await post({ action: "REFRESH_PREVIEW", seasonYear, decisionDate });
    } else {
      await load();
    }
  }

  // #2161 (D2): mark a family as already invoiced (suppresses its PER_FAMILY
  // charge). The inline note editor IS the confirm step; the optional note is
  // sent only when non-empty.
  async function markFamily(familyGroupId: string) {
    const note = markNote.trim();
    setMarkingFamilyGroupId(null);
    setMarkNote("");
    await post({ action: "MARK_FAMILY_INVOICED", seasonYear, familyGroupId, ...(note ? { note } : {}) });
  }

  async function unmarkFamily(familyGroupId: string) {
    const accepted = await confirm({
      title: "Unmark this family?",
      description: "The family will be billed again in the next preview. Only do this if the family was not actually invoiced for this season.",
      confirmLabel: "Unmark family",
    });
    if (!accepted) return;
    await post({ action: "UNMARK_FAMILY_INVOICED", seasonYear, familyGroupId });
  }

  async function confirmBatch() {
    if (!data || data.preview.seasonYear !== seasonYear || data.preview.decisionDate !== decisionDate) return;
    const accepted = await confirm({
      title: `Create ${data.preview.entries.length} annual membership charge${data.preview.entries.length === 1 ? "" : "s"}?`,
      description: `${formatCents(data.preview.totalCents)} will be snapshotted. This creates durable Xero invoice work and cannot be undone by later fee or family changes. ${data.preview.exceptions.length} exception${data.preview.exceptions.length === 1 ? "" : "s"} will be recorded without invoicing.`,
      confirmLabel: "Confirm annual batch",
    });
    if (!accepted) return;
    await post({
      action: "CONFIRM_ANNUAL_BATCH",
      seasonYear,
      decisionDate,
      confirmationToken: data.preview.confirmationToken,
      confirmed: true,
    });
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
    <AdminViewOnlySectionBanner canEdit={canEditFinance} className="mb-4">
      Finance view access can inspect previews and charge history. Finance edit access is required to change settings, confirm billing, or retry Xero delivery.
    </AdminViewOnlySectionBanner>
  );

  return (
    <Card>
      {confirmDialog}
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ReceiptText className="h-5 w-5" /> Annual Membership Fee billing</CardTitle>
      </CardHeader>
      <CardContent>
        {viewOnlyBanner}
        <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Preview first, then explicitly confirm. Confirmation freezes fee, proration, recipient, family coverage, due days, and amount before Xero work is queued.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1"><Label htmlFor="subscription-decision-date">Decision date</Label><Input id="subscription-decision-date" type="date" value={decisionDate} onChange={(event) => { setData(null); setDecisionDate(event.target.value); }} /></div>
          <Button type="button" variant="outline" onClick={() => void refreshPreview()} disabled={loading || working}><RefreshCw className="mr-1 h-4 w-4" /> Refresh preview</Button>
          <div className="space-y-1"><Label htmlFor="subscription-due-days">Invoice due days</Label><Input id="subscription-due-days" className="w-28" type="number" min={1} max={365} value={dueDays} disabled={!canEditFinance} onChange={(event) => setDueDays(event.target.value)} /></div>
          <ViewOnlyActionButton canEdit={canEditFinance} describeReason={false} type="button" variant="outline" disabled={working || Number(dueDays) < 1 || Number(dueDays) > 365} onClick={() => void post({ action: "UPDATE_SETTINGS", invoiceDueDays: Number(dueDays) })}>Save due days</ViewOnlyActionButton>
        </div>
        <div className="space-y-2 rounded-md border p-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="family-billing-mode">Family billing mode</Label>
              <Select value={familyBillingMode} onValueChange={(value) => setFamilyBillingMode(value as FamilyBillingMode)} disabled={!canEditFinance || working}>
                <SelectTrigger id="family-billing-mode" className="w-80"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="BILL_FAMILY_VIA_BILLING_MEMBER">Bill families via a billing member</SelectItem>
                  <SelectItem value="BILL_MEMBERS_INDIVIDUALLY">Bill members individually</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {/* Save the mode with the last-SAVED due days (data.settings), not the
                possibly-dirty input, so switching the mode never silently
                persists an unsaved due-days edit. Due days are changed only via
                the separate "Save due days" button above. */}
            <ViewOnlyActionButton canEdit={canEditFinance} describeReason={false} type="button" variant="outline" disabled={working || !data} onClick={() => { if (!data) return; void post({ action: "UPDATE_SETTINGS", invoiceDueDays: data.settings.invoiceDueDays, familyBillingMode }); }}>Save billing mode</ViewOnlyActionButton>
          </div>
          <p className="text-sm text-muted-foreground">
            {familyBillingMode === "BILL_FAMILY_VIA_BILLING_MEMBER"
              ? "Each family is invoiced once, to the billing member nominated on Membership & Joining Fees. Per-family fee schedules are allowed and families without an active billing member are flagged as exceptions."
              : "Every member is invoiced directly. The family billing members card is hidden, no billing-member exceptions are raised, and per-family fee schedules are disabled."}
          </p>
        </div>
        {mutationFeedback ? <Alert variant={mutationFeedback.kind === "success" ? "success" : "error"}>{mutationFeedback.text}</Alert> : null}
        {loadFeedback ? <Alert variant="error">{loadFeedback.text}</Alert> : null}
        {loading ? <Spinner label="Building subscription billing preview…" /> : data ? (
          <>
            <div className="grid gap-3 sm:grid-cols-4">
              <div><p className="text-xs text-muted-foreground">Charges</p><p className="text-xl font-semibold tabular-nums">{data.preview.entries.length}</p></div>
              <div><p className="text-xs text-muted-foreground">Preview total</p><p className="text-xl font-semibold tabular-nums">{formatCents(data.preview.totalCents)}</p></div>
              <div><p className="text-xs text-muted-foreground">Open exceptions</p><p className="text-xl font-semibold tabular-nums">{visibleExceptions.length}</p></div>
              <div><p className="text-xs text-muted-foreground">Due</p><p className="text-xl font-semibold tabular-nums">{data.preview.dueDays} days</p></div>
            </div>
            {data.preview.entries.length > 0 ? (
              <div className="space-y-2">
                {data.preview.entries.map((entry) => (
                  <div key={entry.key} className="rounded-md border p-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{entry.membershipTypeName} · {entry.recipient.name}</span><span className="tabular-nums">{formatCents(entry.chargedAmountCents)}</span></div>
                    <p className="text-muted-foreground">{entry.billingBasis.replaceAll("_", " ")} · {entry.coveredMonths}/12 months · covers {entry.coveredMembers.map((member) => member.name).join(", ")}{entry.xeroAccountCode ? ` · Xero ${entry.xeroAccountCode}${entry.xeroItemCode ? ` / ${entry.xeroItemCode}` : ""}` : ""}</p>
                    {/* #2161 (D2): a PER_FAMILY charge can be marked as already
                        invoiced when the operator knows an ambiguous legacy
                        invoice already covered the family. */}
                    {entry.billingBasis === "PER_FAMILY" && entry.familyGroupId ? (
                      markingFamilyGroupId === entry.familyGroupId ? (
                        <div className="mt-2 space-y-2 rounded-md border border-dashed p-2">
                          {/* #2264 — the "INV-…" example left the placeholder,
                              where it read as a note already typed, and folded
                              into the label clause that was already naming what
                              to write, so this row keeps ONE description. */}
                          <Label htmlFor={`mark-note-${entry.familyGroupId}`}>Note (optional) — e.g. the covering invoice number, INV-…</Label>
                          <Input id={`mark-note-${entry.familyGroupId}`} value={markNote} onChange={(event) => setMarkNote(event.target.value)} maxLength={500} />
                          <div className="flex flex-wrap gap-2">
                            <Button type="button" size="sm" disabled={working} onClick={() => void markFamily(entry.familyGroupId!)}>Confirm — mark as already invoiced</Button>
                            <Button type="button" size="sm" variant="outline" disabled={working} onClick={() => { setMarkingFamilyGroupId(null); setMarkNote(""); }}>Cancel</Button>
                          </div>
                        </div>
                      ) : (
                        <ViewOnlyActionButton canEdit={canEditFinance} describeReason={false} type="button" size="sm" variant="outline" className="mt-2" disabled={working} onClick={() => { setMarkingFamilyGroupId(entry.familyGroupId); setMarkNote(""); }}>Mark family as already invoiced</ViewOnlyActionButton>
                      )
                    ) : null}
                  </div>
                ))}
                <ViewOnlyActionButton canEdit={canEditFinance} describeReason={false} type="button" onClick={() => void confirmBatch()} disabled={working}>Confirm and queue annual batch</ViewOnlyActionButton>
              </div>
            ) : <Alert variant="info">No new charges are available for this preview. Existing immutable coverage is not regenerated.</Alert>}
            {(data.preview.exemptMembers ?? []).length > 0 ? (
              <details className="rounded-md border p-3 text-sm">
                <summary className="cursor-pointer font-medium">
                  Exempt ({(data.preview.exemptMembers ?? []).length}) — no subscription required by age tier
                </summary>
                <p className="mt-1 text-muted-foreground">
                  These members are in an age tier that does not require a paid subscription, so no annual fee is charged and no MISSING_FEE_SCHEDULE exception is raised. Confirming the batch records a NOT_REQUIRED subscription for the season.
                </p>
                <ul className="mt-2 space-y-1">
                  {(data.preview.exemptMembers ?? []).map((row) => (
                    <li key={row.memberId} className="flex flex-wrap items-center justify-between gap-2">
                      <span>{row.memberName}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {row.ageTier ? row.ageTier.replaceAll("_", " ") : "No age tier"}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {((data.preview.alreadyInvoiced ?? []).length + (data.preview.alreadyInvoicedFamilies ?? []).length) > 0 ? (
              <details className="rounded-md border p-3 text-sm">
                <summary className="cursor-pointer font-medium">
                  Already invoiced ({(data.preview.alreadyInvoiced ?? []).length + (data.preview.alreadyInvoicedFamilies ?? []).length}) — suppressed to avoid double-billing
                </summary>
                <p className="mt-1 text-muted-foreground">
                  These members already have a Xero invoice for this season, so they are not re-billed. Record payment against the existing invoice in Xero (or void it there to re-bill).
                </p>
                {(data.preview.alreadyInvoiced ?? []).length > 0 ? (
                  <ul className="mt-2 space-y-1">
                    {(data.preview.alreadyInvoiced ?? []).map((row) => (
                      <li key={row.memberId} className="flex flex-wrap items-center justify-between gap-2">
                        <span>{row.memberName}</span>
                        <span className="tabular-nums text-muted-foreground">
                          {row.xeroInvoiceNumber ?? "No Xero number"} · {row.status.replaceAll("_", " ")}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {(data.preview.alreadyInvoicedFamilies ?? []).length > 0 ? (
                  <ul className="mt-2 space-y-2">
                    {(data.preview.alreadyInvoicedFamilies ?? []).map((row) => (
                      <li key={row.familyGroupId} className="flex flex-wrap items-center justify-between gap-2">
                        <span>
                          {row.holderName ? `${row.holderName}’s family` : "Family"} — covers the whole family group ({row.membersCovered} {row.membersCovered === 1 ? "member" : "members"})
                          {row.operatorMarked ? (
                            <>
                              {" "}
                              <Badge variant="secondary">Operator marked</Badge>
                              {row.markerNote ? <span className="text-muted-foreground"> · {row.markerNote}</span> : null}
                            </>
                          ) : null}
                          {!row.operatorMarked && row.holderBasisUnresolvable ? (
                            <>
                              {" "}
                              <Badge variant="outline" title="The invoice holder's own membership fee basis could not be resolved, so the family is suppressed conservatively. Resolve the holder's type/fee or void the invoice to re-bill.">Unresolved basis</Badge>
                            </>
                          ) : null}
                        </span>
                        <span className="flex items-center gap-2">
                          <span className="tabular-nums text-muted-foreground">
                            {row.operatorMarked && !row.xeroInvoiceNumber
                              ? "Marked by operator"
                              : `${row.xeroInvoiceNumber ?? "No Xero number"}${row.status ? ` · ${row.status.replaceAll("_", " ")}` : ""}`}
                          </span>
                          {row.operatorMarked ? (
                            <ViewOnlyActionButton canEdit={canEditFinance} describeReason={false} type="button" size="sm" variant="outline" disabled={working} onClick={() => void unmarkFamily(row.familyGroupId)}>Unmark</ViewOnlyActionButton>
                          ) : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </details>
            ) : null}
            {visibleExceptions.length > 0 ? (
              <Alert variant="warning"><div className="space-y-1"><p className="font-medium">Billing exceptions — no invoice created</p>{visibleExceptions.map((item) => <p key={item.fingerprint}>{item.message}</p>)}</div></Alert>
            ) : null}
            {data.charges.length > 0 ? (
              <div className="space-y-2">
                <h3 className="font-medium">Durable charge queue</h3>
                {data.charges.map((charge) => (
                  <div key={charge.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm">
                    <div><p className="font-medium">{charge.membershipTypeName} · {charge.recipientName} · {formatCents(charge.chargedAmountCents)}</p><p className="text-muted-foreground">{charge.coverage.map((row) => row.memberName).join(", ")} · {charge.xeroInvoiceNumber ?? "No Xero number yet"}</p>{charge.lastErrorMessage ? <p className="text-danger">{charge.lastErrorMessage}</p> : null}</div>
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary">{charge.status.replaceAll("_", " ")}</Badge>
                      {charge.status === "EMAIL_FAILED" || charge.status === "CONFLICT" || charge.status === "QUEUED" || charge.status === "INVOICE_CREATED" ? <ViewOnlyActionButton canEdit={canEditFinance} describeReason={false} size="sm" variant="outline" disabled={working} onClick={() => void post({ action: "RETRY_CHARGE", chargeId: charge.id })}>{charge.status === "EMAIL_FAILED" ? <MailWarning className="mr-1 h-4 w-4" /> : charge.status === "CONFLICT" ? <AlertTriangle className="mr-1 h-4 w-4" /> : <CheckCircle2 className="mr-1 h-4 w-4" />} Retry</ViewOnlyActionButton> : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
