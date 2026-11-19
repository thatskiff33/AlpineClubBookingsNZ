"use client"

import { useCallback, useEffect, useRef } from "react"

/**
 * A Xero setup section's automatic load, latched to run once per opening
 * (ALP-591, #5203). It fires when the section is `active` (connected and
 * open), its data is still `needed`, and no load is `busy`. After a failed or
 * empty load nothing more is requested until the admin acts: without the latch
 * the effect re-fired each time `busy` settled, so a failing read looped. The
 * latch re-arms when the section closes or Xero disconnects; the returned
 * `rearm` lets a control that clears the data (Reset) ask for one more load.
 */
export function useAutoLoadOncePerOpening(input: {
  active: boolean
  needed: boolean
  busy: boolean
  load: () => Promise<void>
}): { rearm: () => void } {
  const { active, needed, busy, load } = input
  const attemptedRef = useRef(false)
  useEffect(() => {
    if (!active) {
      attemptedRef.current = false
      return
    }
    if (attemptedRef.current || !needed || busy) return
    attemptedRef.current = true
    void load()
  }, [active, busy, load, needed])
  const rearm = useCallback(() => {
    attemptedRef.current = false
  }, [])
  return { rearm }
}
