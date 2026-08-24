"use client";

import { useEffect, useState } from "react";
import {
  Check,
  Copy,
  CreditCard,
  Landmark,
  Lock,
  LockOpen,
  Users,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import StripeProvider from "@/components/stripe/StripeProvider";
import PaymentForm from "@/components/stripe/PaymentForm";
import {
  renderClientBookingMessage,
  type BookingMessageClubTokens,
} from "@/lib/booking-message-definitions";
import { formatCents } from "@/lib/utils";
import {
  calendarDateOfSerialisedDbDate,
  formatClubDate,
} from "@/lib/club-time";
import { bookingStatusLabel } from "@/lib/status-colors";

type PaymentMode = "EACH_PAYS_OWN" | "ORGANISER_PAYS";
type GroupStatus = "OPEN" | "CLOSED" | "CANCELLED";
type SettlePaymentMethod = "stripe" | "internet_banking";

interface JoinerRow {
  id: string;
  name: string;
  guestCount: number;
  status: string | null;
  priceCents: number | null;
  isMember: boolean;
}

interface SettlementState {
  status: string;
  amountCents: number;
  paidAt: string | null;
}

export interface OrganiserGroupState {
  code: string;
  status: GroupStatus;
  paymentMode: PaymentMode;
  joinDeadline: string | null;
  maxJoiners: number | null;
  joiners: JoinerRow[];
  settlement: SettlementState | null;
}

const PAYMENT_MODE_LABEL: Record<PaymentMode, string> = {
  EACH_PAYS_OWN: "Each person pays their own beds",
  ORGANISER_PAYS: "You pay for everyone (settle one combined bill)",
};

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          // Clipboard can be unavailable (insecure context); selecting the
          // text manually still works, so fail quietly.
        }
      }}
    >
      {copied ? <Check className="mr-1 h-4 w-4" /> : <Copy className="mr-1 h-4 w-4" />}
      {copied ? "Copied" : label}
    </Button>
  );
}

