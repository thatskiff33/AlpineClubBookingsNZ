"use client";

import { useId } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BackLink } from "@/components/admin/back-link";
import { ViewOnlyActionButton } from "@/components/admin/view-only-action";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ExternalLink,
  Link2,
  MoreHorizontal,
  Plus,
} from "lucide-react";
import { accessRoleLabelForToken } from "@/lib/access-role-definitions";
import { useAccessRoleOptions } from "@/hooks/use-access-role-options";
import { buildXeroContactUrl } from "@/lib/xero-links";
import {
  DEPENDENT_PARENT_BLOCK_EXPLANATIONS,
  dependentParentStateBlocker,
} from "@/lib/dependent-link-eligibility";
import { DependentNotice } from "./dependent-notices";
import type { MemberDetail, MemberLifecycleActionRequest } from "../_types";

interface MemberDetailHeaderProps {
  member: MemberDetail;
  backHref: string;
  backLabel: string;
  pendingDeleteRequest: MemberLifecycleActionRequest | undefined;
  /** null = status still loading; no Xero UI renders until it resolves. */
  xeroConnected: boolean | null;
  /**
   * Organisation short code for the "View in Xero" deep link, or null when
   * unavailable — the link then degrades to the generic session-scoped Xero
   * URL, it is never hidden (#2283).
   */
  xeroOrgShortCode: string | null;
  xeroPushing: boolean;
  xeroUnlinking: boolean;
  xeroCreateSuppressed?: boolean;
  xeroWritesSuppressed?: boolean;
  /**
   * Add Dependent writes the membership-area members route (#1997).
   * Tri-state (#2065): `undefined` while the client session resolves — the
   * `!canEdit`/`canEdit === false` idioms treat that as the neutral disabled
   * state, so this must never default to `true`.
   */
  canEditMembership: boolean | undefined;
  /**
   * The Xero link/push/unlink actions write members/[id]/xero-* routes, which
   * the route-area matrix maps to the finance area (#1997). Tri-state (#2065):
   * `undefined` while the client session resolves.
   */
  canEditFinance: boolean | undefined;
  onOpenDependentDialog: () => void;
  onOpenLinkXero: () => void;
  onOpenCreateXero: () => void;
  onUnlinkXero: () => void;
}

