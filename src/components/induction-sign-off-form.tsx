"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useActionFocusReturn } from "@/hooks/use-scroll-to-feedback";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { type InductionDetailClient } from "@/lib/induction-display";

export function InductionSignOffForm({
  inductionId,
  onComplete,
  onCancel,
}: {
  inductionId: string;
  onComplete: () => void;
  onCancel: () => void;
}) {
  const [detail, setDetail] = useState<InductionDetailClient | null>(null);
  const [declaration, setDeclaration] = useState("");
  const [declarationAccepted, setDeclarationAccepted] = useState(false);
  const [comments, setComments] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const focusReturn = useActionFocusReturn();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/inductions/${inductionId}`, { credentials: "same-origin" })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(body.error ?? "Failed to load the induction.");
          return;
        }
        const body = (await res.json()) as {
          induction: InductionDetailClient;
          declaration: string;
        };
        if (cancelled) return;
        setDetail(body.induction);
        setDeclaration(body.declaration);
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load the induction.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [inductionId]);

  async function handleSubmit() {
    if (!declarationAccepted) {
      toast.error("Please accept the declaration before signing off.");
      return;
    }
    // A browser drops focus from a disabled control; hand it back when re-enabled (#5442).
    focusReturn.capture();
    setSubmitting(true);

    try {
      const res = await fetch(`/api/inductions/${inductionId}/sign-off`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          declarationAccepted: true,
          comments: comments.trim() || null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error ?? "Failed to record sign-off.");
        return;
      }
      toast.success(
        body.completed
          ? "Induction passed and completed."
          : "Induction pass recorded."
      );
      onComplete();
    } catch {
      toast.error("Failed to record sign-off.");
    } finally {
      setSubmitting(false);
      focusReturn.release();
    }
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading induction…</p>;
  }
  if (error) {
    return <p className="text-sm text-destructive">{error}</p>;
  }
  if (!detail) {
    return null;
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Signing off the lodge induction for{" "}
        <strong className="text-foreground">
          {detail.member.firstName} {detail.member.lastName}
        </strong>
        . Work through the checklist, then record one overall Pass.
      </p>

      {detail.template.sections.map((section) => (
        <div key={section.id} className="space-y-3">
          <h4 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {section.title}
          </h4>
          {section.description && (
            <p className="text-xs text-muted-foreground">{section.description}</p>
          )}
          <ul className="space-y-2">
            {section.items.map((item) => (
              <li key={item.id} className="rounded-md border p-3">
                <p className="text-sm font-medium">
                  {item.label}
                  {item.isMandatory && (
                    <span className="ml-2 text-xs font-normal text-destructive">
                      Mandatory
                    </span>
                  )}
                  {item.requiresDemonstration && (
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      Demonstrate
                    </span>
                  )}
                </p>
                {item.competencyPrompt && (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {item.competencyPrompt}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}

      <div className="space-y-3 rounded-md border bg-muted p-4">
        <Label htmlFor="signoff-comments" className="text-sm font-medium">
          Comments (optional)
        </Label>
        <Textarea
          id="signoff-comments"
          value={comments}
          onChange={(e) => setComments(e.target.value)}
          placeholder="Any notes about this induction"
          rows={2}
        />
        <label className="flex items-start gap-3 text-sm">
          <Checkbox
            className="mt-0.5"
            checked={declarationAccepted}
            onCheckedChange={(checked) => setDeclarationAccepted(checked === true)}
          />
          <span>{declaration}</span>
        </label>
        <div className="flex gap-2">
          <Button onClick={handleSubmit} disabled={submitting || !declarationAccepted}>
            {submitting ? "Signing off…" : "Pass induction"}
          </Button>
          <Button variant="outline" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
