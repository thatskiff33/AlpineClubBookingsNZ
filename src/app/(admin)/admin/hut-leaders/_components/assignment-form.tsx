"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Check, CalendarDays, Users, UserSearch } from "lucide-react";
import {
  OccupancyCalendar,
  type CalendarOverlayValue,
  type CalendarTone,
} from "@/components/admin/occupancy-calendar";
import { MemberPicker, type PickedMember } from "@/components/admin/member-picker";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";

export interface EligibleMember {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  hutLeaderEligible: boolean;
  hutLeaderEligibleAt: string | null;
  bookingCheckIn: string;
  bookingCheckOut: string;
  suggestedStartDate: string;
  suggestedEndDate: string;
  uncoveredNightCount: number;
  fullyCovered: boolean;
}

export interface AssignmentTarget {
  memberId: string;
  memberName: string;
}

export interface ConflictInfo {
  name: string;
  startDate: string;
  endDate: string;
  days: number;
}

export interface AssignmentSummary {
  name: string;
  startDate: string;
  endDate: string;
  nights: number;
  fills: number;
  conflicts: ConflictInfo[];
}

type MemberTab = "staying" | "any";

interface AssignmentFormProps {
  hutLeaderLabel: string;
  selectedStartDate: string;
  selectedEndDate: string;
  // Step 1: the operator picked new nights (calendar tap or date input). The
  // parent clears any selected target when this fires.
  onPickNights: (selection: { startDate: string; endDate: string }) => void;
  onVisibleMonthChange: (month: string) => void;
  overlayByDate: Record<string, CalendarOverlayValue>;
  overlayLegend: Array<{ tone: CalendarTone; label: string }>;
  // Step 2
  eligibleMembers: EligibleMember[];
  loadingMembers: boolean;
  target: AssignmentTarget | null;
  onSelectEligible: (member: EligibleMember) => void;
  onSelectAnyMember: (member: PickedMember) => void;
  onClearTarget: () => void;
  // Step 3
  summary: AssignmentSummary | null;
  creating: boolean;
  error: { message: string; memberId: string | null } | null;
  onConfirm: () => void;
  // Lodge edit gating (#1940): a lodge:view admin can view the picker but the
  // Confirm-assignment write is disabled.
  canEdit: boolean | undefined;
  /**
   * Whether this form renders its OWN view-only banner (#2160). Default `true`,
   * so the form is self-explaining wherever it is dropped. A parent that
   * already renders an `AdminViewOnlySectionBanner` covering this form passes
   * `false`: two identical banners, each in its own `role="status"`, announce
   * the same sentence twice to a view-only admin. Gating never changes — this
   * only says WHO states the reason.
   */
  renderViewOnlyBanner?: boolean;
  // Optional lodge picker (multi-lodge, ADR-002): renders in step 1 above the
  // date inputs. It renders nothing while fewer than two lodges exist.
  lodgeSelector?: ReactNode;
  // Optional custodian bed picker (#2286): renders under step 2, so the bed is
  // chosen after the person and before the confirm. The form stays purely
  // presentational — the parent owns the selection and sends it with the POST.
  bedPicker?: ReactNode;
}

