"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Users } from "lucide-react";

interface FamilyGroupSectionProps {
  familyGroupId: string | null;
  familyGroupName: string | null;
  familyGroupMembers: { id: string; firstName: string; lastName: string }[];
}

export function FamilyGroupSection({
  familyGroupId,
  familyGroupName,
  familyGroupMembers,
}: FamilyGroupSectionProps) {
  const [showJoinForm, setShowJoinForm] = useState(false);
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function handleRequestJoin(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setMessage("");
    setSubmitting(true);

    try {
      const res = await fetch("/api/members/family/request-join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetEmail: email.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Request failed");
        return;
      }
      setMessage(data.message || "Request submitted successfully");
      setEmail("");
      setShowJoinForm(false);
    } finally {
      setSubmitting(false);
    }
  }

  if (familyGroupId) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-indigo-600" />
          <span className="font-medium">{familyGroupName || "Family Group"}</span>
        </div>
        {familyGroupMembers.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {familyGroupMembers.map((m) => (
              <Badge key={m.id} variant="secondary" className="bg-indigo-50 text-indigo-700 border-indigo-200">
                {m.firstName} {m.lastName}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No other members in this group yet.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Family group members appear in your booking quick-add list. Contact an admin to change your group.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {message && (
        <div className="p-2 bg-green-50 border border-green-200 text-green-700 rounded text-sm">
          {message}
        </div>
      )}
      {error && (
        <div className="p-2 bg-red-50 border border-red-200 text-red-700 rounded text-sm">
          {error}
        </div>
      )}
      <p className="text-sm text-muted-foreground">
        You are not currently in a family group. Link with your partner/spouse so you can quickly add each other when booking.
      </p>
      {showJoinForm ? (
        <form onSubmit={handleRequestJoin} className="space-y-3">
          <div>
            <Label htmlFor="partnerEmail">Partner&apos;s email address</Label>
            <Input
              id="partnerEmail"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="partner@example.com"
              required
            />
            <p className="text-xs text-muted-foreground mt-1">
              An admin will review and approve your request.
            </p>
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={submitting}>
              {submitting ? "Submitting..." : "Send Request"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setShowJoinForm(false);
                setError("");
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setShowJoinForm(true)}>
          <Users className="h-4 w-4 mr-2" />
          Request to Join a Family Group
        </Button>
      )}
    </div>
  );
}
