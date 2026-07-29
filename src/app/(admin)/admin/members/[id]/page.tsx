"use client";

import { useEffect, useRef, useState, use } from "react";
import { useSession } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { BackLink } from "@/components/admin/back-link";
import { AdminViewOnlySectionBanner } from "@/components/admin/view-only-action";
import { FamilyGroupEditorDialog } from "@/components/admin/family-group-editor-dialog";
import {
  formatMemberAccountPreview,
  formatMemberAuditLogSummary as formatMemberAuditLogSummaryHelper,
  formatMemberDateNz,
  formatMemberCommitteePreview,
  formatMemberContactPreview,
  formatMemberFamilyPreview,
  formatMemberFinancePreview,
  formatMemberHistoryPreview,
  formatMemberLifecyclePreview,
  formatMemberMembershipPreview,
  getAuditActorDisplayName as getAuditActorDisplayNameHelper,
  getMemberDetailBackLabel,
  parseInviteAuditDetails as parseInviteAuditDetailsHelper,
} from "@/lib/admin-member-detail-helpers";
import { resolveInternalReturnPath } from "@/lib/internal-return-path";
import { hasAccessRole, isFullAdmin } from "@/lib/access-roles";
import { toast } from "sonner";
import { useScrollToFeedback } from "@/hooks/use-scroll-to-feedback";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { useXeroStatus } from "@/hooks/use-xero-status";
import { useXeroOrgShortCode } from "@/hooks/use-xero-org-short-code";
import { Accordion } from "@/components/ui/accordion";
import { subscriptionStatusLabel } from "@/lib/status-colors";
import { MemberDetailHeader } from "./_components/member-detail-header";
import { MemberGroupCard } from "./_components/member-group-card";
import { MemberSummaryStrip } from "./_components/member-summary-strip";
import { MemberContactGroup } from "./_components/member-contact-group";
import { MemberAccountAccessGroup } from "./_components/member-account-access-group";
import { MemberXeroContactSummary } from "./_components/member-xero-contact-summary";
import { MemberSubscriptionHistoryTable } from "./_components/member-subscription-history-table";
import { MemberHistoryGroup } from "./_components/member-history-group";
import { MemberDeletionCard } from "./_components/member-deletion-card";
import { MemberLifecycleCard } from "./_components/member-lifecycle-card";
import { MemberFamilyTreeCard } from "./_components/member-family-tree-card";
import { MemberParentLinksCard } from "./_components/member-parent-links-card";
import { MemberBillingFamilyCard } from "./_components/member-billing-family-card";
import { MemberPartnerLinkCard } from "./_components/member-partner-link-card";
import { MemberLodgeAccessCard } from "./_components/member-lodge-access-card";
import { MemberPromoCodesCard } from "./_components/member-promo-codes-card";
import { MemberDependentsCard } from "./_components/member-dependents-card";
import { MemberCreditCard } from "./_components/member-credit-card";
import { MemberSeasonalMembershipCard } from "./_components/member-seasonal-membership-card";
import { MemberCommitteeAssignmentsCard } from "./_components/member-committee-assignments-card";
import { MemberPhotoCard } from "./_components/member-photo-card";
import { MemberXeroLinkDialog } from "./_components/member-xero-link-dialog";
import {
  buildAccountEditForm,
  buildAccountPayload,
  buildContactEditForm,
  buildContactPayload,
  type MemberAccountEditForm,
  type MemberContactEditForm,
} from "@/lib/admin-member-edit-groups";
import { MemberXeroCreateDialog } from "./_components/member-xero-create-dialog";
import { MemberXeroDecisionDialog } from "./_components/member-xero-decision-dialog";
import { MemberParentLinkDialog } from "./_components/member-parent-link-dialog";
import { MemberDependentDialog } from "./_components/member-dependent-dialog";
import { MemberDeleteRequestDialog } from "./_components/member-delete-request-dialog";
import { MemberDeleteReviewDialog } from "./_components/member-delete-review-dialog";
import { useCollapsibleMemberSections } from "./_hooks/use-collapsible-member-sections";
import { useMemberCredits } from "./_hooks/use-member-credits";
import { useMemberLifecycleActions } from "./_hooks/use-member-lifecycle-actions";
import { useMemberDelete } from "./_hooks/use-member-delete";
import { useMemberRelationships } from "./_hooks/use-member-relationships";
import { useMemberParentLink } from "./_hooks/use-member-parent-link";
import { useMemberDependentDialog } from "./_hooks/use-member-dependent-dialog";
import { useMemberXero } from "./_hooks/use-member-xero";
import { useInheritEmailSearch } from "./_hooks/use-inherit-email-search";
import { useMemberGroupEdit } from "./_hooks/use-member-group-edit";
import type { MemberDetail } from "./_types";

// Re-exports preserve the existing import paths used by tests and other callers
// that previously imported these helpers from the page route.
export const formatMemberAuditLogSummary = formatMemberAuditLogSummaryHelper;
export const parseInviteAuditDetails = parseInviteAuditDetailsHelper;
export const getAuditActorDisplayName = getAuditActorDisplayNameHelper;

