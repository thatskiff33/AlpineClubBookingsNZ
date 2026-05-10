"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  Clock,
  Loader2,
  RefreshCw,
  UserCheck,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { ProfileForm } from "@/app/(authenticated)/profile/profile-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface MissingField {
  key: string;
  label: string;
}

interface OnboardingStatus {
  isProfileComplete: boolean;
  isDetailsConfirmed: boolean;
  canBeBookedAsMember: boolean;
  missingFields: string[];
  missingFieldDetails: MissingField[];
  needsOwnLoginConfirmation: boolean;
  confirmationMode: "self" | "delegated" | "not_allowed";
  hasCompletedOnboarding: boolean;
  needsOnboardingConfirmation: boolean;
  requiresWizard: boolean;
}

interface ProfileFormMember {
  id: string;
  firstName: string;
  lastName: string;
  phoneCountryCode: string;
  phoneAreaCode: string;
  phoneNumber: string;
  dateOfBirth: string;
  streetAddressLine1: string;
  streetAddressLine2: string;
  streetCity: string;
  streetRegion: string;
  streetPostalCode: string;
  streetCountry: string;
  postalAddressLine1: string;
  postalAddressLine2: string;
  postalCity: string;
  postalRegion: string;
  postalPostalCode: string;
  postalCountry: string;
}

interface FamilyMember {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  ageTier: string;
  active: boolean;
  canLogin: boolean;
  isCurrentUser: boolean;
  groupRole: string;
  status: OnboardingStatus;
  nextAction:
    | "current_user"
    | "self_confirmation_required"
    | "delegated_placeholder"
    | "complete";
}

interface FamilyGroup {
  id: string;
  name: string | null;
  members: FamilyMember[];
}

interface PendingRequest {
  id: string;
  type: string;
  familyGroupName: string | null;
  childName: string | null;
  invitedMember: { id: string; name: string } | null;
  requester: { id: string; name: string } | null;
  direction: "submitted" | "invitation" | "family_group";
  isPendingAdminRequest: boolean;
}

interface OnboardingData {
  shouldShow: boolean;
  currentMember: {
    id: string;
    name: string;
    profile: ProfileFormMember;
    status: OnboardingStatus;
    needsOwnDetailsConfirmation: boolean;
  };
  familyGroups: FamilyGroup[];
  pendingRequests: PendingRequest[];
}

type WizardStep = "profile" | "confirm" | "family";

function getMemberStatusBadge(member: FamilyMember) {
  if (member.status.isProfileComplete && member.status.isDetailsConfirmed) {
    return <Badge variant="success">Confirmed</Badge>;
  }

  if (member.canLogin) {
    return <Badge variant="warning">Needs their login</Badge>;
  }

  return <Badge variant="warning">Needs family adult</Badge>;
}

function PendingRequestSummary({ request }: { request: PendingRequest }) {
  const title =
    request.type === "CHILD_REQUEST"
      ? request.childName
        ? `Add ${request.childName}`
        : "Child/youth request"
      : request.type === "ADULT_INVITE"
        ? request.invitedMember
          ? `Invite for ${request.invitedMember.name}`
          : "Adult invite"
        : request.requester
          ? `${request.requester.name} join request`
          : "Join request";

  return (
    <div className="flex items-start justify-between gap-3 rounded-md border bg-slate-50 px-3 py-2">
      <div>
        <p className="text-sm font-medium text-slate-900">{title}</p>
        <p className="text-xs text-slate-500">
          {request.familyGroupName ?? "Family group"} · Pending
          {request.isPendingAdminRequest ? " admin review" : " response"}
        </p>
      </div>
      <Badge variant="warning">Pending</Badge>
    </div>
  );
}

