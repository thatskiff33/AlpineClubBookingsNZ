"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type ApplicationStatus =
  | "PENDING_NOMINATORS"
  | "PENDING_ADMIN"
  | "APPROVED"
  | "REJECTED";

type ApplicationRecord = {
  id: string;
  applicantFirstName: string;
  applicantLastName: string;
  applicantEmail: string;
  applicantDateOfBirth: string | null;
  applicantPhone: string | null;
  applicantAddress: {
    streetAddressLine1?: string | null;
    streetAddressLine2?: string | null;
    streetCity?: string | null;
    streetRegion?: string | null;
    streetPostalCode?: string | null;
    streetCountry?: string | null;
  };
  familyMembers: Array<{
    firstName: string;
    lastName: string;
    dateOfBirth: string;
  }>;
  familyMemberCount: number;
  nominator1Email: string;
  nominator2Email: string;
  nominator1Name: string | null;
  nominator2Name: string | null;
  nominator1ConfirmedAt: string | null;
  nominator2ConfirmedAt: string | null;
  status: ApplicationStatus;
  adminNotes: string | null;
  reviewerName: string | null;
  reviewedAt: string | null;
  createdAt: string;
};

const filters: Array<{ label: string; value: string }> = [
  { label: "Pending admin", value: "PENDING_ADMIN" },
  { label: "Waiting on nominators", value: "PENDING_NOMINATORS" },
  { label: "Approved", value: "APPROVED" },
  { label: "Rejected", value: "REJECTED" },
  { label: "All", value: "all" },
];

