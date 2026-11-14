"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FieldHint, useFieldHint } from "@/components/ui/field-hint";
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
  parentLinks?: Array<{
    id: string;
    firstName: string;
    lastName: string;
    parentLinkType: "PRIMARY" | "SECONDARY";
    /** The parent's own already-flattened source, when they inherit too. */
    inheritEmailFromId?: string | null;
  }>;
  notificationEmailFromId?: string | null;
  /**
   * #2255: the name behind `notificationEmailFromId` when it is somebody other
   * than a listed parent. Null when a parent marker already covers it.
   */
  notificationEmailFromName?: string | null;
  /**
   * #2284 (S3): read-only provenance for a delegated details confirmation — who
   * last confirmed this member's details on their behalf, and when. Null when
   * the member confirmed their own details or nothing was confirmed.
   */
  detailsConfirmedBy?: { name: string; at: string | null } | null;
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

interface MyPendingCreateRequest {
  id: string;
  familyGroupId: string;
  groupName: string | null;
  partner: { id: string; firstName: string; lastName: string; email: string } | null;
  pendingChildRequests: Array<{
    id: string;
    firstName: string | null;
    lastName: string | null;
  }>;
}

interface CreateChildRow {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
}

const MAX_CREATE_GROUP_CHILDREN = 6;

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
  if (!status) return { label: "Unknown", className: "bg-muted text-foreground" };
  if (groupPendingRequest || status.pendingRequestStatus) {
    return { label: "Pending admin", className: "border-warning/20 bg-warning-muted text-warning" };
  }
  if (status.canBeBooked) {
    return { label: "Details confirmed", className: "border-success/20 bg-success-muted text-success" };
  }
  if (status.confirmationMode === "not_allowed") {
    const label =
      status.role === "ADMIN"
        ? "Admin account"
        : status.role === "LODGE"
          ? "Lodge account"
          : "No confirmation needed";
    return { label, className: "border-border bg-muted text-foreground" };
  }
  if (status.canLogin && status.needsOwnLoginConfirmation) {
    return { label: "Needs own confirmation", className: "border-info/20 bg-info-muted text-info" };
  }
  return { label: "Needs details", className: "border-danger/20 bg-danger-muted text-danger" };
}