export function MemberDetailHeader({
  member,
  backHref,
  backLabel,
  pendingDeleteRequest,
  xeroConnected,
  xeroOrgShortCode,
  xeroPushing,
  xeroUnlinking,
  xeroCreateSuppressed = false,
  xeroWritesSuppressed = false,
  canEditMembership,
  canEditFinance,
  onOpenDependentDialog,
  onOpenLinkXero,
  onOpenCreateXero,
  onUnlinkXero,
}: MemberDetailHeaderProps) {
  const roleOptions = useAccessRoleOptions();
  const accessRoles = member.accessRoles ?? [];
  // #2282: the same predicate the two write routes use, so the toolbar button
  // and the Dependents card cannot disagree with each other or with the server.
  const addDependentBlockReason = dependentParentStateBlocker(member);
  const addDependentBlockReasonId = useId();
  return (
    <div>
      <div className="mb-2">
        <BackLink href={backHref} label={backLabel} />
      </div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="break-words text-2xl font-bold text-foreground">
            {member.firstName} {member.lastName}
          </h1>
          <p className="mt-1 break-all text-sm text-muted-foreground">{member.email}</p>
          <div className="flex flex-wrap gap-2 mt-2">
            {accessRoles.length > 0 ? (
              accessRoles.map((role) => (
                <Badge
                  key={role}
                  variant={role.startsWith("ADMIN") ? "default" : "secondary"}
                  className={
                    role.startsWith("ADMIN")
                      ? "bg-primary text-primary-foreground hover:shadow-md"
                      : ""
                  }
                >
                  {accessRoleLabelForToken(role, roleOptions)}
                </Badge>
              ))
            ) : (
              <Badge variant="secondary">No Login</Badge>
            )}
            <Badge
              variant={member.active ? "default" : "destructive"}
              className={
                member.active
                  ? "border-success/20 bg-success-muted text-success hover:shadow-md"
                  : ""
              }
            >
              {member.active ? "Active" : "Inactive"}
            </Badge>
            {member.cancelledAt && (
              <Badge
                variant="secondary"
                className="border-warning/20 bg-warning-muted text-warning"
              >
                Cancelled
              </Badge>
            )}
            {member.archivedAt && (
              <Badge
                variant="secondary"
                className="border-border bg-muted text-foreground"
              >
                Archived
              </Badge>
            )}
            {member.forcePasswordChange && (
              <Badge variant="destructive" className="text-xs">
                PW Reset Required
              </Badge>
            )}
            {pendingDeleteRequest && (
              <Badge variant="destructive" className="text-xs">
                Delete Pending
              </Badge>
            )}
          </div>
        </div>
        <div className="flex w-full flex-wrap gap-2 sm:w-auto sm:shrink-0 sm:justify-end">
          {/* #2282: shown at all ages — parentage is recordable whatever the
              member's age tier — and shown DISABLED WITH THE REASON when the
              record is not current, or is an organisation/school account rather
              than a person, instead of disappearing. The reason sits beside the
              button as visible text AND is attached to it with
              `aria-describedby`, because a disabled Button has
              `pointer-events-none`, so a `title` tooltip would never fire and a
              nearby paragraph is not an association. */}
          <div className="flex flex-col items-start gap-1">
            <ViewOnlyActionButton
              canEdit={canEditMembership}
              variant="outline"
              size="sm"
              disabled={Boolean(addDependentBlockReason)}
              aria-describedby={
                addDependentBlockReason ? addDependentBlockReasonId : undefined
              }
              onClick={onOpenDependentDialog}
            >
              <Plus className="h-4 w-4 mr-1" />
              Add Dependent
            </ViewOnlyActionButton>
            <DependentNotice id={addDependentBlockReasonId} tone="warning">
              {addDependentBlockReason
                ? DEPENDENT_PARENT_BLOCK_EXPLANATIONS[addDependentBlockReason]
                : null}
            </DependentNotice>
          </div>
          {/* Xero actions render only once the connection status resolves to
              true: everyday actions stay visible, rare ones live in the
              overflow menu. Disconnected (or still loading) shows no Xero UI
              at all — offering link/unlink against a dead connection only
              fails after the click. */}
          {xeroConnected === true &&
            (member.xeroContactId ? (
              <>
                <Button asChild variant="outline" size="sm">
                  <a
                    href={buildXeroContactUrl(member.xeroContactId, {
                      shortCode: xeroOrgShortCode,
                    })}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink className="h-4 w-4 mr-1" />
                    View in Xero
                  </a>
                </Button>
                {!xeroWritesSuppressed && <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label="More member actions"
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={onOpenLinkXero}
                      disabled={!canEditFinance}
                    >
                      <Link2 className="h-4 w-4 mr-1" />
                      Change Xero Link
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={onUnlinkXero}
                      disabled={xeroUnlinking || !canEditFinance}
                    >
                      {xeroUnlinking ? "Unlinking..." : "Unlink Xero Contact"}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>}
              </>
            ) : (
              <>
                {!xeroWritesSuppressed && (
                  <ViewOnlyActionButton
                    canEdit={canEditFinance}
                    variant="outline"
                    size="sm"
                    onClick={onOpenLinkXero}
                  >
                    <Link2 className="h-4 w-4 mr-1" />
                    Link to Xero
                  </ViewOnlyActionButton>
                )}
                {!xeroWritesSuppressed && !xeroCreateSuppressed && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label="More member actions"
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={onOpenCreateXero}
                        disabled={xeroPushing || !canEditFinance}
                      >
                        <Plus className="h-4 w-4 mr-1" />
                        {xeroPushing ? "Creating..." : "Create in Xero"}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </>
            ))}
        </div>
      </div>
    </div>
  );
}