export function OrganiserGroupBookingCard({
  bookingId,
  canOpenGroup,
  group: initialGroup,
  lodgeName = null,
}: {
  bookingId: string;
  canOpenGroup: boolean;
  group: OrganiserGroupState | null;
  /**
   * The lodge this booking is at (#2919 review), supplied by the server page
   * that renders the card. It stands in for `{{CLUB_LODGE_NAME}}` in the two
   * group messages below, so an organiser at a non-default lodge is not told
   * about the club's default one. Null falls back to the club-level value.
   */
  lodgeName?: string | null;
}) {
  const [group, setGroup] = useState<OrganiserGroupState | null>(initialGroup);

  // Create-group form state.
  const [paymentMode, setPaymentMode] = useState<PaymentMode>("EACH_PAYS_OWN");
  const [joinDeadline, setJoinDeadline] = useState("");
  const [maxJoiners, setMaxJoiners] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  // Management state.
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusError, setStatusError] = useState("");

  // Settlement state.
  const [settleBusy, setSettleBusy] = useState(false);
  const [settleError, setSettleError] = useState("");
  const [settleClientSecret, setSettleClientSecret] = useState<string | null>(null);
  const [settleAmountCents, setSettleAmountCents] = useState<number | null>(null);
  const [settleMessage, setSettleMessage] = useState("");
  const [settleComplete, setSettleComplete] = useState(false);
  const [internetBankingEnabled, setInternetBankingEnabled] = useState(false);
  const [settleMethod, setSettleMethod] = useState<SettlePaymentMethod>("stripe");
  const [settleReference, setSettleReference] = useState<string | null>(null);
  const [bookingMessages, setBookingMessages] = useState<Record<string, string>>({});
  // #2919 review: what this card's message tokens resolve to. Without them an
  // operator's {{CLUB_LODGE_NAME}} reached the organiser as literal braces.
  const [messageTokens, setMessageTokens] =
    useState<BookingMessageClubTokens | null>(null);

  // Internet Banking is an optional module; only offer it when it's on.
  useEffect(() => {
    fetch("/api/payments/options")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) =>
        setInternetBankingEnabled(
          Boolean(data?.methods?.internetBanking?.enabled)
        )
      )
      .catch(() => setInternetBankingEnabled(false));
  }, []);

  useEffect(() => {
    fetch("/api/booking-messages")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        setBookingMessages(data?.messages ?? {});
        setMessageTokens(data?.tokens ?? null);
      })
      .catch(() => {
        setBookingMessages({});
        setMessageTokens(null);
      });
  }, []);

  const [shareUrl, setShareUrl] = useState("");
  useEffect(() => {
    if (group && typeof window !== "undefined") {
      setShareUrl(`${window.location.origin}/join/${group.code}`);
    }
  }, [group]);

  async function openGroup() {
    setCreating(true);
    setCreateError("");
    try {
      const res = await fetch("/api/group-bookings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organiserBookingId: bookingId,
          paymentMode,
          joinDeadline: joinDeadline || null,
          maxJoiners: maxJoiners ? Number(maxJoiners) : null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Unable to open the group right now.");
      }
      setGroup({
        code: data.joinCode,
        status: data.status,
        paymentMode: data.paymentMode,
        joinDeadline: data.joinDeadline,
        maxJoiners: data.maxJoiners,
        joiners: [],
        settlement: null,
      });
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Unable to open the group right now.");
    } finally {
      setCreating(false);
    }
  }

  async function toggleStatus() {
    if (!group) return;
    const action = group.status === "OPEN" ? "close" : "reopen";
    setStatusBusy(true);
    setStatusError("");
    try {
      const res = await fetch(`/api/group-bookings/${encodeURIComponent(group.code)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Unable to update the group right now.");
      }
      setGroup({ ...group, status: data.status });
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : "Unable to update the group right now.");
    } finally {
      setStatusBusy(false);
    }
  }

  async function startSettle() {
    if (!group) return;
    const usingInternetBanking =
      internetBankingEnabled && settleMethod === "internet_banking";
    setSettleBusy(true);
    setSettleError("");
    setSettleMessage("");
    try {
      const res = await fetch(
        `/api/group-bookings/${encodeURIComponent(group.code)}/settle`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            paymentMethod: usingInternetBanking ? "internet_banking" : "stripe",
          }),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Unable to start settlement right now.");
      }
      if (data.outcome === "already_settled") {
        setSettleComplete(true);
        return;
      }
      if (data.outcome === "nothing_to_settle") {
        setSettleMessage("There are no confirmed joiners to settle yet.");
        return;
      }
      // Internet Banking: the combined Xero invoice is emailed; show the
      // bank-transfer reference instead of opening the card flow.
      if (data.outcome === "invoice_sent") {
        setSettleAmountCents(data.amountCents);
        setSettleReference(data.reference ?? null);
        return;
      }
      if (data.outcome === "ready" && data.clientSecret) {
        setSettleAmountCents(data.amountCents);
        setSettleClientSecret(data.clientSecret);
        return;
      }
      throw new Error("Unable to start settlement right now.");
    } catch (err) {
      setSettleError(err instanceof Error ? err.message : "Unable to start settlement right now.");
    } finally {
      setSettleBusy(false);
    }
  }

  // ---- No group yet: offer to open one (owner + eligible booking only) ----
  if (!group) {
    if (!canOpenGroup) return null;
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" /> Invite others to join this trip
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Open this booking up as a group so others can join on the same dates with a
            shareable link. You stay in control of who can join and how it&apos;s paid.
          </p>

          <div className="space-y-1">
            <Label htmlFor="paymentMode">How is it paid?</Label>
            <select
              id="paymentMode"
              className="h-10 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={paymentMode}
              onChange={(e) => setPaymentMode(e.target.value as PaymentMode)}
            >
              <option value="EACH_PAYS_OWN">{PAYMENT_MODE_LABEL.EACH_PAYS_OWN}</option>
              <option value="ORGANISER_PAYS">{PAYMENT_MODE_LABEL.ORGANISER_PAYS}</option>
            </select>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="joinDeadline">Close to new joins after (optional)</Label>
              <Input
                id="joinDeadline"
                type="date"
                value={joinDeadline}
                onChange={(e) => setJoinDeadline(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="maxJoiners">Max joiners (optional)</Label>
              <Input
                id="maxJoiners"
                type="number"
                min={1}
                max={200}
                value={maxJoiners}
                onChange={(e) => setMaxJoiners(e.target.value)}
              />
            </div>
          </div>

          {createError ? (
            <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {createError}
            </div>
          ) : null}

          <Button onClick={openGroup} disabled={creating}>
            {creating ? "Opening..." : "Open group booking"}
          </Button>
        </CardContent>
      </Card>
    );
  }

  // ---- Group exists: management view ----
  const isOrganiserPays = group.paymentMode === "ORGANISER_PAYS";
  const isCancelled = group.status === "CANCELLED";
  const activeJoiners = group.joiners.filter(
    (j) => j.status !== "CANCELLED" && j.status !== "BUMPED"
  );
  const settledAlready =
    settleComplete || group.settlement?.status === "SUCCEEDED";
  const outstandingCents = activeJoiners
    .filter((j) => j.status === "CONFIRMED" || j.status === "PAYMENT_PENDING")
    .reduce((sum, j) => sum + (j.priceCents ?? 0), 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <Users className="h-5 w-5" /> Group booking
          </span>
          <Badge
            variant="outline"
            className={
              group.status === "OPEN"
                ? "border-success-6 bg-success-3 text-success-11"
                : group.status === "CLOSED"
                  ? "border-border bg-muted text-muted-foreground"
                  : "border-danger-6 bg-danger-3 text-danger-11"
            }
          >
            {group.status}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-3 rounded-md border bg-card p-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Join code
            </p>
            <p className="mt-1 font-mono text-2xl font-semibold tracking-widest text-foreground">
              {group.code}
            </p>
          </div>
          {shareUrl ? (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Shareable link
              </p>
              <p className="mt-1 break-all font-mono text-sm text-muted-foreground">{shareUrl}</p>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <CopyButton value={group.code} label="Copy code" />
            {shareUrl ? <CopyButton value={shareUrl} label="Copy link" /> : null}
          </div>
        </div>

        <div className="grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <span className="text-muted-foreground">Payment:</span>{" "}
            {PAYMENT_MODE_LABEL[group.paymentMode]}
          </div>
          {group.joinDeadline ? (
            <div>
              <span className="text-muted-foreground">Closes to joins:</span>{" "}
              {formatClubDate(calendarDateOfSerialisedDbDate(group.joinDeadline))}
            </div>
          ) : null}
          {group.maxJoiners != null ? (
            <div>
              <span className="text-muted-foreground">Max joiners:</span> {group.maxJoiners}
            </div>
          ) : null}
        </div>

        {!isCancelled ? (
          <div className="space-y-2">
            <Button
              type="button"
              variant="outline"
              onClick={toggleStatus}
              disabled={statusBusy}
            >
              {group.status === "OPEN" ? (
                <>
                  <Lock className="mr-1 h-4 w-4" /> Close to new joins
                </>
              ) : (
                <>
                  <LockOpen className="mr-1 h-4 w-4" /> Reopen to new joins
                </>
              )}
            </Button>
            {statusError ? (
              <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {statusError}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">
            Joiners ({activeJoiners.length})
          </p>
          {activeJoiners.length === 0 ? (
            <p className="text-sm text-muted-foreground">No one has joined yet.</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {activeJoiners.map((j) => (
                <li
                  key={j.id}
                  className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                >
                  <span className="text-foreground">
                    {j.name}
                    {j.guestCount > 1 ? (
                      <span className="text-muted-foreground"> · {j.guestCount} guests</span>
                    ) : null}
                    {!j.isMember ? (
                      <span className="text-muted-foreground"> · guest</span>
                    ) : null}
                  </span>
                  <span className="flex items-center gap-2">
                    {j.priceCents != null ? (
                      <span className="text-muted-foreground">{formatCents(j.priceCents)}</span>
                    ) : null}
                    {j.status ? (
                      <Badge variant="outline" className="text-xs">
                        {bookingStatusLabel(j.status)}
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-xs">
                        Awaiting Confirmation
                      </Badge>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {isOrganiserPays ? (
          <div className="space-y-3 rounded-md border border-border p-3">
            <p className="text-sm font-medium text-foreground">Settle the group</p>
            {settledAlready ? (
              <div className="flex items-start gap-2 text-success-11">
                <Check className="h-5 w-5 shrink-0" />
                <p className="text-sm font-medium">
                  Paid in full
                  {group.settlement
                    ? ` — ${formatCents(group.settlement.amountCents)}`
                    : ""}
                  . Everyone in your group is confirmed.
                </p>
              </div>
            ) : settleReference ? (
              <div className="space-y-3">
                <div className="flex items-start gap-2 text-success-11">
                  <Check className="h-5 w-5 shrink-0" />
                  <p className="text-sm font-medium">
                    Invoice emailed
                    {settleAmountCents != null
                      ? ` — ${formatCents(settleAmountCents)}`
                      : ""}
                    .
                  </p>
                </div>
                <p className="text-sm text-muted-foreground">
                  {/* #2919 review: every token this body may carry, not just the
                      payment reference, and this booking's own lodge. */}
                  {renderClientBookingMessage({
                    template:
                      bookingMessages["groupBooking.invoiceSent.description"],
                    fallback:
                      "The organiser invoice has been emailed. The group booking stays confirmed while Xero reconciles the payment.",
                    clubTokens: messageTokens,
                    lodgeName,
                    data: { paymentReference: settleReference },
                  })}
                </p>
                <div className="rounded-md border border-border p-3 text-sm">
                  <p className="font-medium text-foreground">Payment reference</p>
                  <p className="mt-1 font-mono text-foreground">{settleReference}</p>
                </div>
              </div>
            ) : settleClientSecret && settleAmountCents != null ? (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Combined total: <strong>{formatCents(settleAmountCents)}</strong>
                </p>
                {settleComplete ? (
                  <div className="flex items-start gap-2 text-success-11">
                    <Check className="h-5 w-5 shrink-0" />
                    <p className="text-sm font-medium">
                      Payment complete — your group is confirmed.
                    </p>
                  </div>
                ) : (
                  <StripeProvider clientSecret={settleClientSecret}>
                    <PaymentForm
                      amountCents={settleAmountCents}
                      returnUrl={typeof window !== "undefined" ? window.location.href : ""}
                      onSuccess={() => setSettleComplete(true)}
                      onError={(msg) => setSettleError(msg)}
                    />
                  </StripeProvider>
                )}
              </div>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  Pay for every joiner&apos;s beds in one combined payment. Their spots are
                  confirmed and held while you settle.
                  {outstandingCents > 0
                    ? ` Estimated total: ${formatCents(outstandingCents)}.`
                    : ""}
                </p>

                {internetBankingEnabled ? (
                  <div className="space-y-2">
                    <p className="text-sm font-medium text-muted-foreground">
                      How would you like to pay?
                    </p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <button
                        type="button"
                        onClick={() => setSettleMethod("stripe")}
                        className={`flex min-h-16 items-start gap-3 rounded-md border p-3 text-left text-sm ${
                          settleMethod === "stripe"
                            ? "border-info-7 bg-info-3 text-info-11"
                            : "border-border bg-card text-muted-foreground hover:border-border"
                        }`}
                      >
                        <CreditCard className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>
                          <span className="block font-medium">Card</span>
                          <span className="block text-xs opacity-80">
                            Pay now to settle the group.
                          </span>
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setSettleMethod("internet_banking")}
                        className={`flex min-h-16 items-start gap-3 rounded-md border p-3 text-left text-sm ${
                          settleMethod === "internet_banking"
                            ? "border-info-7 bg-info-3 text-info-11"
                            : "border-border bg-card text-muted-foreground hover:border-border"
                        }`}
                      >
                        <Landmark className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>
                          <span className="block font-medium">Internet Banking</span>
                          <span className="block text-xs opacity-80">
                            {renderClientBookingMessage({
                              template:
                                bookingMessages[
                                  "groupBooking.internetBanking.description"
                                ],
                              fallback:
                                "Receive one Xero invoice by email for the organiser-settled group bookings.",
                              clubTokens: messageTokens,
                              lodgeName,
                            })}
                          </span>
                        </span>
                      </button>
                    </div>
                  </div>
                ) : null}

                <Button onClick={startSettle} disabled={settleBusy}>
                  {settleBusy
                    ? "Preparing..."
                    : internetBankingEnabled && settleMethod === "internet_banking"
                      ? "Settle by invoice (emailed)"
                      : "Settle group total"}
                </Button>
                {settleMessage ? (
                  <p className="text-sm text-muted-foreground">{settleMessage}</p>
                ) : null}
              </>
            )}
            {settleError ? (
              <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {settleError}
              </div>
            ) : null}
          </div>
        ) : null}

        {isCancelled ? (
          <p className="text-sm text-muted-foreground">
            This group has been cancelled and is no longer accepting joins.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
