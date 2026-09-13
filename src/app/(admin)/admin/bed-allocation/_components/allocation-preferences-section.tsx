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
  MODULE_DISABLED_ERROR_CODE,
  apiErrorCodeFromBody,
  apiErrorMessageFromBody,
  readApiErrorBody,
} from "@/lib/api-error-message";
import {
  BED_ALLOCATION_PRIORITY_VOCABULARY,
  type BedAllocationPriority,
  type BedAllocationSettingsWriteBody,
  type EffectiveBedAllocationSettings,
} from "@/lib/bed-allocation-settings";

/**
 * The editable half of the settings payload, DERIVED from the server's own type
 * rather than restated (#2931).
 *
 * It used to be a hand-written interface naming the same two fields, and the
 * responses were cast to it at both the load and the save — so the compiler
 * never saw the six read-only provenance fields that actually arrive, and the
 * projection below type-checked as an identity function. `Pick` costs nothing
 * here (this module is client-safe and already imported) and turns a
 * server-side rename of either field into a compile error instead of a runtime
 * surprise.
 */
type AllocationPreferencesDraft = Pick<
  EffectiveBedAllocationSettings,
  "autoAllocationEnabled" | "allocationPriorityOrder"
>;

/**
 * Why a refused load or save is not diagnosed from the status code (#2931).
 *
 * `/api/admin/bed-allocation` is module-gated, and a module-gated route answers
 * 404 both when the module is off and when the caller is not signed in at all —
 * `moduleGatedNotFoundResponse` in `src/lib/session-guards.ts` does that on
 * purpose, so one anonymous probe cannot read which optional modules a club
 * runs. Reading 404 as "module off" therefore told an admin whose session had
 * expired mid-board to go and turn a module on: on a page they could not reach,
 * and which only a `support` role could switch anyway. A wrong diagnosis, not
 * merely an unhelpful message.
 *
 * So the module refusal NAMES itself — `code: MODULE_DISABLED` on the route's
 * own 404, set only past the permission guard — and this screen reads the name.
 * A 404 without it is the other cause, and is worded as such.
 */
export const ALLOCATION_PREFERENCES_MODULE_OFF_REASON =
  "Bed allocation is switched off for this club, so allocation preferences cannot be loaded or saved. Someone who can manage Feature modules can turn it on.";

/**
 * 401. The gate that turns an anonymous 401 into a 404 fails OPEN when the
 * request-path header is missing, so this status is reachable — and used to
 * reach the officer as the bare word "Unauthorized".
 */
export const ALLOCATION_PREFERENCES_SIGNED_OUT_REASON =
  "Your sign-in has expired, so allocation preferences could not be loaded or saved. Sign in again — another tab is fine — then try again.";

/**
 * 404 with no module code. Hedged, because the browser cannot prove it: an
 * expired sign-in is the cause this route can actually produce, and the action
 * that settles it is the same one either way.
 */
export const ALLOCATION_PREFERENCES_NOT_FOUND_REASON =
  "Your sign-in may have expired, so this request was refused. Sign in again — another tab is fine — then try again.";

/**
 * 403 on the LOAD. The save's 403 keeps the shared
 * `ADMIN_FORBIDDEN_SAVE_REASON` ("this change was not saved…"), which is the
 * wrong tense for a read that never attempted a change — and before this the
 * load had no 403 branch at all, so it rendered the bare word "Forbidden".
 */
export const ALLOCATION_PREFERENCES_VIEW_FORBIDDEN_REASON =
  "Your admin role cannot view allocation preferences. Bookings view access is required. Refresh the page to see the latest permissions.";

/**
 * The bare word `requireAdmin` answers a plain permission refusal with
 * (`forbiddenResponse` in `src/lib/session-guards.ts`). It is the ONE 403 body
 * worth replacing: the guard's other 403s — "Two-factor verification required",
 * "Password change required", "Account is deactivated" — are curated, specific
 * and actionable, and overwriting them with a generic sentence about roles
 * would be the same wrong diagnosis this whole change removes.
 */
const BARE_FORBIDDEN_ERROR = "Forbidden";

const LOAD_FALLBACK = "Failed to load allocation preferences";
const SAVE_FALLBACK = "Failed to save allocation preferences";
const UNREADABLE_SAVE_REPLY =
  "Allocation preferences may have been saved, but the reply could not be read. Reload the board to see what is stored.";

