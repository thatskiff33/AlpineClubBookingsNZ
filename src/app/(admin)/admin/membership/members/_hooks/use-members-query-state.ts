"use client"

import { useCallback, useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import type { Filters } from "../_types"
import { emptyFilters, getInitialLifecycleStatus } from "../_utils"

import { adminHref } from "@/lib/admin-hubs";
const MEMBERS_DATASET_QUERY_KEYS = [
  "q",
  "page",
  "sortBy",
  "sortDir",
  "active",
  ...Object.keys(emptyFilters),
] as const

export function useMembersQueryState() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [search, setSearch] = useState(searchParams.get("q") || "")
  const [debouncedSearch, setDebouncedSearch] = useState(search)
  const [page, setPage] = useState(parseInt(searchParams.get("page") || "1", 10))
  const [pageSize] = useState(25)
  const [sortBy, setSortBy] = useState(searchParams.get("sortBy") || "name")
  const [sortDir, setSortDir] = useState<"asc" | "desc">(
    (searchParams.get("sortDir") as "asc" | "desc") || "asc"
  )
  const [filters, setFilters] = useState<Filters>({
    role: searchParams.get("role") || "",
    financeAccess: searchParams.get("financeAccess") || "",
    lifecycleStatus: getInitialLifecycleStatus(searchParams),
    membershipType: searchParams.get("membershipType") || "",
    ageTier: searchParams.get("ageTier") || "",
    familyGroup: searchParams.get("familyGroup") || "",
    inviteStatus: searchParams.get("inviteStatus") || "",
    xeroLinked: searchParams.get("xeroLinked") || "",
    subscription: searchParams.get("subscription") || "",
    xeroContactGroup: searchParams.get("xeroContactGroup") || "",
    contactability: searchParams.get("contactability") || "",
  })

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search)
      setPage(1)
    }, 300)
    return () => clearTimeout(timer)
  }, [search])

  const buildMembersSearchParams = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString())
    for (const key of MEMBERS_DATASET_QUERY_KEYS) params.delete(key)
    if (debouncedSearch) params.set("q", debouncedSearch)
    if (page > 1) params.set("page", String(page))
    if (sortBy !== "name") params.set("sortBy", sortBy)
    if (sortDir !== "asc") params.set("sortDir", sortDir)
    Object.entries(filters).forEach(([key, value]) => {
      if (value) params.set(key, value)
    })
    return params
  }, [debouncedSearch, filters, page, searchParams, sortBy, sortDir])

  const buildMembersListPath = useCallback(() => {
    const params = buildMembersSearchParams()
    const queryString = params.toString()
    return queryString ? `${adminHref("members")}?${queryString}` : adminHref("members")
  }, [buildMembersSearchParams])

  useEffect(() => {
    router.replace(buildMembersListPath(), { scroll: false })
  }, [buildMembersListPath, router])

  const setFilter = useCallback((key: keyof Filters, value: string) => {
    setFilters((current) => ({ ...current, [key]: value }))
    setPage(1)
  }, [])

  const resetDataset = useCallback(() => {
    setSearch("")
    setDebouncedSearch("")
    setFilters(emptyFilters)
    setSortBy("name")
    setSortDir("asc")
    setPage(1)
  }, [])

  const toggleSort = useCallback((column: string) => {
    setSortBy((currentSortBy) => {
      if (currentSortBy === column) {
        setSortDir((currentSortDir) => (currentSortDir === "asc" ? "desc" : "asc"))
        return currentSortBy
      }
      setSortDir("asc")
      return column
    })
    setPage(1)
  }, [])

  const buildExportUrl = useCallback(() => {
    const params = new URLSearchParams()
    if (debouncedSearch) params.set("q", debouncedSearch)
    Object.entries(filters).forEach(([key, value]) => {
      if (value) params.set(key, value)
    })
    const queryString = params.toString()
    return queryString ? `/api/admin/members/export?${queryString}` : "/api/admin/members/export"
  }, [debouncedSearch, filters])

  return {
    search,
    setSearch,
    debouncedSearch,
    page,
    setPage,
    pageSize,
    sortBy,
    sortDir,
    filters,
    setFilter,
    resetDataset,
    isDatasetDefault:
      search === "" &&
      debouncedSearch === "" &&
      page === 1 &&
      sortBy === "name" &&
      sortDir === "asc" &&
      Object.values(filters).every((value) => value === ""),
    activeFilterCount: Object.values(filters).filter(Boolean).length,
    toggleSort,
    buildMembersSearchParams,
    buildMembersListPath,
    buildExportUrl,
  }
}
