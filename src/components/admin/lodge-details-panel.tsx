"use client";

import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";

type Lodge = {
  id: string;
  name: string;
  address: string | null;
  travelNote: string | null;
  doorCode: string | null;
};

/**
 * Whether a row from `GET /api/admin/lodges` carries the lodge DETAIL fields
 * this card edits (#2925).
 *
 * That route now admits any admitted admin and narrows its payload instead of
 * refusing: a caller without `lodge:view` gets `{ id, name, slug, active }` and
 * a 200. Keying the refusal on the 403 alone would therefore render a
 * live-looking form with address, travel note and door code silently blank —
 * and saving it would post those blanks back. So the card keys on the FIELDS
 * being absent, which is true of both answers: the narrowed 200 and (should the
 * route ever tighten again) the 403 handled beside it.
 *
 * `in` rather than a null check, deliberately: a real lodge with no door code
 * set sends `doorCode: null`, which is an editable empty value, not a refusal.
 */
function hasLodgeDetailFields(row: unknown): row is Lodge {
  if (typeof row !== "object" || row === null) return false;
  return "address" in row && "travelNote" in row && "doorCode" in row;
}

// Single-lodge editing surface (E3 #1929). Multi-lodge clubs manage lodges under
// Admin > Setup > Lodges; this card only appears for a single-lodge club.
export function LodgeDetailsPanel() {
  const [lodge, setLodge] = useState<Lodge | null>(null);
  const [multiLodge, setMultiLodge] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  // A content-only admin can reach the Club Identity page but has no lodge:view.
  // Since #2925 that shows up as a 200 carrying only the lodge VOCABULARY rather
  // than a 403 — see `hasLodgeDetailFields`. Either way it is a permission
  // answer, not a transient failure, so it earns an explanation instead of a raw
  // error + Retry that could only produce the same answer again.
  const [accessDenied, setAccessDenied] = useState(false);
  // Gated on the "lodge" area (E1's view-only pattern, area-generic): the save
  // hits the lodge-area /api/admin/lodges/[id] route, so the UI gate must match.
  const canEdit = useAdminAreaEditAccess("lodge");
  const viewOnlyReasonId = useId();

  function load() {
    setLoadFailed(false);
    setAccessDenied(false);
    void fetch("/api/admin/lodges")
      .then(async (response) => {
        // A cross-area denial (content-only admin without lodge:view) is not a
        // failure — render a read-only explanation instead of an error + Retry.
        if (response.status === 403) {
          setAccessDenied(true);
          return;
        }
        if (!response.ok) throw new Error();
        const rows: unknown[] = (await response.json()).lodges ?? [];
        // A narrowed payload means this admin holds no lodge:view (#2925), so
        // refuse before the single/multi-lodge split — the explanation is the
        // same either way, and a narrowed multi-lodge club would otherwise be
        // told to go and edit lodges it cannot read.
        if (rows.length > 0 && !rows.every(hasLodgeDetailFields)) {
          setAccessDenied(true);
          return;
        }
        const lodges = rows.filter(hasLodgeDetailFields);
        const [onlyLodge] = lodges;
        if (lodges.length === 1 && onlyLodge) {
          setLodge(onlyLodge);
          setMultiLodge(false);
        } else {
          setLodge(null);
          setMultiLodge(true);
        }
      })
      .catch(() => {
        setLoadFailed(true);
        toast.error("Could not load lodge details.");
      });
  }
  useEffect(() => {
    load();
  }, []);

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before its
    content appears; a region injected already-populated is silently dropped by
    some screen-reader/browser pairings. It sits OUTSIDE the `space-y-*` stack so
    the empty wrapper an edit-capable admin gets costs no layout. The `id`
    wrapper is retained because the disabled text INPUTS below (which are not
    ViewOnlyActionButtons and keep their own description) point their
    `aria-describedby` at it.
  */
  const viewOnlyBanner = (
    <div id={viewOnlyReasonId}>
      <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-4">
        Lodge view access can inspect lodge details. Lodge edit access is
        required to change them.
      </AdminViewOnlySectionBanner>
    </div>
  );

  if (accessDenied)
    return (
      <p className="text-sm text-muted-foreground">
        Your admin role does not include lodge access, so lodge details can only
        be viewed and edited by an admin with lodge permissions.
      </p>
    );
  if (loadFailed)
    return (
      <div className="space-y-3">
        <p className="text-sm text-danger">Could not load lodge details.</p>
        <Button variant="outline" onClick={load}>
          Retry
        </Button>
      </div>
    );
  if (multiLodge)
    return (
      <p className="text-sm text-muted-foreground">
        This club has more than one lodge. Manage each lodge&apos;s name,
        address, travel note, and door code under Admin &gt; Setup &gt; Lodges.
      </p>
    );
  if (!lodge)
    return (
      <div>
        {viewOnlyBanner}
        <p className="text-sm text-muted-foreground">Loading lodge details…</p>
      </div>
    );

  async function save() {
    if (!lodge) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/admin/lodges/${lodge.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: lodge.name.trim(),
          address: lodge.address ?? null,
          travelNote: lodge.travelNote ?? null,
          doorCode: lodge.doorCode ?? null,
        }),
      });
      if (!response.ok) throw new Error();
      setLodge((await response.json()).lodge);
      toast.success("Lodge details updated.");
    } catch {
      toast.error("Could not update lodge details.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      {viewOnlyBanner}
      <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        The lodge name and address appear on the public site (contact page and
        the {"{{lodge-name}}"} / {"{{lodge-address}}"} content tokens). The door
        code is only shared in confirmation emails.
      </p>
      <div className="space-y-1.5">
        <Label htmlFor="lodge-details-name">Lodge name</Label>
        <Input
          id="lodge-details-name"
          value={lodge.name}
          disabled={!canEdit}
          aria-describedby={!canEdit ? viewOnlyReasonId : undefined}
          onChange={(event) => setLodge({ ...lodge, name: event.target.value })}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="lodge-details-address">Address</Label>
        <Textarea
          id="lodge-details-address"
          value={lodge.address ?? ""}
          rows={2}
          placeholder="Optional — shown on the public contact page when set"
          disabled={!canEdit}
          aria-describedby={!canEdit ? viewOnlyReasonId : undefined}
          onChange={(event) =>
            setLodge({ ...lodge, address: event.target.value })
          }
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="lodge-details-travel">Travel note</Label>
        <Textarea
          id="lodge-details-travel"
          value={lodge.travelNote ?? ""}
          rows={2}
          disabled={!canEdit}
          aria-describedby={!canEdit ? viewOnlyReasonId : undefined}
          onChange={(event) =>
            setLodge({ ...lodge, travelNote: event.target.value })
          }
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="lodge-details-door">Door code</Label>
        <Input
          id="lodge-details-door"
          value={lodge.doorCode ?? ""}
          disabled={!canEdit}
          aria-describedby={!canEdit ? viewOnlyReasonId : undefined}
          onChange={(event) =>
            setLodge({ ...lodge, doorCode: event.target.value })
          }
        />
      </div>
      <ViewOnlyActionButton canEdit={canEdit} describeReason={false} disabled={saving} onClick={save}>
        {saving ? "Saving…" : "Save lodge details"}
      </ViewOnlyActionButton>
      </div>
    </div>
  );
}