export function MemberOnboardingWizard({
  initialShouldShow,
}: {
  initialShouldShow: boolean;
}) {
  const [open, setOpen] = useState(initialShouldShow);
  const [data, setData] = useState<OnboardingData | null>(null);
  const [loading, setLoading] = useState(initialShouldShow);
  const [confirming, setConfirming] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [detailsAccepted, setDetailsAccepted] = useState(false);

  const loadOnboarding = useCallback(async () => {
    setLoading(true);
    setLoadError("");

    try {
      const res = await fetch("/api/member/onboarding", {
        credentials: "same-origin",
      });
      const body = await res.json();

      if (!res.ok) {
        throw new Error(body.error ?? "Could not load onboarding");
      }

      setData(body);
      setOpen(Boolean(body.shouldShow));
      setDetailsAccepted(false);
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : "Could not load onboarding"
      );
      setOpen(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (initialShouldShow) {
      void loadOnboarding();
    }
  }, [initialShouldShow, loadOnboarding]);

  const step: WizardStep = useMemo(() => {
    if (!data?.currentMember.status.isProfileComplete) return "profile";
    if (!detailsAccepted) return "confirm";
    return "family";
  }, [data, detailsAccepted]);

  const confirmOnboarding = async () => {
    setConfirming(true);

    try {
      const res = await fetch("/api/member/onboarding/confirm", {
        method: "POST",
        credentials: "same-origin",
      });
      const body = await res.json();

      if (!res.ok) {
        toast.error(body.error ?? "Could not confirm your details");
        await loadOnboarding();
        return;
      }

      toast.success("Details confirmed");
      setData((prev) => (prev ? { ...prev, shouldShow: body.shouldShow } : prev));
      setOpen(Boolean(body.shouldShow));
    } catch {
      toast.error("Could not confirm your details");
    } finally {
      setConfirming(false);
    }
  };

  if (!initialShouldShow && !open) {
    return null;
  }

  return (
    <Dialog open={open}>
      <DialogContent
        className="max-h-[92vh] max-w-3xl overflow-y-auto"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle>Confirm member details</DialogTitle>
          <DialogDescription>
            Please complete these required details before continuing. We use them for membership records, bookings, and Xero sync.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-600">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading member details
          </div>
        ) : loadError ? (
          <div className="space-y-4 rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
            <p>{loadError}</p>
            <Button type="button" variant="outline" onClick={loadOnboarding}>
              <RefreshCw className="h-4 w-4" />
              Try again
            </Button>
          </div>
        ) : data ? (
          <div className="space-y-5">
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="rounded-md border bg-white p-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <CircleAlert className="h-4 w-4 text-amber-600" />
                  Profile
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  {data.currentMember.status.isProfileComplete
                    ? "Complete"
                    : "Required details missing"}
                </p>
              </div>
              <div className="rounded-md border bg-white p-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <UserCheck className="h-4 w-4 text-sky-700" />
                  Confirmation
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  {detailsAccepted ? "Ready for family review" : "Needs review"}
                </p>
              </div>
              <div className="rounded-md border bg-white p-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Users className="h-4 w-4 text-indigo-700" />
                  Family
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  {data.familyGroups.length > 0 ? "Review linked members" : "No family group"}
                </p>
              </div>
            </div>

            {step === "profile" ? (
              <div className="space-y-4">
                {data.currentMember.status.missingFieldDetails.length > 0 ? (
                  <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
                    <p className="text-sm font-medium text-amber-900">Missing details</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {data.currentMember.status.missingFieldDetails.map((field) => (
                        <Badge key={field.key} variant="warning">
                          {field.label}
                        </Badge>
                      ))}
                    </div>
                  </div>
                ) : null}
                <ProfileForm
                  member={data.currentMember.profile}
                  onSaved={loadOnboarding}
                  submitLabel="Save and continue"
                />
              </div>
            ) : null}

            {step === "confirm" ? (
              <div className="space-y-4 rounded-md border bg-white p-4">
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-700" />
                  <div>
                    <h3 className="font-medium text-slate-900">
                      Confirm your details are correct.
                    </h3>
                    <p className="mt-1 text-sm text-slate-600">
                      You are confirming your own member profile. Login-capable family members must sign in and confirm themselves.
                    </p>
                  </div>
                </div>
                <div className="grid gap-2 rounded-md bg-slate-50 p-3 text-sm sm:grid-cols-2">
                  <div>
                    <span className="text-slate-500">Name</span>
                    <p className="font-medium">{data.currentMember.name}</p>
                  </div>
                  <div>
                    <span className="text-slate-500">Date of birth</span>
                    <p className="font-medium">
                      {data.currentMember.profile.dateOfBirth}
                    </p>
                  </div>
                </div>
                <DialogFooter>
                  <Button type="button" onClick={() => setDetailsAccepted(true)}>
                    Confirm details are correct
                  </Button>
                </DialogFooter>
              </div>
            ) : null}

            {step === "family" ? (
              <div className="space-y-4">
                {data.familyGroups.length === 0 ? (
                  <div className="rounded-md border bg-white p-4 text-sm text-slate-600">
                    No family group members are linked to your profile.
                  </div>
                ) : (
                  data.familyGroups.map((group) => (
                    <div key={group.id} className="space-y-3 rounded-md border bg-white p-4">
                      <div className="flex items-center gap-2">
                        <Users className="h-4 w-4 text-indigo-700" />
                        <h3 className="font-medium">
                          {group.name ?? "Family group"}
                        </h3>
                      </div>
                      <div className="space-y-2">
                        {group.members.map((member) => (
                          <div
                            key={`${group.id}-${member.id}`}
                            className="flex flex-col gap-3 rounded-md border bg-slate-50 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
                          >
                            <div>
                              <div className="flex flex-wrap items-center gap-2">
                                <p className="text-sm font-medium text-slate-900">
                                  {member.name}
                                  {member.isCurrentUser ? " (you)" : ""}
                                </p>
                                {getMemberStatusBadge(member)}
                              </div>
                              <p className="mt-1 text-xs text-slate-500">
                                {member.isCurrentUser
                                  ? "Your own details are reviewed in this wizard."
                                  : member.nextAction === "self_confirmation_required"
                                    ? `${member.firstName} has their own login and needs to sign in and confirm their details.`
                                    : member.nextAction === "delegated_placeholder"
                                      ? `${member.firstName} does not have their own login. A family adult can complete their details.`
                                      : "Member details are confirmed."}
                              </p>
                            </div>
                            {!member.isCurrentUser ? (
                              <div className="flex flex-wrap gap-2">
                                {member.nextAction === "delegated_placeholder" ? (
                                  <Button type="button" variant="outline" size="sm" disabled>
                                    Complete details
                                  </Button>
                                ) : null}
                                <Button type="button" variant="outline" size="sm" disabled>
                                  Request removal
                                </Button>
                              </div>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))
                )}

                {data.pendingRequests.length > 0 ? (
                  <div className="space-y-2 rounded-md border bg-white p-4">
                    <div className="flex items-center gap-2">
                      <Clock className="h-4 w-4 text-amber-700" />
                      <h3 className="font-medium">Pending family requests</h3>
                    </div>
                    {data.pendingRequests.map((request) => (
                      <PendingRequestSummary key={request.id} request={request} />
                    ))}
                  </div>
                ) : null}

                <DialogFooter>
                  <Button
                    type="button"
                    onClick={confirmOnboarding}
                    disabled={confirming}
                  >
                    {confirming ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <CheckCircle2 className="h-4 w-4" />
                    )}
                    Confirm and finish
                  </Button>
                </DialogFooter>
              </div>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
