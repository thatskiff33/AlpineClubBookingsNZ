"use client";

import { useCallback, useEffect, useState } from "react";
import { ClipboardCheck, PenLine } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { InductionSignOffForm } from "@/components/induction-sign-off-form";
import { useClubIdentity } from "@/components/club-identity-provider";
import { useClubTime } from "@/components/club-time-provider";
import {
  type AwaitingInductionClient,
  type InductionDetailClient,
  type InductionStatus,
  formatInductionDate,
  INDUCTION_KIND_LABELS,
  INDUCTION_SIGNER_ROLE_LABELS,
  INDUCTION_STATUS_LABELS,
} from "@/lib/induction-display";

interface InductionsResponse {
  own: InductionDetailClient | null;
  awaiting: AwaitingInductionClient[];
}

const STATUS_VARIANT: Record<
  InductionStatus,
  "default" | "secondary" | "outline" | "destructive"
> = {
  DRAFT: "outline",
  IN_PROGRESS: "secondary",
  COMPLETED: "default",
  VOIDED: "destructive",
};

export default function InductionPage() {
  const { hutLeaderLabel } = useClubIdentity();
  const [data, setData] = useState<InductionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeSignOffId, setActiveSignOffId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/inductions", { credentials: "same-origin" });
      if (!res.ok) {
        setError("Failed to load your induction.");
        return;
      }
      setData((await res.json()) as InductionsResponse);
      setError(null);
    } catch {
      setError("Failed to load your induction.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <ClipboardCheck className="h-6 w-6" />
          Lodge Induction
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your lodge induction must be signed off before you can nominate new
          members. Work through the checklist below, then your assigned signers
          will confirm the sign-off.
        </p>
      </header>

      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}

      {data && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Your induction</CardTitle>
              <CardDescription>
                Work through the checklist below with your assigned signers so
                they can confirm one overall Pass.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {data.own ? (
                <OwnInduction induction={data.own} />
              ) : (
                <p className="text-sm text-muted-foreground">
                  You don&apos;t have an induction record yet. An administrator
                  or {hutLeaderLabel.toLowerCase()} will create one for you once
                  you&apos;ve arranged your lodge induction.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <PenLine className="h-5 w-5" />
                Inductions awaiting your sign-off
              </CardTitle>
              <CardDescription>
                Members whose induction you have been asked to sign off.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {data.awaiting.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  There are no inductions waiting for your sign-off.
                </p>
              ) : (
                data.awaiting.map((item) => (
                  <div key={item.id} className="rounded-md border p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="font-medium">
                          {item.member.firstName} {item.member.lastName}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {INDUCTION_KIND_LABELS[item.kind]} ·{" "}
                          {item.signOffCount}/{item.requiredSignOffs} sign-offs
                        </p>
                      </div>
                      {activeSignOffId === item.id ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setActiveSignOffId(null)}
                        >
                          Close
                        </Button>
                      ) : (
                        <Button size="sm" onClick={() => setActiveSignOffId(item.id)}>
                          Sign off
                        </Button>
                      )}
                    </div>
                    {activeSignOffId === item.id && (
                      <div className="mt-4 border-t pt-4">
                        <InductionSignOffForm
                          inductionId={item.id}
                          onComplete={() => {
                            setActiveSignOffId(null);
                            void load();
                          }}
                          onCancel={() => setActiveSignOffId(null)}
                        />
                      </div>
                    )}
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function OwnInduction({
  induction,
}: {
  induction: InductionDetailClient;
}) {
  const clubTime = useClubTime();
  const signedCount = induction.signOffs.length;
  const isOpen = induction.status === "IN_PROGRESS" || induction.status === "DRAFT";

  return (
    <div className="space-y-5">
      {/* Status summary */}
      <div className="flex flex-wrap items-center gap-3">
        <Badge variant={STATUS_VARIANT[induction.status]}>
          {INDUCTION_STATUS_LABELS[induction.status]}
        </Badge>
        <span className="text-sm text-muted-foreground">
          {INDUCTION_KIND_LABELS[induction.kind]}
        </span>
        <span className="text-sm text-muted-foreground">
          {signedCount}/{induction.requiredSignOffs} sign-offs
        </span>
        {induction.completedAt && (
          <span className="text-sm text-muted-foreground">
            Completed {formatInductionDate(induction.completedAt, clubTime)}
          </span>
        )}
      </div>

      {/* Assigned signers */}
      {induction.assignedSigners.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold">Assigned signers</h4>
          <ul className="mt-1 space-y-1 text-sm text-muted-foreground">
            {induction.assignedSigners.map((signer) => {
              const hasSigned = induction.signOffs.some(
                (signOff) => signOff.signerMemberId === signer.memberId
              );
              return (
                <li key={signer.memberId}>
                  {signer.firstName} {signer.lastName}
                  {hasSigned && (
                    <span className="ml-2 text-xs text-success-11">Signed</span>
                  )}
                  {signer.emailSentAt && !hasSigned && (
                    <span className="ml-2 text-xs">
                      (notified {formatInductionDate(signer.emailSentAt, clubTime)})
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Completed sign-offs */}
      {induction.signOffs.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold">Signed off by</h4>
          <ul className="mt-1 space-y-1 text-sm text-muted-foreground">
            {induction.signOffs.map((signOff) => (
              <li key={signOff.id}>
                {signOff.signerName} (
                {INDUCTION_SIGNER_ROLE_LABELS[signOff.signerRole]}) —{" "}
                {formatInductionDate(signOff.signedAt, clubTime)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Status message */}
      {induction.status === "COMPLETED" ? (
        <p className="text-sm text-muted-foreground">
          Your induction is complete.
        </p>
      ) : isOpen ? (
        <p className="text-sm text-muted-foreground">
          Your induction needs {induction.requiredSignOffs} sign-off
          {induction.requiredSignOffs === 1 ? "" : "s"}. Work through the
          checklist with your signers so they can record an overall Pass.
        </p>
      ) : null}

      {/* Checklist reference */}
      {isOpen && induction.template.sections.length > 0 && (
        <div className="space-y-3">
          <h4 className="text-sm font-semibold">Induction checklist</h4>
          {induction.template.sections.map((section) => (
            <div key={section.id} className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {section.title}
              </p>
              <ul className="space-y-1 text-sm text-muted-foreground">
                {section.items.map((item) => (
                  <li key={item.id} className="rounded-md border px-3 py-2">
                    <span className="font-medium text-foreground">{item.label}</span>
                    {item.isMandatory && (
                      <span className="ml-2 text-xs text-destructive">
                        Mandatory
                      </span>
                    )}
                    {item.requiresDemonstration && (
                      <span className="ml-2 text-xs">Demonstrate</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