export function AssignmentForm({
  hutLeaderLabel,
  selectedStartDate,
  selectedEndDate,
  onPickNights,
  onVisibleMonthChange,
  overlayByDate,
  overlayLegend,
  eligibleMembers,
  loadingMembers,
  target,
  onSelectEligible,
  onSelectAnyMember,
  onClearTarget,
  summary,
  creating,
  error,
  onConfirm,
  canEdit,
  renderViewOnlyBanner = true,
  lodgeSelector,
  bedPicker,
}: AssignmentFormProps) {
  const label = hutLeaderLabel.toLowerCase();
  const datesSelected = Boolean(
    selectedStartDate &&
      selectedEndDate &&
      selectedStartDate <= selectedEndDate,
  );
  const [memberTab, setMemberTab] = useState<MemberTab>("staying");
  const [anyMember, setAnyMember] = useState<PickedMember | null>(null);

  // When the parent drops the target (e.g. the operator re-picks nights), clear
  // the "Any member" combobox selection so the two tabs never disagree.
  useEffect(() => {
    if (!target) setAnyMember(null);
  }, [target]);

  const hasConflict = Boolean(summary && summary.conflicts.length > 0);

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before its
    content appears; a region injected already-populated is silently dropped by
    some screen-reader/browser pairings. It sits OUTSIDE the card so the empty
    wrapper an edit-capable admin gets costs no layout.

    `renderViewOnlyBanner={false}` suppresses it entirely for a parent that
    already covers this form with its own banner — the page-level banner on
    `/admin/hut-leaders` does, and two of them announced the same sentence
    twice. Suppressing the whole wrapper (rather than just its content) is
    correct here: the ancestor's wrapper is the registered live region, and a
    second empty one adds nothing.
  */
  const viewOnlyBanner = renderViewOnlyBanner ? (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view {label} assignments but cannot create them. Lodge
      edit access is required.
    </AdminViewOnlySectionBanner>
  ) : null;

  return (
    <div>
      {viewOnlyBanner}
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">New {hutLeaderLabel} Assignment</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Step 1 — pick nights */}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-foreground">
            1. Pick the nights to cover
          </h3>
          {lodgeSelector ? <div className="max-w-xs">{lodgeSelector}</div> : null}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="startDate">Start Date</Label>
              <Input
                id="startDate"
                type="date"
                value={selectedStartDate}
                onChange={(e) =>
                  onPickNights({ startDate: e.target.value, endDate: selectedEndDate })
                }
              />
            </div>
            <div>
              <Label htmlFor="endDate">End Date</Label>
              <Input
                id="endDate"
                type="date"
                value={selectedEndDate}
                onChange={(e) =>
                  onPickNights({ startDate: selectedStartDate, endDate: e.target.value })
                }
              />
            </div>
          </div>
          <OccupancyCalendar
            mode="range"
            selectedStartDate={selectedStartDate}
            selectedEndDate={selectedEndDate}
            onSelectionChange={onPickNights}
            overlayByDate={overlayByDate}
            overlayLegend={overlayLegend}
            // No `overlayCountsOperationalDay` here, deliberately (#2631):
            // this overlay is hut-leader COVERAGE, which is night-based and
            // fenced. Passing the flag would print "the day colours count who
            // is in the lodge that day, including a checkout morning" under a
            // calendar where that is simply not true.
            onVisibleMonthChange={onVisibleMonthChange}
          />
        </div>

        {/* Step 2 — pick a member */}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-foreground">
            2. Choose the {label}
          </h3>
          {!datesSelected ? (
            <p className="text-sm text-muted-foreground">
              Pick a start and end date first.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={memberTab === "staying" ? "default" : "outline"}
                  onClick={() => setMemberTab("staying")}
                >
                  <Users className="mr-1.5 h-3.5 w-3.5" />
                  Staying during these dates
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={memberTab === "any" ? "default" : "outline"}
                  onClick={() => setMemberTab("any")}
                >
                  <UserSearch className="mr-1.5 h-3.5 w-3.5" />
                  Any member
                </Button>
              </div>

              {memberTab === "staying" ? (
                loadingMembers ? (
                  <p className="text-sm text-muted-foreground">Loading eligible members...</p>
                ) : eligibleMembers.length === 0 ? (
                  <p className="text-sm text-warning">
                    No adult members have bookings during this date range. Use the
                    &quot;Any member&quot; tab to assign someone else.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {eligibleMembers.map((m) => {
                      const isSelected = target?.memberId === m.id;
                      return (
                        <div
                          key={m.id}
                          className={`rounded-lg border p-4 ${
                            m.fullyCovered ? "opacity-60 " : ""
                          }${
                            isSelected
                              ? "border-info bg-info-muted"
                              : "border-border bg-card"
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <p className="text-sm font-medium">
                                {m.firstName} {m.lastName}
                              </p>
                              <p className="text-xs text-muted-foreground">{m.email}</p>
                              <div className="mt-1.5">
                                {m.hutLeaderEligible ? (
                                  <Badge className="border-success/20 bg-success-muted text-success">
                                    {hutLeaderLabel} qualified
                                  </Badge>
                                ) : (
                                  <span className="text-xs text-muted-foreground">
                                    Not yet inducted
                                  </span>
                                )}
                              </div>
                              <div className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground">
                                <CalendarDays className="h-3.5 w-3.5" />
                                <span>
                                  Booking: {m.bookingCheckIn} — {m.bookingCheckOut}
                                </span>
                              </div>
                              <p className="mt-0.5 text-xs text-muted-foreground">
                                Suggested: {m.suggestedStartDate} — {m.suggestedEndDate}{" "}
                                (covers {m.uncoveredNightCount} uncovered night
                                {m.uncoveredNightCount !== 1 ? "s" : ""})
                              </p>
                              {m.fullyCovered && (
                                <p className="mt-1 text-xs text-warning">
                                  These dates already have a {label}.
                                </p>
                              )}
                            </div>
                            <Button
                              type="button"
                              size="sm"
                              variant={isSelected ? "default" : "outline"}
                              disabled={creating || m.fullyCovered}
                              onClick={() => onSelectEligible(m)}
                              className="flex-shrink-0"
                            >
                              <Check className="mr-1 h-3.5 w-3.5" />
                              {isSelected ? "Selected" : "Select"}
                            </Button>
                          </div>
                          {error?.memberId === m.id && (
                            <p className="mt-2 text-sm text-danger">{error.message}</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )
              ) : (
                <MemberPicker
                  selected={anyMember}
                  onSelect={(m) => {
                    setAnyMember(m);
                    onSelectAnyMember(m);
                  }}
                  onClear={() => {
                    setAnyMember(null);
                    onClearTarget();
                  }}
                  label={`Search any member to assign as ${label}`}
                  placeholder="Type a name or email..."
                  selectedPrefix="Assign"
                />
              )}
            </>
          )}
        </div>

        {/* Optional custodian bed hold (#2286) — only meaningful once both the
            nights and the person are settled, so it sits between steps 2 and 3. */}
        {bedPicker && datesSelected && target ? (
          <div className="border-t border-border pt-4">{bedPicker}</div>
        ) : null}

        {/* Step 3 — visual confirm (sticky above the submit button) */}
        {summary && (
          <div className="sticky bottom-0 z-10 -mx-6 -mb-6 space-y-2 border-t border-border bg-card px-6 py-4 text-card-foreground">
            <h3 className="text-sm font-semibold text-foreground">3. Confirm</h3>
            <p className="text-sm text-foreground">
              <span className="font-medium">Assign {summary.name}:</span>{" "}
              {summary.startDate} → {summary.endDate} · {summary.nights} night
              {summary.nights !== 1 ? "s" : ""} · fills {summary.fills} uncovered
              night{summary.fills !== 1 ? "s" : ""}
              {hasConflict && (
                <>
                  {" "}
                  ·{" "}
                  {summary.conflicts.reduce((sum, c) => sum + c.days, 0)} conflict
                  nights with{" "}
                  {summary.conflicts.map((c) => c.name).join(", ")}
                </>
              )}
            </p>
            {hasConflict && (
              <div className="rounded-md border border-danger/20 bg-danger-muted px-3 py-2 text-sm text-danger">
                {summary.conflicts.map((c) => (
                  <p key={`${c.name}-${c.startDate}`}>
                    Overlaps {c.name}&apos;s assignment ({c.startDate} to {c.endDate})
                    by {c.days} days. Maximum 1 day overlap is allowed for handover —
                    adjust the dates.
                  </p>
                ))}
              </div>
            )}
            {error && !hasConflict && (
              <div className="rounded-md border border-danger/20 bg-danger-muted px-3 py-2 text-sm text-danger">
                {error.message}
              </div>
            )}
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
              type="button"
              onClick={onConfirm}
              disabled={creating || hasConflict}
              className="w-full sm:w-auto"
            >
              {creating ? "Assigning..." : `Confirm assignment`}
            </ViewOnlyActionButton>
          </div>
        )}
      </CardContent>
    </Card>
    </div>
  );
}
