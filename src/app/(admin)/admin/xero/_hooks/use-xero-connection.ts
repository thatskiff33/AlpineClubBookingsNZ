"use client"

import { useCallback, useEffect, useState } from "react"
import { revealEditor } from "@/hooks/use-scroll-to-feedback"
import { toSafeXeroOAuthCallbackMessage } from "@/lib/xero-oauth-callback-messages"
import { SECTION_DEFAULTS, SECTION_STORAGE_KEY, type SectionKey, type XeroStatus } from "../_components/types"

export function useXeroConnection() {
  const [status, setStatus] = useState<XeroStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [connectSuccess, setConnectSuccess] = useState(false)
  const [sectionOpen, setSectionOpen] = useState<Record<SectionKey, boolean>>(SECTION_DEFAULTS)
  const [sectionsHydrated, setSectionsHydrated] = useState(false)
  // A "go to section" request: which section, and a nonce so the same section
  // can be asked for twice. Opening the section and recording the request land
  // in one commit, and the effect below runs after that commit — so the section
  // exists when it is revealed, with no timer guessing at when (#2934).
  const [revealRequest, setRevealRequest] = useState<{ section: SectionKey; nonce: number } | null>(null)

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/xero/status")
      if (!res.ok) throw new Error("Failed to fetch status")
      const data: XeroStatus = await res.json()
      setStatus(data)
    } catch {
      setError("Failed to load Xero connection status")
    } finally {
      setLoading(false)
    }
  }, [])

  const setSectionState = useCallback((section: SectionKey, nextOpen: boolean) => {
    setSectionOpen((prev) => ({ ...prev, [section]: nextOpen }))
  }, [])

  const scrollToSection = useCallback((section: SectionKey) => {
    setSectionOpen((prev) => ({ ...prev, [section]: true }))
    setRevealRequest((prev) => ({ section, nonce: (prev?.nonce ?? 0) + 1 }))
  }, [])

  useEffect(() => {
    if (!revealRequest) return
    revealEditor(document.getElementById(`xero-section-${revealRequest.section}`))
  }, [revealRequest])

  const handleConnect = useCallback(() => {
    window.location.href = "/api/admin/xero/connect"
  }, [])

  const handleDisconnect = useCallback(async () => {
    if (!confirm("Are you sure you want to disconnect Xero? This will remove all stored tokens.")) return
    try {
      const res = await fetch("/api/admin/xero/disconnect", { method: "POST" })
      if (!res.ok) throw new Error("Failed to disconnect")
      setStatus({ connected: false, needsReentry: false, tenantId: null, tokenExpiresAt: null })
    } catch {
      setError("Failed to disconnect Xero")
    }
  }, [])

  useEffect(() => {
    void fetchStatus()
  }, [fetchStatus])

  useEffect(() => {
    try {
      const storedState = window.localStorage.getItem(SECTION_STORAGE_KEY)
      if (storedState) {
        setSectionOpen((prev) => ({
          ...prev,
          ...(JSON.parse(storedState) as Partial<Record<SectionKey, boolean>>),
        }))
      }
    } catch {
      // Ignore malformed localStorage state and fall back to defaults.
    } finally {
      setSectionsHydrated(true)
    }
  }, [])

  useEffect(() => {
    if (sectionsHydrated) window.localStorage.setItem(SECTION_STORAGE_KEY, JSON.stringify(sectionOpen))
  }, [sectionOpen, sectionsHydrated])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get("connected") === "true") {
      setConnectSuccess(true)
      void fetchStatus()
    }
    // ALLOW-LISTED, not rendered raw (#2394 review, F9). The callback route only
    // ever emits one of three messages of ours, and this value now reaches a
    // danger-styled box on two admin pages — so a crafted link must not be able
    // to put arbitrary prose of arbitrary length into an authoritative-looking
    // red banner on a trusted page. Anything unrecognised becomes the generic
    // "Xero connection failed" rather than being dropped: the connect attempt
    // really did fail, and silence would be worse. `params.get` is already
    // percent-decoded, so the old extra `decodeURIComponent` was both redundant
    // and a `URIError` waiting for a malformed escape.
    const safeError = toSafeXeroOAuthCallbackMessage(params.get("error"))
    if (safeError) setError(safeError)
  }, [fetchStatus])

  return {
    status,
    loading,
    error,
    setError,
    connectSuccess,
    setConnectSuccess,
    sectionOpen,
    setSectionState,
    scrollToSection,
    handleConnect,
    handleDisconnect,
  }
}
