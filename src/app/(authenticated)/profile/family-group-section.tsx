"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Users, UserPlus, Baby, Mail, UserCheck, UserMinus } from "lucide-react";

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

interface FamilyMemberStatus {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: string;
  role: string;
  canLogin: boolean;
  confirmationMode: "self" | "delegated" | "not_allowed";
  canBeBooked: boolean;
  missingFields: string[];
  needsOwnLoginConfirmation: boolean;
  canCurrentUserConfirmDetails: boolean;
  pendingRequestStatus: string | null;
  pendingRequestType: string | null;
  pendingRequests?: Array<{
    id: string;
    type: string;
    status: string;
    familyGroupId: string;
  }>;
  pendingRequestFamilyGroupIds?: string[];
  bookableFamilyGroupIds?: string[];
  action: string | null;
  dateOfBirth: string | null;
}

interface PendingFamilyRequest {
  id: string;
  type: string;
  status: string;
  familyGroupId: string;
  subjectMemberId: string | null;
  invitedMemberId: string | null;
  linkedMemberId: string | null;
  requestedFirstName: string | null;
  requestedLastName: string | null;
}

interface FamilyGroupSectionProps {
  familyGroups: FamilyGroup[];
  canManage?: boolean;
}

function getMemberName(member: { firstName: string; lastName: string }) {
  return `${member.firstName} ${member.lastName}`.trim();
}

function pendingRequestTargetsMember(request: PendingFamilyRequest, memberId: string) {
  return (
    request.subjectMemberId === memberId ||
    request.invitedMemberId === memberId ||
    request.linkedMemberId === memberId
  );
}

function getStatusBadge(
  status?: FamilyMemberStatus,
  groupPendingRequest?: PendingFamilyRequest
) {
  if (!status) return { label: "Unknown", className: "bg-slate-100 text-slate-700" };
  if (groupPendingRequest || status.pendingRequestStatus) {
    return { label: "Pending admin", className: "bg-amber-100 text-amber-800 border-amber-200" };
  }
  if (status.canBeBooked) {
    return { label: "Details confirmed", className: "bg-emerald-100 text-emerald-800 border-emerald-200" };
  }
  if (status.confirmationMode === "not_allowed") {
    const label =
      status.role === "ADMIN"
        ? "Admin account"
        : status.role === "LODGE"
          ? "Lodge account"
          : "No confirmation needed";
    return { label, className: "bg-slate-100 text-slate-700 border-slate-200" };
  }
  if (status.canLogin && status.needsOwnLoginConfirmation) {
    return { label: "Needs own confirmation", className: "bg-blue-100 text-blue-800 border-blue-200" };
  }
  return { label: "Needs details", className: "bg-rose-100 text-rose-800 border-rose-200" };
}

