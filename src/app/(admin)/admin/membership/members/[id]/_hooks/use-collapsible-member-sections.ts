"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  collapsibleMemberSections,
  isCollapsibleMemberSection,
  memberSectionStorageKeys,
  type CollapsibleMemberSection,
} from "@/lib/admin-member-detail-helpers"

export function useCollapsibleMemberSections() {
  const [persistedSections, setPersistedSections] = useState<
    CollapsibleMemberSection[]
  >([])
  // Sections opened programmatically (the #account-credit deep link). They
  // stay out of localStorage so a deep-linked visit
  // does not pin the group open for every future member page.
  const [forcedSections, setForcedSections] = useState<
    CollapsibleMemberSection[]
  >([])

  useEffect(() => {
    try {
      setPersistedSections(
        collapsibleMemberSections.filter((section) => {
          const storedValue = window.localStorage.getItem(
            memberSectionStorageKeys[section]
          )
          return storedValue === "true" || storedValue === "open"
        })
      )
    } catch {
      // localStorage unavailable; sections stay collapsed for this visit.
    }
  }, [])

  const openSections = useMemo(
    () =>
      collapsibleMemberSections.filter(
        (section) =>
          persistedSections.includes(section) ||
          forcedSections.includes(section)
      ),
    [persistedSections, forcedSections]
  )

  const onValueChange = (value: string[]) => {
    const nextSections = value.filter(isCollapsibleMemberSection)
    // A forced-open section stays transient while open; closing it clears the
    // force. Only user-driven opens beyond the forced set are persisted.
    const nextForced = forcedSections.filter((section) =>
      nextSections.includes(section)
    )
    const nextPersisted = nextSections.filter(
      (section) => !nextForced.includes(section)
    )
    setForcedSections(nextForced)
    setPersistedSections(nextPersisted)

    try {
      collapsibleMemberSections.forEach((section) => {
        window.localStorage.setItem(
          memberSectionStorageKeys[section],
          String(nextPersisted.includes(section))
        )
      })
    } catch {
      // Ignore storage failures; the accordion still works for this visit.
    }
  }

  const openSection = useCallback(
    (
      section: CollapsibleMemberSection,
      { persist = false }: { persist?: boolean } = {}
    ) => {
      if (persist) {
        setPersistedSections((current) =>
          current.includes(section) ? current : [...current, section]
        )
        try {
          window.localStorage.setItem(
            memberSectionStorageKeys[section],
            "true"
          )
        } catch {
          // Ignore storage failures.
        }
        return
      }
      // Already persisted-open: forcing it would demote it to transient on
      // the next accordion interaction, silently unpinning it.
      if (persistedSections.includes(section)) return
      setForcedSections((current) =>
        current.includes(section) ? current : [...current, section]
      )
    },
    [persistedSections]
  )

  return { openSections, onValueChange, openSection }
}
