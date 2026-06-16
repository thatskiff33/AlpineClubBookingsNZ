import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  getMemberName,
  type FamilyGroupMemberRow,
  type SharedEmailCluster,
} from "@/lib/admin-family-group-ui-helpers";

const SESSION_LAG_WARNING =
  "The previous holder's session may remain valid for up to 8 hours after the swap.";

export interface FamilyGroupLoginHolderSectionProps {
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
    <section className="space-y-3 rounded-lg border border-slate-200 p-4">
      <div>
        <h3 className="text-sm font-semibold text-slate-900">Shared email & login</h3>
        <p className="mt-1 text-sm text-slate-500">
          Choose which adult in a shared-email cluster holds the login.
        </p>
      </div>
      {clusters.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-200 p-3 text-sm text-slate-500">
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
            <div key={cluster.email} className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm font-medium text-slate-900">{cluster.email}</p>
                {currentHolder && (
                  <p className="text-xs text-slate-500">
                    Current holder: {getMemberName(currentHolder)}
                  </p>
                )}
              </div>
              {adultMembers.length === 0 ? (
                <p className="text-sm text-slate-500">
                  This shared email has no adult members who can hold the login.
                </p>
              ) : (
                <div className="space-y-2">
                  {adultMembers.map((member) => {
                    const disabled = !member.active || !member.hasPassword;
                    return (
                      <label
                        key={member.id}
                        className={`flex flex-col gap-2 rounded-md border bg-white p-3 sm:flex-row sm:items-start ${
                          disabled ? "border-slate-200 opacity-80" : "border-slate-300"
                        }`}
                      >
                        <input
                          type="radio"
                          name={`login-holder-${cluster.email}`}
                          value={member.id}
                          checked={selections[cluster.email] === member.id}
                          onChange={() => onSelectLoginHolder(cluster.email, member.id)}
                          disabled={disabled}
                          className="mt-1 h-4 w-4 border-slate-300"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium text-slate-900">
                              {getMemberName(member)}
                            </span>
                            {member.canLogin && (
                              <Badge variant="secondary" className="bg-emerald-50 text-emerald-700 border-emerald-200">
                                Current
                              </Badge>
                            )}
                            {!member.active && (
                              <Badge variant="secondary" className="bg-slate-100 text-slate-600 border-slate-200">
                                Inactive
                              </Badge>
                            )}
                          </div>
                          <p className="text-xs text-slate-500">{member.email}</p>
                          {!member.hasPassword && (
                            <p className="mt-1 text-xs text-amber-700">
                              This member has never set a password. Use &apos;Send password setup email&apos; first.
                            </p>
                          )}
                          {setupInviteMessages[member.id] && (
                            <p className="mt-1 text-xs text-slate-600">
                              {setupInviteMessages[member.id]}
                            </p>
                          )}
                        </div>
                        {!member.hasPassword && (
                          <Button
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
                          </Button>
                        )}
                      </label>
                    );
                  })}
                </div>
              )}
              <p className="text-xs text-slate-500">{SESSION_LAG_WARNING}</p>
              {errors[cluster.email] && (
                <p className="text-sm text-red-600">{errors[cluster.email]}</p>
              )}
              {messages[cluster.email] && (
                <p className="text-sm text-emerald-700">{messages[cluster.email]}</p>
              )}
              <Button
                type="button"
                onClick={() => onSaveLoginHolder(cluster)}
                disabled={savingEmail === cluster.email || !selections[cluster.email]}
              >
                {savingEmail === cluster.email ? "Saving..." : "Save login holder"}
              </Button>
            </div>
          );
        })
      )}
    </section>
  );
}
