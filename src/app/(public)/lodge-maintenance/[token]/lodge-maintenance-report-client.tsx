"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { CheckCircle2, Wrench } from "lucide-react";

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
 * The QR form's client half (#2780).
 *
 * THE TOKEN IS READ FROM THE ROUTER, never received as a prop — see the server
 * page for why. It is used in exactly one place, as a path segment of the fetch
 * URL, and appears in no JSX: no hidden input, no `value`, no `href`, no error
 * message. Nothing on this surface displays it.
 *
 * WHAT THIS PAGE KNOWS. The lodge's NAME, the question set, and whether photos and
 * the optional contact prompt are on. It has no session, asks for none, and there
 * is no account information on it — nothing to sign in to, nothing about members,
 * nothing about bookings. A stranger who scans the sign can report a fault and do
 * nothing else.
 *
 * ONE FAILURE MESSAGE. The API answers a single generic 404 for a bad token, a
 * paused sign, a deactivated lodge and the feature being switched off, and this
 * renders one message for all of them. Distinguishing them here would rebuild, in
 * the browser, exactly the oracle the API refuses to be.
 */

type TokenPayload = {
  lodgeName: string;
  questions: MaintenanceFormQuestion[];
  photosEnabled: boolean;
  contactPrompt: boolean;
  summaryMaxLength: number;
};

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; payload: TokenPayload }
  | { kind: "unavailable" }
  | { kind: "error" };

export function LodgeMaintenanceReportClient() {
  const params = useParams<{ token: string }>();
  const token = typeof params?.token === "string" ? params.token : "";

  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [submitted, setSubmitted] = useState(false);

  const load = useCallback(async () => {
    if (!token) {
      setState({ kind: "unavailable" });
      return;
    }
    setState({ kind: "loading" });
    try {
      const res = await fetch(
        `/api/lodge-maintenance/${encodeURIComponent(token)}`,
        { cache: "no-store" },
      );
      if (res.status === 404) {
        setState({ kind: "unavailable" });
        return;
      }
      if (!res.ok) {
        setState({ kind: "error" });
        return;
      }
      setState({ kind: "ready", payload: (await res.json()) as TokenPayload });
    } catch {
      setState({ kind: "error" });
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(submission: MaintenanceFormSubmission) {
    const res = await fetch(`/api/lodge-maintenance/${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: submission.summary,
        answers: submission.answers,
        photoDataUrl: submission.photoDataUrl,
        // Sent only when the club left the prompt on, and empty strings are
        // normalised away so a blank field is stored as nothing rather than as "".
        ...(submission.reporterName ? { reporterName: submission.reporterName } : {}),
        ...(submission.reporterContact
          ? { reporterContact: submission.reporterContact }
          : {}),
      }),
    });

    if (res.status === 429) {
      throw new Error(
        "That is a few reports in a short time. Please try again a bit later.",
      );
    }
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

  if (state.kind === "loading") {
    return (
      <Card className="w-full max-w-xl">
        {/* No visible title while loading; the page still needs its one h1 in
            every render state (#4951). */}
        <h1 className="sr-only">Report a maintenance issue</h1>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          Loading the form...
        </CardContent>
      </Card>
    );
  }

  if (state.kind === "unavailable" || state.kind === "error") {
    return (
      <Card className="w-full max-w-xl">
        <CardHeader>
          <CardTitle headingLevel={1}>This code is not working</CardTitle>
          <CardDescription>
            The sign you scanned is not accepting reports at the moment. Please tell
            somebody at the club, or ask a member to report it from their account.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (submitted) {
    return (
      <Card className="w-full max-w-xl">
        <CardHeader>
          <CardTitle headingLevel={1} className="flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-primary" aria-hidden="true" />
            Thank you — that has been sent
          </CardTitle>
          <CardDescription>
            Whoever looks after {state.payload.lodgeName} has been told. You do not
            need to do anything else.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            onClick={() => {
              setSubmitted(false);
              void load();
            }}
          >
            Report something else
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-xl">
      <CardHeader>
        <CardTitle headingLevel={1} className="flex items-center gap-2">
          <Wrench className="h-5 w-5" aria-hidden="true" />
          Report a maintenance issue
        </CardTitle>
        <CardDescription>
          Something at {state.payload.lodgeName} needs fixing? Tell us here — you do
          not need an account.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <MaintenanceReportForm
          questions={state.payload.questions}
          photosEnabled={state.payload.photosEnabled}
          summaryMaxLength={state.payload.summaryMaxLength}
          lodges={null}
          fixedLodgeName={state.payload.lodgeName}
          contactPrompt={state.payload.contactPrompt}
          submitLabel="Send this report"
          onSubmit={submit}
        />
      </CardContent>
    </Card>
  );
}
