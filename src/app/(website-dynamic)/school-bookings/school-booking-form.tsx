"use client";

import type { AgeTier } from "@prisma/client";
import { useEffect, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
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
import { Checkbox } from "@/components/ui/checkbox";
import type { ClubIdentity } from "@/config/club-identity-types";
import { useAgeTierOptions } from "@/lib/use-age-tier-options";
import { useClubTime } from "@/components/club-time-provider";
import { DEFAULT_SCHOOL_GROUP_SOFT_CAP } from "@/lib/school-booking-constants";

// Schools request counts of children per age tier; teachers and parent helpers
// are the named adults.
const CHILD_TIERS: AgeTier[] = ["INFANT", "CHILD", "YOUTH"];

interface TeacherInput {
  firstName: string;
  lastName: string;
  email: string;
}

function emptyTeacher(): TeacherInput {
  return { firstName: "", lastName: "", email: "" };
}

/**
 * The public school-group booking-request form.
 *
 * Extracted from the former `(public)/school-bookings/page.tsx` so it can render
 * both as that page's body AND as the {{school-bookings}} content token
 * (static → dynamic migration). It takes `club` as a PROP rather than reading
 * `useClubIdentity()`, mirroring the other embedded forms: that keeps it
 * renderable by `EmbeddedPageContentParts` in either public route group, which
 * have no ClubIdentityProvider. The DB-resolved default lodge capacity is
 * injected into `club.lodgeCapacity` by the resolving server page (#1982 R1).
 */
export function SchoolBookingForm({ club }: { club: ClubIdentity }) {
  const ageTierOptions = useAgeTierOptions();
  /*
    THE EARLIEST SELECTABLE LODGE NIGHT IS THE CLUB'S TODAY (CT-4, #2870; epic
    #2988; INV-CONFIG-002).

    It must be the club's day and not this browser's: a parent filling this in
    from Sydney or from London would otherwise be offered a first night the
    server behind `/api/booking-requests` — which resolves "today" against the
    club — then refuses, and #2682 already fixed the same defect once when the
    bound was the UTC day. The zone is now the PERSISTED
    `ClubTimeSettings.timeZone`, reaching this browser as data through
    `ClubTimeProvider`, where it used to be `APP_TIME_ZONE`: the container's
    `TZ`, which is the club's zone only by accident. Same shape, same answer on
    every deployment today; only the authority moved.
  */
  const clubTime = useClubTime();
  const [schoolName, setSchoolName] = useState("");
  const [contactFirstName, setContactFirstName] = useState("");
  const [contactLastName, setContactLastName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [message, setMessage] = useState("");
  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  // Active lodges from the public settings endpoint; empty for a
  // single-lodge club, so no lodge copy renders (ADR-002).
  const [lodges, setLodges] = useState<
    Array<{ id: string; name: string; capacity: number; schoolGroupSoftCap: number }>
  >([]);
  const [lodgeId, setLodgeId] = useState("");
  // Default-lodge soft cap for the single-lodge case (no selector).
  const [defaultSoftCap, setDefaultSoftCap] = useState(DEFAULT_SCHOOL_GROUP_SOFT_CAP);
  // The DB-resolved default-lodge capacity, from the same endpoint. See the
  // `effectiveCapacity` note below for why the prop alone is not enough.
  const [defaultLodgeCapacity, setDefaultLodgeCapacity] = useState<number | null>(
    null,
  );
  const [cateringPreference, setCateringPreference] = useState<
    "CATERED" | "NON_CATERED" | "QUOTE_BOTH"
  >("QUOTE_BOTH");
  // Whole-lodge exclusivity request (issue #121). A request, not a guarantee —
  // an officer decides at approval whether to grant sole occupancy.
  const [exclusivityRequested, setExclusivityRequested] = useState(false);
  const [teachers, setTeachers] = useState<TeacherInput[]>([emptyTeacher()]);
  const [childCounts, setChildCounts] = useState<Record<string, number>>({
    INFANT: 0,
    CHILD: 0,
    YOUTH: 0,
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/booking-requests/settings")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        setLodges(Array.isArray(data?.lodges) ? data.lodges : []);
        if (typeof data?.schoolGroupSoftCap === "number") {
          setDefaultSoftCap(data.schoolGroupSoftCap);
        }
        if (typeof data?.defaultLodgeCapacity === "number") {
          setDefaultLodgeCapacity(data.defaultLodgeCapacity);
        }
      })
      .catch(() => setLodges([]));
  }, []);

  const lodgeChoiceRequired = lodges.length >= 2;
  // Cap guests against the chosen lodge; fall back to the DEFAULT lodge for
  // single-lodge clubs where no selector renders. The server re-validates
  // against the requested lodge regardless.
  //
  // Three sources in strict order, and the middle one is the fix (#2818
  // decision 7): the chosen lodge, then the DB-resolved default capacity from
  // the settings endpoint, then the `club` prop. The prop is only correct on the
  // dedicated page, which spreads the real figure over the club identity before
  // rendering; the `{{school-bookings}}` embed on an ordinary CMS page and the
  // 404 page both pass the identity WITHOUT that spread, so the prop is the
  // static fallback of 20 there. Preferring the fetched value makes every render
  // path right, and keeps the prop as the first-frame value until the fetch
  // lands.
  const selectedLodge = lodges.find((lodge) => lodge.id === lodgeId) ?? null;
  const effectiveCapacity =
    selectedLodge?.capacity ?? defaultLodgeCapacity ?? club.lodgeCapacity;
  const effectiveSoftCap = selectedLodge?.schoolGroupSoftCap ?? defaultSoftCap;

  const childTierLabel = (tier: AgeTier) =>
    ageTierOptions.find((option) => option.tier === tier)?.label ?? tier;

  const totalChildren = CHILD_TIERS.reduce((sum, tier) => sum + (childCounts[tier] || 0), 0);
  const validTeachers = teachers.filter((t) => t.firstName.trim() && t.lastName.trim());
  const totalGuests = validTeachers.length + totalChildren;
  const datesValid = Boolean(checkIn && checkOut && checkOut > checkIn);
  // Soft cap: a club member must host, so groups over 25 may be declined. We
  // warn but still allow submission up to the lodge capacity.
  const overSoftCap = totalGuests > effectiveSoftCap;

  function updateTeacher(index: number, field: keyof TeacherInput, value: string) {
    setTeachers((prev) => prev.map((t, i) => (i === index ? { ...t, [field]: value } : t)));
  }

  function addTeacher() {
    setTeachers((prev) => [...prev, emptyTeacher()]);
  }

  function removeTeacher(index: number) {
    setTeachers((prev) => prev.filter((_, i) => i !== index));
  }

  function updateChildCount(tier: AgeTier, value: string) {
    const parsed = Math.max(0, Math.floor(Number(value) || 0));
    setChildCounts((prev) => ({ ...prev, [tier]: parsed }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (!schoolName.trim()) {
      setError("Please enter the school name.");
      return;
    }
    if (lodgeChoiceRequired && !lodgeId) {
      setError("Please choose a lodge.");
      return;
    }
    if (!datesValid) {
      setError("Check-out must be after check-in.");
      return;
    }
    if (validTeachers.length === 0) {
      setError("Please add at least one teacher or parent helper with a name.");
      return;
    }
    if (totalChildren === 0) {
      setError("Please enter the number of children attending.");
      return;
    }
    if (totalGuests > effectiveCapacity) {
      setError(`Total guests (${totalGuests}) exceeds the lodge capacity of ${effectiveCapacity}.`);
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/booking-requests/school", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schoolName,
          contactFirstName,
          contactLastName,
          contactEmail,
          contactPhone: contactPhone || undefined,
          checkIn,
          checkOut,
          lodgeId: lodgeChoiceRequired ? lodgeId : undefined,
          cateringPreference,
          teachers: validTeachers.map((t) => ({
            firstName: t.firstName,
            lastName: t.lastName,
            email: t.email.trim() || undefined,
          })),
          childCounts: {
            INFANT: childCounts.INFANT || undefined,
            CHILD: childCounts.CHILD || undefined,
            YOUTH: childCounts.YOUTH || undefined,
          },
          exclusivityRequested,
          message: message || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Unable to submit your school booking request right now.");
      }
      setSubmitted(true);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to submit your school booking request right now."
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle>Request Sent</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2 text-success-11">
            <CheckCircle2 className="h-6 w-6 shrink-0" />
            <p className="font-medium">Thanks, {contactFirstName} — almost there.</p>
          </div>
          <p className="text-sm text-muted-foreground">
            We&apos;ve sent a confirmation email to {contactEmail}. Please click the link inside to
            confirm your email address. Once confirmed, your request will join our review queue and
            {" "}{selectedLodge?.name ?? club.lodgeName} will send a quote for your school to
            review.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card id="schoolBookingForm" className="w-full max-w-2xl">
      <CardHeader>
        <CardTitle>School Group Booking Request</CardTitle>
        <CardDescription>
          Request a school group stay at {club.lodgeName}. We&apos;ll email you to confirm your
          address, then send a quote for your school to review.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-6">
          {error ? (
            <div className="rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          <div className="space-y-1">
            <Label htmlFor="schoolName">School name</Label>
            <Input
              id="schoolName"
              value={schoolName}
              onChange={(e) => setSchoolName(e.target.value)}
              required
              maxLength={200}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="contactFirstName">Contact first name</Label>
              <Input
                id="contactFirstName"
                value={contactFirstName}
                onChange={(e) => setContactFirstName(e.target.value)}
                required
                maxLength={100}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="contactLastName">Contact last name</Label>
              <Input
                id="contactLastName"
                value={contactLastName}
                onChange={(e) => setContactLastName(e.target.value)}
                required
                maxLength={100}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="contactEmail">Contact email (school invoice)</Label>
              <Input
                id="contactEmail"
                type="email"
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
                required
                maxLength={200}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="contactPhone">Phone (optional)</Label>
              <Input
                id="contactPhone"
                value={contactPhone}
                onChange={(e) => setContactPhone(e.target.value)}
                maxLength={30}
              />
            </div>
          </div>

          {lodgeChoiceRequired ? (
            <div className="space-y-1">
              <Label htmlFor="lodgeId">Which lodge?</Label>
              <Select value={lodgeId || undefined} onValueChange={setLodgeId}>
                <SelectTrigger id="lodgeId">
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
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="checkIn">Check-in</Label>
              <Input
                id="checkIn"
                type="date"
                value={checkIn}
                min={clubTime.today()}
                onChange={(e) => setCheckIn(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="checkOut">Check-out</Label>
              <Input
                id="checkOut"
                type="date"
                value={checkOut}
                min={checkIn || clubTime.today()}
                onChange={(e) => setCheckOut(e.target.value)}
                required
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="cateringPreference">Catering</Label>
            <Select
              value={cateringPreference}
              onValueChange={(value) =>
                setCateringPreference(value as "CATERED" | "NON_CATERED" | "QUOTE_BOTH")
              }
            >
              <SelectTrigger id="cateringPreference">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="QUOTE_BOTH">Quote catered and non-catered</SelectItem>
                <SelectItem value="CATERED">Catered</SelectItem>
                <SelectItem value="NON_CATERED">Non-catered</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <Checkbox
                checked={exclusivityRequested}
                onCheckedChange={setExclusivityRequested}
                className="mt-0.5"
              />
              <span>
                Request exclusive use of the lodge (sole occupancy for our group)
              </span>
            </label>
            <p className="text-xs text-muted-foreground">
              We&apos;ll do our best, but this is a request — {selectedLodge?.name ?? club.lodgeName}
              will confirm whether the whole lodge can be reserved for your group
              when we send your quote.
            </p>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">
                Teachers &amp; parent helpers ({club.hutLeaderLabel.toLowerCase()}s)
              </h3>
              <Button type="button" variant="outline" size="sm" onClick={addTeacher}>
                + Add adult
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Each teacher or parent helper is set up as a{" "}
              {club.hutLeaderLabel.toLowerCase()} and emailed their kiosk PIN. If
              no email is given, the PIN goes to the contact email above.
            </p>

            {teachers.map((teacher, index) => (
              <div key={index} className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_1fr_1fr_auto]">
                <div className="space-y-1">
                  <Label>First name</Label>
                  <Input
                    value={teacher.firstName}
                    onChange={(e) => updateTeacher(index, "firstName", e.target.value)}
                    maxLength={100}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Last name</Label>
                  <Input
                    value={teacher.lastName}
                    onChange={(e) => updateTeacher(index, "lastName", e.target.value)}
                    maxLength={100}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Email (optional)</Label>
                  <Input
                    type="email"
                    value={teacher.email}
                    onChange={(e) => updateTeacher(index, "email", e.target.value)}
                    maxLength={200}
                  />
                </div>
                <div className="flex items-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeTeacher(index)}
                    disabled={teachers.length <= 1}
                    className="text-danger-11 hover:text-danger-11"
                  >
                    Remove
                  </Button>
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-3">
            <h3 className="text-sm font-semibold">Children attending</h3>
            <div className="grid gap-4 sm:grid-cols-3">
              {CHILD_TIERS.map((tier) => (
                <div key={tier} className="space-y-1">
                  <Label htmlFor={`count-${tier}`}>{childTierLabel(tier)}</Label>
                  <Input
                    id={`count-${tier}`}
                    type="number"
                    min="0"
                    value={childCounts[tier] || 0}
                    onChange={(e) => updateChildCount(tier, e.target.value)}
                  />
                </div>
              ))}
            </div>
            <p className="text-sm text-muted-foreground">
              Total guests: {totalGuests} / {effectiveCapacity} max ({validTeachers.length} teachers
              {" "}&amp; helpers, {totalChildren} children)
            </p>
            {overSoftCap ? (
              <p className="rounded-md border border-warning-6 bg-warning-3 px-3 py-2 text-sm text-warning-11">
                School groups are capped at {effectiveSoftCap} beds (students plus teachers and
                parent helpers) unless the remaining beds, up to the lodge&apos;s {effectiveCapacity},{" "}
                include a club member staying with your group. Requests over {effectiveSoftCap}{" "}
                may be declined until a member is confirmed to host. You can still submit and
                we&apos;ll be in touch.
              </p>
            ) : null}
          </div>

          <div className="space-y-1">
            <Label htmlFor="message">Message (optional)</Label>
            <Textarea
              id="message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={1000}
              placeholder="Anything else we should know about your visit?"
            />
          </div>

          <Button type="submit" disabled={submitting} className="w-full sm:w-auto">
            {submitting ? "Submitting..." : "Submit school request"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
