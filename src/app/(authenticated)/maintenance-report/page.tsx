"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Wrench } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  MaintenanceReportForm,
  type MaintenanceFormQuestion,
  type MaintenanceFormSubmission,
} from "@/components/maintenance/maintenance-report-form";

/**
 * The members' portal maintenance form (#2780, owner decision 1).
 *
 * A client page in the same shape as `/induction`: it fetches what the form needs
 * from `GET /api/maintenance-reports` and posts back to the same address. The
 * module gate is upstream in `src/proxy.ts` (`FEATURE_ROUTE_RULES` covers
 * `/maintenance-report`), so with the module off this address is a 404 and this
 * file never runs — which is why there is no module check in here.
 */

type FormPayload = {
  questions: MaintenanceFormQuestion[];
  lodges: Array<{ id: string; name: string }>;
  photosEnabled: boolean;
  summaryMaxLength: number;
};

export default function MaintenanceReportPage() {
  const [payload, setPayload] = useState<FormPayload | null>(null);
  const [loadError, setLoadError] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const res = await fetch("/api/maintenance-reports");
      if (!res.ok) throw new Error("Failed to load the form");
      setPayload((await res.json()) as FormPayload);
    } catch {
      setLoadError("The form could not be loaded. Please try again.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(submission: MaintenanceFormSubmission) {
    const res = await fetch("/api/maintenance-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lodgeId: submission.lodgeId,
        summary: submission.summary,
        answers: submission.answers,
        photoDataUrl: submission.photoDataUrl,
      }),
    });

    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: unknown };
      throw new Error(
        typeof data.error === "string"
          ? data.error
          : "Something went wrong sending that report. Please try again.",
      );
    }

    setSubmitted(true);
  }

  if (submitted) {
    return (
      <div className="mx-auto max-w-xl space-y-6 p-4 sm:p-6">
        <Card>
          <CardHeader>
            {/* The submitted card is the page's whole content with no h1 in
                this render state — the form state's h1 is a separate branch. */}
            <CardTitle headingLevel={1} className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-primary" aria-hidden="true" />
              Thank you — that has been sent
            </CardTitle>
            <CardDescription>
              Whoever looks after the lodge has been told. You do not need to do
              anything else.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 sm:flex-row">
            <Button
              variant="outline"
              onClick={() => {
                setSubmitted(false);
                void load();
              }}
            >
              Report something else
            </Button>
            <Button asChild>
              <Link href="/dashboard">Back to my dashboard</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl space-y-6 p-4 sm:p-6">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Wrench className="h-6 w-6" aria-hidden="true" />
          Report a maintenance issue
        </h1>
        <p className="text-sm text-muted-foreground">
          Tell us about something at the lodge that needs fixing. A photo helps if
          you can take one.
        </p>
      </div>

      {loadError ? <Alert variant="error">{loadError}</Alert> : null}

      {payload ? (
        <MaintenanceReportForm
          questions={payload.questions}
          photosEnabled={payload.photosEnabled}
          summaryMaxLength={payload.summaryMaxLength}
          lodges={payload.lodges}
          submitLabel="Send this report"
          onSubmit={submit}
        />
      ) : loadError ? null : (
        <p className="text-sm text-muted-foreground">Loading the form...</p>
      )}
    </div>
  );
}