/**
 * Turn a non-OK reply into the error to throw, reading the body exactly once —
 * a `Response` body can only be read once, and both the code and the sentence
 * come out of it.
 *
 * `bareForbidden` is what a 403 becomes when the body carries nothing better:
 * the load wants a read-shaped sentence, the save wants the hook's shared
 * "this change was not saved" copy via {@link ForbiddenSaveError}.
 */
async function refusalFor(
  response: Response,
  fallback: string,
  bareForbidden: () => Error,
): Promise<Error> {
  const body = await readApiErrorBody(response);
  if (apiErrorCodeFromBody(body) === MODULE_DISABLED_ERROR_CODE) {
    return new Error(ALLOCATION_PREFERENCES_MODULE_OFF_REASON);
  }
  if (response.status === 401) {
    return new Error(ALLOCATION_PREFERENCES_SIGNED_OUT_REASON);
  }
  if (response.status === 404) {
    return new Error(ALLOCATION_PREFERENCES_NOT_FOUND_REASON);
  }
  if (response.status === 403) {
    const message = apiErrorMessageFromBody(body, BARE_FORBIDDEN_ERROR);
    return message === BARE_FORBIDDEN_ERROR
      ? bareForbidden()
      : new Error(message);
  }
  return new Error(apiErrorMessageFromBody(body, fallback));
}

/**
 * The settings out of a 200 body, or `null` when the reply is not the shape
 * this screen was promised.
 *
 * A 200 whose body has no `settings` used to reach `toDraft(undefined)` and put
 * a raw `TypeError` on the officer's screen — internal detail, which is the one
 * thing the card's error contract says never happens (#2931).
 */
function settingsOf(payload: unknown): EffectiveBedAllocationSettings | null {
  const settings = (payload as { settings?: unknown } | null | undefined)
    ?.settings;
  if (typeof settings !== "object" || settings === null) return null;
  const candidate = settings as Partial<EffectiveBedAllocationSettings>;
  return typeof candidate.autoAllocationEnabled === "boolean" &&
    Array.isArray(candidate.allocationPriorityOrder)
    ? (candidate as EffectiveBedAllocationSettings)
    : null;
}

/**
 * The GET and PUT both answer with the server's EFFECTIVE settings view: the
 * two editable fields plus read-only provenance (`source`, `fallback`,
 * `settingsId`, `authoritativeLodgeId`, `updatedByMemberId`, `updatedAt`).
 * Only the two editable fields are the draft.
 *
 * Projecting here rather than at save time is the point: the PUT schema is
 * `.strict()`, so while the whole response WAS the draft, the save body spread
 * six fields the write contract does not accept and every save came back 400
 * "Invalid input" — which the generic error message then hid (#2931). Taking
 * the WIDE type is what makes this a real projection to the compiler rather
 * than an identity function wearing a cast.
 */
function toDraft(
  settings: EffectiveBedAllocationSettings,
): AllocationPreferencesDraft {
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
        throw await refusalFor(
          response,
          LOAD_FALLBACK,
          () => new Error(ALLOCATION_PREFERENCES_VIEW_FORBIDDEN_REASON),
        );
      }
      const settings = settingsOf(await response.json().catch(() => null));
      if (!settings) throw new Error(LOAD_FALLBACK);
      return toDraft(settings);
    },
    save: async (draft) => {
      // The write contract, field by field and TYPED by it — never a spread of
      // the draft. The annotation is what makes a stray field a compile error.
      const writeBody: BedAllocationSettingsWriteBody = {
        lodgeId,
        autoAllocationEnabled: draft.autoAllocationEnabled,
        allocationPriorityOrder: draft.allocationPriorityOrder,
      };
      const response = await fetch("/api/admin/bed-allocation/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(writeBody),
      });
      if (!response.ok) {
        throw await refusalFor(
          response,
          SAVE_FALLBACK,
          () => new ForbiddenSaveError(),
        );
      }
      const settings = settingsOf(await response.json().catch(() => null));
      if (!settings) throw new Error(UNREADABLE_SAVE_REPLY);
      const saved = toDraft(settings);
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
