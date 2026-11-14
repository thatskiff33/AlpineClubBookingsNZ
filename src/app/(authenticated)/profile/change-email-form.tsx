"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { FieldHint, useFieldHint } from "@/components/ui/field-hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";

/** The member's unexpired email-change link, its expiry already in club time. */
export interface PendingEmailChange {
  newEmail: string;
  expiresOn: string;
}

interface ChangeEmailFormProps {
  currentEmail: string;
  pendingChange?: PendingEmailChange | null;
}

export function ChangeEmailForm({
  currentEmail,
  pendingChange = null,
}: ChangeEmailFormProps) {
  const router = useRouter();
  const [newEmail, setNewEmail] = useState("");
  const [loading, setLoading] = useState(false);
  // #2264 — the example address lives UNDER the field, folded into the note that
  // was already there: a grey "new@example.com" inside the box reads as an
  // address the form has already accepted.
  const newEmailHint = useFieldHint();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (newEmail.toLowerCase() === currentEmail.toLowerCase()) {
      toast.error("New email is the same as your current email");
      return;
    }

    setLoading(true);

    try {
      const res = await fetch("/api/auth/request-email-change", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newEmail }),
      });

      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error ?? "Failed to request email change");
        return;
      }

      toast.success(`Verification email sent to ${newEmail}`);
      setNewEmail("");
      // #4956: re-read the pending change so the notice names the new address.
      router.refresh();
    } catch {
      toast.error("An unexpected error occurred");
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="currentEmail">Current Email</Label>
        <Input id="currentEmail" value={currentEmail} disabled className="bg-muted" />
        {pendingChange ? (
          <p role="status" className="text-sm text-muted-foreground">
            A change to <strong>{pendingChange.newEmail}</strong> is waiting for
            you to click the link we sent. The link expires{" "}
            {pendingChange.expiresOn}. Requesting again replaces it.
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="newEmail">New Email</Label>
        <Input
          id="newEmail"
          type="email"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          required
          {...newEmailHint.fieldProps}
        />
        <FieldHint {...newEmailHint.hintProps}>
          Example: new@example.com. A verification link will be sent to the new
          email address. The change takes effect only after you click that link.
        </FieldHint>
      </div>

      <div className="flex justify-end pt-2">
        <Button type="submit" disabled={loading || !newEmail}>
          {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {loading ? "Sending..." : "Request Email Change"}
        </Button>
      </div>
    </form>
  );
}