export function FamilyGroupSection({ familyGroups, canManage = false }: FamilyGroupSectionProps) {
  const [showJoinForm, setShowJoinForm] = useState(false);
  const [showInviteForm, setShowInviteForm] = useState<string | null>(null);
  const [showChildForm, setShowChildForm] = useState<string | null>(null);
  const [showAdultForm, setShowAdultForm] = useState<string | null>(null);
  const [detailMemberId, setDetailMemberId] = useState<string | null>(null);
  const [removalMemberId, setRemovalMemberId] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [childFirstName, setChildFirstName] = useState("");
  const [childLastName, setChildLastName] = useState("");
  const [childDob, setChildDob] = useState("");
  const [adultFirstName, setAdultFirstName] = useState("");
  const [adultLastName, setAdultLastName] = useState("");
  const [adultDob, setAdultDob] = useState("");
  const [adultNotes, setAdultNotes] = useState("");
  const [detailsFirstName, setDetailsFirstName] = useState("");
  const [detailsLastName, setDetailsLastName] = useState("");
  const [detailsDob, setDetailsDob] = useState("");
  const [removalNotes, setRemovalNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [familyStatuses, setFamilyStatuses] = useState<FamilyMemberStatus[]>([]);
  const [pendingRequests, setPendingRequests] = useState<PendingFamilyRequest[]>([]);
  const [respondingTo, setRespondingTo] = useState<string | null>(null);

  const statusByMemberId = useMemo(
    () => new Map(familyStatuses.map((status) => [status.id, status])),
    [familyStatuses]
  );

  async function loadFamilyData() {
    const res = await fetch("/api/members/family");
    if (!res.ok) return;
    const data = await res.json();
    setFamilyStatuses(data.familyMembers || []);
    setPendingRequests(data.pendingRequests || []);
  }

  useEffect(() => {
    fetch("/api/members/family/invitations")
      .then((res) => (res.ok ? res.json() : { invitations: [] }))
      .then((data) => setInvitations(data.invitations || []))
      .catch(() => {});
    loadFamilyData().catch(() => {});
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
      await loadFamilyData();
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
      await loadFamilyData();
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
      await loadFamilyData();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAdultRequest(e: React.FormEvent, familyGroupId: string) {
    e.preventDefault();
    setError("");
    setMessage("");
    setSubmitting(true);

    try {
      const res = await fetch("/api/members/family/request-adult", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          familyGroupId,
          firstName: adultFirstName.trim(),
          lastName: adultLastName.trim(),
          dateOfBirth: adultDob,
          notes: adultNotes.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Request failed");
        return;
      }
      setMessage(data.message || "Request submitted");
      setAdultFirstName("");
      setAdultLastName("");
      setAdultDob("");
      setAdultNotes("");
      setShowAdultForm(null);
      await loadFamilyData();
    } finally {
      setSubmitting(false);
    }
  }

  function startDetailsForm(member: { id: string; firstName: string; lastName: string }) {
    const status = statusByMemberId.get(member.id);
    setDetailMemberId(member.id);
    setRemovalMemberId(null);
    setDetailsFirstName(status?.firstName || member.firstName);
    setDetailsLastName(status?.lastName || member.lastName);
    setDetailsDob(status?.dateOfBirth || "");
    setError("");
    setMessage("");
  }

  async function handleDelegatedDetails(e: React.FormEvent, memberId: string) {
    e.preventDefault();
    setError("");
    setMessage("");
    setSubmitting(true);

    try {
      const res = await fetch(`/api/members/family/${memberId}/details`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: detailsFirstName.trim(),
          lastName: detailsLastName.trim(),
          dateOfBirth: detailsDob,
          inheritContactFromSelf: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to save details");
        return;
      }
      setMessage("Family member details confirmed.");
      setDetailMemberId(null);
      setDetailsFirstName("");
      setDetailsLastName("");
      setDetailsDob("");
      await loadFamilyData();
    } finally {
      setSubmitting(false);
    }
  }

  function startRemovalForm(memberId: string) {
    setRemovalMemberId(memberId);
    setDetailMemberId(null);
    setRemovalNotes("");
    setError("");
    setMessage("");
  }

  async function handleRemovalRequest(e: React.FormEvent, familyGroupId: string, memberId: string) {
    e.preventDefault();
    setError("");
    setMessage("");
    setSubmitting(true);

    try {
      const res = await fetch("/api/members/family/request-removal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          familyGroupId,
          memberId,
          notes: removalNotes.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Request failed");
        return;
      }
      setMessage(data.message || "Removal request submitted");
      setRemovalMemberId(null);
      setRemovalNotes("");
      await loadFamilyData();
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
      await loadFamilyData();
    } finally {
      setRespondingTo(null);
    }
  }

  const resetForms = () => {
    setShowInviteForm(null);
    setShowChildForm(null);
    setShowAdultForm(null);
    setShowJoinForm(false);
    setDetailMemberId(null);
    setRemovalMemberId(null);
    setEmail("");
    setChildFirstName("");
    setChildLastName("");
    setChildDob("");
    setAdultFirstName("");
    setAdultLastName("");
    setAdultDob("");
    setAdultNotes("");
    setDetailsFirstName("");
    setDetailsLastName("");
    setDetailsDob("");
    setRemovalNotes("");
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

      {familyGroups.length > 0 ? (
        <div className="space-y-4">
          {familyGroups.map((group) => {
            const groupPendingRequests = pendingRequests.filter(
              (request) => request.familyGroupId === group.id
            );
            return (
              <div key={group.id} className="space-y-3">
                <div className="flex items-center gap-2">
                  <Users className="h-4 w-4 text-indigo-600" />
                  <span className="font-medium">{group.name || "Family Group"}</span>
                </div>

                {groupPendingRequests.length > 0 && (
                  <div className="space-y-2">
                    {groupPendingRequests.map((request) => (
                      <div key={request.id} className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                        This family change is awaiting admin approval.
                        {request.type === "ADULT_REQUEST" && request.requestedFirstName && (
                          <span> Requested adult: {request.requestedFirstName} {request.requestedLastName}.</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {group.members.length > 0 ? (
                  <div className="space-y-2">
                    {group.members.map((member) => {
                      const status = statusByMemberId.get(member.id);
                      const groupPendingRequest = groupPendingRequests.find((request) =>
                        pendingRequestTargetsMember(request, member.id)
                      );
                      const badge = getStatusBadge(status, groupPendingRequest);
                      const memberName = getMemberName(member);
                      const needsMemberDetails = Boolean(
                        status &&
                        status.confirmationMode !== "not_allowed" &&
                        !status.canBeBooked &&
                        !status.pendingRequestStatus &&
                        !groupPendingRequest
                      );
                      const pendingRemoval =
                        groupPendingRequest?.type === "REMOVAL_REQUEST" ||
                        (
                          status?.pendingRequestType === "REMOVAL_REQUEST" &&
                          status.pendingRequestFamilyGroupIds?.includes(group.id)
                        );

                      return (
                        <div key={member.id} className="rounded-lg border border-slate-200 p-3">
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                            <div className="space-y-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-sm font-medium">{memberName}</span>
                                <Badge variant="secondary" className={badge.className}>
                                  {badge.label}
                                </Badge>
                                {status?.canLogin === false && (
                                  <Badge variant="outline">No login</Badge>
                                )}
                              </div>
                              {status && needsMemberDetails && (
                                <p className="text-sm text-slate-600">
                                  {status.canLogin
                                    ? `${member.firstName} has their own login and needs to sign in and confirm their details.`
                                    : `Complete ${member.firstName}'s details before booking them as a member. Because ${member.firstName} does not have their own login, any adult in this family group can do this.`}
                                </p>
                              )}
                              {status?.confirmationMode !== "not_allowed" && status?.missingFields && status.missingFields.length > 0 && (
                                <p className="text-xs text-slate-500">
                                  Missing: {status.missingFields.join(", ")}
                                </p>
                              )}
                            </div>

                            {canManage && (
                              <div className="flex flex-wrap gap-2">
                                {status?.canCurrentUserConfirmDetails && !status.canBeBooked && !status.pendingRequestStatus && !groupPendingRequest && (
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={() => startDetailsForm(member)}
                                  >
                                    <UserCheck className="h-4 w-4 mr-1" />
                                    Complete details
                                  </Button>
                                )}
                                {!pendingRemoval && (
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={() => startRemovalForm(member.id)}
                                  >
                                    <UserMinus className="h-4 w-4 mr-1" />
                                    Request removal
                                  </Button>
                                )}
                              </div>
                            )}
                          </div>

                          {detailMemberId === member.id && (
                            <form onSubmit={(e) => handleDelegatedDetails(e, member.id)} className="mt-3 space-y-3 rounded-md border bg-slate-50 p-3">
                              <div className="grid grid-cols-2 gap-3">
                                <div>
                                  <Label htmlFor={`details-first-${member.id}`}>First Name</Label>
                                  <Input
                                    id={`details-first-${member.id}`}
                                    value={detailsFirstName}
                                    onChange={(e) => setDetailsFirstName(e.target.value)}
                                    required
                                  />
                                </div>
                                <div>
                                  <Label htmlFor={`details-last-${member.id}`}>Last Name</Label>
                                  <Input
                                    id={`details-last-${member.id}`}
                                    value={detailsLastName}
                                    onChange={(e) => setDetailsLastName(e.target.value)}
                                    required
                                  />
                                </div>
                              </div>
                              <div>
                                <Label htmlFor={`details-dob-${member.id}`}>Date of Birth</Label>
                                <Input
                                  id={`details-dob-${member.id}`}
                                  type="date"
                                  value={detailsDob}
                                  onChange={(e) => setDetailsDob(e.target.value)}
                                  required
                                />
                              </div>
                              <div className="flex gap-2">
                                <Button type="submit" size="sm" disabled={submitting}>
                                  {submitting ? "Saving..." : "Save and Confirm"}
                                </Button>
                                <Button type="button" variant="outline" size="sm" onClick={resetForms}>
                                  Cancel
                                </Button>
                              </div>
                            </form>
                          )}

                          {removalMemberId === member.id && (
                            <form onSubmit={(e) => handleRemovalRequest(e, group.id, member.id)} className="mt-3 space-y-3 rounded-md border bg-slate-50 p-3">
                              <div>
                                <Label htmlFor={`removal-notes-${member.id}`}>Context for admin</Label>
                                <Textarea
                                  id={`removal-notes-${member.id}`}
                                  value={removalNotes}
                                  onChange={(e) => setRemovalNotes(e.target.value)}
                                  maxLength={500}
                                  placeholder="Why should this member be removed from this family group?"
                                />
                              </div>
                              <div className="flex gap-2">
                                <Button type="submit" size="sm" disabled={submitting}>
                                  {submitting ? "Submitting..." : "Submit Removal Request"}
                                </Button>
                                <Button type="button" variant="outline" size="sm" onClick={resetForms}>
                                  Cancel
                                </Button>
                              </div>
                            </form>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No other members in this group yet.
                  </p>
                )}

                {canManage && (
                  <div className="flex flex-wrap gap-2">
                    {showInviteForm !== group.id && showChildForm !== group.id && showAdultForm !== group.id && (
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
                          onClick={() => { resetForms(); setShowAdultForm(group.id); }}
                        >
                          <UserPlus className="h-4 w-4 mr-1" />
                          Request Same-email Adult
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

                {showAdultForm === group.id && (
                  <form onSubmit={(e) => handleAdultRequest(e, group.id)} className="space-y-3 rounded-lg border p-4">
                    <p className="text-sm font-medium flex items-center gap-2">
                      <UserPlus className="h-4 w-4" />
                      Request Same-email Adult
                    </p>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label htmlFor="adult-first-name">First Name</Label>
                        <Input
                          id="adult-first-name"
                          value={adultFirstName}
                          onChange={(e) => setAdultFirstName(e.target.value)}
                          required
                        />
                      </div>
                      <div>
                        <Label htmlFor="adult-last-name">Last Name</Label>
                        <Input
                          id="adult-last-name"
                          value={adultLastName}
                          onChange={(e) => setAdultLastName(e.target.value)}
                          required
                        />
                      </div>
                    </div>
                    <div>
                      <Label htmlFor="adult-dob">Date of Birth</Label>
                      <Input
                        id="adult-dob"
                        type="date"
                        value={adultDob}
                        onChange={(e) => setAdultDob(e.target.value)}
                        required
                      />
                    </div>
                    <div>
                      <Label htmlFor="adult-notes">Notes for admin</Label>
                      <Textarea
                        id="adult-notes"
                        value={adultNotes}
                        onChange={(e) => setAdultNotes(e.target.value)}
                        maxLength={500}
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
            );
          })}
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
