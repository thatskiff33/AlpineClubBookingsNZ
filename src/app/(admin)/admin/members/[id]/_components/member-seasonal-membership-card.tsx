"use client";

import { useEffect, useMemo, useState } from "react";
import { Eye, Loader2, RefreshCw, Save } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AdminViewOnlyNotice,
  ViewOnlyActionButton,
  type AncestorViewOnlyBannerProps,
} from "@/components/admin/view-only-action";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ROLE_LABELS } from "@/lib/member-roles";
import { formatCents } from "@/lib/utils";
import { clubSeasonYear } from "@/lib/financial-year";
import { seasonSelectLabel } from "@/lib/season-label";
import { useClubTime } from "@/components/club-time-provider";
import { parseInstant, type BoundClubTime } from "@/lib/club-time";
import { formatPayloadCalendarDay } from "../../../_lib/calendar-day";
import type {
  MembershipTypeSummary,
  MemberDetail,
  SeasonalMembershipAssignmentSummary,
} from "../_types";

type BookingBehavior = "MEMBER_RATE" | "NON_MEMBER_RATE" | "BLOCK_BOOKING";
type SubscriptionBehavior = "REQUIRED" | "NOT_REQUIRED" | "BASED_ON_AGE_TIER";

interface MembershipTypesResponse {
  membershipTypes: MembershipTypeSummary[];
}

interface PreviewBookingSummary {
  count: number;
  truncatedCount: number;
  list: Array<{
    id: string;
    checkIn: string;
    checkOut: string;
    status: string;
    finalPriceCents: number;
    guestCount: number;
    waitlistPosition: number | null;
    waitlistOfferExpiresAt: string | null;
  }>;
}

interface SeasonalMembershipPreview {
  seasonYear: number;
  applyFrom: string | null;
  previousAssignment: SeasonalMembershipAssignmentSummary | null;
  newMembershipType: MembershipTypeSummary;
  resultingBookingBehavior: BookingBehavior;
  resultingSubscriptionBehavior: SubscriptionBehavior;
  behaviorChanged: boolean;
  bookingBehaviorChanged: boolean;
  subscriptionBehaviorChanged: boolean;
  affectedCounts: {
    futureConfirmedBookings: number;
    draftBookings: number;
    waitlistRecords: number;
  };
  futureConfirmedBookings: PreviewBookingSummary;
  draftBookings: PreviewBookingSummary;
  waitlistRecords: PreviewBookingSummary;
  currentSeasonSubscription: {
    seasonYear: number;
    status: string;
    hasInvoice: boolean;
    xeroInvoiceNumber: string | null;
    paidAt: string | null;
  };
  subscriptionHistory: {
    totalRecords: number;
    recent: Array<{
      seasonYear: number;
      status: string;
      hasInvoice: boolean;
      xeroInvoiceNumber: string | null;
      paidAt: string | null;
    }>;
  };
  previewToken: string;
}

interface MemberSeasonalMembershipCardProps extends AncestorViewOnlyBannerProps {
  member: MemberDetail;
  onSaved: () => Promise<void>;
  className?: string;
}

const bookingBehaviorLabels: Record<BookingBehavior, string> = {
  MEMBER_RATE: "Member rate",
  NON_MEMBER_RATE: "Non-member rate",
  BLOCK_BOOKING: "Block booking",
};

const subscriptionBehaviorLabels: Record<SubscriptionBehavior, string> = {
  REQUIRED: "Required",
  NOT_REQUIRED: "Not required",
  BASED_ON_AGE_TIER: "Based on age tier",
};

const EMPTY_SEASONAL_ASSIGNMENTS: SeasonalMembershipAssignmentSummary[] = [];

function responseErrorMessage(body: unknown, fallback: string) {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "string"
  ) {
    return body.error;
  }
  return fallback;
}

/**
 * A CALENDAR DATE from a `@db.Date` column — a lodge night, an assignment's
 * `applyFrom`. No timezone, ever: the value arrives as UTC midnight and the
 * calendar-date formatter pins "UTC" over that encoding, so the projection is
 * the identity for every club (CT-4, #2870).
 *
 * Split from {@link formatInstantDate} deliberately. One helper used to serve
 * both this and `paidAt`, which is a real instant — so whichever zone it chose
 * was wrong for one of them.
 */
