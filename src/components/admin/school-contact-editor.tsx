"use client";

/**
 * EDIT SCHOOL DETAILS — the officer's correction of a school's own email
 * address and phone number (#5245).
 *
 * One editor, reached from wherever the app shows a school record: the
 * booking-request correction form and the bookings list. Callers mount it only
 * for an officer who can edit bookings; the server refuses everyone else
 * anyway. Every rule is the server's (`school-organisation-contact-edit.ts`):
 * this shows what it holds, sends the version it loaded, and says plainly what
 * happened at Xero.
 */

import { useCallback, useEffect, useState } from "react";

import { fetchWithRecentAuth } from "@/components/confirm-its-you";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiErrorMessageFromBody, readApiErrorBody } from "@/lib/api-error-message";
import { readValidationDetails } from "@/lib/format-validation-errors";

export type SchoolContactDetails = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  updatedAt: string;
  hasXeroContact: boolean;
  xeroSync: {
    operationId: string;
    status: string;
    lastErrorMessage: string | null;
  } | null;
};

type LoadState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; school: SchoolContactDetails };

/** A refusal's first validation message, else its sentence, through the shared readers. */
async function readError(response: Response, fallback: string): Promise<string> {
  const body = await readApiErrorBody(response);
  const refusal = readValidationDetails(body);
  return refusal?.formErrors[0] ?? refusal?.fieldErrors[0]?.[1][0] ?? apiErrorMessageFromBody(body, fallback);
}

/** What Xero has of this school, in words an officer can act on. */
export function SchoolXeroSyncStatus(props: {
  school: SchoolContactDetails;
  retrying: boolean;
  onRetry: () => void;
}) {
  const { school } = props;
  if (!school.hasXeroContact) {
    return (
      <p className="text-xs text-muted-foreground">
        This school has no Xero contact yet. Xero will get these details on the
        school&apos;s first invoice.
      </p>
    );
  }
  const sync = school.xeroSync;
  if (!sync) return null;
  if (sync.status === "FAILED") {
    return (
      <div className="space-y-2 rounded-md border border-warning-6 bg-warning-2 p-2 text-xs" role="alert">
        <p>
          Xero did not take the last change
          {sync.lastErrorMessage ? `: ${sync.lastErrorMessage}` : "."} The
          details are saved here; Xero still has the old ones.
        </p>
        <Button type="button" size="sm" variant="outline" onClick={props.onRetry} disabled={props.retrying}>
          {props.retrying ? "Retrying…" : "Retry sending to Xero"}
        </Button>
      </div>
    );
  }
  const words: Record<string, string> = {
    PENDING: "The last change is queued to send to Xero.",
    RUNNING: "The last change is being sent to Xero.",
    SUCCEEDED: "Xero has the last change.",
    CANCELLED: "The last change was not sent to Xero.",
  };
  return <p className="text-xs text-muted-foreground">{words[sync.status] ?? `Xero: ${sync.status}`}</p>;
}

export function SchoolContactEditor(props: {
  organisationId: string;
  /** Shown on the button before the record has loaded. */
  schoolName?: string;
}) {
  const { organisationId } = props;
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const url = `/api/admin/organisations/${encodeURIComponent(organisationId)}/contact`;

  const load = useCallback(
    async (seedFields: boolean) => {
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) {
          setState({ kind: "failed", message: await readError(response, "Could not load the school's details.") });
          return;
        }
        const { school } = (await response.json()) as { school: SchoolContactDetails };
        setState({ kind: "ready", school });
        if (seedFields) {
          setEmail(school.email ?? "");
          setPhone(school.phone ?? "");
          setConflict(false);
        }
      } catch {
        setState({ kind: "failed", message: "Could not load the school's details." });
      }
    },
    [url],
  );

  useEffect(() => {
    if (!open) return;
    setState({ kind: "loading" });
    setError(null);
    setNotice(null);
    void load(true);
  }, [open, load]);

  const save = async () => {
    if (state.kind !== "ready") return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetchWithRecentAuth(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, phone, expectedUpdatedAt: state.school.updatedAt }),
      });
      if (response.status === 409) {
        setConflict(true);
        return;
      }
      if (!response.ok) {
        setError(await readError(response, "Could not save the school's details."));
        return;
      }
      const { result } = (await response.json()) as { result: { changed: boolean } };
      setNotice(result.changed ? "Saved." : "Nothing changed.");
      await load(true);
    } catch {
      setError("Could not save the school's details.");
    } finally {
      setSaving(false);
    }
  };

  const retry = async () => {
    setRetrying(true);
    setError(null);
    try {
      const response = await fetch(`${url}/retry`, { method: "POST" });
      if (!response.ok) {
        setError(await readError(response, "Could not retry the Xero update."));
      }
      await load(false);
    } catch {
      setError("Could not retry the Xero update.");
    } finally {
      setRetrying(false);
    }
  };

  const emailId = `school-contact-email-${organisationId}`;
  const phoneId = `school-contact-phone-${organisationId}`;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="outline">
          Edit school details
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {state.kind === "ready" ? state.school.name : (props.schoolName ?? "School details")}
          </DialogTitle>
          <DialogDescription>
            The school&apos;s own email address and phone number. Invoices and
            emails to the school use them from now on; anything already sent is
            not changed. The school&apos;s name and teachers are not edited here.
          </DialogDescription>
        </DialogHeader>
        {state.kind === "loading" ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : state.kind === "failed" ? (
          <div className="space-y-2 text-sm">
            <p role="alert">{state.message}</p>
            <Button type="button" size="sm" variant="outline" onClick={() => void load(true)}>
              Try again
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor={emailId}>Email address</Label>
              <Input
                id={emailId}
                type="email"
                value={email}
                maxLength={200}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={phoneId}>Phone number</Label>
              <Input
                id={phoneId}
                type="tel"
                value={phone}
                maxLength={30}
                onChange={(event) => setPhone(event.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground">Leave a field empty to clear it.</p>
            {conflict ? (
              <div className="space-y-2 rounded-md border border-warning-6 bg-warning-2 p-2 text-xs" role="alert">
                <p>Changed by someone else — reload to see their details before saving yours.</p>
                <Button type="button" size="sm" variant="outline" onClick={() => void load(true)}>
                  Reload
                </Button>
              </div>
            ) : null}
            {error ? (
              <p className="text-xs text-destructive" role="alert">
                {error}
              </p>
            ) : null}
            {notice ? <p className="text-xs text-muted-foreground">{notice}</p> : null}
            <SchoolXeroSyncStatus school={state.school} retrying={retrying} onRetry={() => void retry()} />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Close
              </Button>
              <Button type="button" onClick={() => void save()} disabled={saving || conflict}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
