"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useActionFocusReturn } from "@/hooks/use-scroll-to-feedback";
import { FieldHint, useFieldHint } from "@/components/ui/field-hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { HeartHandshake } from "lucide-react";
import type {
  MemberPartnerLinkStateResponse,
  SerializedPartnerLinkMember,
} from "@/lib/partner-link-views";

interface PartnerLinkSectionProps {
  canManage?: boolean;
}

function partnerName(partner: { firstName: string; lastName: string }) {
  return `${partner.firstName} ${partner.lastName}`.trim();
}

/**
 * Member self-service for the declared Partner/Husband/Wife relationship
 * (#1742): request by email, respond to requests, withdraw, and remove.
 * Family-group admins can also declare a no-login family member directly
 * (the "one login manages the family" one-step flow).
 */
export function PartnerLinkSection({ canManage = false }: PartnerLinkSectionProps) {
  const [state, setState] = useState<MemberPartnerLinkStateResponse | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [email, setEmail] = useState("");
  const [selectedMemberId, setSelectedMemberId] = useState("");
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const focusReturn = useActionFocusReturn();
  // #2264 — same treatment and same wording as the family-group email boxes:
  // the example moves under the field and folds into the note already there.
  const partnerEmailHint = useFieldHint();

  async function loadState() {
    try {
      const res = await fetch("/api/members/partner-link");
      if (!res.ok) {
        setLoadFailed(true);
        return;
      }
      setState(await res.json());
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }

  useEffect(() => {
    loadState();
  }, []);

  async function callApi(input: RequestInfo, init: RequestInit) {
    setError("");
    focusReturn.capture();
    setSubmitting(true);
    try {
      const res = await fetch(input, init);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Request failed");
        return false;
      }
      toast.success(data.message || "Done");
      await loadState();
      return true;
    } catch {
      setError("Request failed. Check your connection and try again.");
      return false;
    } finally {
      setSubmitting(false);
      focusReturn.release();
    }
  }

  async function handleRequest(e: React.FormEvent) {
    e.preventDefault();
    const body = selectedMemberId
      ? { memberId: selectedMemberId }
      : { email: email.trim() };
    const ok = await callApi("/api/members/partner-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (ok) {
      setEmail("");
      setSelectedMemberId("");
    }
  }

  async function handleRespond(linkId: string, action: "accept" | "decline") {
    await callApi("/api/members/partner-link", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ linkId, action }),
    });
  }

  async function handleRemove(linkId: string) {
    const ok = await callApi(`/api/members/partner-link?id=${encodeURIComponent(linkId)}`, {
      method: "DELETE",
    });
    if (ok) setShowRemoveConfirm(false);
  }

  async function handleCancelInvite(inviteTokenId: string) {
    await callApi(
      `/api/members/partner-link?inviteTokenId=${encodeURIComponent(inviteTokenId)}`,
      { method: "DELETE" }
    );
  }

  if (!state) {
    return loadFailed ? (
      <p className="text-sm text-muted-foreground">
        Could not load your partner details. Refresh the page to try again.
      </p>
    ) : (
      <p className="text-sm text-muted-foreground">Loading…</p>
    );
  }

  const familyCandidates: SerializedPartnerLinkMember[] = state.oneStepCandidates ?? [];
  const canRequest =
    canManage && !state.confirmed && state.pendingOutgoing.length === 0;

  return (
    <div className="space-y-4">
      {error && (
        <div className="p-2 bg-danger-3 border border-danger-6 text-danger-11 rounded text-sm">
          {error}
        </div>
      )}

      {state.pendingIncoming.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium">Partner Requests</p>
          {state.pendingIncoming.map((link) => (
            <div
              key={link.id}
              className="flex items-center justify-between rounded-lg border border-cat3-6 bg-cat3-3 p-3"
            >
              <p className="text-sm font-medium">
                {partnerName(link.partner)} has asked to record you as their partner
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={submitting}
                  onClick={() => handleRespond(link.id, "accept")}
                >
                  Confirm
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={submitting}
                  onClick={() => handleRespond(link.id, "decline")}
                >
                  Decline
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {state.confirmed && (
        <div className="rounded-lg border p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <HeartHandshake className="h-4 w-4 text-cat3-11" />
              <span className="font-medium">{partnerName(state.confirmed.partner)}</span>
              <Badge className="bg-success-3 text-success-11 border-success-6">
                Confirmed partner
              </Badge>
            </div>
            {canManage && !showRemoveConfirm && (
              <Button
                variant="outline"
                size="sm"
                disabled={submitting}
                onClick={() => setShowRemoveConfirm(true)}
              >
                Remove
              </Button>
            )}
          </div>
          {showRemoveConfirm && (
            <div className="flex items-center justify-between rounded-md border border-danger-6 bg-danger-3 p-2">
              <p className="text-sm text-danger-11">
                Remove this partner relationship? {partnerName(state.confirmed.partner)} will
                be notified.
              </p>
              <div className="flex gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={submitting}
                  onClick={() => handleRemove(state.confirmed!.id)}
                >
                  Confirm removal
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={submitting}
                  onClick={() => setShowRemoveConfirm(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {state.pendingOutgoing.map((link) => (
        <div
          key={link.id}
          className="flex items-center justify-between rounded-lg border border-warning-6 bg-warning-3 p-3"
        >
          <p className="text-sm text-warning-11">
            Waiting for {partnerName(link.partner)} to confirm your partner request.
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={submitting}
            onClick={() => handleRemove(link.id)}
          >
            Withdraw
          </Button>
        </div>
      ))}

      {state.pendingPartnerInvite && !state.confirmed && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-warning-6 bg-warning-3 p-3">
          <p className="text-sm text-warning-11">
            Waiting for <strong>{state.pendingPartnerInvite.invitedEmail}</strong> to
            join and accept your invitation — accepting will record them as your
            partner.
            {!canManage &&
              " Contact an admin if you need to cancel the invitation."}
          </p>
          {canManage && (
            <Button
              variant="outline"
              size="sm"
              disabled={submitting}
              onClick={() => handleCancelInvite(state.pendingPartnerInvite!.id)}
            >
              Cancel invitation
            </Button>
          )}
        </div>
      )}

      {!state.confirmed &&
        state.pendingIncoming.length === 0 &&
        state.pendingOutgoing.length === 0 &&
        !state.pendingPartnerInvite && (
          <p className="text-sm text-muted-foreground">
            No partner recorded. {canManage ? "You can declare your partner below — they confirm the relationship from their profile." : ""}
          </p>
        )}

      {canRequest && (
        <form onSubmit={handleRequest} className="space-y-3 rounded-md border bg-muted p-3">
          <p className="text-sm font-medium">Declare your partner</p>
          <div>
            <Label htmlFor="partner-link-email">Partner&apos;s email address</Label>
            <Input
              id="partner-link-email"
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (e.target.value) setSelectedMemberId("");
              }}
              disabled={Boolean(selectedMemberId)}
              {...partnerEmailHint.fieldProps}
            />
            <FieldHint {...partnerEmailHint.hintProps} className="mt-1">
              Example: member@example.com. They must be a registered adult member
              with a login; they confirm the relationship from their profile.
            </FieldHint>
          </div>
          {familyCandidates.length > 0 && (
            <div>
              <Label htmlFor="partner-link-family-member">
                Or select a family member without a login
              </Label>
              <Select
                value={selectedMemberId || undefined}
                onValueChange={(value) => {
                  setSelectedMemberId(value);
                  setEmail("");
                }}
              >
                <SelectTrigger id="partner-link-family-member">
                  <SelectValue placeholder="Select family member" />
                </SelectTrigger>
                <SelectContent>
                  {familyCandidates.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {partnerName(candidate)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">
                As their family group&apos;s admin you can declare this directly — they
                have no login of their own to confirm with, so they&apos;ll be notified
                by email instead.
              </p>
            </div>
          )}
          <div className="flex gap-2">
            <Button
              type="submit"
              size="sm"
              disabled={submitting || (!email.trim() && !selectedMemberId)}
            >
              {submitting ? "Sending…" : "Send partner request"}
            </Button>
            {selectedMemberId && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setSelectedMemberId("")}
              >
                Clear selection
              </Button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
