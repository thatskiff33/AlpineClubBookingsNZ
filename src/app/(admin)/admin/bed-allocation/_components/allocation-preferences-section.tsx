"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { PolicyFeedback } from "@/components/admin/booking-policies/policy-feedback";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import {
  ForbiddenSaveError,
  useSectionEditState,
} from "@/hooks/use-section-edit-state";
import { responseErrorMessage } from "@/lib/api-error-message";
import {
  BED_ALLOCATION_PRIORITY_VOCABULARY,
  type BedAllocationPriority,
} from "@/lib/bed-allocation-settings";

interface AllocationPreferencesDraft {
  autoAllocationEnabled: boolean;
  allocationPriorityOrder: BedAllocationPriority[];
}

/**
 * A 404 here means the bed-allocation module is switched off, not that the
 * address is wrong: the route's own guard answers a disabled module with
 * `{ error: "Not found" }` before it ever looks at the body. Passing that two
 * word sentence through would tell an admin nothing, so the module-off state
 * gets its own explicit message and stays distinguishable from both the
 * permission refusal (403) and the generic fallback (#2931).
 */
export const ALLOCATION_PREFERENCES_MODULE_OFF_REASON =
  "Bed allocation is turned off for this club, so allocation preferences cannot be loaded or saved. Turn the module on under Feature modules first.";

const LOAD_FALLBACK = "Failed to load allocation preferences";
const SAVE_FALLBACK = "Failed to save allocation preferences";

/**
 * The GET and PUT both answer with the server's EFFECTIVE settings view: the
 * two editable fields plus read-only provenance (`source`, `fallback`,
 * `settingsId`, `authoritativeLodgeId`, `updatedByMemberId`, `updatedAt`).
 * Only the two editable fields are the draft.
 *
 * Projecting here rather than at save time is the point: the PUT schema is
 * `.strict()`, so while the whole response WAS the draft, the save body spread
 * six fields the write contract does not accept and every save came back 400
 * "Invalid input" — which the generic error message then hid (#2931). Keeping
 * the draft narrow makes that unrepresentable instead of policed.
 */
function toDraft(settings: AllocationPreferencesDraft) {
  return {
    autoAllocationEnabled: settings.autoAllocationEnabled,
    allocationPriorityOrder: settings.allocationPriorityOrder,
  };
}

const LABELS: Record<BedAllocationPriority, string> = {
  BOOKING_COHESION: "Keep each booking together",
  STAY_CONTINUITY: "Keep guests in the same room and bed",
  REQUESTED_ROOM: "Honour the requested room",
  FAMILY_COHESION: "Keep direct family members together",
};

interface AllocationPreferencesSectionProps {
  lodgeId: string;
  canEdit: boolean | undefined;
  onSaved: (settings: AllocationPreferencesDraft) => Promise<void> | void;
  renderViewOnlyBanner?: boolean;
}

