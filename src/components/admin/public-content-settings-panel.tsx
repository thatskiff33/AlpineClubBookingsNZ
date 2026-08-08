"use client";

import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { PUBLIC_CONTENT_SETTINGS_CHANGED_EVENT } from "@/lib/public-content-settings-events";
import { AdminViewOnlySectionBanner, ViewOnlyActionButton } from "@/components/admin/view-only-action";

type Settings = {
  membershipTypes: boolean;
  entranceFees: boolean;
  hutFees: boolean;
  bookingPolicySummary: boolean;
  cancellationPolicy: boolean;
  annualFees: boolean;
  showBookNow: boolean;
  bookNowTarget: "BOOKING_FLOW" | "PAGE";
  bookNowPageId: string | null;
  committeePhotoDisplay: "NONE" | "CIRCLE" | "SQUARE";
};

type PublishedPage = { id: string; title: string; path: string };

// annualFees is a dedicated double-opt-in for the {{annual-fees}} embed (#1933,
// E7); {{membership-types}} is now its deprecated alias and renders through the
// same annualFees gate, so the legacy membershipTypes flag is orphaned and no
// longer surfaced. Joining fees ({{joining-fees}}/{{entrance-fees}}) stay on
// the existing entranceFees gate.
const labels: Array<[keyof Settings, string]> = [
  ["entranceFees", "Joining fees"],
  ["annualFees", "Annual membership fees"],
  ["hutFees", "Hut fees"],
  ["bookingPolicySummary", "Booking policy summaries"],
  ["cancellationPolicy", "Cancellation policies"],
];

