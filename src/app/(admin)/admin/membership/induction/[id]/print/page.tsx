"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  type InductionDetailClient,
  INDUCTION_KIND_LABELS,
  INDUCTION_SIGNER_ROLE_LABELS,
  INDUCTION_STATUS_LABELS,
} from "@/lib/induction-display";
import { useClubTime } from "@/components/club-time-provider";
import { parseInstant, type BoundClubTime } from "@/lib/club-time";

/**
 * A completion or sign-off stamp on the printed record sheet.
 *
 * Both are real INSTANTS, so they have no civil date until a zone is chosen —
 * the club's PERSISTED one (`INV-CONFIG-002`). The shared
 * `@/lib/induction-display` formatter this replaces pins `APP_TIME_ZONE` at
 * module scope, so a sheet printed by an administrator abroad could carry the
 * wrong day on a record that is then signed and filed.
 *
 * The long "16 April 2026" spelling is unchanged: `instantLongDate` is the
 * kernel's shape for `dateStyle: "long"` in `en-NZ`, which is what this sheet
 * already rendered. `null` is preserved for a missing or unreadable value —
 * #2256 — because a template literal would otherwise print "null" on a printed
 * record.
 */
function inductionStamp(
  clubTime: BoundClubTime,
  value: string | null,
): string | null {
  if (!value) return null;
  const instant = parseInstant(value);
  return instant === null ? null : clubTime.instantLongDate(instant);
}

export default function InductionPrintPage() {
  const clubTime = useClubTime();
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const [induction, setInduction] = useState<InductionDetailClient | null>(null);
  const [declaration, setDeclaration] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    fetch(`/api/admin/inductions/${id}`, { credentials: "same-origin" })
      .then(async (res) => {
        if (!res.ok) {
          setError("Failed to load the induction.");
          return;
        }
        const body = await res.json();
        setInduction(body.induction as InductionDetailClient);
        setDeclaration(body.declaration ?? "");
      })
      .catch(() => setError("Failed to load the induction."));
  }, [id]);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!induction) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const completedOn = inductionStamp(clubTime, induction.completedAt);

  return (
    <div className="mx-auto max-w-3xl space-y-6 bg-white p-2 text-slate-900">
      <div className="flex items-center justify-between print:hidden">
        <h1 className="text-xl font-bold">Lodge Induction Sign-Off Sheet</h1>
        <Button onClick={() => window.print()} variant="outline">
          <Printer className="mr-2 h-4 w-4" /> Print
        </Button>
      </div>

      <div className="border-b pb-3">
        <h2 className="text-lg font-bold">
          {induction.member.firstName} {induction.member.lastName}
        </h2>
        <p className="text-sm text-slate-600">
          {INDUCTION_KIND_LABELS[induction.kind]} ·{" "}
          {INDUCTION_STATUS_LABELS[induction.status]}
          {completedOn && ` · Completed ${completedOn}`}
        </p>
        <p className="text-xs text-slate-500">
          {induction.template.name} v{induction.template.version}
        </p>
      </div>

      {induction.template.sections.map((section) => (
        <div key={section.id}>
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-700">
            {section.title}
          </h3>
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-slate-500">
                <th className="py-1 pr-2">Item</th>
                <th className="py-1 pr-2 w-24">Required</th>
                <th className="py-1">Prompt</th>
              </tr>
            </thead>
            <tbody>
              {section.items.map((item) => (
                <tr key={item.id} className="border-b align-top">
                  <td className="py-1 pr-2">
                    {item.label}
                    {item.isMandatory && (
                      <span className="ml-1 text-xs text-danger-11">*</span>
                    )}
                  </td>
                  <td className="py-1 pr-2 text-xs">
                    {item.requiresDemonstration ? "Demo" : item.isMandatory ? "Yes" : "—"}
                  </td>
                  <td className="py-1 text-xs">{item.competencyPrompt ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      <div className="border-t pt-3">
        <h3 className="text-sm font-semibold">Declaration</h3>
        <p className="mt-1 text-sm italic text-slate-700">{declaration}</p>
      </div>

      <div>
        <h3 className="text-sm font-semibold">Sign-offs</h3>
        {induction.signOffs.length === 0 ? (
          <p className="text-sm text-slate-500">No sign-offs recorded yet.</p>
        ) : (
          <ul className="mt-1 space-y-1 text-sm">
            {induction.signOffs.map((signOff) => (
              <li key={signOff.id}>
                {signOff.signerName} (
                {INDUCTION_SIGNER_ROLE_LABELS[signOff.signerRole]}) —{" "}
                {inductionStamp(clubTime, signOff.signedAt)}
                {signOff.comments ? ` · ${signOff.comments}` : ""}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