export function AllocationPreferencesSection({
  lodgeId,
  canEdit,
  onSaved,
  renderViewOnlyBanner = true,
}: AllocationPreferencesSectionProps) {
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    // React StrictMode rehearses setup -> cleanup -> setup. Re-arm the guard in
    // setup so the real mounted instance still refreshes its parent after Save.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const endpoint = `/api/admin/bed-allocation/settings?lodgeId=${encodeURIComponent(lodgeId)}`;
  const section = useSectionEditState<AllocationPreferencesDraft>({
    load: async (signal) => {
      const response = await fetch(endpoint, { cache: "no-store", signal });
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error(ALLOCATION_PREFERENCES_MODULE_OFF_REASON);
        }
        throw new Error(await responseErrorMessage(response, LOAD_FALLBACK));
      }
      const body = (await response.json()) as {
        settings: AllocationPreferencesDraft;
      };
      return toDraft(body.settings);
    },
    save: async (draft) => {
      const response = await fetch("/api/admin/bed-allocation/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // The write contract, field by field — never a spread of the draft.
        body: JSON.stringify({
          lodgeId,
          autoAllocationEnabled: draft.autoAllocationEnabled,
          allocationPriorityOrder: draft.allocationPriorityOrder,
        }),
      });
      // Three refusals an admin must be able to tell apart: their role can read
      // but not write (403), the module is off (404), and everything else, for
      // which the server's own curated sentence is the useful one and the
      // fallback covers a body that carried none.
      if (response.status === 403) throw new ForbiddenSaveError();
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error(ALLOCATION_PREFERENCES_MODULE_OFF_REASON);
        }
        throw new Error(await responseErrorMessage(response, SAVE_FALLBACK));
      }
      const body = (await response.json()) as {
        settings: AllocationPreferencesDraft;
      };
      const saved = toDraft(body.settings);
      // The section is keyed by lodge. A save may finish after a scope change;
      // never let that stale completion refresh its former parent's board.
      if (mountedRef.current) await onSaved(saved);
      return saved;
    },
    successMessage: "Allocation preferences saved",
    loadErrorFallback: LOAD_FALLBACK,
    saveErrorFallback: SAVE_FALLBACK,
    isDirty: (draft, saved) =>
      draft.autoAllocationEnabled !== saved.autoAllocationEnabled ||
      draft.allocationPriorityOrder.join("|") !==
        saved.allocationPriorityOrder.join("|"),
  });
  const draft = section.draft;

  const move = (from: number, to: number) => {
    if (
      !draft ||
      section.saving ||
      to < 0 ||
      to >= draft.allocationPriorityOrder.length
    ) {
      return;
    }
    section.setDraft((current) => {
      const next = [...current.allocationPriorityOrder];
      const [priority] = next.splice(from, 1);
      // A REAL missing state, not a restatement of the guard above: that guard
      // bounds `to` and has never bounded `from`. The drop handler passes a
      // `draggedIndex` captured at drag start, so removing a preference (or a
      // refresh shortening the list) mid-drag can hand this an index past the
      // end. `splice` then removes nothing and the insert below would put an
      // `undefined` INTO the saved priority order — one entry longer than it
      // started, with a bogus preference in it. Leaving the draft alone is the
      // only answer that cannot corrupt it (#2801).
      if (priority === undefined) return current;
      next.splice(to, 0, priority);
      return { ...current, allocationPriorityOrder: next };
    });
  };

  return (
    <div>
      {renderViewOnlyBanner ? (
        <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-4">
          Your admin role can view allocation preferences but cannot change
          them. Bookings edit access is required.
        </AdminViewOnlySectionBanner>
      ) : null}
      <PolicyFeedback
        error={section.error}
        success={section.success}
        onClearError={() => section.setError("")}
        onClearSuccess={() => section.setSuccess("")}
      />
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Allocation preferences</CardTitle>
          {draft && !section.editing ? (
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
              variant="outline"
              size="sm"
              onClick={section.startEditing}
            >
              Edit
            </ViewOnlyActionButton>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-4">
          {section.loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner size="sm" label="Loading allocation preferences" />
              Loading allocation preferences
            </div>
          ) : null}
          {!section.loading && !draft ? (
            <Button
              variant="outline"
              disabled={section.loading || section.saving}
              onClick={() => void section.reload()}
            >
              Try again
            </Button>
          ) : null}
          {draft ? (
            <>
              <label className="flex items-center gap-3 text-sm font-medium">
                <Checkbox
                  checked={draft.autoAllocationEnabled}
                  disabled={!section.editing || section.saving}
                  onCheckedChange={(checked) =>
                    section.setDraft({ autoAllocationEnabled: checked === true })
                  }
                />
                Auto allocation enabled
              </label>
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  Preferences are applied from top to bottom. Removing every
                  preference leaves deterministic neutral allocation.
                </p>
                {draft.allocationPriorityOrder.map((priority, index) => (
                  <div
                    key={priority}
                    draggable={section.editing && !section.saving}
                    onDragStart={() => {
                      if (!section.saving) setDraggedIndex(index);
                    }}
                    onDragEnd={() => setDraggedIndex(null)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => {
                      if (!section.saving && draggedIndex !== null) {
                        move(draggedIndex, index);
                      }
                      setDraggedIndex(null);
                    }}
                    className="flex items-center gap-2 rounded-md border p-2"
                  >
                    <GripVertical className="h-4 w-4 text-muted-foreground" />
                    <span className="flex-1 text-sm">{LABELS[priority]}</span>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      disabled={
                        !section.editing || section.saving || index === 0
                      }
                      aria-label={`Move ${LABELS[priority]} up`}
                      onClick={() => move(index, index - 1)}
                    >
                      <ArrowUp className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      disabled={
                        !section.editing ||
                        section.saving ||
                        index === draft.allocationPriorityOrder.length - 1
                      }
                      aria-label={`Move ${LABELS[priority]} down`}
                      onClick={() => move(index, index + 1)}
                    >
                      <ArrowDown className="h-4 w-4" />
                    </Button>
                    {section.editing ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={section.saving}
                        aria-label={`Disable ${LABELS[priority]}`}
                        onClick={() =>
                          section.setDraft({
                            allocationPriorityOrder:
                              draft.allocationPriorityOrder.filter(
                                (candidate) => candidate !== priority,
                              ),
                          })
                        }
                      >
                        Disable
                      </Button>
                    ) : null}
                  </div>
                ))}
                {BED_ALLOCATION_PRIORITY_VOCABULARY.filter(
                  (priority) =>
                    !draft.allocationPriorityOrder.includes(priority),
                ).map((priority) => (
                  <div
                    key={priority}
                    className="flex items-center gap-2 rounded-md border border-dashed p-2 text-muted-foreground"
                  >
                    <span className="flex-1 text-sm">{LABELS[priority]}</span>
                    {section.editing ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={section.saving}
                          aria-label={`Enable ${LABELS[priority]}`}
                          onClick={() =>
                            section.setDraft({
                              allocationPriorityOrder: [
                                ...draft.allocationPriorityOrder,
                                priority,
                              ],
                            })
                          }
                        >
                          Enable
                        </Button>
                    ) : (
                      <Badge variant="outline">Disabled</Badge>
                    )}
                  </div>
                ))}
              </div>
              {section.editing ? (
                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    disabled={section.saving}
                    onClick={section.cancelEditing}
                  >
                    Cancel
                  </Button>
                  <ViewOnlyActionButton
                    canEdit={canEdit}
                    describeReason={false}
                    disabled={!section.dirty || section.saving}
                    onClick={() => void section.save()}
                  >
                    Save
                  </ViewOnlyActionButton>
                </div>
              ) : null}
            </>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
