"use client";

import { useRef, useState } from "react";
import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { PolicyFeedback } from "@/components/admin/booking-policies/policy-feedback";
import { LODGE_OPTIONS_RETRY_LABEL } from "@/components/admin/lodge-options-status";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { useRevealAttention } from "@/hooks/use-scroll-to-feedback";
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
import type {
  LodgeOptionScopeOnLodge,
  SettledLodgeOptionScope,
} from "@/lib/lodge-option-scope";

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
> & {
  /**
   * The lodge this draft was LOADED from, carried in the draft itself so that
   * the save can only ever write back to it (#2937).
   *
   * Dirty state must never cross lodge scope: an officer who edits, switches
   * lodge and saves must not have their edits written onto the lodge they
   * switched to. {@link AllocationPreferencesPanel} already keys this component
   * by lodge, so a switch unmounts the draft outright and the crossing cannot
   * begin — but that guarantee lives in the CALLER, one `key` away from being
   * dropped by the next person who moves this card. Taking the write target out
   * of the render-time prop and into the loaded draft makes the bad write
   * unrepresentable instead: a stale draft names a stale lodge, and the newly
   * chosen lodge is not a value it can reach.
   */
  readonly lodgeId: string;
};

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
  lodgeId: string,
  settings: EffectiveBedAllocationSettings,
): AllocationPreferencesDraft {
  return {
    lodgeId,
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
  /**
   * A scope that has SETTLED on one lodge — the only state this editor accepts.
   *
   * The narrowed variant of the shared type rather than a bare `lodgeId`, so
   * "only a settled lodge is a write target" is a fact about the props and not
   * a rule a host has to remember. {@link AllocationPreferencesPanel} is what
   * produces one, by discriminating the scope it was handed.
   */
  scope: LodgeOptionScopeOnLodge;
  canEdit: boolean | undefined;
}

export function AllocationPreferencesSection({
  scope,
  canEdit,
}: AllocationPreferencesSectionProps) {
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  // Edit replaces the header button with nothing the admin can stand on, so
  // focus would drop to <body>; the shared reveal primitive moves it (and the
  // viewport) to the card instead, keyed on the explicit Edit click (#2934).
  const cardRef = useRef<HTMLDivElement>(null);
  const lodgeId = scope.lodgeId;
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
      return toDraft(lodgeId, settings);
    },
    save: async (draft) => {
      // The write contract, field by field and TYPED by it — never a spread of
      // the draft. The annotation is what makes a stray field a compile error.
      const writeBody: BedAllocationSettingsWriteBody = {
        // The DRAFT's lodge, never the render-time prop: see
        // `AllocationPreferencesDraft.lodgeId`.
        lodgeId: draft.lodgeId,
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
      return toDraft(draft.lodgeId, settings);
    },
    successMessage: "Allocation preferences saved",
    loadErrorFallback: LOAD_FALLBACK,
    saveErrorFallback: SAVE_FALLBACK,
    isDirty: (draft, saved) =>
      draft.autoAllocationEnabled !== saved.autoAllocationEnabled ||
      draft.allocationPriorityOrder.join("|") !==
        saved.allocationPriorityOrder.join("|"),
  });
  useRevealAttention(cardRef, section.editRequestKey);
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
      <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-4">
        Your admin role can view allocation preferences but cannot change them.
        Bookings edit access is required.
      </AdminViewOnlySectionBanner>
      <PolicyFeedback
        error={section.error}
        success={section.success}
        onClearError={() => section.setError("")}
        onClearSuccess={() => section.setSuccess("")}
      />
      <Card ref={cardRef} className="scroll-mt-20">
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

/**
 * What the Allocation preferences card says when there is no lodge to edit.
 *
 * One sentence per scope state, because "Choose a lodge to continue" is only
 * true in one of them: a club with no active lodge has nothing to choose, a
 * role without lodge access cannot choose, and a failed lodge list is an outage
 * rather than a choice (#2701, carried across in #2937).
 *
 * `failed` deliberately points at the retry the page already renders through
 * `LodgeScopeStatusNotice` rather than growing a second button. That is the
 * canonical handling, stated by `LodgeOptionsUnavailableNotice` itself:
 * retrying the lodge list is what brings every lodge-scoped card back, "so
 * there is one button, not two".
 */
function scopeReason(
  scope: Exclude<SettledLodgeOptionScope, { kind: "lodge" }>,
): string {
  switch (scope.kind) {
    case "all":
      return "Preferences are set per lodge. Choose a single lodge to see and edit them.";
    case "forbidden":
      return "Preferences are set per lodge, and your admin role cannot choose one. Ask for lodge access if you need to change them.";
    case "failed":
      return `The lodge list could not be loaded, so preferences cannot be shown or changed. Use ${LODGE_OPTIONS_RETRY_LABEL} above.`;
    case "empty":
      return "This club has no active lodge, so there are no preferences to show.";
    case "loading":
      return "Loading lodge…";
  }
}

/**
 * The ONE mount point for the allocation preferences editor (#2937).
 *
 * It takes the whole {@link SettledLodgeOptionScope} rather than a `lodgeId`,
 * which is what makes the binding contract's five states structural instead of
 * remembered:
 *
 * - `lodge`     — the editor, keyed by that lodge, loading/editing/saving it
 *                 and nothing else;
 * - `all`       — visible, read-only, with the select-a-lodge prompt. There is
 *                 no write target and no "apply to every lodge" reading of it;
 * - `loading`   — says so, and fetches nothing. It cannot guess a lodge because
 *                 a `loading` scope carries no lodge id to guess WITH;
 * - `failed`    — the canonical failure and its one retry, no write target;
 * - `forbidden` — permission wording, no edit path.
 *
 * (`empty` is the sixth state of the shared type — a club with no active lodge
 * — and is handled beside them rather than left to fall through.)
 *
 * The editor cannot be handed a lodge that no scope settled on: it takes the
 * narrowed {@link LodgeOptionScopeOnLodge} — the `lodge` variant of the shared
 * type — rather than a bare lodge id, so the only way to reach it is to
 * discriminate a real scope, which is what this function does. The per-lodge
 * `key` lives here too, rather than at each call site.
 *
 * That is a guarantee about the SHAPE, not about the mounting. The editor is
 * still exported, because its own suites drive it directly; mounting it through
 * this panel is a convention, and the reason to keep it is that this is where
 * the five non-`lodge` states are answered.
 *
 * Rooms & Beds, its only host today, does not offer a club-wide view of its
 * inventory, so `all` is defensive there rather than reachable. It is still
 * implemented and tested: the state is part of the shared scope type, the next
 * host may well offer it, and the failure mode it prevents — an "all lodges"
 * view that silently acquires a write target — is the one this issue exists to
 * make impossible.
 */
export function AllocationPreferencesPanel({
  scope,
  canEdit,
}: {
  scope: SettledLodgeOptionScope;
  canEdit: boolean | undefined;
}) {
  if (scope.kind === "lodge") {
    return (
      <AllocationPreferencesSection
        key={scope.lodgeId}
        scope={scope}
        canEdit={canEdit}
      />
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Allocation preferences</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        {scopeReason(scope)}
      </CardContent>
    </Card>
  );
}
