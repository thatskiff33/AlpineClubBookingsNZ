"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAdminAreaEditAccess, useAdminAreaViewAccess } from "@/hooks/use-admin-area-edit-access";
import { AdminViewOnlySectionBanner, ViewOnlyActionButton } from "@/components/admin/view-only-action";
import { PolicyFeedback } from "@/components/admin/booking-policies/policy-feedback";

type Scope = { scope: "member" | "booking"; id: string } | { scope: "club" };

export function XeroSyncNowButton({ target, onSynced }: { target: Scope; onSynced?: () => void | Promise<void> }) {
  const canEdit = useAdminAreaEditAccess("finance");
  const canView = useAdminAreaViewAccess("finance");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  async function sync() {
    if (canEdit !== true || busy) return;
    setBusy(true); setError(""); setSuccess("");
    try {
      const response = await fetch("/api/admin/xero/sync-now", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(target),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Sync could not finish. It is safe to retry.");
      setSuccess(result.message);
      await onSynced?.();
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sync could not finish. It is safe to retry.");
    } finally { setBusy(false); }
  }
  if (canView !== true) return null;
  return <section className="space-y-2" aria-label="Sync from Xero">
    <AdminViewOnlySectionBanner canEdit={canEdit}>Finance edit access is required to sync.</AdminViewOnlySectionBanner>
    <PolicyFeedback error={error} success={success} onClearError={() => setError("")} onClearSuccess={() => setSuccess("")} />
    <ViewOnlyActionButton canEdit={canEdit} describeReason={false} variant="outline" disabled={busy} onClick={() => void sync()}>
      {busy ? "Syncing from Xero…" : target.scope === "club" ? "Sync everything from Xero now" : "Sync from Xero now"}
    </ViewOnlyActionButton>
  </section>;
}
