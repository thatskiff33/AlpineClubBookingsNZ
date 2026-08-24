"use client";

import type { FamilyBillingMode } from "@prisma/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DollarSign, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldHint, describedByFieldHint, useFieldHint } from "@/components/ui/field-hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { parseDecimalDollarsToCents } from "@/lib/money-input";
import { useClubTime } from "@/components/club-time-provider";
import { useScrollToFeedback } from "@/hooks/use-scroll-to-feedback";
import { AdminViewOnlyNotice } from "@/components/admin/view-only-action";
import { XeroAccountSelect, XeroItemSelect } from "@/components/admin/xero-code-select";
import type { XeroAccount, XeroItem } from "@/lib/xero-admin-cache";

// The Joining Fees + Annual Membership Fees + Family billing sections of the
// consolidated /admin/fees console (#1933, E7). Moved verbatim from the former
// /admin/fee-configuration page (that route now redirects here). Every editable
// control gates on the finance:edit `canEdit` returned by
// /api/admin/fee-configuration, exactly as before — the historical finance area
// still owns these three sections even though the page admits bookings viewers
// too. Hut Fees is a sibling section gated on bookings:edit.

type FeeComponent = { id: string; label: string; amountCents: number; prorate: boolean; xeroAccountCode: string | null; xeroItemCode: string | null; sortOrder: number };
type Fee = { id: string; amountCents: number; effectiveFrom: string; effectiveTo: string | null; ageTier?: string | null; billingBasis?: string; prorationRule?: string; components?: FeeComponent[] };
// A draft component row in the fee editor (#1932, E6). Amounts are entered as NZD
// strings and converted to integer cents on save, exactly like the fee total.
type ComponentDraft = { label: string; amount: string; prorate: boolean; xeroAccountCode: string; xeroItemCode: string };
const defaultComponentDraft = (): ComponentDraft => ({ label: "Annual membership fee", amount: "", prorate: true, xeroAccountCode: "", xeroItemCode: "" });
/*
  #2264 — the component rows render inside a `.map()`, so a hook cannot be called
  per row (see the count contract on `useFieldHint`). Each row's hint id is
  derived from the row index — the same key the rows already use — and spelled
  exactly once here, so a typo cannot silently orphan a hint.
*/
const componentLabelHintId = (index: number) => `component-label-hint-${index}`;
const componentAmountHintId = (index: number) => `component-amount-hint-${index}`;
type JoiningFeeRow = Fee & { ageTier: string | null };
type Data = {
  canEdit: boolean;
  familyBillingMode: FamilyBillingMode;
  // Resolved default income account code for empty component Account fields
  // (#2068); paired with the account name from the live chart of accounts.
  defaultInvoiceAccountCode?: string | null;
  membershipTypes: Array<{ id: string; key: string; name: string; isActive: boolean; annualFees: Fee[]; joiningFees: JoiningFeeRow[] }>;
  familyGroups: Array<{
    id: string; name: string | null; billingMemberId: string | null; billingException: boolean;
    members: Array<{ id: string; firstName: string; lastName: string; email: string; active: boolean }>;
  }>;
};

// A joining fee keys on membership type x optional age tier; "FLAT" is the
// whole-type fee (the built-in Family type uses it).
const JOINING_TIERS = [
  { value: "FLAT", label: "Flat (all ages)" },
  { value: "ADULT", label: "Adult" },
  { value: "YOUTH", label: "Youth" },
  { value: "CHILD", label: "Child" },
  { value: "INFANT", label: "Infant" },
] as const;
const tierLabel = (tier: string | null) =>
  JOINING_TIERS.find((option) => option.value === (tier ?? "FLAT"))?.label ?? (tier ?? "Flat");
const dollars = (cents: number | null) => cents == null ? "Not configured" : new Intl.NumberFormat("en-NZ", { style: "currency", currency: "NZD" }).format(cents / 100);
const memberName = (member: { firstName: string; lastName: string }) => `${member.firstName} ${member.lastName}`.trim();
// The fee-level proration rule, in the same words as the editor's Proration
// select (#2068, finding 7). Rendered on saved fees so the display can never
// contradict the stored rule.
const PRORATION_LABELS: Record<string, string> = {
  NONE: "Full annual fee",
  REMAINING_MONTHS_INCLUSIVE: "Remaining months, including decision month",
};
const prorationLabel = (rule: string | null | undefined) => PRORATION_LABELS[rule ?? "NONE"] ?? "Full annual fee";
// A component is only ever prorated when the fee-level rule prorates AND the
// component opts in; a "Full annual fee" (NONE) rule always charges in full,
// regardless of the stored per-component flag, so display "full" (#2068).
const componentIsProrated = (fee: Fee, component: FeeComponent) =>
  (fee.prorationRule ?? "NONE") !== "NONE" && component.prorate;

