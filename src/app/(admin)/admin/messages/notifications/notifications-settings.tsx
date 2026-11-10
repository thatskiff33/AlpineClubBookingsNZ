"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  ADMIN_FORBIDDEN_SAVE_REASON,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import {
  ADMIN_NOTIFICATION_PREFERENCE_KEYS,
  ADMIN_NOTIFICATION_PREFERENCE_META,
  type AdminNotificationPreferenceKey,
  type AdminNotificationPreferences,
} from "@/lib/admin-notification-preferences";
import { unverifiedWriteMessage } from "@/lib/unverified-write-copy";

interface AdminNotificationUser {
  id: string;
  name: string;
  email: string;
  /** Access-role labels, shown so the unavailable categories make sense. */
  roleLabels?: string[];
  /**
   * Alert categories this admin's permission areas cover (#2548). Categories
   * outside the list are never sent to them, so they render locked rather than
   * pretending a tick would do something.
   */
  availableKeys?: AdminNotificationPreferenceKey[];
  preferences: AdminNotificationPreferences;
}

const DEFAULT_SAVE_ERROR = "Failed to update notification preferences";
/** #2668 — the browser never read an answer, so it claims no outcome. */
const UNVERIFIED_SAVE_ERROR = unverifiedWriteMessage(
  "these notification preferences were saved",
  "Reload the page to see the current settings before saving again.",
);

/** Per-admin save outcome, so one card's failure never reverts another's. */
type SaveSuccess = {
  memberId: string;
  ok: true;
  preferences: AdminNotificationPreferences;
};
type SaveFailure = {
  memberId: string;
  ok: false;
  error: string;
  /**
   * #2668 — the request's outcome was never read, so this is NOT a refusal.
   * A refusal is something the server said; this is the absence of an answer,
   * and the preferences may well be stored. Cards marked this way are neither
   * rolled back nor re-baselined, and the toast does not call them "Not saved".
   */
  unverified?: true;
};
type SaveOutcome = SaveSuccess | SaveFailure;

