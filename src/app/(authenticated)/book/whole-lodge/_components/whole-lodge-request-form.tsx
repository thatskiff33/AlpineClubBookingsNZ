"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldHint, useFieldHint } from "@/components/ui/field-hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Lodge = { id: string; name: string };

/*
  #2263 — the member's whole-lodge request form.

  What is NOT here is the design. There is no availability calendar, no "N beds
  left" hint, no live price and no capacity pre-check, because every one of them
  answers the question a member may not have answered: is the lodge free — or
  already held for somebody else — that week? (ADR-001 decision 6 / D11.)

  The acknowledgement below is likewise fixed. It is what the server sends back
  for EVERY schema-valid submission, and it echoes nothing the member typed —
  no dates, no headcount, no reference number. An echo is a channel, and a
  channel that varies with the calendar is the leak this whole feature is shaped
  around avoiding.
*/

export function WholeLodgeRequestForm({
  availableCreditCents = 0,
}: {
  /**
   * The member's own account-credit balance, read server-side by the page. It
   * is the member's OWN figure, not a property of the calendar, so showing it
   * here keeps the disclosure contract intact. Zero hides the control.
   */
  availableCreditCents?: number;
}) {
  const [lodges, setLodges] = useState<Lodge[]>([]);
  const [lodgeId, setLodgeId] = useState<string>("");
  const [lodgesLoading, setLodgesLoading] = useState(true);
  const [lodgesError, setLodgesError] = useState(false);
  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [headcount, setHeadcount] = useState("");
  const [groupDescription, setGroupDescription] = useState("");
  const [notes, setNotes] = useState("");
  const [applyAccountCredit, setApplyAccountCredit] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const headcountHint = useFieldHint();
  const groupHint = useFieldHint();
  const notesHint = useFieldHint();

  const loadLodges = useCallback(() => {
    let cancelled = false;
    setLodgesLoading(true);
    setLodgesError(false);
    setLodgeId("");
    fetch("/api/lodges")
      .then((response) => {
        if (!response.ok) throw new Error("lodge-list-failed");
        return response.json();
      })
      .then((data: { lodges?: Lodge[] }) => {
        if (cancelled) return;
        const list = data.lodges ?? [];
        setLodges(list);
        setLodgeId(list[0]?.id ?? "");
      })
      .catch(() => {
        if (!cancelled) {
          setLodges([]);
          setLodgesError(true);
        }
      })
      .finally(() => {
        if (!cancelled) setLodgesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return loadLodges();
  }, [loadLodges]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!lodgeId) {
      setError("Choose a lodge before sending this request.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const response = await fetch("/api/booking-requests/whole-lodge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkIn,
          checkOut,
          headcount: Number(headcount),
          groupDescription,
          notes: notes.trim() ? notes : undefined,
          lodgeId,
          applyAccountCredit: availableCreditCents > 0 && applyAccountCredit,
        }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(data.error || "Could not send your request");
      }
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send your request");
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Request sent</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* FIXED COPY. Identical whatever the member asked for and whatever
              the lodge's state is on those nights. */}
          <p>
            Thanks — your whole-lodge request has been sent to the booking
            officer. They will be in touch to confirm what is possible.
          </p>
          <p className="text-sm text-muted-foreground">
            You can see it under <strong>My requests</strong> on My bookings.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button asChild>
              <Link href="/bookings">Go to My bookings</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/book">Back to Book a Stay</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="pt-6">
        <form onSubmit={handleSubmit} className="space-y-5">
          {error && (
            <Alert variant="error">{error}</Alert>
          )}

          {lodgesError ? (
            <Alert variant="error">
              <p className="mb-3">
                The lodge list could not be loaded. No request can be sent
                until its lodge is known.
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  loadLodges();
                }}
              >
                Try again
              </Button>
            </Alert>
          ) : lodgesLoading ? (
            <p className="text-sm text-muted-foreground">Loading lodges...</p>
          ) : lodges.length === 0 ? (
            <Alert variant="error">No active lodge is available for this request.</Alert>
          ) : null}

          {lodges.length > 1 && (
            <div className="space-y-2">
              <Label htmlFor="whole-lodge-lodge">Lodge</Label>
              <Select value={lodgeId} onValueChange={setLodgeId}>
                <SelectTrigger id="whole-lodge-lodge">
                  <SelectValue placeholder="Choose a lodge" />
                </SelectTrigger>
                <SelectContent>
                  {lodges.map((lodge) => (
                    <SelectItem key={lodge.id} value={lodge.id}>
                      {lodge.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="whole-lodge-check-in">Arriving</Label>
              <Input
                id="whole-lodge-check-in"
                type="date"
                required
                value={checkIn}
                onChange={(event) => setCheckIn(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="whole-lodge-check-out">Leaving</Label>
              <Input
                id="whole-lodge-check-out"
                type="date"
                required
                value={checkOut}
                onChange={(event) => setCheckOut(event.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="whole-lodge-headcount">
              Roughly how many people?
            </Label>
            <Input
              id="whole-lodge-headcount"
              type="number"
              min={1}
              required
              value={headcount}
              onChange={(event) => setHeadcount(event.target.value)}
              {...headcountHint.fieldProps}
            />
            <FieldHint {...headcountHint.hintProps}>
              An estimate is fine — the booking officer will confirm the final
              number with you before anything is charged. We do not need guest
              names yet.
            </FieldHint>
          </div>

          <div className="space-y-2">
            <Label htmlFor="whole-lodge-group">Who is the group?</Label>
            <Textarea
              id="whole-lodge-group"
              required
              rows={3}
              maxLength={500}
              value={groupDescription}
              onChange={(event) => setGroupDescription(event.target.value)}
              {...groupHint.fieldProps}
            />
            <FieldHint {...groupHint.hintProps}>
              Example: the club&apos;s alpine skills course, or a family
              gathering for a 70th.
            </FieldHint>
          </div>

          <div className="space-y-2">
            <Label htmlFor="whole-lodge-notes">
              Anything else we should know? (optional)
            </Label>
            <Textarea
              id="whole-lodge-notes"
              rows={3}
              maxLength={400}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              {...notesHint.fieldProps}
            />
            <FieldHint {...notesHint.hintProps}>
              Arrival times, catering plans, or anything that would help the
              booking officer.
            </FieldHint>
          </div>

          {/* The member's credit election, mirroring the "Apply credit to this
              booking" control on the ordinary review step. The price is not
              known until the officer prices the approval, so the ask is a
              yes/no: approval puts up to the balance towards the total, and the
              member pays the rest by card or internet banking from the booking
              page. The balance decides only whether the control is offered; the
              figure itself is NOT printed here. It is the member's own number
              and says nothing about the calendar, but this page is swept for
              any "$<digit>" at all (e2e/whole-lodge-request.spec.ts) so that no
              price can ever creep onto it, and that sweep is worth more than
              repeating a figure the dashboard already shows. */}
          {availableCreditCents > 0 && (
            <div className="rounded-md border border-success/20 bg-success-muted p-4">
              <p className="mb-2 text-sm text-success">
                You have account credit on your account.
              </p>
              <label className="flex cursor-pointer items-center gap-2 text-sm text-success">
                <input
                  type="checkbox"
                  checked={applyAccountCredit}
                  onChange={(event) =>
                    setApplyAccountCredit(event.target.checked)
                  }
                  className="rounded border-success/40"
                />
                Put my account credit towards this booking if it is approved
              </label>
              <p className="mt-2 text-xs text-success">
                If the booking officer approves the request, as much of your
                credit as the booking costs is applied to it, and you pay any
                remainder from the booking page.
              </p>
            </div>
          )}

          <p className="text-sm text-muted-foreground">
            This is a request, not a booking. Nothing is reserved and nothing is
            charged until the booking officer confirms it with you.
          </p>

          <div className="flex flex-wrap gap-3">
            <Button
              type="submit"
              disabled={submitting || lodgesLoading || lodgesError || !lodgeId}
            >
              {submitting ? "Sending..." : "Send request"}
            </Button>
            {/* No `type` here: asChild renders the Link's anchor, and `type` on
                an <a> means a MIME type hint, not a button behaviour. */}
            <Button asChild variant="outline">
              <Link href="/book">Cancel</Link>
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