function formatCalendarDay(date: string | null) {
  return formatPayloadCalendarDay(date, "-");
}

/** A real INSTANT, in the club's persisted zone (INV-CONFIG-002). */
function formatInstantDate(clubTime: BoundClubTime, date: string | null) {
  const instant = date === null ? null : parseInstant(date);
  return instant === null ? "-" : clubTime.instantDate(instant);
}

function BookingSummaryBlock({
  title,
  summary,
}: {
  title: string;
  summary: PreviewBookingSummary;
}) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        <Badge variant="secondary">{summary.count}</Badge>
      </div>
      {summary.count === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">None</p>
      ) : (
        <div className="mt-2 space-y-2">
          {summary.list.map((booking) => (
            <div key={booking.id} className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">
                {formatCalendarDay(booking.checkIn)} to {formatCalendarDay(booking.checkOut)}
              </span>{" "}
              - {booking.status} - {booking.guestCount} guest
              {booking.guestCount === 1 ? "" : "s"} -{" "}
              {formatCents(booking.finalPriceCents)}
              {booking.waitlistPosition
                ? ` - position ${booking.waitlistPosition}`
                : ""}
            </div>
          ))}
          {summary.truncatedCount > 0 && (
            <p className="text-xs text-muted-foreground">
              {summary.truncatedCount} more not shown
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function MemberSeasonalMembershipCard({
  member,
  onSaved,
  className,
  ancestorRendersViewOnlyBanner = false,
}: MemberSeasonalMembershipCardProps) {
  // Saving a change writes /api/admin/members/[id]/seasonal-membership
  // (membership area); a view-only membership admin may still preview but
  // cannot commit the change (#1997).
  const clubTime = useClubTime();
  const canEdit = useAdminAreaEditAccess("membership");
  const [membershipTypes, setMembershipTypes] = useState<
    MembershipTypeSummary[]
  >([]);
  // The club's season, from the zone the SERVER read and handed to the provider
  // (CT-4 group F1, #2870). Before this it went through a helper that read a
  // `Date`'s host-local components, so the fallback answered from whatever zone
  // the bundle was built with rather than the club's — and no better argument
  // could have fixed that, which is why the helper was replaced instead.
  // Season NAMES come from `season-label.ts`, which also records why the
  // year-end is unplumbed here and why that keeps name and value in step.
  const effectiveCurrentSeasonYear =
    member.currentSeasonYear ?? clubSeasonYear(clubTime.zone);
  const seasonalAssignments =
    member.seasonalMembershipAssignments ?? EMPTY_SEASONAL_ASSIGNMENTS;
  const [typesLoading, setTypesLoading] = useState(true);
  const [seasonYear, setSeasonYear] = useState(effectiveCurrentSeasonYear);
  const [selectedMembershipTypeId, setSelectedMembershipTypeId] = useState("");
  const [applyFrom, setApplyFrom] = useState("");
  const [preview, setPreview] = useState<SeasonalMembershipPreview | null>(null);
  const [reason, setReason] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const currentAssignment = useMemo(
    () =>
      seasonalAssignments.find(
        (assignment) => assignment.seasonYear === seasonYear,
      ) ?? null,
    [seasonalAssignments, seasonYear],
  );

  const selectedMembershipType = membershipTypes.find(
    (type) => type.id === selectedMembershipTypeId,
  );
  const targetChanged =
    selectedMembershipTypeId.length > 0 &&
    (currentAssignment?.membershipTypeId !== selectedMembershipTypeId ||
      (currentAssignment?.applyFrom ?? "") !== applyFrom);

  async function loadMembershipTypes() {
    setTypesLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/membership-types", {
        credentials: "same-origin",
      });
      const body = (await response.json()) as
        | MembershipTypesResponse
        | { error?: string };
      if (!response.ok || !("membershipTypes" in body)) {
        throw new Error(
          responseErrorMessage(body, "Failed to load membership types"),
        );
      }
      setMembershipTypes(body.membershipTypes);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load membership types",
      );
    } finally {
      setTypesLoading(false);
    }
  }

  useEffect(() => {
    void loadMembershipTypes();
  }, []);

  useEffect(() => {
    setSeasonYear(effectiveCurrentSeasonYear);
    setApplyFrom("");
    setPreview(null);
    setReason("");
    setMessage("");
    setError("");
  }, [member.id, effectiveCurrentSeasonYear]);

  useEffect(() => {
    const activeFallback = membershipTypes.find((type) => type.isActive);
    setSelectedMembershipTypeId(
      currentAssignment?.membershipTypeId ?? activeFallback?.id ?? "",
    );
    setApplyFrom(currentAssignment?.applyFrom ?? "");
  }, [
    currentAssignment?.applyFrom,
    currentAssignment?.membershipTypeId,
    membershipTypes,
    seasonYear,
  ]);

  useEffect(() => {
    setPreview(null);
    setReason("");
    setMessage("");
  }, [member.id, seasonYear, selectedMembershipTypeId]);

  async function previewChange() {
    if (!selectedMembershipTypeId) {
      setError("Select a membership type");
      return;
    }

    setPreviewing(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(
        `/api/admin/members/${member.id}/seasonal-membership/preview`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            seasonYear,
            membershipTypeId: selectedMembershipTypeId,
            applyFrom: applyFrom || null,
          }),
        },
      );
      const body = (await response.json()) as
        | { preview: SeasonalMembershipPreview }
        | { error?: string };
      if (!response.ok || !("preview" in body)) {
        throw new Error(
          responseErrorMessage(body, "Failed to preview membership change"),
        );
      }
      setPreview(body.preview);
    } catch (previewError) {
      setError(
        previewError instanceof Error
          ? previewError.message
          : "Failed to preview membership change",
      );
    } finally {
      setPreviewing(false);
    }
  }

  async function saveChange() {
    if (!preview) {
      setError("Preview the membership type change before saving");
      return;
    }
    if (!reason.trim()) {
      setError("Admin reason is required");
      return;
    }

    setSaving(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(
        `/api/admin/members/${member.id}/seasonal-membership`,
        {
          method: "PATCH",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            seasonYear,
            membershipTypeId: selectedMembershipTypeId,
            applyFrom: applyFrom || null,
            reason,
            previewToken: preview.previewToken,
          }),
        },
      );
      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(
          responseErrorMessage(body, "Failed to save membership change"),
        );
      }
      setPreview(null);
      setReason("");
      setMessage("Seasonal membership type saved.");
      await onSaved();
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Failed to save membership change",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="text-base font-medium">
          Seasonal Membership
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/*
          #2168: dropped only when an ancestor vouches that it states the same
          membership scope above this card — on `/admin/members/[id]` the page
          banner does, and repeating it here would be the same sentence twice.
          Rendered standalone, or under any parent that does not vouch, the
          Notice stays and this card still explains itself.
        */}
        {!ancestorRendersViewOnlyBanner ? (
          <AdminViewOnlyNotice canEdit={canEdit}>
            Your admin role can view the seasonal membership type but cannot
            preview or change it.
          </AdminViewOnlyNotice>
        ) : null}
        {(error || message) && (
          <div
            className={
              error
                ? "rounded-md border border-danger-6 bg-danger-3 px-3 py-2 text-sm text-danger-11"
                : "rounded-md border border-success-6 bg-success-3 px-3 py-2 text-sm text-success-11"
            }
          >
            {error || message}
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-[160px_minmax(0,1fr)_180px_auto] lg:items-end">
          <div className="space-y-2">
            <Label htmlFor="seasonal-membership-season">Season</Label>
            <Input
              id="seasonal-membership-season"
              type="number"
              min={2020}
              max={2040}
              value={seasonYear}
              onChange={(event) =>
                setSeasonYear(Number.parseInt(event.target.value, 10) || 2020)
              }
            />
          </div>

          <div className="space-y-2">
            <Label>Membership Type</Label>
            <Select
              value={selectedMembershipTypeId}
              onValueChange={setSelectedMembershipTypeId}
              disabled={typesLoading}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select membership type" />
              </SelectTrigger>
              <SelectContent>
                {membershipTypes.map((type) => (
                  <SelectItem
                    key={type.id}
                    value={type.id}
                    disabled={!type.isActive && type.id !== currentAssignment?.membershipTypeId}
                  >
                    {type.name}
                    {!type.isActive ? " (archived)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="seasonal-membership-apply-from">Apply from</Label>
            <Input
              id="seasonal-membership-apply-from"
              type="date"
              value={applyFrom}
              onChange={(event) => setApplyFrom(event.target.value)}
            />
          </div>

          <ViewOnlyActionButton
            canEdit={canEdit}
            describeReason={!ancestorRendersViewOnlyBanner}
            type="button"
            variant="outline"
            onClick={() => void previewChange()}
            disabled={previewing || typesLoading || !targetChanged}
          >
            {previewing ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Eye className="mr-2 h-4 w-4" />
            )}
            Preview
          </ViewOnlyActionButton>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-md border border-border p-3 text-sm">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Access role
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Badge variant={member.role === "ADMIN" ? "default" : "secondary"}>
                {ROLE_LABELS[member.role]}
              </Badge>
            </div>
          </div>

          <div className="rounded-md border border-border p-3 text-sm">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Current assignment
            </div>
            <div className="mt-1 font-medium text-foreground">
              {currentAssignment
                ? `${currentAssignment.membershipType.name} for ${seasonSelectLabel(
                    currentAssignment.seasonYear,
                  )}`
                : `No assignment for ${seasonSelectLabel(seasonYear)}`}
            </div>
            {currentAssignment?.applyFrom && (
              <div className="mt-1 text-xs text-muted-foreground">
                Applies from {formatCalendarDay(currentAssignment.applyFrom)}
              </div>
            )}
          </div>
        </div>

        {selectedMembershipType && (
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-md border border-border p-3 text-sm">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Resulting booking behavior
              </div>
              <div className="mt-1 font-medium text-foreground">
                {bookingBehaviorLabels[selectedMembershipType.bookingBehavior]}
              </div>
            </div>
            <div className="rounded-md border border-border p-3 text-sm">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Resulting subscription behavior
              </div>
              <div className="mt-1 font-medium text-foreground">
                {
                  subscriptionBehaviorLabels[
                    selectedMembershipType.subscriptionBehavior
                  ]
                }
              </div>
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => void loadMembershipTypes()}
            disabled={typesLoading}
          >
            {typesLoading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            Refresh Types
          </Button>
        </div>

        {preview && (
          <div className="space-y-4 rounded-md border border-info-6 bg-info-3 p-4">
            <div className="grid gap-3 md:grid-cols-3">
              <BookingSummaryBlock
                title="Future confirmed"
                summary={preview.futureConfirmedBookings}
              />
              <BookingSummaryBlock
                title="Draft bookings"
                summary={preview.draftBookings}
              />
              <BookingSummaryBlock
                title="Waitlist records"
                summary={preview.waitlistRecords}
              />
            </div>

            <div className="rounded-md border border-info-6 bg-card p-3 text-sm">
              <div className="font-medium text-foreground">
                Subscription summary
              </div>
              <div className="mt-1 text-muted-foreground">
                Applies from {preview.applyFrom ? formatCalendarDay(preview.applyFrom) : "season start"}
              </div>
              <div className="mt-1 text-muted-foreground">
                {seasonSelectLabel(preview.currentSeasonSubscription.seasonYear)}
                : {preview.currentSeasonSubscription.status}
                {preview.currentSeasonSubscription.xeroInvoiceNumber
                  ? ` - invoice ${preview.currentSeasonSubscription.xeroInvoiceNumber}`
                  : ""}
                {preview.currentSeasonSubscription.paidAt
                  ? ` - paid ${formatInstantDate(clubTime, preview.currentSeasonSubscription.paidAt)}`
                  : ""}
              </div>
              {preview.subscriptionHistory.recent.length > 0 && (
                <div className="mt-2 text-xs text-muted-foreground">
                  Recent seasons:{" "}
                  {preview.subscriptionHistory.recent
                    .map(
                      (record) =>
                        `${seasonSelectLabel(record.seasonYear)} ${record.status}`,
                    )
                    .join(", ")}
                </div>
              )}
            </div>

            <div className="rounded-md border border-warning-6 bg-warning-3 px-3 py-2 text-xs text-warning-11">
              Existing future bookings are not automatically repriced by this
              change.
            </div>

            <div className="space-y-2">
              <Label htmlFor="seasonal-membership-reason">Admin reason</Label>
              <Textarea
                id="seasonal-membership-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={1000}
                rows={3}
              />
            </div>

            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={!ancestorRendersViewOnlyBanner}
              type="button"
              onClick={() => void saveChange()}
              disabled={saving || !reason.trim()}
            >
              {saving ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-2 h-4 w-4" />
              )}
              Save Membership Type
            </ViewOnlyActionButton>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