export function PublicContentSettingsPanel() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [pages, setPages] = useState<PublishedPage[]>([]);
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const canEdit = useAdminAreaEditAccess("content");
  const viewOnlyReasonId = useId();
  function load() {
    setLoadFailed(false);
    void fetch("/api/admin/public-content-settings").then(async (response) => {
      if (!response.ok) throw new Error();
      const data = await response.json();
      setSettings(data.settings);
      setPages(data.pages ?? []);
    }).catch(() => { setLoadFailed(true); toast.error("Could not load public content settings."); });
  }
  useEffect(() => {
    load();
    /*
      Second review finding S2 (#2352). `admin/page-content` renders this panel
      and `PageContentPanel` as siblings with no common client ancestor, and this
      one posts its WHOLE settings object on save. Deleting a page therefore left
      this panel holding a published-page list that still contained it and — when
      the delete repointed the setting inside its own transaction — a
      `bookNowTarget: "PAGE"` plus a page id that no longer existed, so every
      later save here failed with 400 "The selected Book Now page is not
      published." until the officer thought to reload. Deterministic, not a race.

      A re-read rather than a local patch: the endpoint is the authority on what
      it repointed to, and re-reading also refreshes the page list the Book Now
      selector offers. `router.refresh()` would not help — it re-renders the
      server tree without touching either panel's own fetched state.
    */
    window.addEventListener(PUBLIC_CONTENT_SETTINGS_CHANGED_EVENT, load);
    return () => {
      window.removeEventListener(PUBLIC_CONTENT_SETTINGS_CHANGED_EVENT, load);
    };
    // Load once on mount; retry is explicit after an error.
  }, []);
  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before its
    content appears; a region injected already-populated is silently dropped by
    some screen-reader/browser pairings. It sits OUTSIDE the `space-y-*` stack so
    the empty wrapper an edit-capable admin gets costs no layout. The `id`
    wrapper is retained because the disabled checkboxes below (which are not
    ViewOnlyActionButtons and keep their own description) point their
    `aria-describedby` at it.
  */
  const viewOnlyBanner = (
    <div id={viewOnlyReasonId}>
      <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-4">
        Content view access can inspect public visibility. Content edit access is required to change it.
      </AdminViewOnlySectionBanner>
    </div>
  );
  if (loadFailed) return <div className="space-y-3"><p className="text-sm text-danger">Could not load public content settings.</p><Button variant="outline" onClick={load}>Retry</Button></div>;
  if (!settings) return <div>{viewOnlyBanner}<p className="text-sm text-muted-foreground">Loading visibility settings…</p></div>;
  async function save() {
    setSaving(true);
    try {
      const response = await fetch("/api/admin/public-content-settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) });
      if (!response.ok) throw new Error();
      setSettings((await response.json()).settings);
      toast.success("Public content visibility updated.");
    } catch { toast.error("Could not update public content visibility."); }
    finally { setSaving(false); }
  }
  return <div>{viewOnlyBanner}<div className="space-y-4"><p className="text-sm text-muted-foreground">A token renders no authoritative fee or policy data until its family is enabled here. Membership types must also be individually marked for public listing.</p><div className="grid gap-3 sm:grid-cols-2">{labels.map(([key, label]) => <label key={key} className="flex items-center gap-3 rounded-md border p-3"><input type="checkbox" checked={settings[key] as boolean} disabled={!canEdit} aria-describedby={!canEdit ? viewOnlyReasonId : undefined} onChange={(event) => setSettings({ ...settings, [key]: event.target.checked })} /><span>{label}</span></label>)}</div>
    <div className="space-y-3 rounded-md border p-4">
      <div>
        <p className="text-sm font-medium">Book Now button</p>
        <p className="text-sm text-muted-foreground">Controls the public website header&apos;s Book Now button; a visitor who is not signed in sees it labelled &ldquo;Member booking&rdquo;. A page target that is unpublished falls back to the booking flow while it stays hidden; deleting that page switches this setting back to the booking flow.</p>
      </div>
      <label className="flex items-center gap-3"><input type="checkbox" checked={settings.showBookNow} disabled={!canEdit} aria-describedby={!canEdit ? viewOnlyReasonId : undefined} onChange={(event) => setSettings({ ...settings, showBookNow: event.target.checked })} /><span>Show the Book Now button</span></label>
      {settings.showBookNow ? <div className="space-y-2 pl-1">
        <label className="flex items-center gap-3"><input type="radio" name="bookNowTarget" checked={settings.bookNowTarget === "BOOKING_FLOW"} disabled={!canEdit} onChange={() => setSettings({ ...settings, bookNowTarget: "BOOKING_FLOW" })} /><span>Go to the booking flow</span></label>
        <label className="flex items-center gap-3"><input type="radio" name="bookNowTarget" checked={settings.bookNowTarget === "PAGE"} disabled={!canEdit} onChange={() => setSettings({ ...settings, bookNowTarget: "PAGE" })} /><span>Go to a content page</span></label>
        {settings.bookNowTarget === "PAGE" ? <select className="w-full rounded-md border p-2 text-sm" value={settings.bookNowPageId ?? ""} disabled={!canEdit} onChange={(event) => setSettings({ ...settings, bookNowPageId: event.target.value || null })}><option value="">Select a published page…</option>{pages.map((page) => <option key={page.id} value={page.id}>{page.title} ({page.path})</option>)}</select> : null}
      </div> : null}
    </div>
    <div className="space-y-2 rounded-md border p-3">
      <p className="text-sm font-medium">Committee photos</p>
      <p className="text-sm text-muted-foreground">Whether members&apos; photos appear on the public committee roster, and their shape. Hidden by default; members without a photo show their initials.</p>
      <p className="text-sm text-muted-foreground">&ldquo;Don&apos;t show photos&rdquo; takes the pictures off the public website altogether &mdash; they stop being handed out to the outside world at all, not just hidden from the roster page &mdash; so you can use it to answer a request to take someone&apos;s picture down. Members still see their own photo, and administrators with membership access still see it on the member&apos;s record.</p>
      <select className="w-full rounded-md border p-2 text-sm" value={settings.committeePhotoDisplay} disabled={!canEdit} aria-label="Committee photo display" aria-describedby={!canEdit ? viewOnlyReasonId : undefined} onChange={(event) => setSettings({ ...settings, committeePhotoDisplay: event.target.value as Settings["committeePhotoDisplay"] })}><option value="NONE">Don&apos;t show photos</option><option value="CIRCLE">Show photos (circular)</option><option value="SQUARE">Show photos (square)</option></select>
    </div>
    <ViewOnlyActionButton canEdit={canEdit} describeReason={false} disabled={saving} onClick={save}>{saving ? "Saving…" : "Save visibility"}</ViewOnlyActionButton></div></div>;
}
