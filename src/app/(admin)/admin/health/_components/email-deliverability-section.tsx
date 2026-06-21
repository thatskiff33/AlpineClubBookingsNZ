"use client";

import { useState } from "react";
import { Mail, CheckCircle } from "lucide-react";
import { StatusBadge, formatDate } from "./shared";
import type { HealthData } from "./types";

export function EmailDeliverabilitySection({
  emailDeliverability,
  emailFailures,
  adminAlertDelivery,
  tokenEmailRecovery,
  onRefresh,
  onError,
}: {
  emailDeliverability: HealthData["emailDeliverability"];
  emailFailures: HealthData["emailFailures"];
  adminAlertDelivery: HealthData["adminAlertDelivery"];
  tokenEmailRecovery: HealthData["tokenEmailRecovery"];
  onRefresh: () => Promise<void> | void;
  onError: (message: string) => void;
}) {
  const [clearingSuppressionId, setClearingSuppressionId] = useState<string | null>(null);
  const [reviewingEmailFailureId, setReviewingEmailFailureId] = useState<string | null>(null);
  const [reissuingTokenEmailId, setReissuingTokenEmailId] = useState<string | null>(null);

  async function clearSuppression(id: string, email: string) {
    if (!window.confirm(`Clear email suppression for ${email}?`)) {
      return;
    }

    setClearingSuppressionId(id);
    try {
      const res = await fetch(`/api/admin/email-suppressions/${id}/clear`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Reviewed from admin health dashboard" }),
      });
      if (!res.ok) throw new Error("Failed to clear suppression");
      await onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setClearingSuppressionId(null);
    }
  }

  async function archiveEmailFailure(id: string, to: string) {
    const reason = window.prompt(
      `Archive exhausted email failure for ${to}?`,
      "Reviewed from admin health dashboard"
    );
    if (reason === null) {
      return;
    }

    setReviewingEmailFailureId(id);
    try {
      const res = await fetch(`/api/admin/email-failures/${id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      if (!res.ok) throw new Error("Failed to archive exhausted email failure");
      await onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setReviewingEmailFailureId(null);
    }
  }

  async function reissueTokenEmail(id: string, to: string) {
    if (!window.confirm(`Reissue and resend token email for ${to}?`)) {
      return;
    }

    setReissuingTokenEmailId(id);
    try {
      const res = await fetch(`/api/admin/email-failures/${id}/reissue-token`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to reissue token email");
      }
      if (Array.isArray(data.emailWarnings) && data.emailWarnings.length > 0) {
        onError(data.emailWarnings.join(" "));
      }
      await onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setReissuingTokenEmailId(null);
    }
  }

  return (
    <div className="space-y-6">
      {/* Email Deliverability */}
      <div>
        <h2 className="text-lg font-semibold text-slate-900 mb-3 flex items-center gap-2">
          <Mail className="h-5 w-5" />
          Email Deliverability
        </h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
          <div className="bg-white border rounded-lg p-4">
            <p className="text-sm text-slate-500">Active suppressions</p>
            <p className="text-2xl font-bold text-slate-900">
              {emailDeliverability.summary.activeCount}
            </p>
          </div>
          <div className="bg-white border rounded-lg p-4">
            <p className="text-sm text-slate-500">Bounces</p>
            <p className="text-2xl font-bold text-red-600">
              {emailDeliverability.summary.bounceCount}
            </p>
          </div>
          <div className="bg-white border rounded-lg p-4">
            <p className="text-sm text-slate-500">Complaints</p>
            <p className="text-2xl font-bold text-red-600">
              {emailDeliverability.summary.complaintCount}
            </p>
          </div>
          <div className="bg-white border rounded-lg p-4">
            <p className="text-sm text-slate-500">Events 24h</p>
            <p className="text-2xl font-bold text-slate-900">
              {emailDeliverability.summary.eventsLast24h}
            </p>
          </div>
        </div>

        {emailDeliverability.suppressions.length === 0 ? (
          <div className="bg-white border rounded-lg p-4 text-slate-500">
            No active recipient suppressions.
          </div>
        ) : (
          <div className="bg-white border rounded-lg overflow-x-auto">
            <div className="min-w-[760px]">
              <div className="grid grid-cols-[minmax(0,1.7fr)_100px_90px_140px_88px] gap-3 px-4 py-2 text-xs font-medium text-slate-500 bg-slate-50 border-b">
                <span>Recipient</span>
                <span>Reason</span>
                <span>Events</span>
                <span>Last event</span>
                <span className="text-right">Action</span>
              </div>
              <div className="divide-y">
                {emailDeliverability.suppressions.map((suppression) => (
                  <div
                    key={suppression.id}
                    className="grid grid-cols-[minmax(0,1.7fr)_100px_90px_140px_88px] gap-3 px-4 py-3 text-sm items-center"
                  >
                    <span className="font-medium text-slate-900 truncate">
                      {suppression.email}
                    </span>
                    <StatusBadge status={suppression.reason} />
                    <span className="text-slate-600">{suppression.eventCount}</span>
                    <span className="text-slate-500">
                      {formatDate(suppression.lastEventAt)}
                    </span>
                    <button
                      onClick={() =>
                        clearSuppression(suppression.id, suppression.email)
                      }
                      disabled={clearingSuppressionId === suppression.id}
                      className="inline-flex justify-self-end items-center gap-1.5 px-2.5 py-1.5 text-xs bg-slate-100 hover:bg-slate-200 rounded-md transition-colors disabled:opacity-50"
                    >
                      <CheckCircle className="h-3.5 w-3.5" />
                      Clear
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Token Email Recovery */}
      <div>
        <h2 className="text-lg font-semibold text-slate-900 mb-3 flex items-center gap-2">
          <Mail className="h-5 w-5" />
          Token Email Recovery
        </h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
          <div className="bg-white border rounded-lg p-4">
            <p className="text-sm text-slate-500">Active failures</p>
            <p className="text-2xl font-bold text-red-600">
              {tokenEmailRecovery.summary.activeCount}
            </p>
          </div>
          <div className="bg-white border rounded-lg p-4">
            <p className="text-sm text-slate-500">Reissued</p>
            <p className="text-2xl font-bold text-slate-900">
              {tokenEmailRecovery.summary.reissuedCount}
            </p>
          </div>
          <div className="bg-white border rounded-lg p-4">
            <p className="text-sm text-slate-500">Scanned</p>
            <p className="text-2xl font-bold text-slate-900">
              {tokenEmailRecovery.summary.scannedCount}
            </p>
          </div>
        </div>

        {tokenEmailRecovery.failures.length === 0 ? (
          <div className="bg-white border rounded-lg p-4 text-slate-500">
            No active failed token-bearing lifecycle emails.
          </div>
        ) : (
          <div className="bg-white border rounded-lg overflow-x-auto">
            <div className="min-w-[980px]">
              <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1.2fr)_140px_100px_140px_88px] gap-3 px-4 py-2 text-xs font-medium text-slate-500 bg-slate-50 border-b">
                <span>Recipient</span>
                <span>Subject</span>
                <span>Template</span>
                <span>Status</span>
                <span>Last attempt</span>
                <span className="text-right">Action</span>
              </div>
              <div className="divide-y">
                {tokenEmailRecovery.failures.map((failure) => (
                  <div
                    key={failure.id}
                    className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1.2fr)_140px_100px_140px_88px] gap-3 px-4 py-3 text-sm items-center"
                  >
                    <span className="font-medium text-slate-900 truncate">
                      {failure.to}
                    </span>
                    <span className="text-slate-700 truncate" title={failure.subject}>
                      {failure.subject}
                    </span>
                    <span className="text-slate-600 truncate">
                      {failure.templateName}
                    </span>
                    <StatusBadge status={failure.status} />
                    <span className="text-slate-500">
                      {formatDate(failure.lastAttemptAt)}
                    </span>
                    <button
                      onClick={() => reissueTokenEmail(failure.id, failure.to)}
                      disabled={reissuingTokenEmailId === failure.id}
                      className="inline-flex justify-self-end items-center gap-1.5 px-2.5 py-1.5 text-xs bg-slate-100 hover:bg-slate-200 rounded-md transition-colors disabled:opacity-50"
                    >
                      <Mail className="h-3.5 w-3.5" />
                      Reissue
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Exhausted Email Failures */}
      <div>
        <h2 className="text-lg font-semibold text-slate-900 mb-3 flex items-center gap-2">
          <Mail className="h-5 w-5" />
          Exhausted Email Failures
        </h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
          <div className="bg-white border rounded-lg p-4">
            <p className="text-sm text-slate-500">Active failures</p>
            <p className="text-2xl font-bold text-red-600">
              {emailFailures.summary.activeCount}
            </p>
          </div>
          <div className="bg-white border rounded-lg p-4">
            <p className="text-sm text-slate-500">Archived</p>
            <p className="text-2xl font-bold text-slate-900">
              {emailFailures.summary.reviewedCount}
            </p>
          </div>
          <div className="bg-white border rounded-lg p-4">
            <p className="text-sm text-slate-500">Retry limit</p>
            <p className="text-2xl font-bold text-slate-900">
              {emailFailures.summary.maxAttempts}
            </p>
          </div>
          <div className="bg-white border rounded-lg p-4">
            <p className="text-sm text-slate-500">Scanned</p>
            <p className="text-2xl font-bold text-slate-900">
              {emailFailures.summary.scannedCount}
            </p>
          </div>
        </div>

        {emailFailures.failures.length === 0 ? (
          <div className="bg-white border rounded-lg p-4 text-slate-500">
            No active exhausted email failures.
          </div>
        ) : (
          <div className="bg-white border rounded-lg overflow-x-auto">
            <div className="min-w-[900px]">
              <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1.5fr)_140px_90px_140px_88px] gap-3 px-4 py-2 text-xs font-medium text-slate-500 bg-slate-50 border-b">
                <span>Recipient</span>
                <span>Subject</span>
                <span>Template</span>
                <span>Attempts</span>
                <span>Last attempt</span>
                <span className="text-right">Action</span>
              </div>
              <div className="divide-y">
                {emailFailures.failures.map((failure) => (
                  <div
                    key={failure.id}
                    className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1.5fr)_140px_90px_140px_88px] gap-3 px-4 py-3 text-sm items-center"
                  >
                    <span className="font-medium text-slate-900 truncate">
                      {failure.to}
                    </span>
                    <span className="text-slate-700 truncate" title={failure.subject}>
                      {failure.subject}
                    </span>
                    <span className="text-slate-600 truncate">
                      {failure.templateName}
                    </span>
                    <span className="text-slate-600">{failure.attempts}</span>
                    <span className="text-slate-500">
                      {formatDate(failure.lastAttemptAt)}
                    </span>
                    <button
                      onClick={() => archiveEmailFailure(failure.id, failure.to)}
                      disabled={reviewingEmailFailureId === failure.id}
                      className="inline-flex justify-self-end items-center gap-1.5 px-2.5 py-1.5 text-xs bg-slate-100 hover:bg-slate-200 rounded-md transition-colors disabled:opacity-50"
                    >
                      <CheckCircle className="h-3.5 w-3.5" />
                      Archive
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Admin Alert Delivery Escalations */}
      <div>
        <h2 className="text-lg font-semibold text-slate-900 mb-3 flex items-center gap-2">
          <Mail className="h-5 w-5" />
          Admin Alert Delivery
        </h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
          <div className="bg-white border rounded-lg p-4">
            <p className="text-sm text-slate-500">Undelivered alerts</p>
            <p className="text-2xl font-bold text-red-600">
              {adminAlertDelivery.summary.recentCount}
            </p>
          </div>
          <div className="bg-white border rounded-lg p-4">
            <p className="text-sm text-slate-500">Lookback</p>
            <p className="text-2xl font-bold text-slate-900">
              {adminAlertDelivery.summary.lookbackDays}d
            </p>
          </div>
        </div>

        {adminAlertDelivery.escalations.length === 0 ? (
          <div className="bg-white border rounded-lg p-4 text-slate-500">
            No recent admin alerts failed for every recipient.
          </div>
        ) : (
          <div className="bg-white border rounded-lg overflow-x-auto">
            <div className="min-w-[780px]">
              <div className="grid grid-cols-[minmax(0,1.4fr)_120px_120px_120px_150px] gap-3 px-4 py-2 text-xs font-medium text-slate-500 bg-slate-50 border-b">
                <span>Template</span>
                <span>Attempted</span>
                <span>Suppressed</span>
                <span>Failed</span>
                <span>Recorded</span>
              </div>
              <div className="divide-y">
                {adminAlertDelivery.escalations.map((escalation) => (
                  <div
                    key={escalation.id}
                    className="grid grid-cols-[minmax(0,1.4fr)_120px_120px_120px_150px] gap-3 px-4 py-3 text-sm items-center"
                  >
                    <span className="font-medium text-slate-900 truncate">
                      {escalation.templateName}
                    </span>
                    <span className="text-slate-600">
                      {escalation.attemptedRecipientCount}
                    </span>
                    <span className="text-slate-600">
                      {escalation.suppressedRecipientCount}
                    </span>
                    <span className="text-slate-600">
                      {escalation.failedRecipientCount}
                    </span>
                    <span className="text-slate-500">
                      {formatDate(escalation.createdAt)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
