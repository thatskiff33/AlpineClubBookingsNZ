"use client";

import { GraduationCap } from "lucide-react";
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
  ForbiddenSaveError,
  useSectionEditState,
} from "@/hooks/use-section-edit-state";
import { ViewOnlyActionButton } from "@/components/admin/view-only-action";
import {
  SCHOOL_HUT_LEADER_KINDS,
  type SchoolHutLeaderKind,
  type SchoolHutLeaderKinds,
} from "@/lib/school-hut-leader-kinds";

const ENDPOINT = "/api/admin/lodge-settings/school-hut-leaders";

/** What each tick means, in the order the setting lists them (#3819). */
const KIND_LABELS: Record<SchoolHutLeaderKind, { label: string; hint: string }> = {
  teacherOnBooking: {
    label: "A teacher on the booking",
    hint: "Approving a school booking makes its teachers hut leaders and emails them a PIN.",
  },
  custodian: {
    label: "The lodge custodian",
    hint: "An assignment ticked Custodian (lives on site), or one holding a custodian bed.",
  },
  memberOnBooking: {
    label: "A member on the school booking",
    hint: "A club member linked to the school booking and staying that night.",
  },
  memberStayingSeparately: {
    label: "A member staying separately",
    hint: "A club member on their own booking at this lodge that night.",
  },
};

async function readKinds(lodgeId: string, asSaveStep = false): Promise<SchoolHutLeaderKinds> {
  const res = await fetch(`${ENDPOINT}?lodgeId=${encodeURIComponent(lodgeId)}`, {
    cache: "no-store",
  });
  if (!res.ok) {
    if (asSaveStep && res.status === 403) throw new ForbiddenSaveError();
    throw new Error("Failed to load who can be hut leader for school bookings");
  }
  return ((await res.json()) as { kinds: SchoolHutLeaderKinds }).kinds;
}

/**
 * "Who can be hut leader for school bookings" for one lodge (#3819, owner
 * decisions on #3789/#3820). A night a school booking stays here counts as
 * covered only when its hut leader is a ticked kind, and approving a school
 * request makes its teachers hut leaders only when teachers are ticked.
 *
 * The canonical settings pattern (`docs/ARCHITECTURE.md` → "Admin/member
 * layer"): read-only until Edit, Save gated on a change, Cancel restores the
 * stored value, and every edit affordance gated through `ViewOnlyActionButton`.
 * The card renders no banner of its own: the lodge hub that hosts it already
 * heads the page with one, and vouches for it by passing
 * `ancestorRendersViewOnlyBanner` (#2168). Rendered anywhere else without that,
 * each button explains itself. The hook loads on
 * mount only, so the page keys this card by lodge.
 */
export function SchoolHutLeaderKindsCard({
  lodgeId,
  canEdit,
  ancestorRendersViewOnlyBanner = false,
}: {
  lodgeId: string;
  canEdit: boolean | undefined;
  ancestorRendersViewOnlyBanner?: boolean;
}) {
  const section = useSectionEditState<SchoolHutLeaderKinds>({
    // No `initial`: the card shows no ticks until the lodge's own are loaded,
    // so a failed load can never present the defaults as this lodge's setting.
    load: () => readKinds(lodgeId),
    save: async (draft) => {
      const res = await fetch(ENDPOINT, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lodgeId, kinds: draft }),
      });
      if (!res.ok) {
        if (res.status === 403) throw new ForbiddenSaveError();
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? "Failed to save");
      }
      return ((await res.json()) as { kinds: SchoolHutLeaderKinds }).kinds;
    },
    successMessage: "Saved who can be hut leader for school bookings",
  });

  const draft = section.draft;
  const busy = section.loading || section.saving;
  const noneTicked = draft !== null && SCHOOL_HUT_LEADER_KINDS.every((kind) => !draft[kind]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <GraduationCap className="h-4 w-4" />
            Who can be hut leader for school bookings
          </CardTitle>
          <CardDescription>
            On a night a school group stays at this lodge, the night counts as
            covered only when its hut leader is one of the ticked kinds.
          </CardDescription>
        </div>
        {!section.editing && (
          <ViewOnlyActionButton
            type="button"
            canEdit={canEdit}
            describeReason={!ancestorRendersViewOnlyBanner}
            variant="outline"
            size="sm"
            aria-label="Edit who can be hut leader for school bookings"
            onClick={section.startEditing}
            disabled={busy || draft === null}
          >
            Edit
          </ViewOnlyActionButton>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {draft === null ? (
          section.loading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-danger-11" role="alert">
                Couldn&apos;t load who can be hut leader for this lodge&apos;s
                school bookings. Nothing is shown rather than a guess.
              </p>
              <Button type="button" variant="outline" size="sm" onClick={() => void section.reload()}>
                Try again
              </Button>
            </div>
          )
        ) : (
        <fieldset className="space-y-3">
          <legend className="sr-only">Who can be hut leader for school bookings</legend>
          {SCHOOL_HUT_LEADER_KINDS.map((kind) => {
            const id = `school-hut-leader-${kind}`;
            return (
              <div key={kind} className="flex items-start gap-2">
                <input
                  type="checkbox"
                  id={id}
                  aria-describedby={`${id}-hint`}
                  checked={draft[kind]}
                  onChange={(e) => section.setDraft({ [kind]: e.target.checked })}
                  className="mt-1 rounded border-input"
                  disabled={!section.editing || busy}
                />
                <div>
                  <Label htmlFor={id}>{KIND_LABELS[kind].label}</Label>
                  <p id={`${id}-hint`} className="text-xs text-muted-foreground">
                    {KIND_LABELS[kind].hint}
                  </p>
                </div>
              </div>
            );
          })}
        </fieldset>
        )}
        {noneTicked && (
          <p className="text-sm text-warning-11" role="status">
            With nothing ticked, no hut leader can cover a school group&apos;s
            nights here, so each one shows as needing a leader.
          </p>
        )}
        {section.editing && (
          <div className="flex gap-3">
            <ViewOnlyActionButton
              type="button"
              canEdit={canEdit}
              describeReason={!ancestorRendersViewOnlyBanner}
              onClick={() => void section.save()}
              disabled={busy || !section.dirty || !canEdit}
            >
              {section.saving ? "Saving..." : "Save"}
            </ViewOnlyActionButton>
            <Button
              type="button"
              variant="outline"
              aria-label="Cancel editing who can be hut leader for school bookings"
              onClick={section.cancelEditing}
              disabled={section.saving}
            >
              Cancel
            </Button>
          </div>
        )}
        {section.error && draft !== null && (
          <p className="text-sm text-danger-11" role="alert">
            {section.error}
          </p>
        )}
        {section.success && (
          <p className="text-sm text-success-11" role="status">
            {section.success}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
