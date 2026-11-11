"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { loadAdminXeroContactGroups } from "@/lib/admin-xero-contact-groups"
import { useXeroStatus } from "@/hooks/use-xero-status"
import type { XeroContactGroup, XeroFeatureFlags } from "../_types"

interface UseXeroContactGroupsOptions {
  onError: (message: string) => void
  onSuccess: (message: string) => void
  refreshMembers: () => Promise<void>
}

export function useXeroContactGroups({
  onError,
  onSuccess,
  refreshMembers,
}: UseXeroContactGroupsOptions) {
  const { connected: xeroConnected, features } = useXeroStatus()
  const xeroFeatures: XeroFeatureFlags = useMemo(
    () => ({
      autoLoadContactGroups: features.autoLoadContactGroups,
      liveMemberGroupLookups: features.liveMemberGroupLookups,
    }),
    [features.autoLoadContactGroups, features.liveMemberGroupLookups]
  )
  const [xeroContactGroupsList, setXeroContactGroupsList] = useState<XeroContactGroup[]>([])
  const [refreshingXeroGroups, setRefreshingXeroGroups] = useState(false)
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null)

  useEffect(() => {
    // Whenever Xero is connected we read the cached contact-groups snapshot so
    // the page can show when it was last refreshed, regardless of feature
    // flags. The groups *list* is only adopted for the filter toolbar under the
    // existing auto-load conditions, so filter behavior is unchanged.
    if (!xeroConnected) {
      return
    }
    const shouldLoadGroupsList =
      features.autoLoadContactGroups && features.liveMemberGroupLookups
    let cancelled = false
    fetch("/api/admin/xero/contact-groups")
      .then((res) => (res.ok ? res.json() : null))
      .then(
        (
          groupsData:
            | { groups?: XeroContactGroup[]; lastRefreshedAt?: string | null }
            | null
        ) => {
          if (cancelled || !groupsData) return
          setLastRefreshedAt(groupsData.lastRefreshedAt ?? null)
          if (shouldLoadGroupsList && groupsData.groups) {
            setXeroContactGroupsList(groupsData.groups)
          }
        }
      )
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [
    xeroConnected,
    features.autoLoadContactGroups,
    features.liveMemberGroupLookups,
  ])

  const refreshXeroGroups = useCallback(async () => {
    if (!xeroConnected) return

    setRefreshingXeroGroups(true)
    try {
      const result = await loadAdminXeroContactGroups({ refreshFromXero: true })
      setXeroContactGroupsList(result.groups)
      setLastRefreshedAt(result.lastRefreshedAt)
      await refreshMembers()
      onSuccess(
        result.groups.length > 0
          ? "Refreshed Xero contact groups"
          : "Refreshed Xero contact groups. No active groups were returned."
      )
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to refresh Xero contact groups")
    } finally {
      setRefreshingXeroGroups(false)
    }
  }, [onError, onSuccess, refreshMembers, xeroConnected])

  return {
    xeroConnected,
    xeroFeatures,
    xeroContactGroupsList,
    refreshingXeroGroups,
    refreshXeroGroups,
    lastRefreshedAt,
  }
}