export function AdminNotificationSettings({
  initialAdmins,
}: {
  initialAdmins: AdminNotificationUser[];
}) {
  // Admin notification preferences are a support-area setting; a support:view
  // admin sees the panel read-only (#1940). The PUT route enforces support:edit.
  const canEdit = useAdminAreaEditAccess("support");
  const [admins, setAdmins] = useState(initialAdmins);
  const [savedAdmins, setSavedAdmins] = useState(initialAdmins);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  function handleEdit() {
    setEditing(true);
  }

  function handleCancel() {
    /*
      Cancel is an explicit discard, so it puts every card back to the last
      baseline this panel holds — including a card whose save outcome was never
      read (#2668), whose baseline may be older than what the server now holds.
      That is deliberate: the operator asked to throw their edits away, and the
      alternative (keeping an unverified card dirty through a Cancel) would give
      Cancel two meanings. What is on screen afterwards is only ever a claim
      about what the club's records held when the page loaded; reloading the
      page is what settles it, which is what the unverified message says.
    */
    setAdmins(savedAdmins.map((a) => ({ ...a, preferences: { ...a.preferences } })));
    setEditing(false);
  }

  /**
   * Categories this admin can actually be sent (#2548). Older callers that do
   * not supply the list fall back to every category, matching the previous
   * Full-Admin-only grid.
   */
  function availableKeysFor(admin: AdminNotificationUser) {
    return admin.availableKeys ?? ADMIN_NOTIFICATION_PREFERENCE_KEYS;
  }

  function togglePreference(memberId: string, key: AdminNotificationPreferenceKey) {
    setAdmins((current) =>
      current.map((admin) =>
        admin.id === memberId
          ? {
              ...admin,
              preferences: { ...admin.preferences, [key]: !admin.preferences[key] },
            }
          : admin
      )
    );
  }

  async function handleSave() {
    setSaving(true);

    // Find all changed preferences
    const changes: Array<{ memberId: string; preferences: Partial<AdminNotificationPreferences> }> = [];
    for (const admin of admins) {
      const saved = savedAdmins.find((s) => s.id === admin.id);
      if (!saved) continue;
      const diff: Partial<AdminNotificationPreferences> = {};
      // Locked categories can never be toggled, and the PUT route rejects them
      // outright — never send one, even if state drifted.
      for (const key of availableKeysFor(admin)) {
        if (admin.preferences[key] !== saved.preferences[key]) {
          diff[key] = admin.preferences[key];
        }
      }
      if (Object.keys(diff).length > 0) {
        changes.push({ memberId: admin.id, preferences: diff });
      }
    }

    if (changes.length === 0) {
      setEditing(false);
      setSaving(false);
      return;
    }

    try {
      /*
        One request per changed admin, and each outcome is kept separately so a
        failure on one card cannot discard the others. The whole batch used to
        share a single try/catch that reverted every card, so one stale-page
        rejection (a category the target's role no longer covers, say) threw away
        unrelated edits the operator had just made.
      */
      const results = await Promise.all(
        changes.map(async ({ memberId, preferences }): Promise<SaveOutcome> => {
          try {
            const response = await fetch("/api/admin/notifications", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ memberId, preferences }),
            });
            const data = await response.json().catch(() => null);
            if (!response.ok) {
              return {
                memberId,
                ok: false,
                error:
                  response.status === 403
                    ? ADMIN_FORBIDDEN_SAVE_REASON
                    : (data?.error ?? DEFAULT_SAVE_ERROR),
              };
            }
            return {
              memberId,
              ok: true,
              preferences: data.preferences as AdminNotificationPreferences,
            };
          } catch {
            // #2668: `fetch` rejects both when the PUT never arrived and when it
            // arrived, ran, and lost its answer. Never read is not the same as
            // never happened, and this card is treated accordingly below.
            return {
              memberId,
              ok: false,
              unverified: true,
              error: UNVERIFIED_SAVE_ERROR,
            };
          }
        })
      );

      const failures = results.filter(
        (result): result is SaveFailure => !result.ok
      );
      const outcomeFor = (memberId: string) =>
        results.find((result) => result.memberId === memberId);

      /*
        Saved cards take the server's effective values, and a card the server
        REFUSED goes back to what the server last confirmed.

        #2668: a card whose outcome was never read is left exactly as the
        operator left it, baseline included. Rolling it back would put a value
        on screen the server may no longer hold, and re-baselining it would
        record a guess as the club's record — the screen-versus-row drift this
        panel's per-card outcomes exist to prevent, reintroduced on the one path
        with the least information. Leaving it dirty keeps Save live, and the
        PUT is a plain preference set, so pressing it again is harmless.

        Cards outside this save are left alone, and the checkboxes are disabled
        while the save is in flight, so no in-flight edit can be silently
        overwritten by this re-baseline.
      */
      const updatedAdmins = admins.map((admin) => {
        const result = outcomeFor(admin.id);
        if (!result) return admin;
        if (result.ok) return { ...admin, preferences: result.preferences };
        if (result.unverified) return admin;
        const saved = savedAdmins.find((s) => s.id === admin.id);
        return saved
          ? { ...admin, preferences: { ...saved.preferences } }
          : admin;
      });
      setAdmins(updatedAdmins);
      /*
        The baseline half of the same rule, and the half that fails silently if
        it is dropped: re-baselining an unverified card would make it CLEAN, the
        next Save would find no changes and return at the guard above without
        sending anything, and the panel would leave edit mode as though the
        guess had been confirmed. Pinned behaviourally in
        `notification-recipient-availability.test.tsx` — after an unread
        outcome, pressing Save again must send a second PUT.
      */
      setSavedAdmins(
        updatedAdmins.map((a) => {
          const result = outcomeFor(a.id);
          if (result && !result.ok && result.unverified) {
            return savedAdmins.find((saved) => saved.id === a.id) ?? a;
          }
          return { ...a, preferences: { ...a.preferences } };
        })
      );

      if (failures.length === 0) {
        setEditing(false);
        return;
      }

      // Stay in edit mode. A refused card has rolled back to its last saved
      // values, so the operator redoes that card's ticks and saves again; an
      // unverified one still holds their ticks. The toast below names exactly
      // which card needs attention either way.
      const detail = failures
        .map((failure) => {
          const name =
            admins.find((admin) => admin.id === failure.memberId)?.name ??
            "An admin";
          return `${name}: ${failure.error}`;
        })
        .join("; ");
      // #2668: "Not saved" is a claim about the stored row, so it is only made
      // when EVERY failure in this batch is one the server itself reported. One
      // unverified card in the set and the summary reports the saves it can
      // vouch for and leaves the rest to their own sentences.
      //
      // The COUNT carries the same claim in numeric form: "Saved 1 of 2" says
      // the other one was not, which is exactly what an unread outcome does not
      // know. With an unverified card in the batch the number is reported as
      // what it actually is — the saves that came back confirmed — and the
      // sentences that follow say what is unknown about the rest.
      const allRefused = failures.every((failure) => !failure.unverified);
      const savedCount = changes.length - failures.length;
      toast.error(
        failures.length === changes.length
          ? detail
          : allRefused
            ? `Saved ${savedCount} of ${changes.length} admins. Not saved — ${detail}`
            : `Confirmed saved for ${savedCount} of ${changes.length} admins. ${detail}`
      );
    } finally {
      setSaving(false);
    }
  }

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before its
    content appears; a region injected already-populated is silently dropped by
    some screen-reader/browser pairings. It sits OUTSIDE the `space-y-*` stack so
    the empty wrapper an edit-capable admin gets costs no layout, and it is
    rendered in BOTH return branches so the region exists from the first paint.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view admin notification preferences but cannot
      change them. Support edit access is required.
    </AdminViewOnlySectionBanner>
  );

  if (admins.length === 0) {
    return (
      <div>
        {viewOnlyBanner}
        <div className="rounded-lg border border-dashed border-border bg-muted px-4 py-6 text-sm text-muted-foreground">
          No active admin users found.
        </div>
      </div>
    );
  }

  return (
    <div>
      {viewOnlyBanner}
      <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div />
        {!editing ? (
          <ViewOnlyActionButton
            canEdit={canEdit}
            describeReason={false}
            variant="outline"
            size="sm"
            onClick={handleEdit}
          >
            Edit
          </ViewOnlyActionButton>
        ) : (
          <div className="flex gap-3">
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? "Saving..." : "Save Changes"}
            </Button>
            <Button variant="outline" size="sm" onClick={handleCancel} disabled={saving}>
              Cancel
            </Button>
          </div>
        )}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {admins.map((admin) => {
          const available = availableKeysFor(admin);

          return (
          <Card key={admin.id} className="border-border shadow-sm">
            <CardHeader className="pb-4">
              <CardTitle className="text-base">{admin.name}</CardTitle>
              <CardDescription>
                <span>{admin.email}</span>
                {admin.roleLabels && admin.roleLabels.length > 0 ? (
                  <span className="mt-1 block text-xs">
                    {admin.roleLabels.join(", ")}
                  </span>
                ) : null}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              {available.length === 0 ? (
                <p className="text-sm text-muted-foreground sm:col-span-2">
                  This admin&apos;s role cannot edit any area that owns an alert,
                  so there are no alerts to send them. Give their role edit
                  access to an area — bookings, membership, finance or support —
                  to make its alerts available.
                </p>
              ) : null}
              {ADMIN_NOTIFICATION_PREFERENCE_KEYS.map((key) => {
                const meta = ADMIN_NOTIFICATION_PREFERENCE_META[key];
                const controlId = `${admin.id}-${key}`;
                // #2548: an alert outside this admin's areas is never sent, so
                // the box stays locked and unticked instead of implying a tick
                // would subscribe them.
                const locked = !available.includes(key);

                return (
                  <div
                    key={key}
                    className={`flex items-start gap-3 rounded-lg border border-border p-3${
                      locked ? " border-dashed" : ""
                    }`}
                  >
                    <Checkbox
                      id={controlId}
                      checked={admin.preferences[key]}
                      disabled={!editing || locked || saving}
                      aria-describedby={locked ? `${controlId}-locked` : undefined}
                      onCheckedChange={() =>
                        editing &&
                        !locked &&
                        !saving &&
                        togglePreference(admin.id, key)
                      }
                    />
                    <div className="space-y-1">
                      <Label htmlFor={controlId} className="cursor-pointer text-sm font-medium">
                        {meta.label}
                      </Label>
                      <p className="text-xs leading-5 text-muted-foreground">
                        {meta.description}
                      </p>
                      {locked ? (
                        <p id={`${controlId}-locked`} className="text-xs leading-5 text-muted-foreground">
                          <span className="font-medium text-foreground">Locked:</span> this alert belongs to an area their role
                          cannot edit. It cannot be switched on here — give their
                          access role edit access to that area instead.
                        </p>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>
          );
        })}
      </div>
      </div>
    </div>
  );
}
