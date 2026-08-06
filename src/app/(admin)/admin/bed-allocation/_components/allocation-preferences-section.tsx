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
import {
  BED_ALLOCATION_PRIORITY_VOCABULARY,
  type BedAllocationPriority,
} from "@/lib/bed-allocation-settings";

interface AllocationPreferencesDraft {
  autoAllocationEnabled: boolean;
  allocationPriorityOrder: BedAllocationPriority[];
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
      if (!response.ok) throw new Error("Failed to load allocation preferences");
      const body = (await response.json()) as {
        settings: AllocationPreferencesDraft;
      };
      return body.settings;
    },
    save: async (draft) => {
      const response = await fetch("/api/admin/bed-allocation/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...draft,
          lodgeId,
        }),
      });
      if (response.status === 403) throw new ForbiddenSaveError();
      if (!response.ok) throw new Error("Failed to save allocation preferences");
      const body = (await response.json()) as {
        settings: AllocationPreferencesDraft;
      };
      // The section is keyed by lodge. A save may finish after a scope change;
      // never let that stale completion refresh its former parent's board.
      if (mountedRef.current) await onSaved(body.settings);
      return body.settings;
    },
    successMessage: "Allocation preferences saved",
    loadErrorFallback: "Failed to load allocation preferences",
    saveErrorFallback: "Failed to save allocation preferences",
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
