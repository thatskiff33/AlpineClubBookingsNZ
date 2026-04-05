"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";

interface ChangeEmailFormProps {
  currentEmail: string;
}

export function ChangeEmailForm({ currentEmail }: ChangeEmailFormProps) {
  const [newEmail, setNewEmail] = useState("");
  const [loading, setLoading] = useState(false);

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
      </div>

      <div className="space-y-2">
        <Label htmlFor="newEmail">New Email</Label>
        <Input
          id="newEmail"
          type="email"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          placeholder="new@example.com"
          required
        />
        <p className="text-xs text-muted-foreground">
          A verification link will be sent to the new email address. The change
          takes effect only after you click that link.
        </p>
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
