"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { AdminViewOnlySectionBanner, ViewOnlyActionButton } from "@/components/admin/view-only-action";
import { PolicyFeedback } from "@/components/admin/booking-policies/policy-feedback";
import { useClubTime } from "@/components/club-time-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { ForbiddenSaveError, useSectionEditState } from "@/hooks/use-section-edit-state";
import { privacyRetentionSettingsSchema, type PrivacyRetentionSettingsValues } from "@/lib/privacy-retention-shared";
import { formatClubInstantDate, formatStayDateOrNull, parseInstant } from "@/lib/club-time";

type PreviewGroup = {
  count: number;
  rows: { id: string; date: string | null; reasons?: string[] }[];
};
type Payload = {
  settings: PrivacyRetentionSettingsValues;
  preview: {
    emailLogs: PreviewGroup;
    rejectedApplications?: PreviewGroup;
    formerMembers?: PreviewGroup;
    blockedMembers?: PreviewGroup;
    undatedMembers?: PreviewGroup;
  };
  pageSize: number;
  canViewMembership: boolean;
};
const ENDPOINT = "/api/admin/privacy-retention";
const PERIOD_FIELDS = [
  ["emailLogRetentionYears", "Email logs (years)"],
  ["rejectedApplicationRetentionYears", "Rejected applications (years)"],
  ["formerMemberRetentionYears", "Former members after leaving (years)"],
] as const;
const SWITCH_FIELDS = [
  ["pruneLogsAndApplicationsEnabled", "Enable email log and rejected application pruning"],
  ["anonymiseMembersEnabled", "Enable former-member anonymisation"],
  ["sentryReplayEnabled", "Enable Sentry Session Replay"],
] as const;
const GROUPS = [
  ["emailLogs", "Email logs to delete", "Sent date"],
  ["rejectedApplications", "Rejected applications to delete", "Rejection date"],
  ["formerMembers", "Former members to anonymise", "Leaving date"],
  ["blockedMembers", "Former members blocked from anonymisation", "Leaving date"],
  ["undatedMembers", "Inactive members with no leaving date", "Leaving date"],
] as const;