export default function MemberDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  // Member-detail actions are gated view-only (#1997). Membership-area cards
  // (contact/account editors, links, seasonal, committee, lifecycle, deletion)
  // key on membership edit; the credit and billing-family cards write
  // finance-area routes (members/[id]/credits and fee-configuration), so they
  // key on finance edit. The credit card reads finance access itself; the
  // billing-family card takes it as a prop.
  const canEditMembership = useAdminAreaEditAccess("membership");
  const canEditFinance = useAdminAreaEditAccess("finance");

  /*
    #2168 owner decision: ONE view-only banner for this page, not one per card.

    #2160 rolled the section banner across the admin tree but deliberately left
    this page alone: nine per-record cards render here, so converting each of
    them stacked three identical banners in the Family group, two in Lifecycle &
    Deletion, and nine on the page. The banner lives here instead, once, above
    the accordion, and the cards it covers drop their per-button reason by
    taking `ancestorRendersViewOnlyBanner` at their render site below.

    SCOPE: this banner states the MEMBERSHIP area only, because that is what the
    cards it vouches for are gated on. `MemberCreditCard` is gated on FINANCE,
    so it is NOT vouched for and keeps its per-button reason — an admin who can
    edit membership but only view finance gets no banner here, and this banner
    would be describing the wrong permission for those controls.

    It is declared UP HERE, above the loading and error early-returns, and
    rendered in all three branches. `AdminViewOnlySectionBanner` renders its
    `role="status"` wrapper unconditionally and gates only the content, so the
    live region has to be registered in the accessibility tree from the first
    paint — a region injected already-populated is silently dropped by some
    screen-reader/browser pairings. `canEditMembership` resolves from
    `undefined` AFTER hydration, which is exactly the announcement moment this
    protects. It sits OUTSIDE the page's `space-y-6` stack so the empty wrapper
    an edit-capable admin gets costs no layout.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEditMembership} className="mb-6">
      Your admin role can view this member but cannot change their details.
      Membership edit access is required.
    </AdminViewOnlySectionBanner>
  );

  const [member, setMember] = useState<MemberDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState("");
  const [relationshipError, setRelationshipError] = useState("");
  const [xeroError, setXeroError] = useState("");
  const relationshipErrorRef = useRef<HTMLDivElement>(null);
  const xeroErrorRef = useRef<HTMLDivElement>(null);
  const { scrollToError } = useScrollToFeedback();

  const fetchMember = async () => {
    try {
      const res = await fetch(`/api/admin/members/${id}`);
      if (!res.ok) {
        setPageError(
          res.status === 404 ? "Member not found" : "Failed to load member",
        );
        setLoading(false);
        return;
      }
      setMember(await res.json());
      setPageError("");
    } catch {
      setPageError("Failed to load member");
    } finally {
      setLoading(false);
    }
  };

  const shouldAutoOpenEdit = searchParams.get("edit") === "true";

  // Dependent dialog state
  const {
    dependentOpen,
    dependentForm,
    dependentPostalSameAsPhysical,
    dependentSaving,
    dependentFormError,
    dependentMode,
    linkDependentSearch,
    linkDependentSearchResults,
    linkDependentIneligibleMatches,
    linkDependentMatchedNobody,
    linkDependentSearching,
    selectedLinkDependent,
    linkDependentNotificationParentId,
    linkDependentDisableLogin,
    linkDependentFamilyGroupIds,
    setDependentOpen,
    setDependentForm,
    setDependentPostalSameAsPhysical,
    setDependentFormError,
    setDependentMode,
    setLinkDependentSearch,
    setSelectedLinkDependent,
    setLinkDependentInheritEmail,
    setLinkDependentNotificationParentId,
    setLinkDependentDisableLogin,
    openDependentDialog,
    handleCreateDependent,
    selectLinkDependent,
    clearLinkDependent,
    toggleLinkFamilyGroup,
    handleLinkDependent,
    updateDependentAddressFields,
  } = useMemberDependentDialog({ member, fetchMember, setLoading });

  // Parent link dialog state
  const {
    parentLinkOpen,
    parentLinkSearch,
    parentLinkSearchResults,
    parentLinkSearching,
    selectedLinkParent,
    parentLinkNotificationParentId,
    parentLinkDisableLogin,
    parentLinkFamilyGroupIds,
    parentLinkSaving,
    parentLinkError,
    setParentLinkOpen,
    setParentLinkSearch,
    setSelectedLinkParent,
    setParentLinkInheritEmail,
    setParentLinkNotificationParentId,
    setParentLinkDisableLogin,
    setParentLinkError,
    openParentLinkDialog,
    selectLinkParent,
    clearLinkParent,
    toggleParentLinkFamilyGroup,
    handleLinkParent,
  } = useMemberParentLink({
    member,
    fetchMember,
    setLoading,
    setRelationshipError,
  });
  const { unlinkingDependentId, handleUnlinkDependent } =
    useMemberRelationships({ fetchMember, setLoading, setRelationshipError });
  const [familyGroupEditorId, setFamilyGroupEditorId] = useState<string | null>(
    null,
  );

  // Account credit state
  const {
    creditBalance,
    creditHistory,
    pendingAdjustmentRequests,
    creditLoading,
    creditError,
    showAdjustmentForm,
    adjustmentAmount,
    adjustmentDescription,
    adjustmentSaving,
    adjustmentError,
    reviewingAdjustmentId,
    setAdjustmentAmount,
    setAdjustmentDescription,
    toggleAdjustmentForm,
    handleAdjustmentSubmit,
    handleReviewAdjustmentRequest,
  } = useMemberCredits(id);

  // Lifecycle state
  const {
    archiveReason,
    archiveReviewNotes,
    archiveActionLoading,
    archiveError,
    cancellationReason,
    cancellationSubmitting,
    cancellationError,
    setArchiveReason,
    setArchiveReviewNotes,
    setCancellationReason,
    handleSubmitArchiveRequest,
    handleReviewArchiveRequest,
    handleSubmitCancellationRequest,
  } = useMemberLifecycleActions({ id, fetchMember, setLoading });

  // Xero link/push state
  const {
    xeroSearchOpen,
    xeroSearchQuery,
    xeroSearchResults,
    xeroSearching,
    xeroLinking,
    xeroUnlinking,
    xeroPushing,
    xeroCreateOpen,
    xeroCreateEntranceFeeInvoice,
    xeroEntranceFeeSkipReason,
    xeroEntranceFeeAmount,
    xeroEntranceFeeNarration,
    xeroCreateDecisionOpen,
    xeroCreateDecisionResults,
    xeroDecisionContactId,
    xeroDecisionError,
    setXeroSearchOpen,
    setXeroSearchQuery,
    setXeroCreateOpen,
    setXeroCreateEntranceFeeInvoice,
    setXeroEntranceFeeSkipReason,
    setXeroEntranceFeeAmount,
    setXeroEntranceFeeNarration,
    setXeroCreateDecisionOpen,
    setXeroCreateDecisionResults,
    setXeroDecisionContactId,
    setXeroDecisionError,
    handleXeroSearch,
    handleXeroLink,
    handleXeroUnlink,
    handleXeroPush,
    handleXeroDecisionLink,
    openLinkXero,
    openCreateXero,
  } = useMemberXero({ id, fetchMember, setLoading, setXeroError });

  // Per-group inline edit state: each group unlocks and saves only its own
  // fields (the member PUT schema is fully partial).
  const refreshMemberAfterSave = async () => {
    setLoading(true);
    await fetchMember();
  };
  const contactEdit = useMemberGroupEdit<MemberContactEditForm>({
    memberId: id,
    buildForm: () => (member ? buildContactEditForm(member) : null),
    // #2106: thread the current-season age-exemption so an ALLOWED-type manual
    // N/A pick is actually submitted (buildContactPayload omits N/A otherwise).
    buildPayload: (form) =>
      buildContactPayload(form, {
        ageExemption: member?.currentSeasonAgeExemption ?? null,
      }),
    successMessage: "Member updated successfully",
    onSaved: refreshMemberAfterSave,
  });
  const accountEditBase = useMemberGroupEdit<MemberAccountEditForm>({
    memberId: id,
    buildForm: () => (member ? buildAccountEditForm(member) : null),
    buildPayload: buildAccountPayload,
    successMessage: "Member updated successfully",
    onSaved: refreshMemberAfterSave,
  });
  const inheritEmail = useInheritEmailSearch({
    memberId: member?.id,
    enabled: accountEditBase.editing && accountEditBase.form?.canLogin === false,
  });
  // Entering account edit re-seeds the recipient picker from the member's
  // current inheritance so a cancelled edit leaves nothing stale behind.
  const accountEdit = {
    ...accountEditBase,
    startEdit: () => {
      inheritEmail.resetTo(member?.inheritEmailFrom ?? null);
      accountEditBase.startEdit();
    },
  };

  // Delete state
  const {
    deleteDialogOpen,
    deleteReason,
    deleteError,
    deleteSubmitting,
    deleteReviewDialog,
    deleteReviewNote,
    deleteReviewError,
    deleteReviewSubmitting,
    setDeleteDialogOpen,
    setDeleteReason,
    setDeleteError,
    setDeleteReviewDialog,
    setDeleteReviewNote,
    setDeleteReviewError,
    handleCreateDeleteRequest,
    handleReviewDeleteRequest,
  } = useMemberDelete({
    member,
    fetchMember,
    setLoading,
    onDeleted: () => router.push(backHref),
  });

  const {
    openSections,
    onValueChange: onSectionsChange,
    openSection,
  } = useCollapsibleMemberSections();
  const { connected: xeroConnected } = useXeroStatus();
  // Org short code for the page's "open in Xero" deep links (#2283). One
  // mount per page; served from the server-side 12h org cache, and null
  // degrades every link to the generic Xero URL rather than hiding it.
  const { shortCode: xeroOrgShortCode } = useXeroOrgShortCode(
    xeroConnected === true,
  );

  const isAdultMember = member?.ageTier === "ADULT";
  const memberIsArchived = Boolean(member?.archivedAt);
  const memberLifecycleLocked = Boolean(
    member?.cancelledAt || member?.archivedAt,
  );
  const backHref = resolveInternalReturnPath(
    searchParams.get("returnTo"),
    "/admin/members",
  );
  const backLabel = getMemberDetailBackLabel(backHref);
  const currentMemberQuery = searchParams.toString();
  const currentMemberPath = currentMemberQuery
    ? `/admin/members/${id}?${currentMemberQuery}`
    : `/admin/members/${id}`;

  useEffect(() => {
    if (relationshipError) scrollToError(relationshipErrorRef);
  }, [relationshipError, scrollToError]);

  useEffect(() => {
    if (
      xeroError &&
      !xeroSearchOpen &&
      !xeroCreateOpen &&
      !xeroCreateDecisionOpen
    ) {
      scrollToError(xeroErrorRef);
    }
  }, [
    scrollToError,
    xeroCreateDecisionOpen,
    xeroCreateOpen,
    xeroError,
    xeroSearchOpen,
  ]);

  useEffect(() => {
    fetchMember();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  // The refund-requests page deep-links to /admin/members/[id]#account-credit;
  // the anchor now lives inside the collapsed Finance group, so open it and
  // scroll once the member has loaded (after the accordion expand animation).
  const handledAccountCreditHash = useRef(false);
  useEffect(() => {
    if (loading || !member || handledAccountCreditHash.current) return;
    if (window.location.hash !== "#account-credit") return;
    handledAccountCreditHash.current = true;
    openSection("finance");
    window.setTimeout(() => {
      document
        .getElementById("account-credit")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 250);
  }, [loading, member, openSection]);

  // The members-list row Edit button navigates here with ?edit=true. The old
  // behavior opened the edit dialog; now it expands the Contact & Personal
  // group, unlocks it, and scrolls to it — once per member id.
  const handledInitialEditParam = useRef(false);
  useEffect(() => {
    handledInitialEditParam.current = false;
  }, [id]);
  useEffect(() => {
    if (
      handledInitialEditParam.current ||
      !shouldAutoOpenEdit ||
      loading ||
      !member
    ) {
      return;
    }
    handledInitialEditParam.current = true;
    openSection("contact");
    contactEdit.startEdit();
    window.setTimeout(() => {
      document
        .getElementById("member-group-contact")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 250);
  }, [contactEdit, loading, member, openSection, shouldAutoOpenEdit]);

  const isSelf = session?.user?.id === id;
  const actorIsFullAdmin = isFullAdmin({
    accessRoles: session?.user?.accessRoles ?? [],
  });

  if (loading) {
    return (
      <div>
        {viewOnlyBanner}
        <div className="py-12 text-center">
          <p className="text-sm text-muted-foreground">Loading member details...</p>
        </div>
      </div>
    );
  }
  if (pageError || !member) {
    return (
      <div>
        {viewOnlyBanner}
        <div className="space-y-4">
          <BackLink href={backHref} label={backLabel} />
          <div className="p-3 bg-danger-3 border border-danger-6 text-danger-11 rounded-md text-sm">
            {pageError || "Member not found"}
          </div>
        </div>
      </div>
    );
  }

  const lifecycleRequests = member.lifecycleActionRequests ?? [];
  const deleteRequests = lifecycleRequests.filter(
    (request) => request.action === "DELETE",
  );
  const pendingDeleteRequest = deleteRequests.find(
    (request) => request.status === "REQUESTED",
  );
  const deleteBlockers = member.deleteEligibility.blockers;
  const approvalBlockers = deleteBlockers.filter(
    (blocker) => blocker.code !== "pending_delete_request",
  );
  const canReviewPendingDeleteRequest =
    Boolean(pendingDeleteRequest) &&
    pendingDeleteRequest?.requestedBy?.id !== session?.user?.id;
  const archiveRequests = lifecycleRequests.filter(
    (request) => request.action === "ARCHIVE",
  );
  const pendingArchiveRequest =
    archiveRequests.find((request) => request.status === "REQUESTED") ?? null;
  const reviewedArchiveRequests = archiveRequests
    .filter((request) => request.status !== "REQUESTED")
    .slice(0, 3);
  const isArchiveRequester =
    pendingArchiveRequest?.requestedBy?.id === session?.user?.id;
  const canRequestArchive = Boolean(
    member.cancelledAt && !member.archivedAt && !pendingArchiveRequest,
  );
  const openCancellationRequest = member.openCancellationRequest;
  const canRequestCancellation = Boolean(
    hasAccessRole(member, "USER") &&
    member.active &&
    !member.cancelledAt &&
    !member.archivedAt &&
    !openCancellationRequest,
  );

  const currentSeasonAssignment =
    (member.seasonalMembershipAssignments ?? []).find(
      (assignment) => assignment.seasonYear === member.currentSeasonYear,
    ) ?? null;
  const currentSeasonSubscription =
    (member.subscriptions ?? []).find(
      (subscription) => subscription.seasonYear === member.currentSeasonYear,
    ) ?? null;
  const embeddedCardClassName = "rounded-none border-0 shadow-none";
  const groupPreviews = {
    contact: formatMemberContactPreview(member),
    account: formatMemberAccountPreview({
      canLogin: member.canLogin,
      accessRoleCount: (member.accessRoles ?? []).length,
      active: member.active,
    }),
    family: formatMemberFamilyPreview({
      parentCount: member.parentLinks?.length ?? 0,
      dependentCount: member.dependents?.length ?? 0,
      familyGroupCount: member.familyGroups?.length ?? 0,
    }),
    membership: formatMemberMembershipPreview({
      currentSeasonYear: member.currentSeasonYear,
      currentSeasonTypeName:
        currentSeasonAssignment?.membershipType.name ?? null,
      currentSeasonSubscriptionLabel: currentSeasonSubscription
        ? subscriptionStatusLabel(currentSeasonSubscription.status)
        : null,
    }),
    finance: formatMemberFinancePreview({
      creditBalanceCents: creditLoading ? null : creditBalance,
      promoCodeCount: member.promoCodes?.length ?? 0,
      xeroLinked: Boolean(member.xeroContactId),
    }),
    committee: formatMemberCommitteePreview({
      assignmentCount: (member.committeeAssignments ?? []).filter(
        (assignment) => assignment.isActive,
      ).length,
    }),
    history: formatMemberHistoryPreview({
      totalBookings: member.stats.totalBookings,
      lastStay: member.stats.lastStay,
    }),
    lifecycle: formatMemberLifecyclePreview({
      active: member.active,
      cancelledAt: member.cancelledAt,
      archivedAt: member.archivedAt,
      hasPendingDeleteRequest: Boolean(pendingDeleteRequest),
    }),
  };

  return (
    <div>
      {viewOnlyBanner}
      <div className="space-y-6">
      <MemberDetailHeader
        member={member}
        backHref={backHref}
        backLabel={backLabel}
        isAdultMember={isAdultMember}
        memberIsArchived={memberIsArchived}
        pendingDeleteRequest={pendingDeleteRequest}
        xeroConnected={xeroConnected}
        xeroOrgShortCode={xeroOrgShortCode}
        xeroPushing={xeroPushing}
        xeroUnlinking={xeroUnlinking}
        canEditMembership={canEditMembership}
        canEditFinance={canEditFinance}
        onOpenDependentDialog={openDependentDialog}
        onOpenLinkXero={openLinkXero}
        onOpenCreateXero={openCreateXero}
        onUnlinkXero={handleXeroUnlink}
      />

      {relationshipError && (
        <div
          ref={relationshipErrorRef}
          role="alert"
          tabIndex={-1}
          className="scroll-mt-20 rounded-md border border-danger-6 bg-danger-3 p-3 text-sm text-danger-11 focus:outline-none"
        >
          {relationshipError}
        </div>
      )}
      {xeroError &&
        !xeroSearchOpen &&
        !xeroCreateOpen &&
        !xeroCreateDecisionOpen && (
          <div
            ref={xeroErrorRef}
            role="alert"
            tabIndex={-1}
            className="scroll-mt-20 rounded-md border border-danger-6 bg-danger-3 p-3 text-sm text-danger-11 focus:outline-none"
          >
            {xeroError}
          </div>
        )}

      <MemberSummaryStrip
        member={member}
        membershipLabel={currentSeasonAssignment?.membershipType.name ?? "None"}
        creditBalance={creditBalance}
        creditLoading={creditLoading}
      />

      <Accordion
        type="multiple"
        value={openSections}
        onValueChange={onSectionsChange}
        className="space-y-6"
      >
        <MemberGroupCard
          id="contact"
          title="Contact & Personal"
          preview={groupPreviews.contact}
        >
          <MemberPhotoCard member={member} canEdit={canEditMembership} />
          <MemberContactGroup
            member={member}
            isSelf={isSelf}
            actorIsFullAdmin={actorIsFullAdmin}
            edit={contactEdit}
            canEdit={canEditMembership}
          />
        </MemberGroupCard>

        <MemberGroupCard
          id="account"
          title="Account & Access"
          preview={groupPreviews.account}
        >
          <MemberAccountAccessGroup
            member={member}
            isSelf={isSelf}
            actorIsFullAdmin={actorIsFullAdmin}
            memberLifecycleLocked={memberLifecycleLocked}
            edit={accountEdit}
            inheritEmail={inheritEmail}
            canEdit={canEditMembership}
          />
          <MemberLodgeAccessCard memberId={id} ancestorRendersViewOnlyBanner />
        </MemberGroupCard>

        <MemberGroupCard
          id="family"
          title="Family"
          preview={groupPreviews.family}
          contentClassName="px-0 pb-0"
        >
          <div className="divide-y">
            <div className="px-6 pb-6 text-sm">
              <p className="text-muted-foreground">Family Groups</p>
              <div className="mt-1 font-medium">
                {member.familyGroups && member.familyGroups.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {member.familyGroups.map((fg) => (
                      <Button
                        key={fg.id}
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 border-cat3-6 bg-cat3-3 px-2 text-xs font-semibold text-cat3-11 hover:bg-cat3-3 hover:text-cat3-11"
                        onClick={() => setFamilyGroupEditorId(fg.id)}
                      >
                        {fg.name || "Unnamed"}
                      </Button>
                    ))}
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">None</span>
                )}
              </div>
            </div>
            <MemberFamilyTreeCard
              className={embeddedCardClassName}
              memberId={member.id}
              currentMemberPath={currentMemberPath}
            />
            {member.familyGroups && member.familyGroups.length > 0 && (
              <MemberBillingFamilyCard
                memberId={member.id}
                billingFamilyGroupId={member.billingFamilyGroupId}
                familyGroups={member.familyGroups}
                familyBillingMode={member.familyBillingMode}
                canEdit={canEditFinance}
                disabled={memberIsArchived}
                onChange={(billingFamilyGroupId) =>
                  setMember((prev) => (prev ? { ...prev, billingFamilyGroupId } : prev))
                }
              />
            )}
            <MemberParentLinksCard
              ancestorRendersViewOnlyBanner
              className={embeddedCardClassName}
              member={member}
              memberIsArchived={memberIsArchived}
              currentMemberPath={currentMemberPath}
              unlinkingDependentId={unlinkingDependentId}
              onOpenParentLinkDialog={openParentLinkDialog}
              onUnlinkParent={handleUnlinkDependent}
              canEdit={canEditMembership}
            />
            <MemberPartnerLinkCard
              ancestorRendersViewOnlyBanner
              className={embeddedCardClassName}
              memberId={member.id}
              isAdultMember={isAdultMember}
              memberIsArchived={memberIsArchived}
              currentMemberPath={currentMemberPath}
            />
            <MemberDependentsCard
              ancestorRendersViewOnlyBanner
              className={embeddedCardClassName}
              member={member}
              isAdultMember={isAdultMember}
              memberIsArchived={memberIsArchived}
              currentMemberPath={currentMemberPath}
              unlinkingDependentId={unlinkingDependentId}
              onOpenDependentDialog={openDependentDialog}
              onUnlinkDependent={handleUnlinkDependent}
              canEdit={canEditMembership}
            />
          </div>
        </MemberGroupCard>

        <MemberGroupCard
          id="membership"
          title="Membership"
          preview={groupPreviews.membership}
          contentClassName="px-0 pb-0"
        >
          <div className="divide-y">
            {member.lifeMemberDate && (
              <div className="p-6 text-sm">
                <span className="text-muted-foreground">Life member since </span>
                <span className="font-medium">
                  {formatMemberDateNz(member.lifeMemberDate)}
                </span>
              </div>
            )}
            <MemberSeasonalMembershipCard
              ancestorRendersViewOnlyBanner
              className={embeddedCardClassName}
              member={member}
              onSaved={async () => {
                setLoading(true);
                await fetchMember();
              }}
            />
            <div className="p-6">
              <h3 className="mb-3 text-sm font-medium">
                Subscription History
              </h3>
              <MemberSubscriptionHistoryTable
                subscriptions={member.subscriptions}
                xeroOrgShortCode={xeroOrgShortCode}
              />
            </div>
          </div>
        </MemberGroupCard>

        <MemberGroupCard
          id="finance"
          title="Finance"
          preview={groupPreviews.finance}
          contentClassName="px-0 pb-0"
        >
          <div className="divide-y">
            <MemberCreditCard
              className={`${embeddedCardClassName} scroll-mt-20`}
              creditBalance={creditBalance}
              creditHistory={creditHistory}
              creditLoading={creditLoading}
              creditError={creditError}
              pendingAdjustmentRequests={pendingAdjustmentRequests}
              reviewingAdjustmentId={reviewingAdjustmentId}
              showAdjustmentForm={showAdjustmentForm}
              adjustmentError={adjustmentError}
              adjustmentAmount={adjustmentAmount}
              adjustmentDescription={adjustmentDescription}
              adjustmentSaving={adjustmentSaving}
              onToggleAdjustmentForm={toggleAdjustmentForm}
              onChangeAdjustmentAmount={setAdjustmentAmount}
              onChangeAdjustmentDescription={setAdjustmentDescription}
              onSubmitAdjustment={handleAdjustmentSubmit}
              onReviewAdjustment={handleReviewAdjustmentRequest}
            />
            <MemberPromoCodesCard
              className={embeddedCardClassName}
              promoCodes={member.promoCodes}
            />
            <div className="p-6">
              <MemberXeroContactSummary
                member={member}
                xeroOrgShortCode={xeroOrgShortCode}
              />
            </div>
          </div>
        </MemberGroupCard>

        <MemberGroupCard
          id="committee"
          title="Committee"
          preview={groupPreviews.committee}
          contentClassName="px-0 pb-0"
        >
          <MemberCommitteeAssignmentsCard
            ancestorRendersViewOnlyBanner
            className={embeddedCardClassName}
            member={member}
            onSaved={async () => {
              setLoading(true);
              await fetchMember();
            }}
          />
        </MemberGroupCard>

        <MemberGroupCard
          id="history"
          title="History & Activity"
          preview={groupPreviews.history}
        >
          <MemberHistoryGroup memberId={id} bookings={member.bookings} />
        </MemberGroupCard>

        <MemberGroupCard
          id="lifecycle"
          title="Lifecycle & Deletion"
          preview={groupPreviews.lifecycle}
          className="border-danger-6"
          contentClassName="px-0 pb-0"
        >
          <div className="divide-y">
            <MemberLifecycleCard
              ancestorRendersViewOnlyBanner
              className={embeddedCardClassName}
              canEdit={canEditMembership}
              member={member}
              pendingArchiveRequest={pendingArchiveRequest}
              reviewedArchiveRequests={reviewedArchiveRequests}
              isArchiveRequester={isArchiveRequester}
              canRequestArchive={canRequestArchive}
              canRequestCancellation={canRequestCancellation}
              openCancellationRequest={openCancellationRequest}
              archiveError={archiveError}
              archiveReason={archiveReason}
              archiveReviewNotes={archiveReviewNotes}
              archiveActionLoading={archiveActionLoading}
              cancellationError={cancellationError}
              cancellationReason={cancellationReason}
              cancellationSubmitting={cancellationSubmitting}
              onChangeArchiveReason={setArchiveReason}
              onChangeArchiveReviewNote={(requestId, value) =>
                setArchiveReviewNotes((current) => ({
                  ...current,
                  [requestId]: value,
                }))
              }
              onChangeCancellationReason={setCancellationReason}
              onSubmitArchive={handleSubmitArchiveRequest}
              onSubmitCancellation={handleSubmitCancellationRequest}
              onReviewArchive={handleReviewArchiveRequest}
            />
            <MemberDeletionCard
              ancestorRendersViewOnlyBanner
              className={embeddedCardClassName}
              canEdit={canEditMembership}
              deleteEligibility={member.deleteEligibility}
              deleteRequests={deleteRequests}
              pendingDeleteRequest={pendingDeleteRequest}
              approvalBlockerCount={approvalBlockers.length}
              canReviewPendingDeleteRequest={canReviewPendingDeleteRequest}
              onOpenRequestDialog={() => {
                setDeleteDialogOpen(true);
                setDeleteReason("");
                setDeleteError("");
              }}
              onOpenReviewDialog={(request, action) => {
                setDeleteReviewDialog({ request, action });
                setDeleteReviewNote("");
                setDeleteReviewError("");
              }}
            />
            {actorIsFullAdmin && !isSelf && (
              <div className="rounded-none border-0 shadow-none px-1 pt-2">
                <h3 className="text-sm font-semibold text-foreground">
                  Merge a duplicate profile
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Combine another duplicate member record into this one. This
                  record stays the master — it keeps its login, security and
                  Xero identity — and the duplicate is permanently deleted.
                  Full Admins only.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => router.push(`/admin/members/${id}/merge`)}
                >
                  Merge a duplicate into this member
                </Button>
              </div>
            )}
          </div>
        </MemberGroupCard>
      </Accordion>

      <FamilyGroupEditorDialog
        groupId={familyGroupEditorId}
        open={Boolean(familyGroupEditorId)}
        onOpenChange={(open) => {
          if (!open) setFamilyGroupEditorId(null);
        }}
        onChanged={() => {
          toast.success("Family group updated successfully");
          setLoading(true);
          void fetchMember();
        }}
        canEdit={canEditMembership}
      />

      <MemberXeroLinkDialog
        open={xeroSearchOpen}
        onOpenChange={setXeroSearchOpen}
        member={member}
        query={xeroSearchQuery}
        results={xeroSearchResults}
        searching={xeroSearching}
        linking={xeroLinking}
        error={xeroError}
        onChangeQuery={setXeroSearchQuery}
        onClearError={() => setXeroError("")}
        onSearch={handleXeroSearch}
        onLink={handleXeroLink}
      />

      <MemberXeroCreateDialog
        open={xeroCreateOpen}
        onOpenChange={setXeroCreateOpen}
        member={member}
        pushing={xeroPushing}
        error={xeroError}
        createEntranceFeeInvoice={xeroCreateEntranceFeeInvoice}
        entranceFeeSkipReason={xeroEntranceFeeSkipReason}
        entranceFeeAmount={xeroEntranceFeeAmount}
        entranceFeeNarration={xeroEntranceFeeNarration}
        onChangeCreateEntranceFeeInvoice={setXeroCreateEntranceFeeInvoice}
        onChangeEntranceFeeSkipReason={setXeroEntranceFeeSkipReason}
        onChangeEntranceFeeAmount={setXeroEntranceFeeAmount}
        onChangeEntranceFeeNarration={setXeroEntranceFeeNarration}
        onSubmit={() => handleXeroPush(false)}
      />

      <MemberXeroDecisionDialog
        open={xeroCreateDecisionOpen}
        onOpenChange={(open) => {
          setXeroCreateDecisionOpen(open);
          if (!open) {
            setXeroCreateDecisionResults([]);
            setXeroDecisionContactId("");
            setXeroDecisionError("");
          }
        }}
        member={member}
        results={xeroCreateDecisionResults}
        selectedContactId={xeroDecisionContactId}
        createEntranceFeeInvoice={xeroCreateEntranceFeeInvoice}
        linking={xeroLinking}
        pushing={xeroPushing}
        error={xeroDecisionError}
        onSelectContact={setXeroDecisionContactId}
        onConfirmLink={handleXeroDecisionLink}
        onCreateAnyway={() => handleXeroPush(true)}
      />

      <MemberParentLinkDialog
        open={parentLinkOpen}
        onOpenChange={setParentLinkOpen}
        member={member}
        search={parentLinkSearch}
        searching={parentLinkSearching}
        searchResults={parentLinkSearchResults}
        selected={selectedLinkParent}
        notificationParentId={parentLinkNotificationParentId}
        disableLogin={parentLinkDisableLogin}
        familyGroupIds={parentLinkFamilyGroupIds}
        saving={parentLinkSaving}
        error={parentLinkError}
        onChangeSearch={(value) => {
          setParentLinkSearch(value);
          setSelectedLinkParent(null);
          setParentLinkError("");
        }}
        onSelectCandidate={selectLinkParent}
        onClearSelection={clearLinkParent}
        onChangeNotificationParentId={(value) => {
          setParentLinkNotificationParentId(value);
          setParentLinkInheritEmail(Boolean(value));
        }}
        onChangeDisableLogin={setParentLinkDisableLogin}
        onToggleFamilyGroup={toggleParentLinkFamilyGroup}
        onSubmit={handleLinkParent}
      />

      <MemberDependentDialog
        open={dependentOpen}
        onOpenChange={setDependentOpen}
        member={member}
        mode={dependentMode}
        onChangeMode={(value) => {
          setDependentMode(value);
          setDependentFormError("");
        }}
        error={dependentFormError}
        saving={dependentSaving}
        createForm={dependentForm}
        createPostalSameAsPhysical={dependentPostalSameAsPhysical}
        onChangeCreateForm={setDependentForm}
        onChangeCreatePostalSameAsPhysical={setDependentPostalSameAsPhysical}
        onChangeCreateAddressFields={updateDependentAddressFields}
        onSubmitCreate={handleCreateDependent}
        linkSearch={linkDependentSearch}
        linkSearching={linkDependentSearching}
        linkSearchResults={linkDependentSearchResults}
        linkIneligibleMatches={linkDependentIneligibleMatches}
        linkSearchMatchedNobody={linkDependentMatchedNobody}
        linkSelected={selectedLinkDependent}
        linkNotificationParentId={linkDependentNotificationParentId}
        linkDisableLogin={linkDependentDisableLogin}
        linkFamilyGroupIds={linkDependentFamilyGroupIds}
        onChangeLinkSearch={(value) => {
          setLinkDependentSearch(value);
          setSelectedLinkDependent(null);
          setDependentFormError("");
        }}
        onSelectLinkCandidate={selectLinkDependent}
        onClearLinkSelection={clearLinkDependent}
        onChangeLinkNotificationParentId={(value) => {
          setLinkDependentNotificationParentId(value);
          setLinkDependentInheritEmail(Boolean(value));
        }}
        onChangeLinkDisableLogin={setLinkDependentDisableLogin}
        onToggleLinkFamilyGroup={toggleLinkFamilyGroup}
        onSubmitLink={handleLinkDependent}
      />

      <MemberDeleteRequestDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        reason={deleteReason}
        error={deleteError}
        submitting={deleteSubmitting}
        onChangeReason={setDeleteReason}
        onSubmit={handleCreateDeleteRequest}
      />

      <MemberDeleteReviewDialog
        dialog={deleteReviewDialog}
        approvalBlockers={approvalBlockers}
        reviewNote={deleteReviewNote}
        error={deleteReviewError}
        submitting={deleteReviewSubmitting}
        onClose={() => {
          setDeleteReviewDialog(null);
          setDeleteReviewNote("");
          setDeleteReviewError("");
        }}
        onChangeReviewNote={setDeleteReviewNote}
        onSubmit={handleReviewDeleteRequest}
      />
      </div>
    </div>
  );
}
