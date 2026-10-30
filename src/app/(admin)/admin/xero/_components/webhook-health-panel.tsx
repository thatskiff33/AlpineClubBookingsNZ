"use client";

import { useState } from "react";
import { MIN_SILENT_WEBHOOK_HOURS, MAX_SILENT_WEBHOOK_HOURS, silentWebhookHoursSchema } from "@/lib/xero-webhook-policy";
import { useClubTime } from "@/components/club-time-provider";
import { requireInstant } from "@/lib/club-time";
import { AdminViewOnlySectionBanner, ViewOnlyActionButton } from "@/components/admin/view-only-action";
import { PolicyFeedback } from "@/components/admin/booking-policies/policy-feedback";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { ForbiddenSaveError, useSectionEditState } from "@/hooks/use-section-edit-state";
import { XeroSyncNowButton } from "@/components/admin/xero-sync-now-button";

type Health = { connected: boolean; silent: boolean; hours: number; lastReceivedAt: string | null };
const ENDPOINT = "/api/admin/xero/webhook-health";

export function WebhookHealthPanel() {
  const canEdit = useAdminAreaEditAccess("finance");
  const clubTime = useClubTime();
  const [health, setHealth] = useState<Health | null>(null);
  const section = useSectionEditState<{ hours: number }>({
    load: async (signal) => {
      const response = await fetch(ENDPOINT, { signal });
      if (!response.ok) throw new Error("Could not load webhook health.");
      const result: Health = await response.json();
      setHealth(result);
      return { hours: result.hours };
    },
    save: async (draft) => {
      const response = await fetch(ENDPOINT, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) });
      if (response.status === 403) throw new ForbiddenSaveError();
      if (!response.ok) throw new Error("Could not save the warning threshold.");
      const result: Health = await response.json();
      setHealth(result);
      return { hours: result.hours };
    },
    isValid: (draft) => silentWebhookHoursSchema.safeParse(draft.hours).success,
    successMessage: "Webhook warning threshold saved.",
  });
  return <section className="my-6 space-y-3 rounded-lg border p-4" {...section.sectionRegionProps}>
    <AdminViewOnlySectionBanner canEdit={canEdit}>Finance edit access is required to change webhook monitoring.</AdminViewOnlySectionBanner>
    <PolicyFeedback error={section.error} success={section.success} onClearError={() => section.setError("")} onClearSuccess={() => section.setSuccess("")} />
    <h2 className="text-lg font-semibold" {...section.titleProps}>Inbound sync and webhook health</h2>
    {section.loading && <p>Loading webhook health…</p>}
    {health && <>
      <p>Last webhook received: {health.lastReceivedAt ? <time dateTime={health.lastReceivedAt}>{clubTime.instantDateTime(requireInstant(health.lastReceivedAt))}</time> : "none recorded"}.</p>
      {health.silent && <p role="alert" className="rounded-md border border-warning-6 bg-warning-3 p-3 text-warning-11">No Xero webhook has arrived for more than {health.hours} hours. Check the webhook subscription in Xero; use sync now to catch up.</p>}
      <p className="text-sm text-muted-foreground">Sync now reads Xero using the scheduled reconciliation paths. It can take a few minutes.</p>
      <XeroSyncNowButton target={{ scope: "club" }} renderViewOnlyBanner={false} />
    </>}
    {section.draft && <div className="space-y-2">
      <Label htmlFor="xero-silent-hours">Warn after hours without a webhook</Label>
      <Input id="xero-silent-hours" className="max-w-40" type="number" min={MIN_SILENT_WEBHOOK_HOURS} max={MAX_SILENT_WEBHOOK_HOURS} value={section.draft.hours} disabled={!section.editing || section.saving || canEdit !== true} onChange={(event) => section.setDraft({ hours: Number(event.target.value) })} />
      {!section.editing ? <ViewOnlyActionButton canEdit={canEdit} describeReason={false} variant="outline" onClick={section.startEditing} {...section.editTriggerProps}>Edit</ViewOnlyActionButton> : <div className="flex gap-2">
        <ViewOnlyActionButton canEdit={canEdit} describeReason={false} disabled={!section.dirty || section.saving || !silentWebhookHoursSchema.safeParse(section.draft.hours).success} onClick={() => void section.save()}>Save</ViewOnlyActionButton>
        <Button variant="outline" disabled={section.saving} onClick={section.cancelEditing}>Cancel</Button>
      </div>}
    </div>}
  </section>;
}