export function FamilyGroupSection({ familyGroups, canManage = false }: FamilyGroupSectionProps) {
  const [showJoinForm, setShowJoinForm] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createGroupName, setCreateGroupName] = useState("");
  // #2257 — the suggested group name lives UNDER the field, not inside it: a
  // grey "Smith Family" in the box reads as a name the form has already taken.
  const createGroupNameHint = useFieldHint();
  /*
    #2264 — the three "member@example.com" boxes. Each already carried a muted
    note beneath it, so the example is folded INTO that note rather than stacked
    below as a second near-identical line. The hooks are declared here, at the
    top of the component, not inside the family-group `.map()`: only one invite
    form is ever open (`showInviteForm` holds a single group id), exactly as the
    static `id="invite-email"` beside it already assumes.
  */
  const inviteEmailHint = useFieldHint();
  const joinEmailHint = useFieldHint();
  const createPartnerEmailHint = useFieldHint();
  const [createPartnerEmail, setCreatePartnerEmail] = useState("");
  const [createDeclarePartner, setCreateDeclarePartner] = useState(false);
  const [createChildren, setCreateChildren] = useState<CreateChildRow[]>([]);
  const [myPendingCreateRequest, setMyPendingCreateRequest] =
    useState<MyPendingCreateRequest | null>(null);
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
    setMyPendingCreateRequest(data.myPendingCreateRequest || null);
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
      toast.success(data.message || "Request submitted successfully");
      setEmail("");
      setShowJoinForm(false);
      await loadFamilyData();
    } finally {
      setSubmitting(false);
    }
  }

  function addCreateChildRow() {
    setCreateChildren((prev) =>
      prev.length >= MAX_CREATE_GROUP_CHILDREN
        ? prev
        : [...prev, { firstName: "", lastName: "", dateOfBirth: "" }]
    );
  }

  function removeCreateChildRow(index: number) {
    setCreateChildren((prev) => prev.filter((_, rowIndex) => rowIndex !== index));
  }

  function updateCreateChildRow(index: number, field: keyof CreateChildRow, value: string) {
    setCreateChildren((prev) =>
      prev.map((row, rowIndex) => (rowIndex === index ? { ...row, [field]: value } : row))
    );
  }

  async function handleCreateGroup(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSubmitting(true);

    try {
      const res = await fetch("/api/members/family/create-group", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          groupName: createGroupName.trim() || undefined,
          partnerEmail: createPartnerEmail.trim() || undefined,
          declarePartnerLink: Boolean(createPartnerEmail.trim()) && createDeclarePartner,
          children: createChildren.map((child) => ({
            firstName: child.firstName.trim(),
            lastName: child.lastName.trim(),
            dateOfBirth: child.dateOfBirth,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Request failed");
        return;
      }
      toast.success(data.message || "Request submitted");
      setShowCreateForm(false);
      setCreateGroupName("");
      setCreatePartnerEmail("");
      setCreateDeclarePartner(false);
      setCreateChildren([]);
      await loadFamilyData();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleInvite(e: React.FormEvent, familyGroupId: string) {
    e.preventDefault();
    setError("");
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
      toast.success(data.message || "Invitation sent");
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
    setSubmitting(true);

    try {
      const body: Record<string, string> = {
        familyGroupId,
        firstName: childFirstName.trim(),
        lastName: childLastName.trim(),
        dateOfBirth: childDob,
      };

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
      toast.success(data.message || "Request submitted");
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
      toast.success(data.message || "Request submitted");
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
  }

  async function handleDelegatedDetails(e: React.FormEvent, memberId: string) {
    e.preventDefault();
    setError("");
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
      toast.success("Family member details confirmed.");
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
  }

  async function handleRemovalRequest(e: React.FormEvent, familyGroupId: string, memberId: string) {
    e.preventDefault();
    setError("");
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
      toast.success(data.message || "Removal request submitted");
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
      toast.success(data.message || `Invitation ${action}ed`);
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
    setShowCreateForm(false);
    setCreateGroupName("");
    setCreatePartnerEmail("");
    setCreateDeclarePartner(false);
    setCreateChildren([]);
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
      {error && (
        <div className="rounded border border-danger/20 bg-danger-muted p-2 text-sm text-danger">
          {error}
        </div>
      )}

      {invitations.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium">Pending Invitations</p>
          {invitations.map((inv) => (
            <div key={inv.id} className="flex flex-col gap-3 rounded-lg border border-info/20 bg-info-muted p-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium">
                  {inv.requester.firstName} {inv.requester.lastName} invited you to join{" "}
                  <span className="text-info">{inv.familyGroup.name}</span>
                </p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
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
                  <Users className="h-4 w-4 text-info" />
                  <span className="font-medium">{group.name || "Family Group"}</span>
                </div>

                {groupPendingRequests.length > 0 && (
                  <div className="space-y-2">
                    {groupPendingRequests.map((request) => (
                      <div key={request.id} className="rounded-md border border-warning/20 bg-warning-muted p-3 text-sm text-warning">
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
                        <div key={member.id} className="rounded-lg border border-border p-3">
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
                                <p className="text-sm text-muted-foreground">
                                  {status.canLogin
                                    ? `${member.firstName} has their own login and needs to sign in and confirm their details.`
                                    : `Complete ${member.firstName}'s details before booking them as a member. Because ${member.firstName} does not have their own login, any adult in this family group can do this.`}
                                </p>
                              )}
                              {status?.confirmationMode !== "not_allowed" && status?.missingFields && status.missingFields.length > 0 && (
                                <p className="text-xs text-muted-foreground">
                                  Missing: {status.missingFields.join(", ")}
                                </p>
                              )}
                              {status?.parentLinks && status.parentLinks.length > 0 && (
                                <p className="text-xs text-muted-foreground">
                                  Parents: {status.parentLinks.map((parent) => {
                                    const label = `${parent.firstName} ${parent.lastName}`.trim();
                                    return parent.id === status.notificationEmailFromId ||
                                      parent.inheritEmailFromId === status.notificationEmailFromId
                                      ? `${label} (notifications)`
                                      : label;
                                  }).join(", ")}
                                </p>
                              )}
                              {/* #2255: the marker above only fires for a LISTED parent.
                                  Family links now run to four generations and the
                                  notification address is resolved by walking up past any
                                  generation without one, so the mailbox is often a
                                  grandparent who is not in that list — and this is the
                                  family whose consent is at stake, so it is said plainly
                                  rather than left to be inferred from a missing marker. */}
                              {status?.notificationEmailFromName && (
                                <p className="text-xs text-muted-foreground">
                                  Club email for {member.firstName} goes to{" "}
                                  {status.notificationEmailFromName}.
                                </p>
                              )}
                              {/* #2284 (S3): a delegated details edit was
                                  audited but never shown to the family. This
                                  read-only line closes that gap — it names who
                                  confirmed this member's details on their behalf
                                  and when. */}
                              {status?.detailsConfirmedBy && (
                                <p className="text-xs text-muted-foreground">
                                  Details last confirmed by{" "}
                                  {status.detailsConfirmedBy.name}
                                  {status.detailsConfirmedBy.at
                                    ? ` on ${status.detailsConfirmedBy.at}`
                                    : ""}
                                  .
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
                            <form onSubmit={(e) => handleDelegatedDetails(e, member.id)} className="mt-3 space-y-3 rounded-md border bg-muted p-3">
                              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
                              <div className="flex flex-col gap-2 sm:flex-row">
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
                            <form onSubmit={(e) => handleRemovalRequest(e, group.id, member.id)} className="mt-3 space-y-3 rounded-md border bg-muted p-3">
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
                              <div className="flex flex-col gap-2 sm:flex-row">
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
                          Request to Add Infant/Child/Youth
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
                        required
                        {...inviteEmailHint.fieldProps}
                      />
                      <FieldHint {...inviteEmailHint.hintProps} className="mt-1">
                        Example: member@example.com. They must already be a registered member. They will be able to accept or decline.
                      </FieldHint>
                    </div>
                    <div className="flex flex-col gap-2 sm:flex-row">
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
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
                    <div className="flex flex-col gap-2 sm:flex-row">
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
                      Request to Add Infant/Child/Youth
                    </p>
                    <p className="text-xs text-muted-foreground">
                      An admin will review your request and either link an existing member record or create an eligible non-login dependant.
                    </p>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
                      <Label htmlFor="child-dob">Date of Birth</Label>
                      <Input
                        id="child-dob"
                        type="date"
                        value={childDob}
                        onChange={(e) => setChildDob(e.target.value)}
                        required
                      />
                    </div>
                    <div className="flex flex-col gap-2 sm:flex-row">
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
      ) : myPendingCreateRequest ? (
        <div className="space-y-1 rounded-md border border-warning/20 bg-warning-muted p-3 text-sm text-warning">
          <p className="font-medium">Your family group request is awaiting admin review.</p>
          <p>Requested group: {myPendingCreateRequest.groupName || "Unnamed Group"}</p>
          {myPendingCreateRequest.partner && (
            <p>
              Partner to invite:{" "}
              {getMemberName(myPendingCreateRequest.partner)}{" "}
              ({myPendingCreateRequest.partner.email})
            </p>
          )}
          {myPendingCreateRequest.pendingChildRequests.length > 0 && (
            <p>
              Infant/child/youth requests:{" "}
              {myPendingCreateRequest.pendingChildRequests
                .map((child) => [child.firstName, child.lastName].filter(Boolean).join(" "))
                .join(", ")}
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            You are not currently in a family group. Request to join another member&apos;s group, create a new family group, or wait for an invitation.
          </p>
          {canManage && !showJoinForm && !showCreateForm && (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => setShowJoinForm(true)}>
                <Users className="h-4 w-4 mr-2" />
                Request to Join a Family Group
              </Button>
              <Button variant="outline" size="sm" onClick={() => setShowCreateForm(true)}>
                <UserPlus className="h-4 w-4 mr-2" />
                Create a Family Group
              </Button>
            </div>
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
                  required
                  {...joinEmailHint.fieldProps}
                />
                <FieldHint {...joinEmailHint.hintProps} className="mt-1">
                  Example: member@example.com. An admin will review and approve your request.
                </FieldHint>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button type="submit" size="sm" disabled={submitting}>
                  {submitting ? "Submitting..." : "Send Request"}
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={resetForms}>
                  Cancel
                </Button>
              </div>
            </form>
          )}
          {showCreateForm && (
            <form onSubmit={handleCreateGroup} className="space-y-3 rounded-lg border p-4">
              <p className="text-sm font-medium flex items-center gap-2">
                <Users className="h-4 w-4" />
                Create a Family Group
              </p>
              <p className="text-xs text-muted-foreground">
                An admin will review your request before the group is created.
              </p>
              <div>
                <Label htmlFor="create-group-name">Group name (optional)</Label>
                <Input
                  id="create-group-name"
                  value={createGroupName}
                  onChange={(e) => setCreateGroupName(e.target.value)}
                  maxLength={100}
                  {...createGroupNameHint.fieldProps}
                />
                <FieldHint {...createGroupNameHint.hintProps}>
                  Example:{" "}
                  {familyStatuses[0]?.lastName
                    ? `${familyStatuses[0].lastName} Family`
                    : "Smith Family"}
                </FieldHint>
              </div>
              <div>
                <Label htmlFor="create-partner-email">Partner&apos;s email address (optional)</Label>
                <Input
                  id="create-partner-email"
                  type="email"
                  value={createPartnerEmail}
                  onChange={(e) => {
                    setCreatePartnerEmail(e.target.value);
                    // The declared-partner checkbox belongs to a specific
                    // address; clearing the field discards the declaration so
                    // it cannot silently carry over to a different person.
                    if (!e.target.value.trim()) {
                      setCreateDeclarePartner(false);
                    }
                  }}
                  {...createPartnerEmailHint.fieldProps}
                />
                <FieldHint {...createPartnerEmailHint.hintProps} className="mt-1">
                  Example: member@example.com. A registered member is invited once your group is approved. If they are not a member yet, we&apos;ll email them a link to join and be added to your group.
                </FieldHint>
                {createPartnerEmail.trim() && (
                  <div className="mt-2 flex items-start gap-2">
                    <Checkbox
                      id="create-declare-partner"
                      checked={createDeclarePartner}
                      onCheckedChange={(checked) => setCreateDeclarePartner(checked === true)}
                    />
                    <div>
                      <Label htmlFor="create-declare-partner" className="font-normal">
                        This person is my partner (husband, wife, or partner)
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        Also records your partner relationship with the club. A
                        registered member confirms it from their profile; someone
                        joining via the emailed link confirms it by accepting.
                      </p>
                    </div>
                  </div>
                )}
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium">Infants, children, and youth (optional)</p>
                {createChildren.map((child, index) => (
                  <div key={index} className="space-y-3 rounded-md border bg-muted p-3">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div>
                        <Label htmlFor={`create-child-first-${index}`}>First Name</Label>
                        <Input
                          id={`create-child-first-${index}`}
                          value={child.firstName}
                          onChange={(e) => updateCreateChildRow(index, "firstName", e.target.value)}
                          required
                        />
                      </div>
                      <div>
                        <Label htmlFor={`create-child-last-${index}`}>Last Name</Label>
                        <Input
                          id={`create-child-last-${index}`}
                          value={child.lastName}
                          onChange={(e) => updateCreateChildRow(index, "lastName", e.target.value)}
                          required
                        />
                      </div>
                    </div>
                    <div>
                      <Label htmlFor={`create-child-dob-${index}`}>Date of Birth</Label>
                      <Input
                        id={`create-child-dob-${index}`}
                        type="date"
                        value={child.dateOfBirth}
                        onChange={(e) => updateCreateChildRow(index, "dateOfBirth", e.target.value)}
                        required
                      />
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => removeCreateChildRow(index)}
                    >
                      Remove
                    </Button>
                  </div>
                ))}
                {createChildren.length < MAX_CREATE_GROUP_CHILDREN && (
                  <Button type="button" variant="outline" size="sm" onClick={addCreateChildRow}>
                    <Baby className="h-4 w-4 mr-1" />
                    Add Infant/Child/Youth
                  </Button>
                )}
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
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
      )}
    </div>
  );
}