export function FinanceFeesSections({ financeCanEdit }: { financeCanEdit?: boolean } = {}) {
  // The default "effective from" for a new fee is the CLUB's today, and it has
  // to be: the server reads these windows in club time, so seeding them from
  // the build's `NEXT_PUBLIC_TZ` — fixed at build time, not read from the club's
  // persisted setting — made a fee start a day early or late. It also moved
  // from module scope into the
  // component — evaluated at import, "today" was whatever day the tab was first
  // opened, and stayed that day across midnight (CT-4, #2870; INV-CONFIG-002).
  const clubTime = useClubTime();
  const today: string = clubTime.today();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Cross-area read: /api/admin/fee-configuration is finance-gated, so a
  // bookings-only operator on the shared /admin/fees console gets a 403 here.
  // Surface that as a friendly read-only notice instead of a raw fetch-failed
  // error (E7 review, Lens-A F1). The read API area is intentionally unchanged.
  const [forbidden, setForbidden] = useState(false);
  // Xero reference data for the component Account/Item pickers (#2068). Fetched
  // via the admin-gated proxy endpoints (no Xero secrets ever reach the client);
  // a load error surfaces an amber notice and enables manual-code entry so the
  // editor never hard-blocks when Xero is disconnected.
  const [accounts, setAccounts] = useState<XeroAccount[]>([]);
  const [items, setItems] = useState<XeroItem[]>([]);
  const [coaError, setCoaError] = useState<string | null>(null);
  const [itemsError, setItemsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [membershipTypeId, setMembershipTypeId] = useState("");
  const [membershipTier, setMembershipTier] = useState<string>("FLAT");
  const [membershipAmount, setMembershipAmount] = useState("");
  const [billingBasis, setBillingBasis] = useState("PER_MEMBER");
  const [prorationRule, setProrationRule] = useState("NONE");
  const [membershipFrom, setMembershipFrom] = useState(today);
  const [membershipTo, setMembershipTo] = useState("");
  const [joiningTypeId, setJoiningTypeId] = useState("");
  const [joiningTier, setJoiningTier] = useState<string>("ADULT");
  const [entranceAmount, setEntranceAmount] = useState("");
  const [entranceFrom, setEntranceFrom] = useState(today);
  const [entranceTo, setEntranceTo] = useState("");
  const [editingMembershipFeeId, setEditingMembershipFeeId] = useState<string | null>(null);
  // Component rows for the annual-fee editor (#1932, E6). Sent as the reconciled
  // `components` array on save; a single row mirrors the fee total automatically.
  const [componentRows, setComponentRows] = useState<ComponentDraft[]>([defaultComponentDraft()]);
  const [editingEntranceFeeId, setEditingEntranceFeeId] = useState<string | null>(null);
  // Per-section edit-mode toggles: each section loads read-only and only exposes
  // its controls once the operator clicks Edit (repo-standard local-boolean +
  // state-mirror pattern; see admin/lodge AccountCard). No API call fires until
  // that section's own Save/commit button.
  const [membershipEditing, setMembershipEditing] = useState(false);
  const [entranceEditing, setEntranceEditing] = useState(false);
  const [familyEditing, setFamilyEditing] = useState(false);
  // Staged family billing selections. Mirrors the saved billing member per group
  // while editing so the Select no longer writes on change; committed on Save,
  // discarded on Cancel.
  const [stagedBilling, setStagedBilling] = useState<Record<string, string | null>>({});
  const [deleteTarget, setDeleteTarget] = useState<{ action: "DELETE_MEMBERSHIP_FEE" | "DELETE_JOINING_FEE"; id: string; label: string } | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const { scrollToError } = useScrollToFeedback();
  // #2264 — example amounts move out of the placeholders (grey text inside a
  // money box reads as an amount already entered) and into hints under each
  // field.
  const entranceAmountHint = useFieldHint();
  const membershipAmountHint = useFieldHint();

  const load = useCallback(async () => {
    const response = await fetch("/api/admin/fee-configuration");
    if (response.status === 403) {
      setForbidden(true);
      setError(null);
      return;
    }
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Failed to load fee configuration");
    setForbidden(false);
    setData(body);
  }, []);
  useEffect(() => { load().catch((cause) => setError(cause instanceof Error ? cause.message : "Failed to load")); }, [load]);
  // Load the Xero account/item lists for the component pickers on mount (#2068).
  // Mirrors FinanceReportMappingsPanel's fetch/amber-fallback pattern; the two
  // requests are independent so one failing still lets the other populate.
  useEffect(() => {
    let cancelled = false;
    async function loadXeroReference() {
      try {
        const response = await fetch("/api/admin/xero/chart-of-accounts", { credentials: "same-origin" });
        const body = await response.json();
        if (!response.ok || !Array.isArray(body.accounts)) throw new Error(body?.error ?? "Failed to load Xero chart of accounts");
        if (!cancelled) setAccounts(body.accounts);
      } catch (cause) {
        if (!cancelled) { setAccounts([]); setCoaError(cause instanceof Error ? cause.message : "Failed to load Xero chart of accounts"); }
      }
      try {
        const response = await fetch("/api/admin/xero/items", { credentials: "same-origin" });
        const body = await response.json();
        if (!response.ok || !Array.isArray(body.items)) throw new Error(body?.error ?? "Failed to load Xero items");
        if (!cancelled) setItems(body.items);
      } catch (cause) {
        if (!cancelled) { setItems([]); setItemsError(cause instanceof Error ? cause.message : "Failed to load Xero items"); }
      }
    }
    void loadXeroReference();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!membershipTypeId && data?.membershipTypes[0]) setMembershipTypeId(data.membershipTypes[0].id);
    if (!joiningTypeId && data?.membershipTypes[0]) setJoiningTypeId(data.membershipTypes[0].id);
  }, [data, membershipTypeId, joiningTypeId]);
  useEffect(() => { if (error) scrollToError(errorRef); }, [error, scrollToError]);

  const exceptions = useMemo(() => data?.familyGroups.filter((group) => group.billingException) ?? [], [data]);
  // When the club bills members individually there is no family-billing surface:
  // the card is hidden and per-family fee schedules are disallowed. The server
  // enforces both; these flags only drive what the operator sees.
  const familyBillingActive = data?.familyBillingMode === "BILL_FAMILY_VIA_BILLING_MEMBER";
  const hasPerFamilySchedule = useMemo(
    () => data?.membershipTypes.some((type) => type.annualFees.some((fee) => fee.billingBasis === "PER_FAMILY")) ?? false,
    [data],
  );
  // The empty-Account placeholder: the resolved default income account (code +
  // name) that the invoice line will use when a component leaves Account blank
  // (#2068). The code comes from the GET payload (null when subscriptionIncome
  // is not explicitly configured — the invoice build would refuse to bill, so we
  // say "not configured" rather than advertise a code that won't apply, F1). The
  // name is resolved from the live chart of accounts when available.
  const defaultAccountLabel = useMemo(() => {
    const code = data?.defaultInvoiceAccountCode ?? null;
    if (!code) return "Default: not configured";
    const account = accounts.find((candidate) => candidate.code.toUpperCase() === code.toUpperCase());
    return account ? `Default: ${code} — ${account.name}` : `Default: ${code}`;
  }, [data?.defaultInvoiceAccountCode, accounts]);
  async function mutate(payload: Record<string, unknown>, options?: { silent?: boolean }) {
    setSaving(true); setError(null);
    try {
      const response = await fetch("/api/admin/fee-configuration", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Failed to save fee configuration");
      setData(body);
      // The family-billing loop suppresses per-call success toasts and fires one
      // summary instead; errors still toast so a mid-loop failure is visible.
      const action = String(payload.action);
      if (!options?.silent) toast.success(action.startsWith("DELETE_") ? "Fee schedule deleted" : action === "SET_FAMILY_BILLING_MEMBER" ? "Billing member updated" : "Fee schedule saved");
      return true;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Failed to save";
      setError(message);
      toast.error(message);
      return false;
    }
    finally { setSaving(false); }
  }
  function resetMembershipForm() {
    setEditingMembershipFeeId(null); setMembershipTier("FLAT"); setMembershipAmount(""); setBillingBasis("PER_MEMBER");
    setProrationRule("NONE"); setMembershipFrom(today); setMembershipTo("");
    setComponentRows([defaultComponentDraft()]);
  }
  const updateComponentRow = (index: number, patch: Partial<ComponentDraft>) =>
    setComponentRows((rows) => rows.map((row, i) => i === index ? { ...row, ...patch } : row));
  const addComponentRow = () =>
    setComponentRows((rows) => [...rows, { label: "", amount: "", prorate: true, xeroAccountCode: "", xeroItemCode: "" }]);
  const removeComponentRow = (index: number) =>
    setComponentRows((rows) => rows.length <= 1 ? rows : rows.filter((_, i) => i !== index));
  // Live reconciliation total for the components editor. Σ of the parsed
  // component cents; a single row mirrors the fee total, so it always reconciles.
  const parsedFeeCents = parseDecimalDollarsToCents(membershipAmount);
  const componentsTotalCents = componentRows.length === 1
    ? (parsedFeeCents ?? 0)
    : componentRows.reduce((sum, row) => sum + (parseDecimalDollarsToCents(row.amount) ?? 0), 0);
  const componentsReconcile = billingBasis === "NO_INVOICE" || parsedFeeCents == null || componentsTotalCents === parsedFeeCents;
  function resetEntranceForm() {
    setEditingEntranceFeeId(null); setJoiningTier("ADULT"); setEntranceAmount(""); setEntranceFrom(today); setEntranceTo("");
  }
  function cancelMembershipEditing() { resetMembershipForm(); setMembershipEditing(false); }
  function cancelEntranceEditing() { resetEntranceForm(); setEntranceEditing(false); }
  function startFamilyEditing() {
    setStagedBilling(Object.fromEntries((data?.familyGroups ?? []).map((group) => [group.id, group.billingMemberId])));
    setFamilyEditing(true);
  }
  function cancelFamilyEditing() { setStagedBilling({}); setFamilyEditing(false); }
  async function saveFamilyBilling() {
    const changed = (data?.familyGroups ?? []).filter((group) => (stagedBilling[group.id] ?? null) !== (group.billingMemberId ?? null));
    for (const group of changed) {
      // Same SET_FAMILY_BILLING_MEMBER payload as before; only the timing moved
      // from onValueChange to this Save. One call per changed family (unchanged
      // API contract). Stop on the first failure so staged edits are preserved.
      // Suppress the per-call toast; a single summary fires once the loop clears.
      const saved = await mutate({ action: "SET_FAMILY_BILLING_MEMBER", familyGroupId: group.id, billingMemberId: stagedBilling[group.id] ?? null }, { silent: true });
      if (!saved) return;
    }
    setStagedBilling({}); setFamilyEditing(false);
    if (changed.length > 0) toast.success("Billing members updated");
  }
  const billingMemberLabel = (group: Data["familyGroups"][number]) => {
    if (!group.billingMemberId) return "No billing member";
    const member = group.members.find((candidate) => candidate.id === group.billingMemberId);
    return member ? `${memberName(member)} · ${member.email}${member.active ? "" : " (inactive)"}` : "No billing member";
  };
  function saveMembershipFee() {
    const amountCents = parseDecimalDollarsToCents(membershipAmount);
    if (amountCents == null) { setError("Enter an NZD amount with no more than two decimal places."); return; }
    // Build the reconciled components array (#1932, E6). NO_INVOICE fees carry no
    // components. A single component mirrors the fee total; multiple components
    // are parsed individually (the server is the final Σ==total validator).
    let components: Array<{ label: string; amountCents: number; prorate: boolean; xeroAccountCode: string | null; xeroItemCode: string | null; sortOrder: number }> = [];
    if (billingBasis !== "NO_INVOICE") {
      const built: typeof components = [];
      for (let index = 0; index < componentRows.length; index += 1) {
        const row = componentRows[index];
        const rowCents = componentRows.length === 1 ? amountCents : parseDecimalDollarsToCents(row.amount);
        if (rowCents == null) { setError("Enter a valid NZD amount for each fee component."); return; }
        built.push({
          label: row.label.trim() || "Annual membership fee",
          amountCents: rowCents,
          prorate: row.prorate,
          xeroAccountCode: row.xeroAccountCode.trim() || null,
          xeroItemCode: row.xeroItemCode.trim() || null,
          sortOrder: index,
        });
      }
      components = built;
    }
    void mutate({
      action: editingMembershipFeeId ? "UPDATE_MEMBERSHIP_FEE" : "CREATE_MEMBERSHIP_FEE",
      // The tier is set only at create; UPDATE inherits the row's tier server-side.
      ...(editingMembershipFeeId ? { id: editingMembershipFeeId } : { membershipTypeId, ageTier: membershipTier === "FLAT" ? null : membershipTier }),
      amountCents, billingBasis, prorationRule, effectiveFrom: membershipFrom, effectiveTo: membershipTo || null,
      components,
    }).then((saved) => { if (saved) resetMembershipForm(); });
  }
  function saveEntranceFee() {
    const amountCents = parseDecimalDollarsToCents(entranceAmount);
    if (amountCents == null) { setError("Enter an NZD amount with no more than two decimal places."); return; }
    void mutate({
      action: editingEntranceFeeId ? "UPDATE_JOINING_FEE" : "CREATE_JOINING_FEE",
      ...(editingEntranceFeeId
        ? { id: editingEntranceFeeId }
        : { membershipTypeId: joiningTypeId, ageTier: joiningTier === "FLAT" ? null : joiningTier }),
      amountCents, effectiveFrom: entranceFrom, effectiveTo: entranceTo || null,
    }).then((saved) => { if (saved) resetEntranceForm(); });
  }

  if (forbidden) {
    return <div className="space-y-6">
      <AdminViewOnlyNotice canEdit={false}>
        You don&apos;t have permission to view this section. Joining fees and annual
        membership fees are managed by finance admins; ask a finance admin if you need
        to see fee schedules.
      </AdminViewOnlyNotice>
    </div>;
  }

  return <div className="space-y-6">
    {error && <div ref={errorRef}><Alert variant="error">{error}</Alert></div>}
    {/* Show the read-only hint immediately for a finance viewer while data loads
        (financeCanEdit is the server-computed finance:edit flag); once loaded,
        the API's own canEdit is authoritative. */}
    {((data && !data.canEdit) || (!data && financeCanEdit === false)) && <Alert>Finance view access is read-only. Ask a finance editor to change fee schedules or family billing members.</Alert>}
    {exceptions.length > 0 && <Alert variant="warning">
      <span>{exceptions.length} membered {exceptions.length === 1 ? "family has" : "families have"} no billing member. They will be omitted from family invoice generation.</span>
    </Alert>}

    <Card><CardHeader className="flex flex-row items-center justify-between"><div className="space-y-1"><CardTitle>Joining fees</CardTitle><CardDescription>the one-off fee a new member pays to join, per membership type and age tier</CardDescription></div>{data?.canEdit && !entranceEditing && <Button variant="outline" size="sm" aria-label="Edit joining fees" onClick={() => setEntranceEditing(true)}>Edit</Button>}</CardHeader><CardContent className="space-y-5">
      <Alert>
        <span>Family joining fees now apply only to members assigned the <strong>Family</strong> membership type. Applicants who previously matched the automatic family heuristic (two adults plus a dependent) are now invoiced their own membership type&apos;s joining fee. A type with no rows raises no joining fee.</span>
      </Alert>
      {entranceEditing && <>
        <div className="grid gap-3 md:grid-cols-5">
          <div><Label htmlFor="joining-type">Membership type</Label><Select value={joiningTypeId} onValueChange={setJoiningTypeId} disabled={!!editingEntranceFeeId}><SelectTrigger id="joining-type"><SelectValue /></SelectTrigger><SelectContent>{data?.membershipTypes.map((type) => <SelectItem key={type.id} value={type.id}>{type.name}</SelectItem>)}</SelectContent></Select></div>
          <div><Label htmlFor="joining-tier">Age tier</Label><Select value={joiningTier} onValueChange={setJoiningTier} disabled={!!editingEntranceFeeId}><SelectTrigger id="joining-tier"><SelectValue /></SelectTrigger><SelectContent>{JOINING_TIERS.map((tier) => <SelectItem key={tier.value} value={tier.value}>{tier.label}</SelectItem>)}</SelectContent></Select></div>
          <div><Label htmlFor="entrance-amount">Amount (NZD)</Label><Input id="entrance-amount" inputMode="decimal" value={entranceAmount} onChange={(event) => setEntranceAmount(event.target.value)} {...entranceAmountHint.fieldProps} /><FieldHint {...entranceAmountHint.hintProps}>Example: 75.00</FieldHint></div>
          <div><Label htmlFor="entrance-from">Effective from</Label><Input id="entrance-from" type="date" value={entranceFrom} onChange={(event) => setEntranceFrom(event.target.value)} /></div>
          <div><Label htmlFor="entrance-to">Effective to (optional)</Label><Input id="entrance-to" type="date" value={entranceTo} onChange={(event) => setEntranceTo(event.target.value)} /></div>
        </div>
        <div className="flex gap-2"><Button disabled={saving || !joiningTypeId} onClick={saveEntranceFee}>{editingEntranceFeeId ? "Update joining fee" : "Add joining fee"}</Button>{editingEntranceFeeId && <Button variant="outline" onClick={resetEntranceForm}>Cancel edit</Button>}<Button variant="ghost" disabled={saving} onClick={cancelEntranceEditing}>Close section</Button></div>
      </>}
      <div className="space-y-3">{data?.membershipTypes.map((type) => <div key={type.id} className="rounded-md border p-3"><div className="font-medium">{type.name}{!type.isActive && <span className="ml-2 text-sm text-muted-foreground">(archived)</span>}</div>{type.joiningFees.length === 0 ? <p className="text-sm text-muted-foreground">No joining fee</p> : type.joiningFees.map((fee) => <div key={fee.id} className="mt-2 flex flex-wrap items-center gap-2 text-sm"><Badge variant="outline">{tierLabel(fee.ageTier)}</Badge><span>{dollars(fee.amountCents)} · {fee.effectiveFrom} – {fee.effectiveTo ?? "ongoing"}</span>{entranceEditing && <><Button size="icon" variant="ghost" aria-label={`Edit ${type.name} ${tierLabel(fee.ageTier)} joining fee`} disabled={saving} onClick={() => { setEditingEntranceFeeId(fee.id); setJoiningTypeId(type.id); setJoiningTier(fee.ageTier ?? "FLAT"); setEntranceAmount((fee.amountCents / 100).toFixed(2)); setEntranceFrom(fee.effectiveFrom); setEntranceTo(fee.effectiveTo ?? ""); }}><Pencil className="h-4 w-4" /></Button><Button size="icon" variant="ghost" aria-label={`Delete ${type.name} ${tierLabel(fee.ageTier)} joining fee`} disabled={saving} onClick={() => setDeleteTarget({ action: "DELETE_JOINING_FEE", id: fee.id, label: `${type.name} ${tierLabel(fee.ageTier)} joining fee from ${fee.effectiveFrom}` })}><Trash2 className="h-4 w-4" /></Button></>}</div>)}</div>)}</div>
    </CardContent></Card>

    <Card><CardHeader className="flex flex-row items-center justify-between"><div className="space-y-1"><CardTitle>Annual membership fees</CardTitle><CardDescription>the fee to be a paid-up member of the club</CardDescription></div>{data?.canEdit && !membershipEditing && <Button variant="outline" size="sm" aria-label="Edit membership fees" onClick={() => setMembershipEditing(true)}>Edit</Button>}</CardHeader><CardContent className="space-y-5">
      <p className="text-sm text-muted-foreground">Amounts are GST-inclusive integer cents after saving. Effective ranges are inclusive and may not overlap for one membership type.</p>
      {!familyBillingActive && hasPerFamilySchedule && <Alert variant="warning">
        <span>This club bills members individually, but one or more schedules still use the per-family basis. Those schedules cannot be invoiced and are not reinterpreted; edit each one to a per-member or no-invoice basis. Per-family can only be chosen after switching the family billing mode on the subscription billing settings.</span>
      </Alert>}
      {membershipEditing && <>
        <div className="grid gap-3 md:grid-cols-3">
          <div><Label htmlFor="membership-type">Membership type</Label><Select value={membershipTypeId} onValueChange={setMembershipTypeId} disabled={!!editingMembershipFeeId}><SelectTrigger id="membership-type"><SelectValue /></SelectTrigger><SelectContent>{data?.membershipTypes.map((type) => <SelectItem key={type.id} value={type.id}>{type.name}</SelectItem>)}</SelectContent></Select></div>
          {/* Per-age-tier annual fees (#2067). Flat (all ages) is the fallback
              row; per-tier rows win at resolution. Per-family fees are flat-only,
              so the tier is forced to Flat and locked while PER_FAMILY is chosen. */}
          <div><Label htmlFor="membership-tier">Age tier</Label><Select value={membershipTier} onValueChange={(value) => { setMembershipTier(value); if (value !== "FLAT" && billingBasis === "PER_FAMILY") setBillingBasis("PER_MEMBER"); }} disabled={!!editingMembershipFeeId || billingBasis === "PER_FAMILY"}><SelectTrigger id="membership-tier"><SelectValue /></SelectTrigger><SelectContent>{JOINING_TIERS.map((tier) => <SelectItem key={tier.value} value={tier.value}>{tier.label}</SelectItem>)}</SelectContent></Select></div>
          <div><Label htmlFor="membership-amount">Annual amount (NZD)</Label><Input id="membership-amount" inputMode="decimal" value={membershipAmount} onChange={(event) => setMembershipAmount(event.target.value)} disabled={billingBasis === "NO_INVOICE"} {...membershipAmountHint.fieldProps} /><FieldHint {...membershipAmountHint.hintProps}>{billingBasis === "NO_INVOICE" ? "A no-invoice fee raises no amount." : "Example: 150.00"}</FieldHint></div>
          <div><Label htmlFor="billing-basis">Billing basis</Label><Select value={billingBasis} onValueChange={(value) => { setBillingBasis(value); if (value === "NO_INVOICE") setMembershipAmount("0"); if (value === "PER_FAMILY") setMembershipTier("FLAT"); }}><SelectTrigger id="billing-basis"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="PER_MEMBER">Per member</SelectItem>{familyBillingActive && membershipTier === "FLAT" && <SelectItem value="PER_FAMILY">Per family</SelectItem>}<SelectItem value="NO_INVOICE">No invoice</SelectItem></SelectContent></Select></div>
          <div><Label htmlFor="proration-rule">Proration</Label><Select value={prorationRule} onValueChange={setProrationRule}><SelectTrigger id="proration-rule"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="NONE">Full annual fee</SelectItem><SelectItem value="REMAINING_MONTHS_INCLUSIVE">Remaining months, including decision month</SelectItem></SelectContent></Select></div>
          <div><Label htmlFor="membership-from">Effective from</Label><Input id="membership-from" type="date" value={membershipFrom} onChange={(event) => setMembershipFrom(event.target.value)} /></div>
          <div><Label htmlFor="membership-to">Effective to (optional)</Label><Input id="membership-to" type="date" value={membershipTo} onChange={(event) => setMembershipTo(event.target.value)} /></div>
        </div>
        {billingBasis === "NO_INVOICE"
          ? <p className="text-sm text-muted-foreground">A no-invoice fee has no invoice-line components.</p>
          : <div className="space-y-2 rounded-md border p-3">
              <div className="flex items-center justify-between">
                <Label>Invoice-line components</Label>
                <span className={componentsReconcile ? "text-sm text-muted-foreground" : "text-sm text-warning-11"}>
                  Components total {dollars(componentsTotalCents)}{componentsReconcile ? "" : ` · must equal the fee amount ${dollars(parsedFeeCents)}`}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">Each component is its own Xero invoice line. A single component uses the fee total. Components must sum to the fee amount. Leave Account or Item empty to use the resolved default.</p>
              {/* Loads asynchronously, so announce it politely to screen readers
                  (#2068, U1). */}
              {(coaError || itemsError) && <div role="status" className="rounded-md border border-warning-6 bg-warning-3 px-3 py-2 text-sm text-warning-11">
                Could not load the Xero {coaError && itemsError ? "chart of accounts and item list" : coaError ? "chart of accounts" : "item list"}. You can still type account and item codes manually; reconnect Xero to pick from the live lists.
              </div>}
              {componentRows.map((row, index) =><div key={index} className="grid items-end gap-2 md:grid-cols-[2fr_1fr_auto_1fr_1fr_auto]">
                <div><Label htmlFor={`component-label-${index}`} className="text-xs">Label</Label><Input id={`component-label-${index}`} value={row.label} onChange={(event) => updateComponentRow(index, { label: event.target.value })} aria-describedby={describedByFieldHint(componentLabelHintId(index))} /><FieldHint id={componentLabelHintId(index)}>Example: Base membership</FieldHint></div>
                {/* A single component always mirrors the fee total and its box
                    is disabled, so that row's hint states what the amount is
                    rather than offering an example the operator cannot type
                    (#2264). */}
                <div><Label htmlFor={`component-amount-${index}`} className="text-xs">Amount (NZD)</Label><Input id={`component-amount-${index}`} inputMode="decimal" value={componentRows.length === 1 ? membershipAmount : row.amount} onChange={(event) => updateComponentRow(index, { amount: event.target.value })} disabled={componentRows.length === 1} aria-describedby={describedByFieldHint(componentAmountHintId(index))} /><FieldHint id={componentAmountHintId(index)}>{componentRows.length === 1 ? "Taken from the annual fee amount above." : "Example: 120.00"}</FieldHint></div>
                {/* A "Full annual fee" (NONE) rule prorates nothing, so the
                    per-component Prorate opt-in is replaced with a read-only
                    "Prorate n/a" placeholder when the rule is NONE (#2068,
                    decision 1). Stored values are untouched. */}
                {prorationRule === "NONE"
                  ? <span className="pb-2 text-xs text-muted-foreground" aria-hidden="true">Prorate n/a</span>
                  : <label className="flex items-center gap-1 pb-2 text-xs"><input type="checkbox" checked={row.prorate} onChange={(event) => updateComponentRow(index, { prorate: event.target.checked })} />Prorate</label>}
                <div><Label htmlFor={`component-account-${index}`} className="text-xs">Account (optional)</Label><XeroAccountSelect accounts={accounts} value={row.xeroAccountCode} onChange={(code) => updateComponentRow(index, { xeroAccountCode: code })} emptyLabel={defaultAccountLabel} id={`component-account-${index}`} ariaLabel={`Account (optional) for component ${index + 1}`} allowManualCodes={accounts.length === 0 || Boolean(coaError)} /></div>
                <div><Label htmlFor={`component-item-${index}`} className="text-xs">Item (optional)</Label><XeroItemSelect items={items} value={row.xeroItemCode} onChange={(code) => updateComponentRow(index, { xeroItemCode: code })} emptyLabel="Default: no item" id={`component-item-${index}`} ariaLabel={`Item (optional) for component ${index + 1}`} allowManualCodes={items.length === 0 || Boolean(itemsError)} /></div>
                <Button type="button" size="icon" variant="ghost" aria-label={`Remove component ${index + 1}`} disabled={componentRows.length <= 1} onClick={() => removeComponentRow(index)}><Trash2 className="h-4 w-4" /></Button>
              </div>)}
              <Button type="button" variant="outline" size="sm" onClick={addComponentRow}>Add component</Button>
            </div>}
        <div className="flex gap-2"><Button disabled={saving || !membershipTypeId} onClick={saveMembershipFee}><DollarSign className="mr-1 h-4 w-4" />{editingMembershipFeeId ? "Update annual fee" : "Add annual fee"}</Button>{editingMembershipFeeId && <Button variant="outline" onClick={resetMembershipForm}>Cancel edit</Button>}<Button variant="ghost" disabled={saving} onClick={cancelMembershipEditing}>Close section</Button></div>
      </>}
      <div className="space-y-3">{data?.membershipTypes.map((type) => <div key={type.id} className="rounded-md border p-3"><div className="font-medium">{type.name}</div>{type.annualFees.length === 0 ? <p className="text-sm text-muted-foreground">Not configured</p> : type.annualFees.map((fee) => <div key={fee.id}><div className="mt-2 flex flex-wrap items-center gap-2 text-sm"><Badge variant="outline">{tierLabel(fee.ageTier ?? null)}</Badge><Badge variant="outline">{dollars(fee.amountCents)}</Badge><span>{fee.billingBasis?.replaceAll("_", " ")}</span>{fee.billingBasis !== "NO_INVOICE" && <Badge variant="outline">{prorationLabel(fee.prorationRule)}</Badge>}<span>{fee.effectiveFrom} – {fee.effectiveTo ?? "ongoing"}</span>{membershipEditing && <><Button size="icon" variant="ghost" aria-label={`Edit ${type.name} ${tierLabel(fee.ageTier ?? null)} fee`} disabled={saving} onClick={() => { setEditingMembershipFeeId(fee.id); setMembershipTypeId(type.id); setMembershipTier(fee.ageTier ?? "FLAT"); setMembershipAmount((fee.amountCents / 100).toFixed(2)); setBillingBasis(fee.billingBasis ?? "PER_MEMBER"); setProrationRule(fee.prorationRule ?? "NONE"); setMembershipFrom(fee.effectiveFrom); setMembershipTo(fee.effectiveTo ?? ""); setComponentRows(fee.components && fee.components.length > 0 ? fee.components.map((component) => ({ label: component.label, amount: (component.amountCents / 100).toFixed(2), prorate: component.prorate, xeroAccountCode: component.xeroAccountCode ?? "", xeroItemCode: component.xeroItemCode ?? "" })) : [defaultComponentDraft()]); }}><Pencil className="h-4 w-4" /></Button><Button size="icon" variant="ghost" aria-label={`Delete ${type.name} ${tierLabel(fee.ageTier ?? null)} fee`} disabled={saving} onClick={() => setDeleteTarget({ action: "DELETE_MEMBERSHIP_FEE", id: fee.id, label: `${type.name} ${tierLabel(fee.ageTier ?? null)} annual fee from ${fee.effectiveFrom}` })}><Trash2 className="h-4 w-4" /></Button></>}</div>{fee.components && fee.components.length > 0 && <ul className="mt-1 space-y-0.5 pl-3 text-xs text-muted-foreground">{fee.components.map((component) => <li key={component.id}>{component.label} · {dollars(component.amountCents)} · {componentIsProrated(fee, component) ? "prorated" : "full"}{component.xeroAccountCode ? ` · acct ${component.xeroAccountCode}` : ""}{component.xeroItemCode ? ` · item ${component.xeroItemCode}` : ""}</li>)}</ul>}</div>)}</div>)}</div>
    </CardContent></Card>

    {familyBillingActive && <Card><CardHeader className="flex flex-row items-center justify-between"><CardTitle>Family billing members</CardTitle>{data?.canEdit && !familyEditing && <Button variant="outline" size="sm" aria-label="Edit family billing" onClick={startFamilyEditing}>Edit</Button>}</CardHeader><CardContent className="space-y-3">
      <p className="text-sm text-muted-foreground">Choose the explicit invoice recipient for each membered family. Login holder and family admin are not inferred.</p>
      {data?.familyGroups.length === 0 && <p className="text-sm text-muted-foreground">No membered families.</p>}
      {data?.familyGroups.map((group) => { const selectId = `family-billing-${group.id}`; return <div key={group.id} className="grid items-center gap-2 rounded-md border p-3 md:grid-cols-[1fr_2fr]"><div><div className="font-medium">{group.name || "Unnamed family"}</div>{group.billingException && <span className="text-sm text-warning-11">Billing exception</span>}</div><div>{familyEditing ? <><Label htmlFor={selectId}>Billing member</Label><Select value={stagedBilling[group.id] ?? "none"} onValueChange={(value) => setStagedBilling((prev) => ({ ...prev, [group.id]: value === "none" ? null : value }))} disabled={saving}><SelectTrigger id={selectId}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">No billing member</SelectItem>{group.members.map((member) => <SelectItem key={member.id} value={member.id} disabled={!member.active}>{memberName(member)} · {member.email}{member.active ? "" : " (inactive)"}</SelectItem>)}</SelectContent></Select></> : <><div className="text-sm text-muted-foreground">Billing member</div><p className="text-sm">{billingMemberLabel(group)}</p></>}</div></div>; })}
      {familyEditing && <div className="flex gap-2"><Button disabled={saving} onClick={() => void saveFamilyBilling()}>Save billing members</Button><Button variant="ghost" disabled={saving} onClick={cancelFamilyEditing}>Cancel</Button></div>}
    </CardContent></Card>}
    <Dialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open && !saving) setDeleteTarget(null); }}>
      <DialogContent showCloseButton={false}>
        <DialogHeader><DialogTitle>Delete fee schedule?</DialogTitle><DialogDescription>Delete {deleteTarget?.label}? This removes configuration, not historical invoices.</DialogDescription></DialogHeader>
        <DialogFooter><Button variant="outline" disabled={saving} onClick={() => setDeleteTarget(null)}>Cancel</Button><Button variant="destructive" disabled={saving || !deleteTarget} onClick={async () => { if (!deleteTarget) return; if (await mutate({ action: deleteTarget.action, id: deleteTarget.id })) setDeleteTarget(null); }}>Delete fee</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