function formatDate(value: string | null) {
  if (!value) {
    return "Not yet";
  }
  return new Date(value).toLocaleString("en-NZ", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function statusLabel(status: ApplicationStatus) {
  switch (status) {
    case "PENDING_NOMINATORS":
      return "Waiting on nominators";
    case "PENDING_ADMIN":
      return "Pending committee review";
    case "APPROVED":
      return "Approved";
    case "REJECTED":
      return "Rejected";
    default:
      return status;
  }
}

export default function MemberApplicationsPage() {
  const [filter, setFilter] = useState("PENDING_ADMIN");
  const [applications, setApplications] = useState<ApplicationRecord[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function loadApplications(nextFilter = filter) {
    setLoading(true);
    setError("");

    try {
      const params = new URLSearchParams();
      params.set("status", nextFilter);
      const response = await fetch(`/api/admin/member-applications?${params.toString()}`);
      const data = await response.json();

      if (!response.ok) {
        setError(data.error || "Could not load member applications.");
        return;
      }

      setApplications(data.applications || []);
      setPendingCount(data.pendingCount || 0);
      setNotes((prev) => {
        const next = { ...prev };
        for (const application of data.applications || []) {
          if (!(application.id in next)) {
            next[application.id] = application.adminNotes || "";
          }
        }
        return next;
      });
    } catch {
      setError("Could not load member applications.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadApplications(filter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  async function reviewApplication(
    applicationId: string,
    decision: "APPROVE" | "REJECT"
  ) {
    setSubmittingId(applicationId);
    setError("");
    setMessage("");

    try {
      const response = await fetch(`/api/admin/member-applications/${applicationId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision,
          adminNotes: notes[applicationId] || "",
        }),
      });
      const data = await response.json();

      if (!response.ok) {
        setError(data.error || "Could not update the application.");
        return;
      }

      const warnings =
        Array.isArray(data.warnings) && data.warnings.length > 0
          ? ` Warnings: ${data.warnings.join(". ")}`
          : "";
      setMessage(
        decision === "APPROVE"
          ? `Application approved.${warnings}`
          : "Application rejected."
      );
      await loadApplications(filter);
    } catch {
      setError("Could not update the application.");
    } finally {
      setSubmittingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.22em] text-slate-500">
            Membership
          </p>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">
            Member Applications
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Pending committee review: <strong>{pendingCount}</strong>
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {filters.map((option) => (
            <Button
              key={option.value}
              type="button"
              variant={filter === option.value ? "default" : "outline"}
              onClick={() => setFilter(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>

      {message && (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          {message}
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <Card>
          <CardContent className="pt-6 text-sm text-slate-600">
            Loading applications...
          </CardContent>
        </Card>
      ) : applications.length === 0 ? (
        <Card>
          <CardContent className="pt-6 text-sm text-slate-600">
            No applications match this filter.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {applications.map((application) => (
            <Card key={application.id}>
              <CardHeader className="space-y-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div>
                    <CardTitle className="text-2xl">
                      {application.applicantFirstName} {application.applicantLastName}
                    </CardTitle>
                    <p className="mt-1 text-sm text-slate-600">
                      Submitted {formatDate(application.createdAt)}
                    </p>
                  </div>
                  <div className="inline-flex w-fit rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-slate-700">
                    {statusLabel(application.status)}
                  </div>
                </div>
              </CardHeader>

              <CardContent className="space-y-6">
                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="space-y-3 text-sm">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                        Contact
                      </p>
                      <p className="mt-1 text-slate-800">{application.applicantEmail}</p>
                      {application.applicantPhone && (
                        <p className="text-slate-600">{application.applicantPhone}</p>
                      )}
                    </div>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                        Address
                      </p>
                      <div className="mt-1 space-y-1 text-slate-700">
                        {application.applicantAddress.streetAddressLine1 && (
                          <p>{application.applicantAddress.streetAddressLine1}</p>
                        )}
                        {application.applicantAddress.streetAddressLine2 && (
                          <p>{application.applicantAddress.streetAddressLine2}</p>
                        )}
                        <p>
                          {[
                            application.applicantAddress.streetCity,
                            application.applicantAddress.streetRegion,
                            application.applicantAddress.streetPostalCode,
                          ]
                            .filter(Boolean)
                            .join(", ") || "No address supplied"}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-3 text-sm">
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                        Nominator 1
                      </p>
                      <p className="mt-1 font-medium text-slate-900">
                        {application.nominator1Name || application.nominator1Email}
                      </p>
                      <p className="text-slate-600">{application.nominator1Email}</p>
                      <p className="mt-2 text-slate-600">
                        Confirmed: {formatDate(application.nominator1ConfirmedAt)}
                      </p>
                    </div>

                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                        Nominator 2
                      </p>
                      <p className="mt-1 font-medium text-slate-900">
                        {application.nominator2Name || application.nominator2Email}
                      </p>
                      <p className="text-slate-600">{application.nominator2Email}</p>
                      <p className="mt-2 text-slate-600">
                        Confirmed: {formatDate(application.nominator2ConfirmedAt)}
                      </p>
                    </div>
                  </div>
                </div>

                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Dependents
                  </p>
                  {application.familyMembers.length === 0 ? (
                    <p className="mt-1 text-sm text-slate-600">
                      No dependents included with this application.
                    </p>
                  ) : (
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      {application.familyMembers.map((familyMember) => (
                        <div
                          key={`${familyMember.firstName}-${familyMember.lastName}-${familyMember.dateOfBirth}`}
                          className="rounded-lg border border-slate-200 px-4 py-3 text-sm"
                        >
                          <p className="font-medium text-slate-900">
                            {familyMember.firstName} {familyMember.lastName}
                          </p>
                          <p className="text-slate-600">
                            DOB {new Date(familyMember.dateOfBirth).toLocaleDateString("en-NZ")}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <label
                    className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500"
                    htmlFor={`notes-${application.id}`}
                  >
                    Committee notes
                  </label>
                  <textarea
                    id={`notes-${application.id}`}
                    className="min-h-28 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                    value={notes[application.id] || ""}
                    onChange={(event) =>
                      setNotes((prev) => ({
                        ...prev,
                        [application.id]: event.target.value,
                      }))
                    }
                    placeholder="Add committee notes or decision context"
                  />
                </div>

                {application.reviewedAt && (
                  <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
                    Reviewed by {application.reviewerName || "an administrator"} on{" "}
                    {formatDate(application.reviewedAt)}
                  </div>
                )}

                {application.status === "PENDING_ADMIN" && (
                  <div className="flex flex-wrap gap-3">
                    <Button
                      type="button"
                      disabled={submittingId === application.id}
                      onClick={() => reviewApplication(application.id, "APPROVE")}
                    >
                      {submittingId === application.id ? "Working..." : "Approve"}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={submittingId === application.id}
                      onClick={() => reviewApplication(application.id, "REJECT")}
                    >
                      Reject
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
