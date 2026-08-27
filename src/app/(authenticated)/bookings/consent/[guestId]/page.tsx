import Link from "next/link";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MemberGuestDelegateConsentCard } from "@/components/member-guest-delegate-consent-card";
import { auth } from "@/lib/auth";
import type { ClubTimeZone } from "@/lib/club-time";
import { clubTimeZone } from "@/lib/club-time/server";
import { loadEmailMessageSettingsForLodge } from "@/lib/email-message-settings";
import {
  describeConsentDeclineRefusal,
  formatConsentFullDate,
  formatConsentGuestName,
  formatConsentNightsLabel,
  formatConsentStayLabel,
} from "@/lib/member-guest-consent-card";
import { resolveDelegateConsentPageState } from "@/lib/member-guest-delegate-page";

/**
 * The delegate consent page ("+ Add Member Guest", epic #2305, MG2 #2307,
 * owner decisions D-5/D-9/D-10) — where a family adult answers a consent
 * request for a member who has no login of their own.
 *
 * Its own route because a delegate is NOT a guest on the booking: the booking
 * page's viewer guard would (correctly) redirect them away. Per D-9 a target
 * with no login is the normal case, so this page carries real traffic — the
 * consent-request email deep-links delegates here.
 *
 * EVERYTHING SECURITY-RELEVANT LIVES IN `resolveDelegateConsentPageState`
 * (unit tested): only an adult in the target's family group is told anything
 * beyond the one neutral "nothing here" state, a target with their own login
 * is redirected to the booking page (their surface under D-11), and nothing
 * this page renders carries a price — a delegate must never see the booking's
 * money. That asymmetry is a security choice stated on the signed-off mockup
 * pack, not an omission.
 */
export default async function DelegateConsentPage({
  params,
}: {
  params: Promise<{ guestId: string }>;
}) {
  const { guestId } = await params;
  const session = await auth();
  if (!session) redirect("/login");

  /*
    #3123 — every date this page prints from a real instant is named in the
    club's PERSISTED zone (`INV-CONFIG-002`), not the container's. Resolved ONCE
    here and threaded down, so the "accepted on" line, the "declined on" line
    and the "answer by" fact in the card below cannot disagree with each other.

    The stay dates and the guest's nights DO NOT take it: they are `@db.Date`
    lodge nights, which are calendar days and have no zone (`INV-DATE-010`).
  */
  const zone = await clubTimeZone();

  const state = await resolveDelegateConsentPageState({
    guestId,
    viewerMemberId: session.user.id,
  });

  if (state.kind === "TARGET_SELF") {
    redirect(`/bookings/${state.bookingId}#consent`);
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-3xl font-bold">Consent request</h1>

      {state.kind === "NOT_FOUND" ? (
        <Card>
          <CardHeader>
            <CardTitle>There is nothing here for you to answer</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>
              This link does not lead to a consent request you can answer. The
              request may already have been dealt with, or the link may have
              been sent to a different account — check you are signed in as the
              person the email was addressed to.
            </p>
            <Button asChild variant="outline" size="sm">
              <Link href="/">Back to the home page</Link>
            </Button>
          </CardContent>
        </Card>
      ) : state.kind === "MODULE_OFF" ? (
        <Card>
          <CardHeader>
            <CardTitle>This request can no longer be answered here</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>
              The club has switched member guests off, so this request is no
              longer in use. Contact the club if {state.guestFirstName} still
              wants to come.
            </p>
            <Button asChild variant="outline" size="sm">
              <Link href="/">Back to the home page</Link>
            </Button>
          </CardContent>
        </Card>
      ) : state.kind === "ALREADY_ANSWERED" ? (
        <Card>
          <CardHeader>
            <CardTitle>This request has already been answered</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>
              {state.status === "CONFIRMED"
                ? `${state.guestFirstName} is on the booking${
                    state.respondedAt
                      ? ` — the request was accepted on ${formatConsentFullDate(state.respondedAt, zone)}`
                      : ""
                  }. Nothing more is needed.`
                : `The request was declined${
                    state.respondedAt
                      ? ` on ${formatConsentFullDate(state.respondedAt, zone)}`
                      : ""
                  }, and ${state.guestFirstName} was not added.`}
            </p>
            <Button asChild variant="outline" size="sm">
              <Link href="/">Back to the home page</Link>
            </Button>
          </CardContent>
        </Card>
      ) : state.kind === "LAPSED" ? (
        <Card>
          <CardHeader>
            <CardTitle>This request has lapsed</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>
              Nobody answered in time, so the request lapsed on its own. If{" "}
              {state.guestFirstName} still wants to come, ask the person who
              made the booking to add them again.
            </p>
            <Button asChild variant="outline" size="sm">
              <Link href="/">Back to the home page</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <DelegateAskCard state={state} zone={zone} />
      )}
    </div>
  );
}

async function DelegateAskCard({
  state,
  zone,
}: {
  state: Extract<
    Awaited<ReturnType<typeof resolveDelegateConsentPageState>>,
    { kind: "ASK" }
  >;
  /** The club's persisted zone, resolved once by the page above (#3123). */
  zone: ClubTimeZone;
}) {
  const { facts } = state;
  // The booking's own lodge identity, the same source the emails use.
  const emailSettings = await loadEmailMessageSettingsForLodge(facts.lodgeId);

  // Composed by the shared label helper, which also handles the guest rows
  // that legitimately carry no last name — see its own note.
  const guestHeadingName = formatConsentGuestName(facts.guest);

  return (
    <MemberGuestDelegateConsentCard
      bookingId={facts.bookingId}
      guestId={facts.guestId}
      guestFirstName={facts.guest.firstName}
      guestHeadingName={guestHeadingName}
      bookerName={facts.bookerName}
      bookerFirstName={facts.bookerFirstName}
      lodgeName={emailSettings.lodgeName}
      stayLabel={formatConsentStayLabel(facts.checkIn, facts.checkOut)}
      nightsLabel={formatConsentNightsLabel(facts.guestNights)}
      answerByLabel={
        facts.consentExpiresAt
          ? formatConsentFullDate(facts.consentExpiresAt, zone)
          : "—"
      }
      party={facts.party}
      refusalWarning={
        facts.refusalBlocker
          ? describeConsentDeclineRefusal({
              blocker: facts.refusalBlocker,
              voice: { kind: "DELEGATE", guestFirstName: facts.guest.firstName },
              bookerFirstName: facts.bookerFirstName,
            })
          : null
      }
    />
  );
}
