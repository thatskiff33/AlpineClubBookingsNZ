"use client";

import { useId } from "react";
import { Link2 } from "lucide-react";

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

/**
 * Which lodge in the Alpine Central Server's registry THIS lodge is (#62).
 *
 * The central server's public lodge search asks this site how many beds are
 * free, naming the lodge by its permanent central id. This card is where an
 * administrator links the two. A club with one active lodge that owns one
 * central lodge needs nothing here: the card says it is linked automatically.
 *
 * The canonical settings pattern, as `lodge-roster-settings-card.tsx`: read-only
 * on mount, a staged Edit -> Save/Cancel step, Save dirty-gated, every edit
 * affordance a `ViewOnlyActionButton` under ONE `AdminViewOnlySectionBanner`
 * mounted in every branch.
 */

interface OwnedLodge {
  id: string;
  name: string;
}

interface CentralLodgeResponse {
  lodgeId: string;
  lodgeName: string;
  lodgeActive: boolean;
  centralLodgeId: string | null;
  ownedLodges: OwnedLodge[] | null;
  defaultCentralLodgeId: string | null;
  otherLodgesEnabled: boolean;
}

interface CentralLodgeDraft {
  centralLodgeId: string | null;
  ownedLodges: OwnedLodge[] | null;
  defaultCentralLodgeId: string | null;
  otherLodgesEnabled: boolean;
  lodgeActive: boolean;
}

function endpoint(lodgeId: string) {
  return `/api/admin/lodges/${encodeURIComponent(lodgeId)}/central-lodge`;
}

function toDraft(body: CentralLodgeResponse): CentralLodgeDraft {
  return {
    centralLodgeId: body.centralLodgeId,
    ownedLodges: body.ownedLodges,
    defaultCentralLodgeId: body.defaultCentralLodgeId,
    otherLodgesEnabled: body.otherLodgesEnabled,
    lodgeActive: body.lodgeActive,
  };
}

/** The select value standing for "not linked". */
const NOT_LINKED = "";

function nameOf(owned: OwnedLodge[] | null, id: string | null): string | null {
  return id === null ? null : (owned?.find((l) => l.id === id)?.name ?? null);
}

export function LodgeCentralLodgeCard({ lodgeId }: { lodgeId: string }) {
  // The write route is gated `lodge:edit`, so a lodge:view admin reads this
  // card and cannot change it (#1940).
  const canEdit = useAdminAreaEditAccess("lodge");
  const selectId = useId();

  const section = useSectionEditState<CentralLodgeDraft>({
    load: async (signal) => {
      const response = await fetch(endpoint(lodgeId), { signal, cache: "no-store" });
      if (!response.ok) throw new Error("The central lodge link could not be read.");
      return toDraft((await response.json()) as CentralLodgeResponse);
    },
    save: async (draft) => {
      const response = await fetch(endpoint(lodgeId), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // Only the field this card owns; the rest are server facts.
        body: JSON.stringify({ centralLodgeId: draft.centralLodgeId }),
      });
      if (!response.ok) {
        if (response.status === 403) throw new ForbiddenSaveError();
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "The link could not be saved.");
      }
      return toDraft((await response.json()) as CentralLodgeResponse);
    },
    successMessage: "Central lodge link saved.",
    isDirty: (draft, saved) => draft.centralLodgeId !== saved.centralLodgeId,
  });

  const { draft, editing, saving, dirty, error, success } = section;

  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can see which central lodge this is but cannot change it.
      Lodge edit access is required.
    </AdminViewOnlySectionBanner>
  );

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
          <p className="text-muted-foreground text-sm">Reading the central lodge link...</p>
        ) : null}
      </div>
    );
  }

  const owned = draft.ownedLodges;
  const linkedName = nameOf(owned, draft.centralLodgeId);
  const defaultName = nameOf(owned, draft.defaultCentralLodgeId);
  // A stored link to a lodge the club no longer owns stays visible, so an
  // administrator can see why the lodge is not answering and clear it.
  const staleLink = draft.centralLodgeId !== null && linkedName === null;

  let state: string;
  if (!draft.otherLodgesEnabled) {
    state =
      "Other lodges sharing with the Alpine Central Server is off, so the central server is told nothing about free beds.";
  } else if (owned === null) {
    state =
      "The central server has not yet said which lodges this club owns. Download from the central server first.";
  } else if (!draft.lodgeActive) {
    state = "This lodge is inactive, so it never answers.";
  } else if (draft.centralLodgeId !== null && !staleLink) {
    state = `Linked to ${linkedName}. The central server's lodge search shows its free beds.`;
  } else if (staleLink) {
    state =
      "Linked to a lodge the central server no longer says this club owns, so nothing is answered. Choose again or clear it.";
  } else if (defaultName) {
    state = `Linked automatically to ${defaultName}, because this club has one lodge and owns one central lodge.`;
  } else {
    state = "Not linked, so the central server's lodge search shows its free beds as unknown.";
  }

  return (
    <div>
      {viewOnlyBanner}
      {feedback}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Link2 className="h-4 w-4" />
              Central lodge
            </CardTitle>
            <CardDescription>
              Which lodge in the Alpine Central Server&apos;s registry this is. The
              central server&apos;s public lodge search asks this site how many beds
              are free there, and sends non-members here to book.
            </CardDescription>
          </div>
          {!editing && (
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
              variant="outline"
              size="sm"
              onClick={section.startEditing}
              disabled={owned === null}
            >
              Edit
            </ViewOnlyActionButton>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-muted-foreground text-sm" role="status">
            {state}
          </p>

          {owned !== null && (
            <div className="max-w-md space-y-1">
              <Label htmlFor={selectId}>Central lodge</Label>
              <select
                id={selectId}
                className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm disabled:bg-muted disabled:text-muted-foreground"
                value={draft.centralLodgeId ?? NOT_LINKED}
                disabled={!editing}
                onChange={(event) =>
                  section.setDraft({
                    centralLodgeId:
                      event.target.value === NOT_LINKED ? null : event.target.value,
                  })
                }
              >
                <option value={NOT_LINKED}>
                  {defaultName ? `Not linked (automatically ${defaultName})` : "Not linked"}
                </option>
                {owned.map((lodge) => (
                  <option key={lodge.id} value={lodge.id}>
                    {lodge.name}
                  </option>
                ))}
                {staleLink && draft.centralLodgeId !== null && (
                  <option value={draft.centralLodgeId}>No longer owned (clear this)</option>
                )}
              </select>
              <p className="text-muted-foreground text-xs">
                Only the lodges the central server says this club owns are offered.
                Only the number of free beds is shared: never a guest, member or
                booking.
              </p>
            </div>
          )}

          {editing && (
            <div className="flex gap-3">
              <ViewOnlyActionButton
                canEdit={canEdit}
                describeReason={false}
                onClick={() => void section.save()}
                disabled={!dirty || saving}
              >
                {saving ? "Saving..." : "Save central lodge"}
              </ViewOnlyActionButton>
              {/* Cancel writes nothing, so it is a plain Button (see the roster card). */}
              <Button variant="outline" onClick={section.cancelEditing} disabled={saving}>
                Cancel
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
