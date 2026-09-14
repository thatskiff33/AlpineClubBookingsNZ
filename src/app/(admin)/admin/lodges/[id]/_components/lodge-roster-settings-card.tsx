"use client";

import { useId } from "react";
import { Users } from "lucide-react";
import type { DisplayNameGranularity } from "@prisma/client";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  ForbiddenSaveError,
  useSectionEditState,
} from "@/hooks/use-section-edit-state";
import {
  DISPLAY_NAME_GRANULARITY_LABELS,
  DISPLAY_NAME_GRANULARITY_VALUES,
} from "@/lib/display-name-granularity";

/**
 * How much of a name the MEMBER LODGE ROSTER shows, for this one lodge (#2942,
 * owner decision D2).
 *
 * A SEPARATE CARD FROM THE LOBBY DISPLAY'S, on purpose. The two settings look
 * identical — the same four levels, the same kind of choice — and they are not
 * the same decision. A screen on the wall inside the hut is read by people who
 * are already in the building; the roster is a web page that reaches anybody
 * who can sign in. A club may reasonably set them differently, so they are two
 * columns, two cards and two saves, and neither is described in terms of the
 * other on screen.
 *
 * IT IS NOT GATED ON THE ROSTER MODULE. An administrator has to be able to
 * choose the disclosure level BEFORE switching the roster on, or the club
 * publishes whatever the default is for however long it takes them to find this
 * card. So the card is always here, and instead of hiding it says plainly
 * whether the roster is on yet.
 *
 * The canonical settings pattern (`docs/ARCHITECTURE.md` -> "Admin/member
 * layer"): read-only on mount, a staged Edit -> Save/Cancel step, nothing
 * persisted by touching a control, Cancel restoring the last saved value, Save
 * dirty-gated and writing once, every edit affordance a `ViewOnlyActionButton`
 * under ONE `AdminViewOnlySectionBanner` that is mounted in every branch so its
 * live region exists from the first paint.
 */

interface RosterSettingsDraft {
  /** Null means "use the roster's own default", reported by the server below. */
  rosterNameGranularity: DisplayNameGranularity | null;
  /**
   * The fallback the roster applies to a lodge that has not chosen, read from
   * the server rather than restated here. It is deliberately NOT the lobby
   * display's default, and a second copy of it in this file could drift from
   * the one the roster actually reads.
   */
  defaultRosterNameGranularity: DisplayNameGranularity;
  /** Whether the roster is switched on club-wide, so the card can say so. */
  memberLodgeRosterEnabled: boolean;
}

interface RosterSettingsResponse extends RosterSettingsDraft {
  lodgeId: string;
  lodgeName: string;
}

function endpoint(lodgeId: string) {
  return `/api/admin/lodges/${encodeURIComponent(lodgeId)}/roster-settings`;
}

function toDraft(body: RosterSettingsResponse): RosterSettingsDraft {
  return {
    rosterNameGranularity: body.rosterNameGranularity,
    defaultRosterNameGranularity: body.defaultRosterNameGranularity,
    memberLodgeRosterEnabled: body.memberLodgeRosterEnabled,
  };
}

/** The empty-string select value standing for "no per-lodge choice". */
const USE_DEFAULT = "";

