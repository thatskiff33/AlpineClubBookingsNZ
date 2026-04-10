"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface LodgeAccount {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  createdAt: string;
  updatedAt: string;
}

export default function AdminLodgePage() {
  const [lodge, setLodge] = useState<LodgeAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    fetch("/api/admin/lodge")
      .then(async (res) => {
        if (!res.ok) throw new Error("Failed to load lodge account");
        const data = await res.json();
        setLodge(data.lodge);
        setEmail(data.lodge.email);
        setFirstName(data.lodge.firstName);
        setLastName(data.lodge.lastName);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  function handleEdit() {
    setEditing(true);
    setSaveMessage(null);
  }

  function handleCancel() {
    if (lodge) {
      setEmail(lodge.email);
      setFirstName(lodge.firstName);
      setLastName(lodge.lastName);
    }
    setPassword("");
    setEditing(false);
    setSaveMessage(null);
  }

  async function handleSave() {
    setSaving(true);
    setSaveMessage(null);

    const body: Record<string, string> = {};
    if (email !== lodge?.email) body.email = email;
    if (firstName !== lodge?.firstName) body.firstName = firstName;
    if (lastName !== lodge?.lastName) body.lastName = lastName;
    if (password) body.password = password;

    if (Object.keys(body).length === 0) {
      setSaveMessage({ type: "error", text: "No changes to save" });
      setSaving(false);
      return;
    }

    try {
      const res = await fetch("/api/admin/lodge", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setSaveMessage({ type: "error", text: data.error || "Failed to save" });
        return;
      }
      setLodge(data.lodge);
      setEmail(data.lodge.email);
      setFirstName(data.lodge.firstName);
      setLastName(data.lodge.lastName);
      setPassword("");
      setEditing(false);
      setSaveMessage({ type: "success", text: "Lodge account updated successfully" });
    } catch {
      setSaveMessage({ type: "error", text: "Failed to save changes" });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-slate-900 mb-6">Lodge Kiosk</h1>
        <div className="animate-pulse h-64 bg-slate-100 rounded-lg" />
      </div>
    );
  }

  if (error || !lodge) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-slate-900 mb-6">Lodge Kiosk</h1>
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
          {error || "Lodge account not found. Run the database seed to create it."}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">Lodge Kiosk</h1>
        <a
          href="/lodge/kiosk"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
        >
          Preview Kiosk
        </a>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Lodge Account Settings</CardTitle>
          {!editing && (
            <Button variant="outline" size="sm" onClick={handleEdit}>
              Edit
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="lodge-first">First Name</Label>
              <Input
                id="lodge-first"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                disabled={!editing}
                className={!editing ? "bg-slate-50 text-slate-700" : ""}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="lodge-last">Last Name</Label>
              <Input
                id="lodge-last"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                disabled={!editing}
                className={!editing ? "bg-slate-50 text-slate-700" : ""}
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="lodge-email">Email</Label>
            <Input
              id="lodge-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={!editing}
              className={!editing ? "bg-slate-50 text-slate-700" : ""}
            />
          </div>

          {editing && (
            <div className="space-y-1">
              <Label htmlFor="lodge-password">New Password</Label>
              <Input
                id="lodge-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Leave blank to keep current password"
              />
              <p className="text-xs text-slate-500">Minimum 6 characters</p>
            </div>
          )}

          <div className="text-xs text-slate-500">
            <p>Created: {new Date(lodge.createdAt).toLocaleString("en-NZ", { timeZone: "Pacific/Auckland" })}</p>
            <p>Last updated: {new Date(lodge.updatedAt).toLocaleString("en-NZ", { timeZone: "Pacific/Auckland" })}</p>
          </div>

          {saveMessage && (
            <div
              className={`rounded-md p-3 text-sm ${
                saveMessage.type === "success"
                  ? "bg-green-50 text-green-700"
                  : "bg-red-50 text-red-700"
              }`}
            >
              {saveMessage.text}
            </div>
          )}

          {editing && (
            <div className="flex gap-3">
              <Button onClick={handleSave} disabled={saving}>
                {saving ? "Saving..." : "Save Changes"}
              </Button>
              <Button variant="outline" onClick={handleCancel} disabled={saving}>
                Cancel
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
