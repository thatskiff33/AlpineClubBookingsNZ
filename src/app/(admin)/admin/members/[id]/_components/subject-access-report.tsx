"use client";

import { useState, type FormEvent } from "react";
import type { SubjectAccessSubject } from "@/lib/subject-access-export";
import { Download } from "lucide-react";

import { fetchWithRecentAuth } from "@/components/confirm-its-you";
import { useClubFormat } from "@/components/club-format-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatStayDateOrNull } from "@/lib/club-time";
import { saveResponseAsFile } from "@/lib/save-response-as-file";

const REPORT_PATH = "/api/admin/members/subject-access";

type Lookup = SubjectAccessSubject;

type GuestMatch = {
  id: string;
  name: string;
  /** Lodge nights as `YYYY-MM-DD`. */
  stayStart: string;
  stayEnd: string;
};

/**
 * The Full Admin subject access report (#4915): the same file a member
 * downloads from Profile, for this member, a dependant, or a non-member found
 * by email or, since guest rows hold no email, by picking their exact guest row
 * from a name search. Shown to Full Admins only; the
 * route refuses everyone else and audits every file produced.
 */
export function SubjectAccessReport({ memberId, className }: { memberId: string; className?: string }) {
  const format = useClubFormat();
  const [email, setEmail] = useState("");
  const [guestName, setGuestName] = useState("");
  const [guests, setGuests] = useState<GuestMatch[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download(lookup: Lookup) {
    setPending(true);
    setError(null);
    try {
      const response = await fetchWithRecentAuth(`${REPORT_PATH}?${new URLSearchParams(lookup)}`);
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "Could not produce the report.");
        return;
      }
      await saveResponseAsFile(response, "subject-access-report.json");
    } catch {
      setError("Could not produce the report.");
    } finally {
      setPending(false);
    }
  }

  async function searchGuests(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch(
        `${REPORT_PATH}/guests?${new URLSearchParams({ name: guestName.trim() })}`,
      );
      const body = (await response.json().catch(() => ({}))) as { guests?: GuestMatch[]; error?: string };
      if (!response.ok || !body.guests) {
        setError(body.error ?? "Could not search guests.");
        return;
      }
      setGuests(body.guests);
    } catch {
      setError("Could not search guests.");
    } finally {
      setPending(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>, lookup: Lookup) {
    event.preventDefault();
    void download(lookup);
  }

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Subject access report</CardTitle>
        <CardDescription>
          Answer a request for a copy of someone&rsquo;s personal information. Check who is
          asking, and that they may see this person&rsquo;s record, before you send the file.
          Every report is recorded in the audit log. The file lists what it leaves out for
          you to review by hand.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <Button
          variant="outline"
          size="sm"
          className="gap-2"
          disabled={pending}
          onClick={() => void download({ memberId })}
        >
          <Download className="h-4 w-4" />
          Download this member&rsquo;s report
        </Button>
        <form className="space-y-2" onSubmit={(event) => submit(event, { email: email.trim() })}>
          <Label htmlFor="subject-access-email">
            Someone else, by email (a member, an applicant or a booking requester)
          </Label>
          <div className="flex flex-wrap gap-2">
            <Input
              id="subject-access-email"
              type="email"
              required
              maxLength={200}
              className="max-w-sm"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <Button type="submit" variant="outline" size="sm" disabled={pending}>
              Download report
            </Button>
          </div>
        </form>
        <form className="space-y-2" onSubmit={(event) => void searchGuests(event)}>
          <Label htmlFor="subject-access-guest">A non-member guest, by name</Label>
          <div className="flex flex-wrap gap-2">
            <Input
              id="subject-access-guest"
              required
              maxLength={120}
              className="max-w-sm"
              value={guestName}
              onChange={(event) => setGuestName(event.target.value)}
            />
            <Button type="submit" variant="outline" size="sm" disabled={pending}>
              Find guest
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            Guest records hold no email address, so a guest cannot be found by email. Pick
            the stay the person asking describes, and confirm it is them, before you send
            the file.
          </p>
        </form>
        {guests && (
          guests.length === 0 ? (
            <p className="text-sm text-muted-foreground">No non-member guest matches that name.</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {guests.map((guest) => (
                <li key={guest.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                  <span>
                    <span className="font-medium">{guest.name}</span>
                    {" · "}
                    {formatStayDateOrNull(guest.stayStart, format) ?? guest.stayStart} to{" "}
                    {formatStayDateOrNull(guest.stayEnd, format) ?? guest.stayEnd}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={() => void download({ guestId: guest.id })}
                  >
                    Download report
                  </Button>
                </li>
              ))}
            </ul>
          )
        )}
        {error && (
          <p role="alert" className="text-sm text-danger-11">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