export function LodgeRosterSettingsCard({ lodgeId }: { lodgeId: string }) {
  // The write route is gated `lodge:edit`, so a lodge:view admin reads this
  // card and cannot change it (#1940).
  const canEdit = useAdminAreaEditAccess("lodge");
  const selectId = useId();

  const section = useSectionEditState<RosterSettingsDraft>({
    load: async (signal) => {
      const response = await fetch(endpoint(lodgeId), {
        signal,
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error("The roster name setting could not be read.");
      }
      return toDraft((await response.json()) as RosterSettingsResponse);
    },
    save: async (draft) => {
      const response = await fetch(endpoint(lodgeId), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // Only the field this card owns. The other two are server facts the
        // GET reports; sending them back would invite a future edit to treat
        // them as writable.
        body: JSON.stringify({
          rosterNameGranularity: draft.rosterNameGranularity,
        }),
      });
      if (!response.ok) {
        if (response.status === 403) throw new ForbiddenSaveError();
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? "That setting could not be saved.");
      }
      return toDraft((await response.json()) as RosterSettingsResponse);
    },
    successMessage: "Roster name detail saved.",
    // Only the level is editable, so only the level can make the draft dirty.
    // The default and the module flag arrive from the server and go back
    // unchanged; comparing them would be comparing a fact with itself.
    isDirty: (draft, saved) =>
      draft.rosterNameGranularity !== saved.rosterNameGranularity,
  });

  const { draft, editing, saving, dirty, error, success } = section;

  /*
    One banner for the section, hoisted above every early return below so the
    polite live region is registered in the accessibility tree before it can
    ever carry content. A region injected already-populated is silently dropped
    by some screen-reader/browser pairings (#2160).
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can see how much of a name the member roster shows but
      cannot change it. Lodge edit access is required.
    </AdminViewOnlySectionBanner>
  );

  /*
    The feedback region is part of the same frame and is likewise mounted in
    every branch, for the same reason: a failed FIRST load clears `loading`, so
    a feedback element that only existed in the loaded branch would appear
    already carrying the error, in one commit.
  */
  const feedback = (
    <div className="mb-4 space-y-2">
      <p className="text-sm text-destructive" role="alert">
        {error}
      </p>
      <p className="text-sm font-medium" role="status">
        {success}
      </p>
    </div>
  );

  if (section.loading || !draft) {
    return (
      <div>
        {viewOnlyBanner}
        {feedback}
        {section.loading ? (
          <p className="text-muted-foreground text-sm">
            Reading the roster name setting...
          </p>
        ) : null}
      </div>
    );
  }

  const selected = draft.rosterNameGranularity ?? USE_DEFAULT;
  const defaultLabel =
    DISPLAY_NAME_GRANULARITY_LABELS[draft.defaultRosterNameGranularity];

  return (
    <div>
      {viewOnlyBanner}
      {feedback}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="h-4 w-4" />
              Member roster
            </CardTitle>
            <CardDescription>
              How much of a name other members see on the roster for this lodge.
              The roster lists who is staying over the next 30 nights, to members
              who can already book here.
            </CardDescription>
          </div>
          {!editing && (
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
              variant="outline"
              size="sm"
              onClick={section.startEditing}
            >
              Edit
            </ViewOnlyActionButton>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {/*
            Whether the roster is switched on is a club-wide setting on another
            page, and an administrator setting this dial needs to know which
            state they are in: with the roster off this choice is a preparation,
            and with it on it is live. Saying so is why the card is not simply
            hidden while the module is off.
          */}
          <p className="text-muted-foreground text-sm" role="status">
            {draft.memberLodgeRosterEnabled
              ? "The member roster is on, so this setting is in effect now. A change takes effect immediately."
              : "The member roster is off, so nothing is shown to members yet. Set this first, then turn the roster on under Admin, Modules."}
          </p>

          <div className="max-w-md space-y-1">
            <Label htmlFor={selectId}>Name detail on the roster</Label>
            <select
              id={selectId}
              className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm disabled:bg-muted disabled:text-muted-foreground"
              value={selected}
              disabled={!editing}
              onChange={(event) =>
                section.setDraft({
                  rosterNameGranularity:
                    event.target.value === USE_DEFAULT
                      ? null
                      : (event.target.value as DisplayNameGranularity),
                })
              }
            >
              <option value={USE_DEFAULT}>{`Use the default (${defaultLabel})`}</option>
              {DISPLAY_NAME_GRANULARITY_VALUES.map((value) => (
                <option key={value} value={value}>
                  {DISPLAY_NAME_GRANULARITY_LABELS[value]}
                </option>
              ))}
            </select>
            <p className="text-muted-foreground text-xs">
              This is applied where the roster is built, so no part of the page
              can show more than it allows. Whatever you choose, a booking that
              includes a child never names anyone in it, and neither does a
              booking by a school or another organisation, a booking that hired
              the whole lodge, or a party of eight or more that turned out to be
              the only booking in the building on every one of its nights.
            </p>
            <p className="text-muted-foreground text-xs">
              This is a separate choice from the lobby display&apos;s guest name
              setting, and changing one does not change the other.
            </p>
          </div>

          {editing && (
            <div className="flex gap-3">
              <ViewOnlyActionButton
                canEdit={canEdit}
                describeReason={false}
                onClick={() => void section.save()}
                disabled={!dirty || saving}
              >
                {saving ? "Saving..." : "Save roster name detail"}
              </ViewOnlyActionButton>
              {/*
                A plain Button: Cancel reverts local state and writes nothing,
                so gating it would refuse a view-only admin the way out of a
                form they could not have changed.
              */}
              <Button
                variant="outline"
                onClick={section.cancelEditing}
                disabled={saving}
              >
                Cancel
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