export function PrivacyRetentionClient({ page }: { page: number }) {
  const canEdit = useAdminAreaEditAccess("support");
  const clubTime = useClubTime();
  const router = useRouter();
  const [payload, setPayload] = useState<Payload | null>(null);
  const [previewError, setPreviewError] = useState("");
  async function loadPayload(signal?: AbortSignal) {
    const response = await fetch(`${ENDPOINT}?page=${page}`, { signal, cache: "no-store" });
    if (!response.ok) throw new Error("Could not load the retention preview. Reload this page to try again.");
    const result = await response.json() as Payload;
    setPayload(result);
    return result;
  }
  const section = useSectionEditState<PrivacyRetentionSettingsValues>({
    load: async (signal) => (await loadPayload(signal)).settings,
    save: async (draft) => {
      const response = await fetch(ENDPOINT, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (response.status === 403) throw new ForbiddenSaveError();
      if (!response.ok) throw new Error("Could not save retention settings.");
      const saved = await response.json() as { settings: PrivacyRetentionSettingsValues };
      setPayload(null);
      setPreviewError("");
      try {
        await loadPayload();
      } catch {
        setPreviewError("Settings were saved, but the preview could not refresh. Reload this page before checking the list.");
      }
      return saved.settings;
    },
    isValid: (draft) => privacyRetentionSettingsSchema.safeParse(draft).success,
    successMessage: "Privacy and retention settings saved.",
  });
  const draft = section.draft;
  const editing = section.editing && canEdit === true;
  const maximumCount = payload ? Math.max(...Object.values(payload.preview).map((group) => group.count)) : 0;
  const hasNextPage = payload ? page * payload.pageSize < maximumCount : false;

  function displayDate(value: string | null, dateOnly: boolean) {
    if (value === null) return "no leaving date — set one to include";
    if (dateOnly) return formatStayDateOrNull(value, clubTime.format) ?? "Unknown date";
    const instant = parseInstant(value);
    return instant ? formatClubInstantDate(instant, clubTime.zone, clubTime.format) : "Unknown date";
  }

  return (
    <div className="space-y-8">
      <AdminPageHeader title="Privacy & Retention" description="Review what would be removed, then choose when automatic retention starts." />
      <section>
        <AdminViewOnlySectionBanner canEdit={canEdit} />
        <PolicyFeedback error={section.error} success={section.success} onClearError={() => section.setError("")} onClearSuccess={() => section.setSuccess("")} />
        <Card {...section.sectionRegionProps}>
          <CardHeader className="flex flex-row items-center justify-between gap-3">
            <CardTitle {...section.titleProps}>Retention settings</CardTitle>
            {!section.editing && <ViewOnlyActionButton {...section.editTriggerProps} canEdit={canEdit} describeReason={false} disabled={!draft || section.loading} onClick={section.startEditing}>Edit</ViewOnlyActionButton>}
          </CardHeader>
          <CardContent className="space-y-5">
            <p className="text-sm text-muted-foreground">Pruning and anonymisation ship off. Check the dry-run lists below before enabling either job. Changing a setting does not run a job immediately.</p>
            {section.loading ? <p>Loading retention settings and preview…</p> : draft ? <>
              <div className="grid gap-4 sm:grid-cols-3">
                {PERIOD_FIELDS.map(([field, label]) => <div key={field} className="space-y-2">
                  <Label htmlFor={field}>{label}</Label>
                  <Input id={field} type="number" min={privacyRetentionSettingsSchema.shape[field].minValue ?? undefined} max={privacyRetentionSettingsSchema.shape[field].maxValue ?? undefined} step={1} value={draft[field]} disabled={!editing || section.saving} onChange={(event) => section.setDraft({ [field]: Number(event.target.value) })} />
                </div>)}
              </div>
              <p className="text-sm text-muted-foreground">Former-member retention starts from the recorded leaving date. Members with no leaving date are never anonymised automatically. Financial records are retained.</p>
              <div className="space-y-3">
                {SWITCH_FIELDS.map(([field, label]) => <label key={field} className="flex items-start gap-3">
                  <input type="checkbox" checked={draft[field]} disabled={!editing || section.saving} aria-describedby={field === "sentryReplayEnabled" ? "replay-notice" : undefined} onChange={(event) => section.setDraft({ [field]: event.target.checked })} />
                  <span className="text-sm">{label}</span>
                </label>)}
              </div>
              <p id="replay-notice" className="rounded-md border border-warning-6 bg-warning-3 p-3 text-sm text-warning-11">Sentry Session Replay is off by default. Enabling it sends screen recordings to an overseas processor. Name Sentry Session Replay in your club&apos;s privacy notice before turning it on.</p>
              {section.editing && <div className="flex gap-3">
                <ViewOnlyActionButton canEdit={canEdit} describeReason={false} disabled={!section.dirty || !section.valid || section.saving} onClick={() => void section.save()}>{section.saving ? "Saving…" : "Save"}</ViewOnlyActionButton>
                <Button variant="outline" disabled={section.saving} onClick={section.cancelEditing}>Cancel</Button>
              </div>}
            </> : null}
          </CardContent>
        </Card>
      </section>
      <section aria-labelledby="preview-heading" className="space-y-4">
        <h2 id="preview-heading" className="text-xl font-semibold">Dry-run preview</h2>
        <p className="text-sm text-muted-foreground">These lists use the saved periods and the same eligibility checks as the jobs, even while the jobs are off. No records are changed by this preview. Each list shows up to 25 records per page; counts include all matching records.</p>
        <div role="alert">{previewError}</div>
        {payload && <>
          {!payload.canViewMembership && <p className="text-sm text-muted-foreground">Membership view access is required to see rejected-application, former-member, blocked-member and undated-member lists.</p>}
          {GROUPS.map(([key, title, dateLabel]) => {
            const group = payload.preview[key];
            if (!group) return null;
            return <Card key={key}>
              <CardHeader><CardTitle className="text-lg">{title} ({group.count})</CardTitle></CardHeader>
              <CardContent>
                {group.rows.length === 0 ? <p className="text-sm text-muted-foreground">{group.count === 0 ? "No matching records." : "No records on this page."}</p> : <Table>
                  <TableHeader><TableRow><TableHead>Record ID</TableHead><TableHead>{dateLabel}</TableHead>{key === "blockedMembers" && <TableHead>Why it is blocked</TableHead>}</TableRow></TableHeader>
                  <TableBody>{group.rows.map((row) => <TableRow key={row.id}>
                    <TableCell className="break-all">{["formerMembers", "blockedMembers", "undatedMembers"].includes(key) ? <Link className="underline" href={`/admin/members/${encodeURIComponent(row.id)}`}>{row.id}</Link> : row.id}</TableCell>
                    <TableCell>{displayDate(row.date, key === "formerMembers" || key === "blockedMembers" || key === "undatedMembers")}</TableCell>
                    {key === "blockedMembers" && <TableCell>{row.reasons?.join("; ")}</TableCell>}
                  </TableRow>)}</TableBody>
                </Table>}
              </CardContent>
            </Card>;
          })}
          <nav aria-label="Retention preview pages" className="flex items-center gap-3">
            <Button variant="outline" disabled={page <= 1 || section.editing} onClick={() => router.push(`?page=${page - 1}`)}>Previous</Button>
            <span className="text-sm">Page {page}</span>
            <Button variant="outline" disabled={!hasNextPage || section.editing} onClick={() => router.push(`?page=${page + 1}`)}>Next</Button>
          </nav>
          {section.editing && <p className="text-sm text-muted-foreground">Save or cancel your changes before changing preview pages.</p>}
        </>}
      </section>
    </div>
  );
}
