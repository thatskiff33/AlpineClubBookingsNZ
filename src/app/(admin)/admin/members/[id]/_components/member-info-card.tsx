"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ExternalLink } from "lucide-react";
import {
  financeAccessBadgeClass,
  financeAccessLongLabels as financeAccessLabels,
  getLoginBadge,
} from "@/lib/admin-member-badges";
import { formatMemberDateNz } from "@/lib/admin-member-detail-helpers";
import { formatGenderLabel, formatTitleLabel } from "@/lib/member-enums";
import { useMemberFieldsSettings } from "@/lib/use-member-fields-settings";
import type { MemberDetail } from "../_types";

interface MemberInfoCardProps {
  member: MemberDetail;
  onEditFamilyGroup: (familyGroupId: string) => void;
}

export function MemberInfoCard({
  member,
  onEditFamilyGroup,
}: MemberInfoCardProps) {
  const loginBadge = getLoginBadge(member.canLogin);
  const { showTitle, showGender, showOccupation } = useMemberFieldsSettings();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium">
          Member Information
        </CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
          {showTitle && (
            <div>
              <dt className="text-slate-500">Title</dt>
              <dd className="font-medium">
                {formatTitleLabel(member.title) || "Not set"}
              </dd>
            </div>
          )}
          {showGender && (
            <div>
              <dt className="text-slate-500">Gender</dt>
              <dd className="font-medium">
                {formatGenderLabel(member.gender) || "Not set"}
              </dd>
            </div>
          )}
          <div>
            <dt className="text-slate-500">Phone</dt>
            <dd className="font-medium">
              {member.phoneNumber
                ? [
                    member.phoneCountryCode
                      ? `+${member.phoneCountryCode}`
                      : null,
                    member.phoneAreaCode,
                    member.phoneNumber,
                  ]
                    .filter(Boolean)
                    .join(" ")
                : "Not provided"}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Member Since</dt>
            <dd className="font-medium">
              {formatMemberDateNz(member.joinedDate || member.createdAt)}
              {member.joinedDate && (
                <span className="text-xs text-slate-400 ml-1">(from Xero)</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Life Member Date</dt>
            <dd className="font-medium">
              {member.lifeMemberDate
                ? formatMemberDateNz(member.lifeMemberDate)
                : "Not set"}
            </dd>
          </div>
          {showOccupation && (
            <div>
              <dt className="text-slate-500">Occupation</dt>
              <dd className="font-medium">{member.occupation || "Not set"}</dd>
            </div>
          )}
          <div className="sm:col-span-2">
            <dt className="text-slate-500">Comments</dt>
            <dd className="font-medium whitespace-pre-wrap">
              {member.comments || "None"}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Finance Access</dt>
            <dd className="font-medium">
              <Badge
                variant="secondary"
                className={financeAccessBadgeClass[member.financeAccessLevel]}
              >
                {financeAccessLabels[member.financeAccessLevel]}
              </Badge>
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Login</dt>
            <dd className="font-medium">
              <Badge variant="secondary" className={loginBadge.className}>
                {loginBadge.label}
              </Badge>
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Email Inheritance</dt>
            <dd className="font-medium">
              {member.inheritEmailFrom ? (
                <span className="text-xs">
                  {member.inheritEmailFrom.firstName}{" "}
                  {member.inheritEmailFrom.lastName}{" "}
                  <span className="text-slate-400">
                    ({member.inheritEmailFrom.email})
                  </span>
                </span>
              ) : (
                <span className="text-xs text-slate-500">Own email</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Family Groups</dt>
            <dd className="font-medium">
              {member.familyGroups && member.familyGroups.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {member.familyGroups.map((fg) => (
                    <Button
                      key={fg.id}
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 border-indigo-200 bg-indigo-50 px-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-100 hover:text-indigo-800"
                      onClick={() => onEditFamilyGroup(fg.id)}
                    >
                      {fg.name || "Unnamed"}
                    </Button>
                  ))}
                </div>
              ) : (
                <span className="text-xs text-slate-500">None</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Xero Contact</dt>
            <dd className="font-medium space-y-2">
              <div>
                {member.xeroContactId ? (
                  <a
                    href={`https://go.xero.com/Contacts/View/${member.xeroContactId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline inline-flex items-center gap-1"
                  >
                    {member.xeroContactId}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                ) : (
                  "Not linked"
                )}
              </div>
              {!member.xeroContactId && (
                <p className="text-xs text-amber-700">
                  Membership refresh skips unlinked members. Link or create a
                  Xero contact before expecting subscription status to update
                  automatically.
                </p>
              )}
              {member.xeroContactGroups.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {member.xeroContactGroups.map((group) => (
                    <Badge
                      key={group.id}
                      variant="secondary"
                      className="bg-emerald-50 text-emerald-700 border-emerald-200"
                    >
                      {group.name}
                    </Badge>
                  ))}
                </div>
              )}
              {member.xeroContactId && !member.xeroContactGroupsLoaded && (
                <p className="text-xs text-slate-500">
                  Cached contact groups have not been refreshed yet.
                </p>
              )}
            </dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}
