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
 * administrator links the two, and EVERY club saves its link here, a one-lodge
 * club included (owner decision, 24 Oct 2026, #4262): an unlinked lodge
 * answers nothing. For a club with one active lodge that owns one central
 * lodge, Edit preselects that lodge, and Save is still what links it.
 *
 * The canonical settings pattern, as `lodge-roster-settings-card.tsx`: read-only
 * on mount, a staged Edit -> Save/Cancel step, Save dirty-gated, every edit
 * affordance a `ViewOnlyActionButton` under ONE `AdminViewOnlySectionBanner`
 * mounted in every branch, and focus returning to the Edit button and the
 * card's title through the hook's own props after Save or Cancel (#4087).
 */

interface OwnedLodge {
  id: string;
  name: string;
  /** The option's text: the name, with the location when names repeat (#69). */
  label: string;
}

interface CentralLodgeResponse {
  lodgeId: string;
  lodgeName: string;
  lodgeActive: boolean;
  centralLodgeId: string | null;
  ownedLodges: OwnedLodge[] | null;
  answersForCentralLodgeId: string | null;
  linkHeldBy: string | null;
  /** Preselected on Edit for a one-lodge club (#4262); never an answer until saved. */
  suggestedCentralLodgeId: string | null;
  otherLodgesEnabled: boolean;
  registeredWithCentralServer: boolean;
}

type CentralLodgeDraft = Omit<CentralLodgeResponse, "lodgeId" | "lodgeName">;

function endpoint(lodgeId: string) {
  return `/api/admin/lodges/${encodeURIComponent(lodgeId)}/central-lodge`;
}

function toDraft(body: CentralLodgeResponse): CentralLodgeDraft {
  return {
    lodgeActive: body.lodgeActive,
    centralLodgeId: body.centralLodgeId,
    ownedLodges: body.ownedLodges,
    answersForCentralLodgeId: body.answersForCentralLodgeId,
    linkHeldBy: body.linkHeldBy,
    suggestedCentralLodgeId: body.suggestedCentralLodgeId,
    otherLodgesEnabled: body.otherLodgesEnabled,
    registeredWithCentralServer: body.registeredWithCentralServer,
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

  // The status line says what is SAVED, never the unsaved choice in the
  // editor (#4262 review): before Save the lodge answers as it did.
  const current = section.saved ?? draft;
  const owned = draft.ownedLodges;
  const linkedName = nameOf(owned, current.centralLodgeId);
  // The server's suggestion for a one-lodge club (#4262): offered on Edit,
  // linked only by Save. The card never re-derives it.
  const suggestedName = nameOf(owned, current.suggestedCentralLodgeId);
  // A stored link to a lodge the club no longer owns stays visible, so an
  // administrator can see why the lodge is not answering and clear it.
  const staleLink = current.centralLodgeId !== null && linkedName === null;
  // What to do about an unlinked lodge depends on who is reading (#4262
  // review): a lodge:view administrator cannot Edit, so is not told to.
  const viewOnly = canEdit === false;
  const toLink = viewOnly
    ? "An administrator with lodge edit access needs to choose this lodge's entry and save it."
    : null;

  let state: string;
  if (!current.otherLodgesEnabled) {
    state =
      "Other lodges sharing with the Alpine Central Server is off, so the central server is told nothing about free beds.";
  } else if (owned === null) {
    state =
      "The central server has not yet said which lodges this club owns. Download from the central server first.";
  } else if (!current.registeredWithCentralServer) {
    state =
      "This site has not registered with the central server, so it cannot check that a question really came from it and answers none. Turn on the Message board module; the site's address must start with https://. The next sync registers it.";
  } else if (!current.lodgeActive) {
    state = "This lodge is inactive, so it never answers.";
  } else if (current.centralLodgeId !== null && !staleLink) {
    state = `Linked to ${linkedName}. The central server's lodge search shows its free beds.`;
  } else if (staleLink) {
    state =
      "Linked to a lodge the central server no longer says this club owns, so nothing is answered. Choose again or clear it.";
  } else if (current.linkHeldBy) {
    state = `Not linked: the club's central lodge is linked to ${current.linkHeldBy}. Unlink it there to use it here.`;
  } else if (suggestedName) {
    state = `Not linked yet, so the central server's lodge search shows its free beds as unknown. ${toLink ?? `Click Edit: ${suggestedName} is chosen for you, and Save links it.`} Every lodge needs its link saved here, even in a club with one lodge.`;
  } else {
    state = `Not linked, so the central server's lodge search shows its free beds as unknown. ${toLink ?? "Click Edit, choose this lodge's entry and Save to link it."}`;
  }
  if (editing && dirty) state = `${state} Your change is not saved yet.`;

  // Edit preselects the suggestion (#4262) as an unsaved change, so Save is
  // what links it and Cancel leaves the lodge unlinked.
  const startEditing = () => {
    section.startEditing();
    const suggestion = draft.suggestedCentralLodgeId;
    if (draft.centralLodgeId === null && suggestion !== null) {
      section.setDraft({ centralLodgeId: suggestion });
    }
  };

  return (
    <div>
      {viewOnlyBanner}
      {feedback}
      <Card {...section.sectionRegionProps}>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle {...section.titleProps} className="flex items-center gap-2 text-base">
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
              onClick={startEditing}
              disabled={owned === null}
              {...section.editTriggerProps}
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
                <option value={NOT_LINKED}>Not linked</option>
                {owned.map((lodge) => (
                  <option key={lodge.id} value={lodge.id}>
                    {lodge.label}
                  </option>
                ))}
                {staleLink && current.centralLodgeId !== null && (
                  <option value={current.centralLodgeId}>No longer owned (clear this)</option>
                )}
              </select>
              <p className="text-muted-foreground text-xs">
                Only the lodges the central server says this club owns are offered.
                Only free-bed counts are shared, night by night: never a guest,
                member or booking.
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
