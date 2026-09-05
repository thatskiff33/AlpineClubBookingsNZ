import { Badge } from "@/components/ui/badge";
import { ViewOnlyActionButton } from "@/components/admin/view-only-action";
import { MemberAgeChip } from "@/components/admin/family-groups/member-age-display";
import {
  getMemberName,
  type FamilyGroupMemberRow,
  type SharedEmailCluster,
} from "@/lib/admin-family-group-ui-helpers";

const SESSION_LAG_WARNING =
  "The previous holder's session may remain valid for up to 8 hours after the swap.";

export interface FamilyGroupLoginHolderSectionProps {
  // Tri-state (#2065): `undefined` while the session resolves (neutral disabled).
  // Swapping the login holder / sending a setup invite writes the membership
  // area, so a view-only membership admin must not act here.
  canEdit: boolean | undefined;
  clusters: Array<SharedEmailCluster<FamilyGroupMemberRow>>;
  selections: Record<string, string>;
  savingEmail: string | null;
  errors: Record<string, string>;
  messages: Record<string, string>;
  setupInviteSendingId: string | null;
  setupInviteMessages: Record<string, string>;
  onSelectLoginHolder: (email: string, memberId: string) => void;
  onSaveLoginHolder: (cluster: SharedEmailCluster<FamilyGroupMemberRow>) => void;
  onSendPasswordSetupInvite: (member: FamilyGroupMemberRow) => void;
}

export function FamilyGroupLoginHolderSection({
  canEdit,
  clusters,
  selections,
  savingEmail,
  errors,
  messages,
  setupInviteSendingId,
  setupInviteMessages,
  onSelectLoginHolder,
  onSaveLoginHolder,
  onSendPasswordSetupInvite,
}: FamilyGroupLoginHolderSectionProps) {
  return (
    <section className="space-y-3 rounded-lg border border-border p-4">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Shared email &amp; login</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose which adult in a shared-email cluster holds the login.
        </p>
      </div>
      {clusters.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
          No shared-email clusters in this family group. This section only
          applies when two or more adults here share the same email address.
          When they do, you can choose which adult holds the login for that
          address.
        </p>
      ) : (
        clusters.map((cluster) => {
          const adultMembers = cluster.members.filter((member) => member.ageTier === "ADULT");
          const currentHolder = cluster.members.find((member) => member.canLogin);
          return (
            <div key={cluster.email} className="space-y-3 rounded-md border border-border bg-muted p-3">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm font-medium text-foreground">{cluster.email}</p>
                {currentHolder && (
                  <p className="text-xs text-muted-foreground">
                    Current holder: {getMemberName(currentHolder)}
                  </p>
                )}
              </div>
              {adultMembers.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  This shared email has no adult members who can hold the login.
                </p>
              ) : (
                <div className="space-y-2">
                  {adultMembers.map((member) => {
                    const disabled = !member.active || !member.hasPassword;
                    return (
                      <label
                        key={member.id}
                        className={`flex flex-col gap-2 rounded-md border bg-card p-3 sm:flex-row sm:items-start ${
                          disabled ? "border-border opacity-80" : "border-border"
                        }`}
                      >
                        <input
                          type="radio"
                          name={`login-holder-${cluster.email}`}
                          value={member.id}
                          checked={selections[cluster.email] === member.id}
                          onChange={() => onSelectLoginHolder(cluster.email, member.id)}
                          disabled={disabled || canEdit !== true}
                          className="mt-1 h-4 w-4 border-border"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="break-words text-sm font-medium text-foreground">
                              {getMemberName(member)}
                            </span>
                            {/* #2568: identity-sensitive — this radio decides
                                which of two adults who share a surname AND an
                                email address keeps the login. */}
                            <MemberAgeChip ageLabel={member.ageLabel} />
                            {member.canLogin && (
                              <Badge variant="secondary" className="bg-success-3 text-success-11 border-success-6">
                                Current
                              </Badge>
                            )}
                            {!member.active && (
                              <Badge variant="secondary" className="bg-muted text-muted-foreground border-border">
                                Inactive
                              </Badge>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground">{member.email}</p>
                          {!member.hasPassword && (
                            <p className="mt-1 text-xs text-warning-11">
                              This member has never set a password. Use &apos;Send password setup email&apos; first.
                            </p>
                          )}
                          {setupInviteMessages[member.id] && (
                            <p className="mt-1 text-xs text-muted-foreground">
                              {setupInviteMessages[member.id]}
                            </p>
                          )}
                        </div>
                        {!member.hasPassword && (
                          <ViewOnlyActionButton
                            canEdit={canEdit}
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={(event) => {
                              event.preventDefault();
                              onSendPasswordSetupInvite(member);
                            }}
                            disabled={setupInviteSendingId === member.id}
                          >
                            {setupInviteSendingId === member.id
                              ? "Sending..."
                              : "Send password setup email"}
                          </ViewOnlyActionButton>
                        )}
                      </label>
                    );
                  })}
                </div>
              )}
              <p className="text-xs text-muted-foreground">{SESSION_LAG_WARNING}</p>
              {errors[cluster.email] && (
                <p className="text-sm text-danger-11">{errors[cluster.email]}</p>
              )}
              {messages[cluster.email] && (
                <p className="text-sm text-success-11">{messages[cluster.email]}</p>
              )}
              <ViewOnlyActionButton
                canEdit={canEdit}
                type="button"
                onClick={() => onSaveLoginHolder(cluster)}
                disabled={savingEmail === cluster.email || !selections[cluster.email]}
              >
                {savingEmail === cluster.email ? "Saving..." : "Save login holder"}
              </ViewOnlyActionButton>
            </div>
          );
        })
      )}
    </section>
  );
}
