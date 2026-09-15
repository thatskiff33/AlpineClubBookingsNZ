"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { FocusedActionError } from "@/components/focused-action-error"
import { buildHrefWithReturnTo } from "@/lib/internal-return-path"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { fetchJson, postJson, XERO_ACTION_NETWORK_ERROR, type ActionResponse } from "./api"
import { SectionCard, type ToggleSection } from "./shared"
import { xeroSectionId } from "./types"
import type { ForceSyncBookingOption, ForceSyncMemberOption, ForceSyncXeroContactOption, SyncResult } from "./types"
import {
  getXeroPartialSuccessGuidance,
  isXeroPartialSuccessRecovery,
  type XeroPartialSuccessRecovery,
} from "@/lib/xero-partial-success"

type ForceSyncType = "CONTACT" | "INVOICE" | "MEMBERSHIP"

export function ContactSyncPanel({
  connected,
  open,
  onToggle,
  clubName,
  syncing,
  setSyncing,
  setSyncResult,
  onMessage,
  onRefreshOperations,
  onRefreshDiagnostics,
  currentXeroPath,
}: {
  connected: boolean
  open: boolean
  onToggle: ToggleSection
  clubName: string
  syncing: string | null
  setSyncing: (syncing: string | null) => void
  setSyncResult: (result: SyncResult | null) => void
  onMessage: (message: string) => void
  onRefreshOperations: () => void
  onRefreshDiagnostics: () => void
  currentXeroPath: string
}) {
  const [error, setError] = useState("")
  const [forceSyncType, setForceSyncType] = useState<ForceSyncType>("CONTACT")
  const [forceSyncing, setForceSyncing] = useState(false)
  const [memberSearch, setMemberSearch] = useState("")
  const [memberResults, setMemberResults] = useState<ForceSyncMemberOption[]>([])
  const [memberSearching, setMemberSearching] = useState(false)
  const [selectedMember, setSelectedMember] = useState<ForceSyncMemberOption | null>(null)
  const [xeroContactResults, setXeroContactResults] = useState<ForceSyncXeroContactOption[]>([])
  const [xeroContactSearching, setXeroContactSearching] = useState(false)
  const [importingXeroContactId, setImportingXeroContactId] = useState<string | null>(null)
  const [bookingSearch, setBookingSearch] = useState("")
  const [bookingResults, setBookingResults] = useState<ForceSyncBookingOption[]>([])
  const [bookingSearching, setBookingSearching] = useState(false)
  const [selectedBooking, setSelectedBooking] = useState<ForceSyncBookingOption | null>(null)
  const [errorAttentionVersion, setErrorAttentionVersion] = useState(0)
  const [recoveryError, setRecoveryError] = useState("")
  const [recoveryAttentionVersion, setRecoveryAttentionVersion] = useState(0)
  const [recoveryMember, setRecoveryMember] = useState<{
    id: string
    name: string
  } | null>(null)
  const recoveryActiveRef = useRef(false)
  const recoveryActive = recoveryError.length > 0

  const showActionError = (message: string) => {
    if (recoveryActiveRef.current) return
    setError(message)
    setErrorAttentionVersion((version) => version + 1)
  }

  const clearActionError = () => {
    setError("")
  }

  const showRecoveryError = (
    message: string,
    affectedMember: { id: string; name: string },
  ) => {
    recoveryActiveRef.current = true
    setError("")
    setRecoveryMember(affectedMember)
    setRecoveryError(message)
    setRecoveryAttentionVersion((version) => version + 1)
  }

  const retainRecoveryAttention = () => {
    setRecoveryAttentionVersion((version) => version + 1)
  }

  useEffect(() => {
    if (!connected || !open || forceSyncType === "INVOICE" || selectedMember) {
      setMemberResults([])
      setMemberSearching(false)
      return
    }
    const query = memberSearch.trim()
    if (query.length < 2) {
      setMemberResults([])
      setMemberSearching(false)
      return
    }
    let cancelled = false
    setMemberSearching(true)
    const timer = window.setTimeout(async () => {
      try {
        const data = await fetchJson<{ members?: ForceSyncMemberOption[] }>(`/api/admin/members?q=${encodeURIComponent(query)}&pageSize=8`, undefined, "Failed to search members")
        if (!cancelled) {
          setMemberResults(
            (data.members ?? []).map((member) => ({
              id: member.id,
              firstName: member.firstName,
              lastName: member.lastName,
              email: member.email,
              active: member.active,
              xeroContactId: member.xeroContactId ?? null,
            }))
          )
        }
      } catch (err) {
        if (!cancelled) {
          setMemberResults([])
          showActionError(err instanceof Error ? err.message : "Failed to search members")
        }
      } finally {
        if (!cancelled) setMemberSearching(false)
      }
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [connected, forceSyncType, memberSearch, open, selectedMember])

  useEffect(() => {
    if (!connected || !open || forceSyncType !== "CONTACT" || selectedMember) {
      setXeroContactResults([])
      setXeroContactSearching(false)
      return
    }
    const query = memberSearch.trim()
    if (query.length < 2) {
      setXeroContactResults([])
      setXeroContactSearching(false)
      return
    }
    let cancelled = false
    setXeroContactSearching(true)
    const timer = window.setTimeout(async () => {
      try {
        const data = await fetchJson<{ contacts?: ForceSyncXeroContactOption[] }>(`/api/admin/xero/search-contacts?q=${encodeURIComponent(query)}`, undefined, "Failed to search Xero contacts")
        if (!cancelled) setXeroContactResults(data.contacts ?? [])
      } catch (err) {
        if (!cancelled) {
          setXeroContactResults([])
          showActionError(err instanceof Error ? err.message : "Failed to search Xero contacts")
        }
      } finally {
        if (!cancelled) setXeroContactSearching(false)
      }
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [connected, forceSyncType, memberSearch, open, selectedMember])

  useEffect(() => {
    if (!connected || !open || forceSyncType !== "INVOICE" || selectedBooking) {
      setBookingResults([])
      setBookingSearching(false)
      return
    }
    const query = bookingSearch.trim()
    if (query.length < 2) {
      setBookingResults([])
      setBookingSearching(false)
      return
    }
    let cancelled = false
    setBookingSearching(true)
    const timer = window.setTimeout(async () => {
      try {
        const data = await fetchJson<{ bookings?: ForceSyncBookingOption[] }>(`/api/admin/bookings/search?q=${encodeURIComponent(query)}&limit=8`, undefined, "Failed to search bookings")
        if (!cancelled) setBookingResults(data.bookings ?? [])
      } catch (err) {
        if (!cancelled) {
          setBookingResults([])
          showActionError(err instanceof Error ? err.message : "Failed to search bookings")
        }
      } finally {
        if (!cancelled) setBookingSearching(false)
      }
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [bookingSearch, connected, forceSyncType, open, selectedBooking])

  const syncContacts = async () => {
    if (recoveryActiveRef.current) {
      retainRecoveryAttention()
      return
    }
    setSyncing("contacts")
    setSyncResult(null)
    clearActionError()
    try {
      const data = await postJson<SyncResult>("/api/admin/xero/sync-contacts", { fullResync: true }, "Sync failed")
      setSyncResult(data)
      onRefreshDiagnostics()
    } catch (err) {
      showActionError(err instanceof Error ? err.message : "Contact sync failed")
    } finally {
      setSyncing(null)
    }
  }

  const forceSync = async () => {
    if (recoveryActiveRef.current) {
      retainRecoveryAttention()
      return
    }
    if (forceSyncType === "INVOICE") {
      if (!selectedBooking) {
        showActionError("Search for and select the booking you want to sync.")
        return
      }
      if (!selectedBooking.canForceSyncInvoice) {
        showActionError(selectedBooking.forceSyncInvoiceReason || "This booking cannot be synced right now.")
        return
      }
    } else if (!selectedMember) {
      showActionError("Search for and select the member you want to sync.")
      return
    }
    setForceSyncing(true)
    clearActionError()
    onMessage("")
    try {
      const query = forceSyncType === "INVOICE" ? selectedBooking?.id : selectedMember?.id
      if (!query) throw new Error("Missing selected record for targeted sync.")
      const data = await postJson<{ message?: string }>("/api/admin/xero/force-sync", { syncType: forceSyncType, query }, "Failed targeted Xero sync")
      onMessage(data.message || "Targeted Xero sync queued.")
      onRefreshOperations()
      onRefreshDiagnostics()
    } catch (err) {
      showActionError(err instanceof Error ? err.message : "Failed targeted Xero sync")
    } finally {
      setForceSyncing(false)
    }
  }

  const importXeroContactAsMember = async (contact: ForceSyncXeroContactOption) => {
    if (recoveryActiveRef.current) {
      retainRecoveryAttention()
      return
    }
    if (!contact.canImportAsMember) {
      showActionError(contact.importBlockReason || "This Xero contact cannot be imported.")
      return
    }
    setImportingXeroContactId(contact.contactId)
    clearActionError()
    onMessage("")
    try {
      let response: Response
      try {
        response = await fetch("/api/admin/xero/import-member-contact", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ xeroContactId: contact.contactId }),
        })
      } catch {
        throw new Error(XERO_ACTION_NETWORK_ERROR)
      }
      const data = (await response.json().catch(() => ({}))) as ActionResponse & XeroPartialSuccessRecovery & {
        error?: string
        memberImported?: boolean
        xeroContactLinked?: boolean
        subscriptionRefreshPending?: boolean
      }
      if (!response.ok) {
        if (
          isXeroPartialSuccessRecovery(data) &&
          data.memberImported &&
          data.memberId
        ) {
          setSelectedMember({
            id: data.memberId,
            firstName: contact.firstName || contact.name,
            lastName: contact.lastName || "",
            email: contact.email ?? "",
            active: true,
            xeroContactId: data.xeroContactId ?? contact.contactId,
          })
          setMemberSearch("")
          setMemberResults([])
          setXeroContactResults([])
          onRefreshDiagnostics()
          showRecoveryError(
            `${getXeroPartialSuccessGuidance(data)} Xero diagnostics are being refreshed; open the member record and check its current state before taking another action.`,
            {
              id: data.memberId,
              name:
                [contact.firstName, contact.lastName]
                  .filter(Boolean)
                  .join(" ") || contact.name,
            },
          )
          return
        }
        throw new Error(data.error || "Failed to import Xero contact")
      }
      setSelectedMember({
        id: data.memberId ?? "",
        firstName: data.memberFirstName || contact.firstName || contact.name,
        lastName: data.memberLastName || contact.lastName || "",
        email: data.memberEmail ?? contact.email ?? "",
        active: data.active ?? true,
        xeroContactId: data.xeroContactId ?? contact.contactId,
      })
      setMemberSearch("")
      setMemberResults([])
      setXeroContactResults([])
      onMessage(data.warning ? `${data.message ?? "Xero contact imported."} ${data.warning}` : data.message ?? "Xero contact imported.")
      onRefreshDiagnostics()
    } catch (err) {
      showActionError(err instanceof Error ? err.message : "Failed to import Xero contact")
    } finally {
      setImportingXeroContactId(null)
    }
  }

  const changeForceSyncType = (value: ForceSyncType) => {
    if (recoveryActiveRef.current) {
      retainRecoveryAttention()
      return
    }
    setForceSyncType(value)
    clearActionError()
    setSelectedMember(null)
    setMemberSearch("")
    setMemberResults([])
    setXeroContactResults([])
    setXeroContactSearching(false)
    setImportingXeroContactId(null)
    setSelectedBooking(null)
    setBookingSearch("")
    setBookingResults([])
  }

  return (
    <>
      <FocusedActionError
        id="xero-contact-sync-recovery-error"
        error={recoveryError}
        attentionKey={recoveryAttentionVersion}
        className="mb-3"
        action={
          recoveryMember ? (
            <Button asChild variant="outline" size="sm">
              <Link
                href={buildHrefWithReturnTo(
                  `/admin/members/${encodeURIComponent(recoveryMember.id)}`,
                  currentXeroPath,
                )}
                aria-label={`Open affected member: ${recoveryMember.name}`}
              >
                Open affected member
              </Link>
            </Button>
          ) : undefined
        }
      />
      <FocusedActionError
        id="xero-contact-sync-error"
        error={error}
        attentionKey={errorAttentionVersion}
        className="mb-3"
      />
      <SectionCard
        id={xeroSectionId("contactSync")}
        title="Contact Sync"
        description="Run a broad link pass, or repair a single record with a targeted force sync."
        open={open}
        onToggle={(nextOpen) => onToggle("contactSync", nextOpen)}
        actions={<Button onClick={() => void syncContacts()} disabled={syncing !== null || !connected || recoveryActive}>{syncing === "contacts" ? "Syncing..." : "Sync Contacts from Xero"}</Button>}
      >
        <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Link existing {clubName} members to their Xero contacts by email address, or push a single member or booking without running a full sweep.
        </p>
        <div className="rounded-lg border p-4">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold">Targeted force sync</h3>
            <p className="text-sm text-muted-foreground">Use this when one record is out of sync and you do not want to run the full admin workflow.</p>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-[180px_minmax(0,1fr)_auto] md:items-end">
            <div className="space-y-1">
              <Label>Sync target</Label>
              <Select value={forceSyncType} onValueChange={(value) => changeForceSyncType(value as ForceSyncType)} disabled={recoveryActive}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="CONTACT">Member contact</SelectItem>
                  <SelectItem value="INVOICE">Booking invoice</SelectItem>
                  <SelectItem value="MEMBERSHIP">Membership status</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <ForceSyncPicker
              type={forceSyncType}
              memberSearch={memberSearch}
              setMemberSearch={setMemberSearch}
              memberSearching={memberSearching}
              selectedMember={selectedMember}
              setSelectedMember={setSelectedMember}
              memberResults={memberResults}
              setMemberResults={setMemberResults}
              xeroContactSearching={xeroContactSearching}
              xeroContactResults={xeroContactResults}
              setXeroContactResults={setXeroContactResults}
              importingXeroContactId={importingXeroContactId}
              onImportContact={importXeroContactAsMember}
              bookingSearch={bookingSearch}
              setBookingSearch={setBookingSearch}
              bookingSearching={bookingSearching}
              selectedBooking={selectedBooking}
              setSelectedBooking={setSelectedBooking}
              bookingResults={bookingResults}
              setBookingResults={setBookingResults}
              clearError={clearActionError}
              disabled={recoveryActive}
            />
            <Button
              onClick={() => void forceSync()}
              disabled={
                forceSyncing ||
                recoveryActive ||
                (forceSyncType === "INVOICE" ? !selectedBooking || !selectedBooking.canForceSyncInvoice : !selectedMember)
              }
            >
              {forceSyncing ? "Running..." : "Run Force Sync"}
            </Button>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            {forceSyncType === "CONTACT"
              ? "Search by name or email. Select an existing local member to force-sync, or import an unlinked Xero contact when that member name does not already exist locally."
              : forceSyncType === "INVOICE"
                ? "Search for the booking by ID, member name, or email, then queue invoice creation only when that booking is eligible."
                : "Search for the member by name or email, then refresh that member's subscription state from Xero invoices."}
          </p>
        </div>
        </div>
      </SectionCard>
    </>
  )
}

function ForceSyncPicker(props: {
  type: ForceSyncType
  memberSearch: string
  setMemberSearch: (value: string) => void
  memberSearching: boolean
  selectedMember: ForceSyncMemberOption | null
  setSelectedMember: (member: ForceSyncMemberOption | null) => void
  memberResults: ForceSyncMemberOption[]
  setMemberResults: (members: ForceSyncMemberOption[]) => void
  xeroContactSearching: boolean
  xeroContactResults: ForceSyncXeroContactOption[]
  setXeroContactResults: (contacts: ForceSyncXeroContactOption[]) => void
  importingXeroContactId: string | null
  onImportContact: (contact: ForceSyncXeroContactOption) => Promise<void>
  bookingSearch: string
  setBookingSearch: (value: string) => void
  bookingSearching: boolean
  selectedBooking: ForceSyncBookingOption | null
  setSelectedBooking: (booking: ForceSyncBookingOption | null) => void
  bookingResults: ForceSyncBookingOption[]
  setBookingResults: (bookings: ForceSyncBookingOption[]) => void
  clearError: () => void
  disabled: boolean
}) {
  if (props.type === "INVOICE") return <BookingPicker {...props} />
  return <MemberPicker {...props} />
}

function BookingPicker({
  bookingSearch,
  setBookingSearch,
  bookingSearching,
  selectedBooking,
  setSelectedBooking,
  bookingResults,
  setBookingResults,
  clearError,
  disabled,
}: Parameters<typeof ForceSyncPicker>[0]) {
  return (
    <div className="space-y-1">
      <Label>Booking</Label>
      {selectedBooking ? (
        <div className="rounded-md border bg-muted px-3 py-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{selectedBooking.memberName}</p>
              <p className="truncate text-xs text-muted-foreground">{selectedBooking.memberEmail}</p>
              <p className="text-xs text-muted-foreground">Booking ID: {selectedBooking.id} - {selectedBooking.checkIn} to {selectedBooking.checkOut} - {selectedBooking.guestCount} guest{selectedBooking.guestCount === 1 ? "" : "s"} - {selectedBooking.status}</p>
              <p className={selectedBooking.canForceSyncInvoice ? "text-xs text-success" : "text-xs text-warning"}>{selectedBooking.canForceSyncInvoice ? "Ready to queue invoice sync." : selectedBooking.forceSyncInvoiceReason}</p>
              {selectedBooking.xeroInvoiceId ? <p className="text-xs text-muted-foreground">Xero invoice: {selectedBooking.xeroInvoiceId}</p> : null}
            </div>
            <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => { clearError(); setSelectedBooking(null); setBookingSearch(""); setBookingResults([]) }}>Change</Button>
          </div>
        </div>
      ) : (
        <div className="relative">
          <Input value={bookingSearch} disabled={disabled} onChange={(event) => { clearError(); setBookingSearch(event.target.value) }} placeholder="Search by booking reference, ID, member name, or email" />
          {bookingSearching ? <div className="absolute right-3 top-2.5 text-xs text-muted-foreground">Searching...</div> : null}
          {bookingResults.length > 0 ? (
            <div className="absolute z-10 mt-1 max-h-64 w-full overflow-y-auto rounded-md border bg-popover text-popover-foreground shadow-lg">
              {bookingResults.map((booking) => (
                <button key={booking.id} type="button" disabled={disabled} onClick={() => { clearError(); setSelectedBooking(booking); setBookingSearch(""); setBookingResults([]) }} className="w-full px-3 py-2 text-left text-sm hover:bg-muted">
                  <div className="font-medium text-foreground">{booking.memberName}</div>
                  <div className="truncate text-xs text-muted-foreground">{booking.memberEmail}</div>
                  <div className="text-xs text-muted-foreground">{booking.id} - {booking.checkIn} to {booking.checkOut} - {booking.status}</div>
                  <div className={booking.forceSyncInvoiceReason ? "text-xs text-warning" : "text-xs text-success"}>{booking.forceSyncInvoiceReason || "Ready to queue invoice sync."}</div>
                </button>
              ))}
            </div>
          ) : null}
          {bookingSearch.trim().length >= 2 && !bookingSearching && bookingResults.length === 0 ? <p className="mt-1 text-xs text-muted-foreground">No matching bookings found yet.</p> : null}
        </div>
      )}
    </div>
  )
}

function MemberPicker(props: Parameters<typeof ForceSyncPicker>[0]) {
  const searching = props.memberSearching || props.xeroContactSearching
  const noResults =
    props.memberSearch.trim().length >= 2 &&
    !searching &&
    props.memberResults.length === 0 &&
    props.xeroContactResults.length === 0

  return (
    <div className="space-y-1">
      <Label>Member</Label>
      {props.selectedMember ? (
        <div className="rounded-md border bg-muted px-3 py-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{props.selectedMember.firstName} {props.selectedMember.lastName}</p>
              <p className="truncate text-xs text-muted-foreground">{props.selectedMember.email}</p>
              <p className="text-xs text-muted-foreground">Member ID: {props.selectedMember.id}{props.selectedMember.xeroContactId ? " - already linked to Xero" : " - not yet linked to Xero"}{!props.selectedMember.active ? " - inactive" : ""}</p>
            </div>
            <Button type="button" variant="outline" size="sm" disabled={props.disabled} onClick={() => { props.clearError(); props.setSelectedMember(null); props.setMemberSearch(""); props.setMemberResults([]); props.setXeroContactResults([]) }}>Change</Button>
          </div>
        </div>
      ) : (
        <div className="relative">
          <Input value={props.memberSearch} disabled={props.disabled} onChange={(event) => { props.clearError(); props.setMemberSearch(event.target.value) }} placeholder={props.type === "CONTACT" ? "Search local members and Xero contacts by name or email" : "Search by member name, email, or member ID"} />
          {searching ? <div className="absolute right-3 top-2.5 text-xs text-muted-foreground">Searching...</div> : null}
          {props.memberResults.length > 0 || props.xeroContactResults.length > 0 ? (
            <div className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-md border bg-popover text-popover-foreground shadow-lg">
              {props.memberResults.length > 0 ? (
                <div className={props.xeroContactResults.length > 0 ? "border-b" : ""}>
                  {props.type === "CONTACT" && props.xeroContactResults.length > 0 ? <div className="px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Local members</div> : null}
                  {props.memberResults.map((member) => (
                    <button key={member.id} type="button" disabled={props.disabled} onClick={() => { props.clearError(); props.setSelectedMember(member); props.setMemberSearch(""); props.setMemberResults([]); props.setXeroContactResults([]) }} className="w-full px-3 py-2 text-left text-sm hover:bg-muted">
                      <div className="font-medium text-foreground">{member.firstName} {member.lastName}</div>
                      <div className="truncate text-xs text-muted-foreground">{member.email}</div>
                      <div className="text-xs text-muted-foreground">ID {member.id}{member.xeroContactId ? " - linked" : " - unlinked"}{!member.active ? " - inactive" : ""}</div>
                    </button>
                  ))}
                </div>
              ) : null}
              {props.type === "CONTACT" && props.xeroContactResults.length > 0 ? (
                <div>
                  <div className="px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Xero contacts</div>
                  {props.xeroContactResults.map((contact) => (
                    <div key={contact.contactId} className="flex items-start justify-between gap-3 px-3 py-2 text-sm hover:bg-muted">
                      <div className="min-w-0">
                        <div className="font-medium text-foreground">{contact.name}</div>
                        <div className="truncate text-xs text-muted-foreground">{contact.email || "No email address"}</div>
                        <div className={contact.canImportAsMember ? "text-xs text-success" : "text-xs text-warning"}>{contact.canImportAsMember ? "Can be imported as a linked local member." : contact.importBlockReason || "Cannot be imported from here."}</div>
                      </div>
                      <Button type="button" size="sm" variant={contact.canImportAsMember ? "default" : "outline"} onClick={() => void props.onImportContact(contact)} disabled={props.disabled || !contact.canImportAsMember || props.importingXeroContactId === contact.contactId}>
                        {props.importingXeroContactId === contact.contactId ? "Importing..." : "Import"}
                      </Button>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          {noResults ? <p className="mt-1 text-xs text-muted-foreground">{props.type === "CONTACT" ? "No matching local members or Xero contacts found yet." : "No matching member records found yet."}</p> : null}
        </div>
      )}
    </div>
  )
}
