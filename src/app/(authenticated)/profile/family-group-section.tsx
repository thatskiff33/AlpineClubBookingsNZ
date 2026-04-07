"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Users, UserPlus, Baby, Mail } from "lucide-react";

interface FamilyGroup {
  id: string;
  name: string | null;
  members: { id: string; firstName: string; lastName: string }[];
}

interface Invitation {
  id: string;
  familyGroup: { id: string; name: string };
  requester: { id: string; firstName: string; lastName: string };
}

interface FamilyGroupSectionProps {
  familyGroups: FamilyGroup[];
  canManage?: boolean;
}

export function FamilyGroupSection({ familyGroups, canManage = false }: FamilyGroupSectionProps) {
  const [showJoinForm, setShowJoinForm] = useState(false);
  const [showInviteForm, setShowInviteForm] = useState<string | null>(null);
  const [showChildForm, setShowChildForm] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [childFirstName, setChildFirstName] = useState("");
  const [childLastName, setChildLastName] = useState("");
  const [childDob, setChildDob] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [respondingTo, setRespondingTo] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/members/family/invitations")
      .then((res) => (res.ok ? res.json() : { invitations: [] }))
      .then((data) => setInvitations(data.invitations || []))
      .catch(() => {});
  }, []);

  async function handleRequestJoin(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setMessage("");
    setSubmitting(true);

    try {
      const res = await fetch("/api/members/family/request-join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetEmail: email.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Request failed");
        return;
      }
      setMessage(data.message || "Request submitted successfully");
      setEmail("");
      setShowJoinForm(false);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleInvite(e: React.FormEvent, familyGroupId: string) {
    e.preventDefault();
    setError("");
    setMessage("");
    setSubmitting(true);

    try {
      const res = await fetch("/api/members/family/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), familyGroupId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Invitation failed");
        return;
      }
      setMessage(data.message || "Invitation sent");
      setEmail("");
      setShowInviteForm(null);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleChildRequest(e: React.FormEvent, familyGroupId: string) {
    e.preventDefault();
    setError("");
    setMessage("");
    setSubmitting(true);

    try {
      const body: Record<string, string> = {
        familyGroupId,
        firstName: childFirstName.trim(),
        lastName: childLastName.trim(),
      };
      if (childDob) body.dateOfBirth = childDob;

      const res = await fetch("/api/members/family/request-child", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Request failed");
        return;
      }
      setMessage(data.message || "Request submitted");
      setChildFirstName("");
      setChildLastName("");
      setChildDob("");
      setShowChildForm(null);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleInvitationResponse(invitationId: string, action: "accept" | "decline") {
    setRespondingTo(invitationId);
    setError("");
    setMessage("");

    try {
      const res = await fetch("/api/members/family/invitations", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invitationId, action }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Response failed");
        return;
      }
      setMessage(data.message || `Invitation ${action}ed`);
      setInvitations((prev) => prev.filter((inv) => inv.id !== invitationId));
    } finally {
      setRespondingTo(null);
    }
  }

  const resetForms = () => {
    setShowInviteForm(null);
    setShowChildForm(null);
    setShowJoinForm(false);
    setEmail("");
    setChildFirstName("");
    setChildLastName("");
    setChildDob("");
    setError("");
  };

  return (
    <div className="space-y-4">
      {message && (
        <div className="p-2 bg-green-50 border border-green-200 text-green-700 rounded text-sm">
          {message}
        </div>
      )}
      {error && (
        <div className="p-2 bg-red-50 border border-red-200 text-red-700 rounded text-sm">
          {error}
        </div>
      )}

      {/* Pending invitations */}
      {invitations.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium">Pending Invitations</p>
          {invitations.map((inv) => (
            <div key={inv.id} className="flex items-center justify-between rounded-lg border border-indigo-200 bg-indigo-50 p-3">
              <div>
                <p className="text-sm font-medium">
                  {inv.requester.firstName} {inv.requester.lastName} invited you to join{" "}
                  <span className="text-indigo-700">{inv.familyGroup.name}</span>
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={respondingTo === inv.id}
                  onClick={() => handleInvitationResponse(inv.id, "accept")}
                >
                  Accept
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={respondingTo === inv.id}
                  onClick={() => handleInvitationResponse(inv.id, "decline")}
                >
                  Decline
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Existing groups */}
      {familyGroups.length > 0 ? (
        <div className="space-y-4">
          {familyGroups.map((group) => (
            <div key={group.id} className="space-y-3">
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4 text-indigo-600" />
                <span className="font-medium">{group.name || "Family Group"}</span>
              </div>
              {group.members.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {group.members.map((m) => (
                    <Badge key={m.id} variant="secondary" className="bg-indigo-50 text-indigo-700 border-indigo-200">
                      {m.firstName} {m.lastName}
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No other members in this group yet.
                </p>
              )}

              {/* Action buttons for adults */}
              {canManage && (
                <div className="flex gap-2">
                  {showInviteForm !== group.id && showChildForm !== group.id && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => { resetForms(); setShowInviteForm(group.id); }}
                      >
                        <UserPlus className="h-4 w-4 mr-1" />
                        Invite Adult
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => { resetForms(); setShowChildForm(group.id); }}
                      >
                        <Baby className="h-4 w-4 mr-1" />
                        Request to Add Child/Youth
                      </Button>
                    </>
                  )}
                </div>
              )}

              {/* Invite adult form */}
              {showInviteForm === group.id && (
                <form onSubmit={(e) => handleInvite(e, group.id)} className="space-y-3 rounded-lg border p-4">
                  <p className="text-sm font-medium flex items-center gap-2">
                    <Mail className="h-4 w-4" />
                    Invite an Adult Member
                  </p>
                  <div>
                    <Label htmlFor="invite-email">Email address of an existing member</Label>
                    <Input
                      id="invite-email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="member@example.com"
                      required
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      They must already be a registered member. They will be able to accept or decline.
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button type="submit" size="sm" disabled={submitting}>
                      {submitting ? "Sending..." : "Send Invitation"}
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={resetForms}>
                      Cancel
                    </Button>
                  </div>
                </form>
              )}

              {/* Request child/youth form */}
              {showChildForm === group.id && (
                <form onSubmit={(e) => handleChildRequest(e, group.id)} className="space-y-3 rounded-lg border p-4">
                  <p className="text-sm font-medium flex items-center gap-2">
                    <Baby className="h-4 w-4" />
                    Request to Add Child/Youth
                  </p>
                  <p className="text-xs text-muted-foreground">
                    An admin will review your request and link them to an existing member record.
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label htmlFor="child-first-name">First Name</Label>
                      <Input
                        id="child-first-name"
                        value={childFirstName}
                        onChange={(e) => setChildFirstName(e.target.value)}
                        required
                      />
                    </div>
                    <div>
                      <Label htmlFor="child-last-name">Last Name</Label>
                      <Input
                        id="child-last-name"
                        value={childLastName}
                        onChange={(e) => setChildLastName(e.target.value)}
                        required
                      />
                    </div>
                  </div>
                  <div>
                    <Label htmlFor="child-dob">Date of Birth (optional)</Label>
                    <Input
                      id="child-dob"
                      type="date"
                      value={childDob}
                      onChange={(e) => setChildDob(e.target.value)}
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button type="submit" size="sm" disabled={submitting}>
                      {submitting ? "Submitting..." : "Submit Request"}
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={resetForms}>
                      Cancel
                    </Button>
                  </div>
                </form>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            You are not currently in a family group. Request to join another member&apos;s group, or wait for an invitation.
          </p>
          {canManage && !showJoinForm && (
            <Button variant="outline" size="sm" onClick={() => setShowJoinForm(true)}>
              <Users className="h-4 w-4 mr-2" />
              Request to Join a Family Group
            </Button>
          )}
          {showJoinForm && (
            <form onSubmit={handleRequestJoin} className="space-y-3">
              <div>
                <Label htmlFor="partnerEmail">Member&apos;s email address</Label>
                <Input
                  id="partnerEmail"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="member@example.com"
                  required
                />
                <p className="text-xs text-muted-foreground mt-1">
                  An admin will review and approve your request.
                </p>
              </div>
              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={submitting}>
                  {submitting ? "Submitting..." : "Send Request"}
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={resetForms}>
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
