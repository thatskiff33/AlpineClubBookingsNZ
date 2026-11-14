"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type BillingFamilyProps = {
  memberId: string;
  billingFamilyGroupId: string | null;
  familyGroups: { id: string; name: string | null }[];
  familyBillingMode: "BILL_FAMILY_VIA_BILLING_MEMBER" | "BILL_MEMBERS_INDIVIDUALLY";
  disabled?: boolean;
  /**
   * Whether the actor may change the billing family. The write goes to the
   * finance-area fee-configuration route, so this is keyed on finance edit
   * (#1997).
   */
  // Tri-state (#2065): `undefined` while the session resolves (neutral disabled).
  canEdit: boolean | undefined;
  onChange?: (billingFamilyGroupId: string | null) => void;
};

// Per-member billing family selector (#1932, E6). When a member belongs to more
// than one family group, an admin chooses which family's per-family fee covers
// them so annual billing no longer stalls on AMBIGUOUS_FAMILY. Greyed with a note
// when the club bills members individually (the selection is ignored then).
export function MemberBillingFamilyCard({
  memberId,
  billingFamilyGroupId,
  familyGroups,
  familyBillingMode,
  disabled,
  canEdit,
  onChange,
}: BillingFamilyProps) {
  const [value, setValue] = useState<string>(billingFamilyGroupId ?? "none");
  const [saving, setSaving] = useState(false);

  if (familyGroups.length === 0) return null;

  const individualMode = familyBillingMode === "BILL_MEMBERS_INDIVIDUALLY";
  const controlDisabled = saving || disabled || individualMode || !canEdit;

  async function save(next: string) {
    if (!canEdit) return;
    const previous = value;
    setValue(next);
    setSaving(true);
    try {
      const response = await fetch("/api/admin/fee-configuration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "SET_MEMBER_BILLING_FAMILY",
          memberId,
          billingFamilyGroupId: next === "none" ? null : next,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Failed to update billing family");
      toast.success("Billing family updated");
      onChange?.(next === "none" ? null : next);
    } catch (cause) {
      setValue(previous);
      toast.error(cause instanceof Error ? cause.message : "Failed to update billing family");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="px-6 pb-6 text-sm">
      <Label htmlFor={`billing-family-${memberId}`} className="text-muted-foreground">
        Billing family
      </Label>
      <div className="mt-1 max-w-md">
        <Select value={value} onValueChange={save} disabled={controlDisabled}>
          <SelectTrigger id={`billing-family-${memberId}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No selection</SelectItem>
            {familyGroups.map((group) => (
              <SelectItem key={group.id} value={group.id}>
                {group.name || "Unnamed family"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {individualMode
          ? "This club bills members individually, so the billing family is ignored."
          : familyGroups.length > 1
            ? "Chooses which family's per-family fee covers this member during annual billing."
            : "Only used when this member belongs to more than one family."}
      </p>
    </div>
  );
}
