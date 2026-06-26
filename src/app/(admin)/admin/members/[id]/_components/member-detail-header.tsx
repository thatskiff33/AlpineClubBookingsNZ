"use client";

import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowLeft, ExternalLink, Link2, Pencil, Plus } from "lucide-react";
import {
  financeAccessBadgeClass,
  financeAccessLongLabels as financeAccessLabels,
} from "@/lib/admin-member-badges";
import type { MemberDetail, MemberLifecycleActionRequest } from "../_types";

interface MemberDetailHeaderProps {
  member: MemberDetail;
  backHref: string;
  backLabel: string;
  isAdultMember: boolean;
  memberIsArchived: boolean;
  pendingDeleteRequest: MemberLifecycleActionRequest | undefined;
  xeroPushing: boolean;
  xeroUnlinking: boolean;
  onOpenDependentDialog: () => void;
  onOpenLinkXero: () => void;
  onOpenCreateXero: () => void;
  onUnlinkXero: () => void;
  onOpenEditDialog: () => void;
}

export function MemberDetailHeader({
  member,
  backHref,
  backLabel,
  isAdultMember,
  memberIsArchived,
  pendingDeleteRequest,
  xeroPushing,
  xeroUnlinking,
  onOpenDependentDialog,
  onOpenLinkXero,
  onOpenCreateXero,
  onUnlinkXero,
  onOpenEditDialog,
}: MemberDetailHeaderProps) {
  const router = useRouter();
  return (
    <div>
      <Button
        variant="ghost"
        size="sm"
        className="mb-2 -ml-2"
        onClick={() => router.push(backHref)}
      >
        <ArrowLeft className="h-4 w-4 mr-1" /> {backLabel}
      </Button>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">
            {member.firstName} {member.lastName}
          </h1>
          <p className="mt-1 text-sm text-slate-500">{member.email}</p>
          <div className="flex flex-wrap gap-2 mt-2">
            <Badge
              variant={member.role === "ADMIN" ? "default" : "secondary"}
              className={
                member.role === "ADMIN"
                  ? "bg-blue-600 text-white hover:bg-blue-700"
                  : ""
              }
            >
              {member.role}
            </Badge>
            <Badge
              variant="secondary"
              className={financeAccessBadgeClass[member.financeAccessLevel]}
            >
              {financeAccessLabels[member.financeAccessLevel]}
            </Badge>
            <Badge
              variant={member.active ? "default" : "destructive"}
              className={
                member.active
                  ? "bg-green-100 text-green-800 hover:bg-green-200 border-green-200"
                  : ""
              }
            >
              {member.active ? "Active" : "Inactive"}
            </Badge>
            {member.cancelledAt && (
              <Badge
                variant="secondary"
                className="bg-amber-100 text-amber-800 border-amber-200"
              >
                Cancelled
              </Badge>
            )}
            {member.archivedAt && (
              <Badge
                variant="secondary"
                className="bg-slate-200 text-slate-800 border-slate-300"
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
        <div className="flex gap-2 shrink-0 flex-wrap">
          {isAdultMember && !memberIsArchived && (
            <Button variant="outline" size="sm" onClick={onOpenDependentDialog}>
              <Plus className="h-4 w-4 mr-1" />
              Add Dependent
            </Button>
          )}
          {member.xeroContactId ? (
            <>
              <a
                href={`https://go.xero.com/Contacts/View/${member.xeroContactId}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Button variant="outline" size="sm">
                  <ExternalLink className="h-4 w-4 mr-1" />
                  View in Xero
                </Button>
              </a>
              <Button variant="outline" size="sm" onClick={onOpenLinkXero}>
                <Link2 className="h-4 w-4 mr-1" />
                Change Link
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={onUnlinkXero}
                disabled={xeroUnlinking}
              >
                {xeroUnlinking ? "Unlinking..." : "Unlink"}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={onOpenLinkXero}>
                <Link2 className="h-4 w-4 mr-1" />
                Link to Xero
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={onOpenCreateXero}
                disabled={xeroPushing}
              >
                <Plus className="h-4 w-4 mr-1" />
                {xeroPushing ? "Creating..." : "Create in Xero"}
              </Button>
            </>
          )}
          <Button size="sm" onClick={onOpenEditDialog}>
            <Pencil className="h-4 w-4 mr-1" />
            Edit Member
          </Button>
        </div>
      </div>
    </div>
  );
}
