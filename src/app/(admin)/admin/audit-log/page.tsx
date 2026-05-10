"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ExternalLink,
  Loader2,
  Search,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DateRangeControls } from "@/components/admin/date-range-controls";
import { auditAndPaymentsDateRangePresets } from "@/lib/date-range-presets";
import {
  AUDIT_TIMELINE_CATEGORY_OPTIONS,
  type AuditDrilldownLink,
  type AuditTimelineEntry,
  type AuditTimelineResponse,
} from "@/lib/audit-query";

type AuditFacets = {
  eventTypes: string[];
  categories: string[];
  entityTypes: string[];
  outcomes: string[];
  severities: string[];
};

type AdminAuditResponse = AuditTimelineResponse & {
  facets?: AuditFacets;
};

type PickedMember = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role?: string;
  ageTier?: string;
};

const emptyFacets: AuditFacets = {
  eventTypes: [],
  categories: [],
  entityTypes: [],
  outcomes: [],
  severities: [],
};

const categoryBadgeClasses: Record<string, string> = {
  account: "bg-sky-100 text-sky-800 border-sky-200",
  booking: "bg-emerald-100 text-emerald-800 border-emerald-200",
  payment: "bg-violet-100 text-violet-800 border-violet-200",
  family: "bg-teal-100 text-teal-800 border-teal-200",
  admin: "bg-slate-100 text-slate-800 border-slate-200",
  security: "bg-rose-100 text-rose-800 border-rose-200",
  lodge: "bg-amber-100 text-amber-800 border-amber-200",
  xero: "bg-blue-100 text-blue-800 border-blue-200",
  communication: "bg-cyan-100 text-cyan-800 border-cyan-200",
  privacy: "bg-fuchsia-100 text-fuchsia-800 border-fuchsia-200",
  system: "bg-neutral-100 text-neutral-800 border-neutral-200",
};

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("en-NZ", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function titleCase(value: string) {
  return value
    .replace(/[._-]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((word) => {
      const lower = word.toLowerCase();
      return `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
    })
    .join(" ");
}

function categoryLabel(category: string) {
  return (
    AUDIT_TIMELINE_CATEGORY_OPTIONS.find((option) => option.value === category)
      ?.label ?? titleCase(category)
  );
}

function hasExpandedDetails(entry: AuditTimelineEntry) {
  return Boolean(
    entry.details ||
      entry.metadata ||
      entry.requestId ||
      entry.ipAddress ||
      entry.userAgent ||
      entry.retentionClass
  );
}

function sortedUnique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) =>
    a.localeCompare(b)
  );
}

function PrimaryDrilldowns({ links }: { links: AuditDrilldownLink[] }) {
  if (links.length === 0) {
    return <span className="text-xs text-slate-400">No direct target</span>;
  }

  const primaryLinks = links.filter((link) => link.primary);
  const visibleLinks = (primaryLinks.length > 0 ? primaryLinks : links).slice(0, 2);

  return (
    <div className="flex flex-wrap gap-1.5">
      {visibleLinks.map((link) => (
        <Button key={link.href} asChild variant="outline" size="sm" className="h-7 px-2">
          <Link href={link.href} onClick={(event) => event.stopPropagation()}>
            <ExternalLink className="mr-1 h-3.5 w-3.5" />
            {link.label}
          </Link>
        </Button>
      ))}
    </div>
  );
}

function MemberSearchFilter({
  selected,
  onSelect,
  onClear,
}: {
  selected: PickedMember | null;
  onSelect: (member: PickedMember) => void;
  onClear: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PickedMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      setOpen(false);
      return;
    }

    const handle = window.setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({
          q: query.trim(),
          pageSize: "8",
        });
        const res = await fetch(`/api/admin/members?${params.toString()}`);
        if (res.ok) {
          const data = (await res.json()) as { members?: PickedMember[] };
          setResults(data.members ?? []);
          setOpen(true);
        }
      } finally {
        setLoading(false);
      }
    }, 250);

    return () => window.clearTimeout(handle);
  }, [query]);

  useEffect(() => {
    function handleClick(event: MouseEvent) {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  if (selected) {
    return (
      <div className="min-w-64 space-y-1">
        <Label className="text-xs">Member</Label>
        <div className="flex h-9 items-center gap-2 rounded-md border px-3 text-sm">
          <span className="min-w-0 flex-1 truncate">
            {selected.firstName} {selected.lastName}
          </span>
          {selected.role ? (
            <Badge variant="secondary" className="text-[10px]">
              {selected.role}
            </Badge>
          ) : null}
          <button
            type="button"
            className="text-slate-500 hover:text-slate-900"
            onClick={onClear}
            aria-label="Clear member filter"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div ref={wrapperRef} className="relative min-w-64 space-y-1">
      <Label className="text-xs">Member</Label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onFocus={() => results.length > 0 && setOpen(true)}
          placeholder="Name, email, or ID"
          className="pl-8"
        />
      </div>
      {loading ? (
        <p className="text-xs text-slate-400">Searching...</p>
      ) : null}
      {open && (
        <div className="absolute z-50 mt-1 max-h-72 w-full overflow-y-auto rounded-md border bg-white shadow-lg">
          {results.length === 0 ? (
            <p className="px-3 py-2 text-sm text-slate-500">No members found</p>
          ) : (
            results.map((member) => (
              <button
                key={member.id}
                type="button"
                className="w-full border-b px-3 py-2 text-left last:border-b-0 hover:bg-slate-50"
                onClick={() => {
                  onSelect(member);
                  setQuery("");
                  setOpen(false);
                }}
              >
                <span className="block text-sm font-medium">
                  {member.firstName} {member.lastName}
                </span>
                <span className="block text-xs text-slate-500">
                  {member.email}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export default function AuditLogPage() {
  const [eventType, setEventType] = useState("all");
  const [category, setCategory] = useState("all");
  const [selectedMember, setSelectedMember] = useState<PickedMember | null>(null);
  const [memberScope, setMemberScope] = useState("involves");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [outcome, setOutcome] = useState("all");
  const [severity, setSeverity] = useState("all");
  const [entityType, setEntityType] = useState("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize] = useState(25);
  const [entries, setEntries] = useState<AuditTimelineEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [facets, setFacets] = useState<AuditFacets>(emptyFacets);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
      });
      if (eventType !== "all") params.set("eventType", eventType);
      if (category !== "all") params.set("category", category);
      if (selectedMember) params.set("memberId", selectedMember.id);
      if (selectedMember && memberScope !== "involves") {
        params.set("memberScope", memberScope);
      }
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      if (outcome !== "all") params.set("outcome", outcome);
      if (severity !== "all") params.set("severity", severity);
      if (entityType !== "all") params.set("entityType", entityType);
      if (search.trim()) params.set("q", search.trim());

      const res = await fetch(`/api/admin/audit-log?${params.toString()}`);
      const json = (await res.json().catch(() => ({}))) as AdminAuditResponse & {
        error?: string;
      };

      if (!res.ok) {
        throw new Error(json.error || "Failed to load audit log");
      }

      setEntries(json.data ?? []);
      setTotal(json.total ?? 0);
      setTotalPages(json.totalPages ?? 1);
      setFacets(json.facets ?? emptyFacets);
    } catch (err) {
      setEntries([]);
      setTotal(0);
      setTotalPages(1);
      setError(err instanceof Error ? err.message : "Failed to load audit log");
    } finally {
      setLoading(false);
    }
  }, [
    category,
    entityType,
    eventType,
    from,
    memberScope,
    outcome,
    page,
    pageSize,
    search,
    selectedMember,
    severity,
    to,
  ]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const rangeLabel = useMemo(() => {
    if (total === 0) {
      return "No records";
    }
    const start = (page - 1) * pageSize + 1;
    const end = Math.min(page * pageSize, total);
    return `${start}-${end} of ${total}`;
  }, [page, pageSize, total]);

  const eventTypeOptions = sortedUnique(facets.eventTypes);
  const outcomeOptions = sortedUnique(facets.outcomes);
  const severityOptions = sortedUnique(facets.severities);
  const entityTypeOptions = sortedUnique(facets.entityTypes);

  function resetPage() {
    setPage(1);
  }

  function clearFilters() {
    setEventType("all");
    setCategory("all");
    setSelectedMember(null);
    setMemberScope("involves");
    setFrom("");
    setTo("");
    setOutcome("all");
    setSeverity("all");
    setEntityType("all");
    setSearch("");
    setPage(1);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Audit Log</h1>
        <p className="mt-1 text-sm text-slate-500">
          Review system, member, finance, booking, Xero, and admin activity
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-white p-4">
        <div className="space-y-1">
          <Label className="text-xs">Event Type</Label>
          <Select
            value={eventType}
            onValueChange={(value) => {
              setEventType(value);
              resetPage();
            }}
          >
            <SelectTrigger className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All event types</SelectItem>
              {eventTypeOptions.map((value) => (
                <SelectItem key={value} value={value}>
                  {titleCase(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label className="text-xs">Category</Label>
          <Select
            value={category}
            onValueChange={(value) => {
              setCategory(value);
              resetPage();
            }}
          >
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AUDIT_TIMELINE_CATEGORY_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <MemberSearchFilter
          selected={selectedMember}
          onSelect={(member) => {
            setSelectedMember(member);
            resetPage();
          }}
          onClear={() => {
            setSelectedMember(null);
            resetPage();
          }}
        />

        <div className="space-y-1">
          <Label className="text-xs">Member Scope</Label>
          <Select
            value={memberScope}
            onValueChange={(value) => {
              setMemberScope(value);
              resetPage();
            }}
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="involves">Involves</SelectItem>
              <SelectItem value="actor">Actor</SelectItem>
              <SelectItem value="subject">Subject</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <DateRangeControls
          presets={auditAndPaymentsDateRangePresets}
          from={from}
          to={to}
          onFromChange={(value) => {
            setFrom(value);
            resetPage();
          }}
          onToChange={(value) => {
            setTo(value);
            resetPage();
          }}
        />

        <div className="space-y-1">
          <Label className="text-xs">Outcome</Label>
          <Select
            value={outcome}
            onValueChange={(value) => {
              setOutcome(value);
              resetPage();
            }}
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All outcomes</SelectItem>
              {outcomeOptions.map((value) => (
                <SelectItem key={value} value={value}>
                  {titleCase(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label className="text-xs">Severity</Label>
          <Select
            value={severity}
            onValueChange={(value) => {
              setSeverity(value);
              resetPage();
            }}
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All severities</SelectItem>
              {severityOptions.map((value) => (
                <SelectItem key={value} value={value}>
                  {titleCase(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label className="text-xs">Entity</Label>
          <Select
            value={entityType}
            onValueChange={(value) => {
              setEntityType(value);
              resetPage();
            }}
          >
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All entities</SelectItem>
              {entityTypeOptions.map((value) => (
                <SelectItem key={value} value={value}>
                  {titleCase(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="min-w-64 space-y-1">
          <Label className="text-xs">Search</Label>
          <Input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              resetPage();
            }}
            placeholder="Action, summary, request, entity"
          />
        </div>

        <Button type="button" variant="outline" size="sm" onClick={clearFilters}>
          <X className="mr-1 h-4 w-4" />
          Clear
        </Button>
      </div>

      {error ? (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {error}
        </div>
      ) : null}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead className="w-44">Timestamp</TableHead>
                <TableHead>Event</TableHead>
                <TableHead className="w-44">Actor</TableHead>
                <TableHead className="w-44">Subject</TableHead>
                <TableHead className="w-40">Entity</TableHead>
                <TableHead className="w-48">Drilldown</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-slate-500">
                    <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                    Loading audit events
                  </TableCell>
                </TableRow>
              ) : entries.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-slate-500">
                    No audit entries found
                  </TableCell>
                </TableRow>
              ) : (
                entries.map((entry) => {
                  const expanded = expandedId === entry.id;
                  const expandable = hasExpandedDetails(entry);

                  return (
                    <Fragment key={entry.id}>
                      <TableRow
                        className={expandable ? "cursor-pointer hover:bg-slate-50" : ""}
                        onClick={() => {
                          if (expandable) {
                            setExpandedId(expanded ? null : entry.id);
                          }
                        }}
                      >
                        <TableCell>
                          {expandable ? (
                            expanded ? (
                              <ChevronUp className="h-4 w-4" />
                            ) : (
                              <ChevronDown className="h-4 w-4" />
                            )
                          ) : null}
                        </TableCell>
                        <TableCell className="align-top text-xs text-slate-500">
                          {formatDateTime(entry.createdAt)}
                        </TableCell>
                        <TableCell className="align-top">
                          <div className="space-y-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Badge
                                variant="secondary"
                                className={
                                  categoryBadgeClasses[entry.category] ??
                                  categoryBadgeClasses.system
                                }
                              >
                                {categoryLabel(entry.category)}
                              </Badge>
                              {entry.severity ? (
                                <Badge variant="outline" className="capitalize">
                                  {entry.severity}
                                </Badge>
                              ) : null}
                              {entry.outcome ? (
                                <Badge variant="outline" className="capitalize">
                                  {entry.outcome}
                                </Badge>
                              ) : null}
                            </div>
                            <p className="font-medium text-slate-900">
                              {entry.summary}
                            </p>
                            {entry.description ? (
                              <p className="max-w-xl text-xs leading-relaxed text-slate-500">
                                {entry.description}
                              </p>
                            ) : null}
                            <p className="font-mono text-[11px] text-slate-400">
                              {entry.action}
                            </p>
                          </div>
                        </TableCell>
                        <TableCell className="align-top text-sm">
                          <div>
                            <p>{entry.actorDisplayName}</p>
                            {entry.actor?.email ? (
                              <p className="truncate text-xs text-slate-500">
                                {entry.actor.email}
                              </p>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell className="align-top text-sm">
                          {entry.subject?.id ? (
                            <Link
                              href={`/admin/members/${entry.subject.id}`}
                              className="text-blue-600 hover:underline"
                              onClick={(event) => event.stopPropagation()}
                            >
                              {entry.subjectDisplayName}
                            </Link>
                          ) : (
                            <span className="text-slate-400">
                              {entry.subjectDisplayName ?? "No member"}
                            </span>
                          )}
                          {entry.subject?.email ? (
                            <p className="truncate text-xs text-slate-500">
                              {entry.subject.email}
                            </p>
                          ) : null}
                        </TableCell>
                        <TableCell className="align-top text-xs text-slate-500">
                          {entry.entityType ? (
                            <div>
                              <p className="font-medium text-slate-700">
                                {entry.entityType}
                              </p>
                              {entry.entityId ? (
                                <p className="font-mono">
                                  {entry.entityId.slice(0, 14)}
                                  {entry.entityId.length > 14 ? "..." : ""}
                                </p>
                              ) : null}
                            </div>
                          ) : (
                            <span className="text-slate-400">None</span>
                          )}
                        </TableCell>
                        <TableCell className="align-top">
                          <PrimaryDrilldowns links={entry.drilldowns} />
                        </TableCell>
                      </TableRow>
                      {expanded ? (
                        <TableRow>
                          <TableCell colSpan={7} className="bg-slate-50 p-4">
                            <div className="grid gap-4 text-xs md:grid-cols-[220px_1fr]">
                              <div className="space-y-1 text-slate-600">
                                <p>
                                  <span className="font-medium">Request:</span>{" "}
                                  {entry.requestId || "—"}
                                </p>
                                <p>
                                  <span className="font-medium">IP:</span>{" "}
                                  {entry.ipAddress || "—"}
                                </p>
                                <p>
                                  <span className="font-medium">Retention:</span>{" "}
                                  {entry.retentionClass || "—"}
                                </p>
                                <p className="break-words">
                                  <span className="font-medium">User agent:</span>{" "}
                                  {entry.userAgent || "—"}
                                </p>
                                {entry.drilldowns.length > 0 ? (
                                  <div className="space-y-1 pt-2">
                                    <p className="font-medium">All targets</p>
                                    {entry.drilldowns.map((link) => (
                                      <Link
                                        key={link.href}
                                        href={link.href}
                                        className="block text-blue-600 hover:underline"
                                      >
                                        {link.label}
                                      </Link>
                                    ))}
                                  </div>
                                ) : null}
                              </div>
                              <div className="space-y-3">
                                {entry.details ? (
                                  <div>
                                    <p className="mb-1 font-medium text-slate-700">
                                      Details
                                    </p>
                                    <pre className="max-h-56 overflow-auto rounded-md bg-white p-3 leading-relaxed text-slate-700">
                                      {entry.details}
                                    </pre>
                                  </div>
                                ) : null}
                                {entry.metadata ? (
                                  <div>
                                    <p className="mb-1 font-medium text-slate-700">
                                      Metadata
                                    </p>
                                    <pre className="max-h-72 overflow-auto rounded-md bg-white p-3 leading-relaxed text-slate-700">
                                      {JSON.stringify(entry.metadata, null, 2)}
                                    </pre>
                                  </div>
                                ) : null}
                              </div>
                            </div>
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </Fragment>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-slate-500">{rangeLabel}</p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={loading || page <= 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            <ChevronLeft className="mr-1 h-4 w-4" />
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={loading || page >= totalPages}
            onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
          >
            Next
            <ChevronRight className="ml-1 h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
