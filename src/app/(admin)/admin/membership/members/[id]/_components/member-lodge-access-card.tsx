"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  AdminViewOnlyNotice,
  ViewOnlyActionButton,
  type AncestorViewOnlyBannerProps,
} from "@/components/admin/view-only-action"
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { LodgeOptionsUnavailableNotice } from "@/components/admin/lodge-options-status"
import { useLodgeOptions } from "@/components/lodge-select"

interface LodgeAccessRow {
  id: string
  lodgeId: string
  kind: "BOOKING_RESTRICTION" | "STAFF"
}

// Per-lodge access grants for one member (multi-lodge phase 7 admin UI over
// the phase-4 API). Booking restriction is default-open: no ticked lodges
// means the member may book every lodge. STAFF grants bind a kiosk account
// to its lodge. Renders nothing while fewer than two lodges exist (ADR-002
// presentation rule).
interface MemberLodgeAccessCardProps extends AncestorViewOnlyBannerProps {
  memberId: string
}

export function MemberLodgeAccessCard({
  memberId,
  ancestorRendersViewOnlyBanner = false,
}: MemberLodgeAccessCardProps) {
  // lodge-access writes /api/admin/members/[id]/lodge-access (membership area);
  // a view-only membership admin sees the grants but cannot change them (#1997).
  const canEdit = useAdminAreaEditAccess("membership")
  /*
    #2701: this card is drawn ENTIRELY from the lodge list — every tickbox is a
    lodge — so a failed list rendered it as a club with fewer than two lodges and
    the whole card disappeared. That is the worst outcome on this page: a member
    whose bookings are restricted to one lodge looks unrestricted, and the
    restriction cannot be lifted because there is nothing on screen to untick.
    Saving would have been worse still — the PUT sends the ticked ids as the
    complete set, so an empty render saved as "clear every grant". The card now
    states the failure and renders no controls at all.
  */
  const {
    lodges,
    loading: lodgesLoading,
    failed: lodgesFailed,
    forbidden: lodgesForbidden,
    reload: reloadLodges,
  } = useLodgeOptions("admin")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [success, setSuccess] = useState("")
  const [bookingRestrictionLodgeIds, setBookingRestrictionLodgeIds] = useState<
    string[]
  >([])
  const [staffLodgeIds, setStaffLodgeIds] = useState<string[]>([])
  const lodgeOptionsReady =
    !lodgesLoading && !lodgesFailed && !lodgesForbidden && lodges.length >= 2
  const lodgeOptionsKey = lodgeOptionsReady
    ? lodges
        .map((lodge) => lodge.id)
        .sort()
        .join("\u0000")
    : ""
  const loadSequenceRef = useRef(0)
  const saveSequenceRef = useRef(0)
  const lodgeOptionsReadyRef = useRef(lodgeOptionsReady)
  const lodgeOptionsKeyRef = useRef(lodgeOptionsKey)
  useEffect(() => {
    lodgeOptionsReadyRef.current = lodgeOptionsReady
    lodgeOptionsKeyRef.current = lodgeOptionsKey
  }, [lodgeOptionsKey, lodgeOptionsReady])

  const loadAccess = useCallback(async () => {
    const sequence = (loadSequenceRef.current += 1)
    // #2701: the grants are only meaningful next to the lodges they name, and
    // no control renders without them, so there is nothing to load them for.
    if (!lodgeOptionsReady) {
      saveSequenceRef.current += 1
      setLoading(false)
      setError("")
      setSuccess("")
      setBookingRestrictionLodgeIds([])
      setStaffLodgeIds([])
      return
    }
    setLoading(true)
    setError("")
    try {
      const res = await fetch(`/api/admin/members/${memberId}/lodge-access`)
      const body = await res.json()
      if (
        sequence !== loadSequenceRef.current ||
        !lodgeOptionsReadyRef.current ||
        lodgeOptionsKeyRef.current !== lodgeOptionsKey
      ) {
        return
      }
      if (!res.ok) {
        throw new Error(body.error || "Failed to load lodge access")
      }
      const rows = (body.lodgeAccess ?? []) as LodgeAccessRow[]
      setBookingRestrictionLodgeIds(
        rows
          .filter((row) => row.kind === "BOOKING_RESTRICTION")
          .map((row) => row.lodgeId),
      )
      setStaffLodgeIds(
        rows.filter((row) => row.kind === "STAFF").map((row) => row.lodgeId),
      )
    } catch (loadError) {
      if (
        sequence !== loadSequenceRef.current ||
        !lodgeOptionsReadyRef.current ||
        lodgeOptionsKeyRef.current !== lodgeOptionsKey
      ) {
        return
      }
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load lodge access",
      )
    } finally {
      if (
        sequence === loadSequenceRef.current &&
        lodgeOptionsReadyRef.current &&
        lodgeOptionsKeyRef.current === lodgeOptionsKey
      ) {
        setLoading(false)
      }
    }
  }, [lodgeOptionsKey, memberId, lodgeOptionsReady])

  useEffect(() => {
    void loadAccess()
  }, [loadAccess])

  async function save() {
    // #2701 backstop: no Save button renders while the lodge list is missing,
    // and a PUT from here would send the empty tick state as the member's whole
    // set of grants — silently revoking every restriction and staff binding.
    if (!lodgeOptionsReady) return
    const sequence = (saveSequenceRef.current += 1)
    const ownsCurrentScope = () =>
      sequence === saveSequenceRef.current &&
      lodgeOptionsReadyRef.current &&
      lodgeOptionsKeyRef.current === lodgeOptionsKey
    setSaving(true)
    setError("")
    setSuccess("")
    try {
      const res = await fetch(`/api/admin/members/${memberId}/lodge-access`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookingRestrictionLodgeIds, staffLodgeIds }),
      })
      const body = await res.json()
      if (!ownsCurrentScope()) return
      if (!res.ok) {
        throw new Error(body.error || "Failed to save lodge access")
      }
      setSuccess("Lodge access saved.")
    } catch (saveError) {
      if (!ownsCurrentScope()) return
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Failed to save lodge access",
      )
    } finally {
      if (ownsCurrentScope()) setSaving(false)
    }
  }

  function toggle(
    lodgeId: string,
    checked: boolean,
    setIds: React.Dispatch<React.SetStateAction<string[]>>,
  ) {
    setSuccess("")
    setIds((current) =>
      checked ? [...current, lodgeId] : current.filter((id) => id !== lodgeId),
    )
  }

  // #2701: checked BEFORE the single-lodge rule below, because on a failure the
  // list is empty and would otherwise read as a single-lodge club. This card
  // must say the grants cannot be shown rather than quietly not existing.
  if (lodgesFailed || lodgesForbidden) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium">Lodge Access</CardTitle>
        </CardHeader>
        <CardContent>
          <LodgeOptionsUnavailableNotice
            failed={lodgesFailed}
            forbidden={lodgesForbidden}
            onRetry={reloadLodges}
            what="this member's lodge access grants"
          />
        </CardContent>
      </Card>
    )
  }

  // Single-lodge presentation rule: the card only exists once a second
  // active lodge does.
  if (lodgesLoading || lodges.length < 2) {
    return null
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium">Lodge Access</CardTitle>
        <CardDescription>
          Booking access is open by default: with no lodges ticked this member
          can book every lodge. Ticking lodges restricts their bookings to
          those lodges only. Staff grants bind a kiosk account to its lodge.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading lodge access...</p>
        ) : (
          <div className="space-y-4">
            {/*
              #2168: this Notice also covers the disabled CHECKBOXES below,
              which are not ViewOnlyActionButtons, so it is dropped only when an
              ancestor vouches that it states the same membership scope above
              this card — on `/admin/members/[id]` the page banner does. Rendered
              standalone, or under any parent that does not vouch, the Notice
              stays and this card still explains itself.
            */}
            {!ancestorRendersViewOnlyBanner ? (
              <AdminViewOnlyNotice canEdit={canEdit}>
                Your admin role can view lodge access but cannot change it.
              </AdminViewOnlyNotice>
            ) : null}
            <div className="space-y-2">
              <Label>Restrict bookings to</Label>
              <div className="flex flex-wrap gap-4">
                {lodges.map((lodge) => (
                  <label key={lodge.id} className="flex items-center space-x-2">
                    <input
                      type="checkbox"
                      checked={bookingRestrictionLodgeIds.includes(lodge.id)}
                      disabled={!canEdit}
                      onChange={(e) =>
                        toggle(
                          lodge.id,
                          e.target.checked,
                          setBookingRestrictionLodgeIds,
                        )
                      }
                      className="rounded border-input"
                    />
                    <span className="text-sm">{lodge.name}</span>
                  </label>
                ))}
              </div>
              {bookingRestrictionLodgeIds.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No restriction — this member can book every lodge.
                </p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label>Staff (kiosk) lodges</Label>
              <div className="flex flex-wrap gap-4">
                {lodges.map((lodge) => (
                  <label key={lodge.id} className="flex items-center space-x-2">
                    <input
                      type="checkbox"
                      checked={staffLodgeIds.includes(lodge.id)}
                      disabled={!canEdit}
                      onChange={(e) =>
                        toggle(lodge.id, e.target.checked, setStaffLodgeIds)
                      }
                      className="rounded border-input"
                    />
                    <span className="text-sm">{lodge.name}</span>
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Only needed for lodge-operational (kiosk) accounts; it does not
                affect booking access.
              </p>
            </div>
            {error ? <p className="text-sm text-danger-11">{error}</p> : null}
            {success ? (
              <p className="text-sm text-success-11">{success}</p>
            ) : null}
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={!ancestorRendersViewOnlyBanner}
              onClick={() => void save()}
              disabled={saving}
            >
              {saving ? "Saving..." : "Save Lodge Access"}
            </ViewOnlyActionButton>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
