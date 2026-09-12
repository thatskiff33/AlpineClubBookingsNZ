"use client"

// Item 15 (#1931, E5): shared client helpers that fetch the read-only joining
// fee preview (default amount + narration) so an admin sees what would be
// invoiced BEFORE overriding. Backed by POST
// /api/admin/members/[id]/joining-fee/preview (memberId mode for existing
// members; raw type+tier/DOB inputs for a not-yet-created applicant). No writes,
// no Xero calls.

import { useEffect, useRef, useState } from "react"
import { formatCents } from "@/lib/utils"

export interface JoiningFeePreviewResult {
  defaultAmountCents: number | null
  defaultNarration: string
  exempt: boolean
  exemptReason?: string
  effectiveFrom: string | null
  source: "SCHEDULE" | "NONE"
}

export interface JoiningFeePreviewState {
  loading: boolean
  loaded: boolean
  error: string | null
  preview: JoiningFeePreviewResult | null
}

// Raw inputs for a not-yet-created applicant. Only defined keys are sent (the
// route schema is strict and rejects nulls), so build these without null values.
export interface JoiningFeePreviewInputs {
  membershipTypeId?: string
  membershipTypeKey?: string
  ageTier?: string
  dateOfBirth?: string // YYYY-MM-DD
}

const IDLE: JoiningFeePreviewState = { loading: false, loaded: false, error: null, preview: null }

/**
 * Fetch the joining-fee preview for the member named by `pathId` (or for raw
 * `inputs` when supplied — the path id is then only the route segment). The
 * fetch runs only while `enabled` is true.
 */
export function useJoiningFeePreview(params: {
  pathId: string | null | undefined
  enabled: boolean
  inputs?: JoiningFeePreviewInputs
}): JoiningFeePreviewState {
  const { pathId, enabled } = params
  const bodyStr = params.inputs ? JSON.stringify(params.inputs) : "{}"
  const [state, setState] = useState<JoiningFeePreviewState>(IDLE)

  useEffect(() => {
    if (!enabled || !pathId) {
      setState(IDLE)
      return
    }
    let cancelled = false
    setState((prev) => ({ ...prev, loading: true, error: null }))
    fetch(`/api/admin/members/${encodeURIComponent(pathId)}/joining-fee/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: bodyStr,
    })
      .then(async (res) => {
        const data = await res.json().catch(() => null)
        if (cancelled) return
        if (!res.ok) {
          setState({ loading: false, loaded: false, error: (data && data.error) || "Failed to load default", preview: null })
          return
        }
        setState({ loading: false, loaded: true, error: null, preview: data as JoiningFeePreviewResult })
      })
      .catch(() => {
        if (!cancelled) setState({ loading: false, loaded: false, error: "Failed to load default", preview: null })
      })
    return () => {
      cancelled = true
    }
  }, [enabled, pathId, bodyStr])

  return state
}

/**
 * One-line hint describing the resolved default (or the exempt / no-fee state).
 * Rendered under the override fields so overriding is an informed choice.
 */
export function JoiningFeePreviewHint({ state }: { state: JoiningFeePreviewState }) {
  if (state.loading) {
    return <p className="text-xs text-muted-foreground">Resolving the default joining fee…</p>
  }
  if (state.error) {
    return <p className="text-xs text-muted-foreground">Default joining fee unavailable ({state.error}).</p>
  }
  const preview = state.preview
  if (!preview) return null
  if (preview.exempt) {
    return (
      <p className="text-xs text-muted-foreground">
        Exempt from joining fees{preview.exemptReason ? ` — ${preview.exemptReason}` : ""}. No invoice is raised.
      </p>
    )
  }
  if (preview.defaultAmountCents == null) {
    return <p className="text-xs text-muted-foreground">No joining fee is configured for this membership type.</p>
  }
  return (
    <p className="text-xs text-muted-foreground">
      Default: <span className="font-medium">{formatCents(preview.defaultAmountCents)}</span> ·
      narration “{preview.defaultNarration}”. Leave the fields as prefilled to use the default, or edit to override.
    </p>
  )
}

/**
 * Prefill the amount + narration override fields with the resolved default the
 * first time a preview arrives for a given `prefillKey`, but only while a field
 * is still empty (never clobbering an admin edit). Sending the default amount
 * explicitly resolves to the same value the backend would use when blank, so
 * prefilling is behaviour-preserving and simply makes the default visible.
 */
export function useJoiningFeePrefill(args: {
  preview: JoiningFeePreviewResult | null
  prefillKey: string
  amount: string
  narration: string
  setAmount: (value: string) => void
  setNarration: (value: string) => void
}) {
  const { preview, prefillKey, amount, narration, setAmount, setNarration } = args
  // Which prefillKey has already been prefilled. A ref (not state) so writing it
  // never re-renders; only ever read/written inside the effect below.
  const doneKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!preview || preview.exempt || preview.defaultAmountCents == null) return
    // Prefill at most once per key. Re-runs (e.g. as the admin types) return
    // here, so an edit is never clobbered; a new key re-arms prefill.
    if (doneKeyRef.current === prefillKey) return
    doneKeyRef.current = prefillKey
    if (amount.trim() === "") setAmount((preview.defaultAmountCents / 100).toFixed(2))
    if (narration.trim() === "") setNarration(preview.defaultNarration)
  }, [preview, prefillKey, amount, narration, setAmount, setNarration])
}
