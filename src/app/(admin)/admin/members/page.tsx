"use client"

import { useEffect, useState, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Users, ExternalLink } from "lucide-react"

interface Member {
  id: string
  firstName: string
  lastName: string
  email: string
  phone: string | null
  dateOfBirth: string | null
  role: "MEMBER" | "ADMIN"
  ageTier: "ADULT" | "YOUTH" | "CHILD"
  active: boolean
  xeroContactId: string | null
  subscriptionStatus: "NOT_INVOICED" | "UNPAID" | "PAID" | "OVERDUE" | null
  subscriptionXeroInvoiceId: string | null
  createdAt: string
}

interface MemberForm {
  firstName: string
  lastName: string
  email: string
  phone: string
  dateOfBirth: string
  role: "MEMBER" | "ADMIN"
  ageTier: "ADULT" | "YOUTH" | "CHILD"
  active: boolean
  sendInvite: boolean
}

const emptyForm: MemberForm = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  dateOfBirth: "",
  role: "MEMBER",
  ageTier: "ADULT",
  active: true,
  sendInvite: false,
}

export default function MembersPage() {
  const [members, setMembers] = useState<Member[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState("")
  const [debouncedSearch, setDebouncedSearch] = useState("")
  const [error, setError] = useState("")
  const [success, setSuccess] = useState("")

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingMember, setEditingMember] = useState<Member | null>(null)
  const [form, setForm] = useState<MemberForm>(emptyForm)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState("")

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300)
    return () => clearTimeout(timer)
  }, [search])

  const fetchMembers = useCallback(async () => {
    try {
      const params = debouncedSearch ? `?q=${encodeURIComponent(debouncedSearch)}` : ""
      const res = await fetch(`/api/admin/members${params}`)
      if (!res.ok) throw new Error("Failed to fetch members")
      const data = await res.json()
      setMembers(data.members)
    } catch {
      setError("Failed to load members")
    } finally {
      setLoading(false)
    }
  }, [debouncedSearch])

  useEffect(() => {
    fetchMembers()
  }, [fetchMembers])

  const openCreateDialog = () => {
    setEditingMember(null)
    setForm(emptyForm)
    setFormError("")
    setDialogOpen(true)
  }

  const openEditDialog = (member: Member) => {
    setEditingMember(member)
    setForm({
      firstName: member.firstName,
      lastName: member.lastName,
      email: member.email,
      phone: member.phone || "",
      dateOfBirth: member.dateOfBirth
        ? new Date(member.dateOfBirth).toISOString().split("T")[0]
        : "",
      role: member.role,
      ageTier: member.ageTier,
      active: member.active,
      sendInvite: false,
    })
    setFormError("")
    setDialogOpen(true)
  }

  const handleSave = async () => {
    setSaving(true)
    setFormError("")

    try {
      const url = editingMember
        ? `/api/admin/members/${editingMember.id}`
        : "/api/admin/members"
      const method = editingMember ? "PUT" : "POST"

      const body: Record<string, unknown> = {
        firstName: form.firstName,
        lastName: form.lastName,
        email: form.email,
        phone: form.phone || null,
        dateOfBirth: form.dateOfBirth || null,
        role: form.role,
        ageTier: form.ageTier,
        active: form.active,
      }
      if (!editingMember) {
        body.sendInvite = form.sendInvite
      }

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Save failed")
      }

      setDialogOpen(false)
      setSuccess(editingMember ? "Member updated" : "Member created")
      setTimeout(() => setSuccess(""), 3000)
      fetchMembers()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Save failed")
    } finally {
      setSaving(false)
    }
  }

  const handleDeactivate = async (member: Member) => {
    if (
      !confirm(
        `Are you sure you want to deactivate ${member.firstName} ${member.lastName}? They will no longer be able to log in.`
      )
    ) {
      return
    }

    try {
      const res = await fetch(`/api/admin/members/${member.id}`, {
        method: "DELETE",
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Deactivate failed")
      }
      setSuccess(`${member.firstName} ${member.lastName} deactivated`)
      setTimeout(() => setSuccess(""), 3000)
      fetchMembers()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Deactivate failed")
    }
  }

  const handleReactivate = async (member: Member) => {
    try {
      const res = await fetch(`/api/admin/members/${member.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: true }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Reactivate failed")
      }
      setSuccess(`${member.firstName} ${member.lastName} reactivated`)
      setTimeout(() => setSuccess(""), 3000)
      fetchMembers()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reactivate failed")
    }
  }

  const handleSendReset = async (member: Member) => {
    if (
      !confirm(
        `Send a password reset email to ${member.email}?`
      )
    ) {
      return
    }

    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: member.email }),
      })
      if (!res.ok) throw new Error("Failed to send reset email")
      setSuccess(`Password reset email sent to ${member.email}`)
      setTimeout(() => setSuccess(""), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send reset email")
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Members</h1>
          <p className="mt-1 text-sm text-slate-500">
            {members.length} member{members.length !== 1 ? "s" : ""}
            {debouncedSearch ? ` matching "${debouncedSearch}"` : " total"}
          </p>
        </div>
        <Button onClick={openCreateDialog}>Add Member</Button>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 text-red-700 rounded-md text-sm">
          {error}
          <button onClick={() => setError("")} className="ml-2 underline">
            Dismiss
          </button>
        </div>
      )}

      {success && (
        <div className="p-3 bg-green-50 border border-green-200 text-green-700 rounded-md text-sm">
          {success}
        </div>
      )}

      {/* Search */}
      <div className="flex max-w-sm gap-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or email..."
          className="bg-white"
        />
        {search && (
          <Button variant="outline" onClick={() => setSearch("")}>
            Clear
          </Button>
        )}
      </div>

      {/* Members table */}
      <Card>
        <CardHeader className="pb-0">
          <CardTitle className="text-base font-medium">Member List</CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          {loading ? (
            <div className="py-12 text-center">
              <p className="text-sm text-slate-500">Loading members...</p>
            </div>
          ) : members.length === 0 ? (
            <div className="py-12 text-center">
              <Users className="mx-auto h-10 w-10 text-slate-300 mb-3" />
              <p className="text-sm font-medium text-slate-500">
                {debouncedSearch
                  ? `No members found matching "${debouncedSearch}"`
                  : "No members yet"}
              </p>
              {!debouncedSearch && (
                <p className="text-xs text-slate-400 mt-1">
                  Add members manually or import from Xero in the Xero Integration page.
                </p>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Age Tier</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Subscription</TableHead>
                    <TableHead>Xero</TableHead>
                    <TableHead>Joined</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {members.map((member) => (
                    <TableRow key={member.id} className="hover:bg-slate-50">
                      <TableCell className="font-medium">
                        {member.firstName} {member.lastName}
                      </TableCell>
                      <TableCell className="text-slate-600">
                        {member.email}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            member.role === "ADMIN" ? "default" : "secondary"
                          }
                          className={
                            member.role === "ADMIN"
                              ? "bg-blue-600 text-white hover:bg-blue-700"
                              : ""
                          }
                        >
                          {member.role}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm text-slate-600">
                          {member.ageTier.charAt(0) +
                            member.ageTier.slice(1).toLowerCase()}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={member.active ? "default" : "destructive"}
                          className={
                            member.active
                              ? "bg-green-100 text-green-800 hover:bg-green-200 border-green-200"
                              : ""
                          }
                        >
                          {member.active ? "Active" : "Inactive"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {member.subscriptionStatus ? (
                          (() => {
                            const statusConfig: Record<string, { className: string; label: string }> = {
                              PAID: { className: "bg-green-100 text-green-800 border-green-200 hover:bg-green-200", label: "Paid" },
                              UNPAID: { className: "bg-yellow-100 text-yellow-800 border-yellow-200 hover:bg-yellow-200", label: "Unpaid" },
                              OVERDUE: { className: "bg-red-100 text-red-800 border-red-200 hover:bg-red-200", label: "Overdue" },
                              NOT_INVOICED: { className: "bg-slate-100 text-slate-600 border-slate-200 hover:bg-slate-200", label: "Not Invoiced" },
                            };
                            const config = statusConfig[member.subscriptionStatus] || statusConfig.NOT_INVOICED;
                            const badge = (
                              <Badge
                                variant="secondary"
                                className={`${config.className} ${member.subscriptionXeroInvoiceId ? "cursor-pointer inline-flex items-center gap-1" : ""}`}
                              >
                                {config.label}
                                {member.subscriptionXeroInvoiceId && (
                                  <ExternalLink className="h-3 w-3" />
                                )}
                              </Badge>
                            );
                            return member.subscriptionXeroInvoiceId ? (
                              <a
                                href={`https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${member.subscriptionXeroInvoiceId}`}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                {badge}
                              </a>
                            ) : badge;
                          })()
                        ) : (
                          <span className="text-xs text-slate-400">-</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {member.xeroContactId ? (
                          <a
                            href={`https://go.xero.com/app/contacts/contact/${member.xeroContactId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <Badge
                              variant="secondary"
                              className="bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100 cursor-pointer inline-flex items-center gap-1"
                            >
                              Linked
                              <ExternalLink className="h-3 w-3" />
                            </Badge>
                          </a>
                        ) : (
                          <span className="text-xs text-slate-400">-</span>
                        )}
                      </TableCell>
                      <TableCell className="text-slate-500 text-sm">
                        {new Date(member.createdAt).toLocaleDateString(
                          "en-NZ",
                          {
                            day: "numeric",
                            month: "short",
                            year: "numeric",
                          }
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openEditDialog(member)}
                          >
                            Edit
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleSendReset(member)}
                          >
                            Reset PW
                          </Button>
                          {member.active ? (
                            <Button
                              variant="destructive"
                              size="sm"
                              onClick={() => handleDeactivate(member)}
                            >
                              Deactivate
                            </Button>
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleReactivate(member)}
                            >
                              Reactivate
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editingMember ? "Edit Member" : "Add Member"}
            </DialogTitle>
            <DialogDescription>
              {editingMember
                ? "Update the member's details. Changes will sync to Xero if connected."
                : "Create a new member account. They will need to reset their password to log in."}
            </DialogDescription>
          </DialogHeader>

          {formError && (
            <div className="p-2 bg-red-50 border border-red-200 text-red-700 rounded text-sm">
              {formError}
            </div>
          )}

          <div className="grid gap-4 py-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="firstName">First Name *</Label>
                <Input
                  id="firstName"
                  value={form.firstName}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, firstName: e.target.value }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="lastName">Last Name *</Label>
                <Input
                  id="lastName"
                  value={form.lastName}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, lastName: e.target.value }))
                  }
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="email">Email *</Label>
              <Input
                id="email"
                type="email"
                value={form.email}
                onChange={(e) =>
                  setForm((f) => ({ ...f, email: e.target.value }))
                }
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="phone">Phone</Label>
              <Input
                id="phone"
                value={form.phone}
                onChange={(e) =>
                  setForm((f) => ({ ...f, phone: e.target.value }))
                }
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="dateOfBirth">Date of Birth</Label>
              <Input
                id="dateOfBirth"
                type="date"
                value={form.dateOfBirth}
                onChange={(e) =>
                  setForm((f) => ({ ...f, dateOfBirth: e.target.value }))
                }
              />
              <p className="text-xs text-muted-foreground">
                Age tier is calculated automatically from date of birth.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Role</Label>
                <Select
                  value={form.role}
                  onValueChange={(v) =>
                    setForm((f) => ({ ...f, role: v as "MEMBER" | "ADMIN" }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="MEMBER">Member</SelectItem>
                    <SelectItem value="ADMIN">Admin</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Age Tier</Label>
                <Select
                  value={form.ageTier}
                  onValueChange={(v) =>
                    setForm((f) => ({
                      ...f,
                      ageTier: v as "ADULT" | "YOUTH" | "CHILD",
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ADULT">Adult</SelectItem>
                    <SelectItem value="YOUTH">Youth</SelectItem>
                    <SelectItem value="CHILD">Child</SelectItem>
                  </SelectContent>
                </Select>
                {form.dateOfBirth && (
                  <p className="text-xs text-muted-foreground">
                    Overridden by date of birth if provided.
                  </p>
                )}
              </div>
            </div>

            {editingMember && (
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="active"
                  checked={form.active}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, active: e.target.checked }))
                  }
                  className="h-4 w-4 rounded border-gray-300"
                />
                <Label htmlFor="active">Active</Label>
              </div>
            )}

            {!editingMember && (
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="sendInvite"
                  checked={form.sendInvite}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, sendInvite: e.target.checked }))
                  }
                  className="h-4 w-4 rounded border-gray-300"
                />
                <Label htmlFor="sendInvite">
                  Send invite email (password reset link)
                </Label>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDialogOpen(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving
                ? "Saving..."
                : editingMember
                  ? "Save Changes"
                  : "Create Member"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
