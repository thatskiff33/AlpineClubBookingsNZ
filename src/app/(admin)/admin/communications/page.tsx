"use client";

import { useState, useEffect } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface HistoryEntry {
  id: string;
  sentBy: string;
  subject: string;
  recipientFilter: string;
  totalRecipients: number;
  eligibleRecipients: number;
  queued: number;
  sentAt: string;
}

export default function CommunicationsPage() {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [recipientFilter, setRecipientFilter] = useState("all");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);

  useEffect(() => {
    fetchHistory();
  }, []);

  async function fetchHistory() {
    try {
      const res = await fetch("/api/admin/communications/history");
      if (res.ok) {
        const data = await res.json();
        setHistory(data.history);
      }
    } catch {
      // ignore
    } finally {
      setLoadingHistory(false);
    }
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setResult(null);

    try {
      const res = await fetch("/api/admin/communications/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, body, recipientFilter }),
      });

      const data = await res.json();

      if (res.ok) {
        setResult({
          success: true,
          message: `Sent to ${data.eligibleRecipients} recipients (${data.filteredByPreference} opted out).`,
        });
        setSubject("");
        setBody("");
        fetchHistory();
      } else {
        setResult({ success: false, message: data.error });
      }
    } catch {
      setResult({ success: false, message: "Failed to send. Please try again." });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Communications</h1>
        <p className="text-sm text-slate-500">
          Send bulk emails to club members. Respects notification preferences.
        </p>
      </div>

      {/* Compose Form */}
      <Card>
        <CardHeader>
          <CardTitle>Compose Message</CardTitle>
          <CardDescription>
            Only members who have opted in to marketing emails will receive this
            message. Rate limited to 1 send per hour.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSend} className="space-y-4">
            <div>
              <Label htmlFor="subject">Subject</Label>
              <Input
                id="subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Email subject line"
                maxLength={200}
                required
              />
              <p className="text-xs text-slate-400 mt-1">
                {subject.length}/200 characters
              </p>
            </div>

            <div>
              <Label htmlFor="recipientFilter">Recipients</Label>
              <Select
                value={recipientFilter}
                onValueChange={setRecipientFilter}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Active Members</SelectItem>
                  <SelectItem value="members-only">Members Only</SelectItem>
                  <SelectItem value="admins-only">Admins Only</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label htmlFor="body">Message Body</Label>
              <Textarea
                id="body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Write your message here (plain text)"
                rows={8}
                maxLength={10000}
                required
              />
              <p className="text-xs text-slate-400 mt-1">
                {body.length}/10,000 characters. Plain text only — HTML is escaped
                for security.
              </p>
            </div>

            {result && (
              <div
                className={`rounded-md p-3 text-sm ${
                  result.success
                    ? "bg-green-50 text-green-800 border border-green-200"
                    : "bg-red-50 text-red-800 border border-red-200"
                }`}
              >
                {result.message}
              </div>
            )}

            <Button type="submit" disabled={sending || !subject || !body}>
              {sending ? "Sending..." : "Send to Members"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* History */}
      <Card>
        <CardHeader>
          <CardTitle>Send History</CardTitle>
          <CardDescription>Previous bulk communications</CardDescription>
        </CardHeader>
        <CardContent>
          {loadingHistory ? (
            <p className="text-sm text-slate-500">Loading...</p>
          ) : history.length === 0 ? (
            <p className="text-sm text-slate-500">
              No bulk communications sent yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-slate-500">
                    <th className="pb-2 pr-4">Date</th>
                    <th className="pb-2 pr-4">Subject</th>
                    <th className="pb-2 pr-4">Filter</th>
                    <th className="pb-2 pr-4">Recipients</th>
                    <th className="pb-2">Sent</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((entry) => (
                    <tr key={entry.id} className="border-b">
                      <td className="py-2 pr-4 text-slate-600">
                        {new Date(entry.sentAt).toLocaleDateString("en-NZ", {
                          dateStyle: "medium",
                        })}
                      </td>
                      <td className="py-2 pr-4 font-medium">
                        {entry.subject}
                      </td>
                      <td className="py-2 pr-4 text-slate-600">
                        {entry.recipientFilter}
                      </td>
                      <td className="py-2 pr-4 text-slate-600">
                        {entry.totalRecipients}
                      </td>
                      <td className="py-2 text-slate-600">
                        {entry.eligibleRecipients}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
