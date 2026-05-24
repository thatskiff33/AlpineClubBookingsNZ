"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Mail, UserMinus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type {
  MembershipCancellationCandidate,
  MembershipCancellationOverview,
  SerializedMembershipCancellationRequest,
} from "@/lib/membership-cancellation-requests";
import {
  participantStatusLabel,
  requestStatusLabel,
} from "@/lib/membership-cancellation-status-labels";
import { formatNZDate } from "@/lib/nzst-date";

function relationshipLabel(candidate: MembershipCancellationCandidate) {
  switch (candidate.relationship) {
    case "self":
      return "You";
    case "dependent":
      return "Dependant";
    case "non_login_adult":
      return "Non-login adult";
    case "family_adult":
      return "Own-login adult";
  }
}

function statusTone(status: string) {
  if (status === "PENDING_CONFIRMATION") {
    return "border-amber-200 bg-amber-50 text-amber-800";
  }
  if (status === "DECLINED" || status === "REJECTED") {
    return "border-rose-200 bg-rose-50 text-rose-800";
  }
  if (status === "REQUESTED" || status === "APPROVED") {
    return "border-blue-200 bg-blue-50 text-blue-800";
  }
  return "border-slate-200 bg-slate-50 text-slate-700";
}

function formatDate(value: string) {
  return formatNZDate(new Date(value));
}

function RequestStatusList({
  requests,
}: {
  requests: SerializedMembershipCancellationRequest[];
}) {
  if (requests.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No membership cancellation requests have been submitted.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {requests.map((request) => (
        <div
          key={request.id}
          className="rounded-md border border-slate-200 bg-white p-3"
        >
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">
                  Request submitted {formatDate(request.submittedAt)}
                </span>
                <Badge className={statusTone(request.status)} variant="outline">
                  {requestStatusLabel(request.status)}
                </Badge>
              </div>
              {request.reason ? (
                <p className="mt-1 text-sm text-muted-foreground">
                  {request.reason}
                </p>
              ) : null}
            </div>
            {request.requestedBy ? (
              <p className="text-xs text-muted-foreground">
                Requested by {request.requestedBy.name}
              </p>
            ) : null}
          </div>
          <div className="mt-3 divide-y divide-slate-100">
            {request.participants.map((participant) => (
              <div
                className="flex flex-col gap-2 py-2 text-sm first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
                key={participant.id}
              >
                <div>
                  <span className="font-medium">{participant.name}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {participant.ageTier}
                  </span>
                </div>
                <Badge
                  className={statusTone(participant.status)}
                  variant="outline"
                >
                  {participantStatusLabel(participant.status)}
                </Badge>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function MembershipCancellationPanel() {
  const [overview, setOverview] =
    useState<MembershipCancellationOverview | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [acknowledgedWarning, setAcknowledgedWarning] = useState(false);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function loadOverview() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/member/membership-cancellation-requests");
      const data = await response.json();
      if (!response.ok) {
        setError(data.error || "Could not load cancellation request options.");
        return;
      }
      setOverview(data);
    } catch {
      setError("Could not load cancellation request options.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadOverview();
  }, []);

  const eligibleCandidates = useMemo(
    () => overview?.candidates.filter((candidate) => candidate.eligible) ?? [],
    [overview],
  );
  const canSubmit =
    selectedIds.length > 0 && acknowledgedWarning && !submitting && !loading;

  function toggleCandidate(id: string, checked: boolean) {
    setSelectedIds((current) =>
      checked
        ? Array.from(new Set([...current, id]))
        : current.filter((candidateId) => candidateId !== id),
    );
  }

  async function submitRequest() {
    setSubmitting(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/member/membership-cancellation-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          participantMemberIds: selectedIds,
          reason: reason.trim() || undefined,
          acknowledgedWarning,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error || "Could not submit cancellation request.");
        return;
      }

      setSelectedIds([]);
      setReason("");
      setAcknowledgedWarning(false);
      setMessage(
        data.emailWarnings?.length
          ? `Request submitted. ${data.emailWarnings.join(" ")}`
          : "Cancellation request submitted.",
      );
      await loadOverview();
    } catch {
      setError("Could not submit cancellation request.");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading && !overview) {
    return (
      <p className="text-sm text-muted-foreground">
        Loading cancellation request options...
      </p>
    );
  }

  if (!overview) {
    return (
      <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
        {error || "Cancellation request options are unavailable."}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-3 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{overview.settings.warningText}</p>
        </div>
        <div className="border-t border-amber-200 pt-3">
          <p>{overview.settings.rejoinProcessText}</p>
        </div>
      </div>

      {message ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          {message}
        </div>
      ) : null}
      {error ? (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {error}
        </div>
      ) : null}

      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">
            Select memberships
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Own-login adults must confirm from their own account before they are included.
          </p>
        </div>

        {overview.candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No eligible memberships were found.
          </p>
        ) : (
          <div className="divide-y divide-slate-100 rounded-md border border-slate-200">
            {overview.candidates.map((candidate) => {
              const checked = selectedIds.includes(candidate.id);
              return (
                <label
                  className="flex cursor-pointer items-start gap-3 p-3 data-[disabled=true]:cursor-not-allowed data-[disabled=true]:bg-slate-50"
                  data-disabled={!candidate.eligible}
                  key={candidate.id}
                >
                  <Checkbox
                    checked={checked}
                    disabled={!candidate.eligible || submitting}
                    onCheckedChange={(value) =>
                      toggleCandidate(candidate.id, value === true)
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-slate-900">
                        {candidate.name}
                      </span>
                      <Badge variant="secondary">
                        {relationshipLabel(candidate)}
                      </Badge>
                      {candidate.requiresOwnConfirmation ? (
                        <Badge
                          className="border-blue-200 bg-blue-50 text-blue-800"
                          variant="outline"
                        >
                          <Mail className="mr-1 h-3 w-3" />
                          Confirms by email
                        </Badge>
                      ) : null}
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {candidate.familyGroupNames.length > 0
                        ? candidate.familyGroupNames.join(", ")
                        : candidate.email}
                    </span>
                    {candidate.ineligibleReason ? (
                      <span className="mt-1 block text-xs text-rose-700">
                        {candidate.ineligibleReason}
                      </span>
                    ) : null}
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="membership-cancellation-reason">
          Reason for cancellation request
        </Label>
        <Textarea
          id="membership-cancellation-reason"
          maxLength={1000}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Optional note for the committee"
          rows={3}
          value={reason}
        />
      </div>

      <label className="flex items-start gap-3 rounded-md border border-slate-200 p-3 text-sm">
        <Checkbox
          checked={acknowledgedWarning}
          onCheckedChange={(value) => setAcknowledgedWarning(value === true)}
        />
        <span>
          I understand the warning above and want to submit this request for
          committee review.
        </span>
      </label>

      <Button
        disabled={!canSubmit || eligibleCandidates.length === 0}
        onClick={submitRequest}
      >
        <UserMinus className="mr-2 h-4 w-4" />
        {submitting ? "Submitting..." : "Submit Cancellation Request"}
      </Button>

      <div className="border-t border-slate-200 pt-5">
        <h3 className="mb-3 text-sm font-semibold text-slate-900">
          Request status
        </h3>
        <RequestStatusList requests={overview.requests} />
      </div>
    </div>
  );
}
