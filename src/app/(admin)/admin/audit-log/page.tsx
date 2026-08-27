"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
import { DatasetResetButton } from "@/components/admin/dataset-reset-button";
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
import { auditCategoryBadgeClass } from "@/lib/audit-category-badges";
import { buildHrefWithReturnTo } from "@/lib/internal-return-path";
import { memberName } from "@/lib/member-serialization";
import { APP_LOCALE } from "@/config/operational";
import { useClubTime } from "@/components/club-time-provider";
import { parseInstant, type BoundClubTime, type ClubTimeZone } from "@/lib/club-time";

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

// #2264: not one of the shared house shapes on purpose — the audit trail keeps
// seconds, so entries logged within the same minute stay orderable. Owner
// decision: do not migrate this to the shared date-time shape
// (`formatClubInstantDateTime`, once `formatNZDateTime`), which drops seconds.
// CT-4 (#2870): an audit stamp is a real INSTANT and is projected through the
// club's PERSISTED zone (INV-CONFIG-002), which a `"use client"` file receives
// as data — so the formatter is memoised per zone rather than frozen at module
// scope against APP_TIME_ZONE.
const AUDIT_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function auditFormatter(zone: ClubTimeZone): Intl.DateTimeFormat {
  const cached = AUDIT_FORMATTERS.get(zone);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat(APP_LOCALE, {
    timeZone: zone,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
  AUDIT_FORMATTERS.set(zone, created);
  return created;
}

function formatDateTime(clubTime: BoundClubTime, value: string) {
  const instant = parseInstant(value);
  if (instant === null) return value;
  return auditFormatter(clubTime.zone).format(instant);
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

function parsePositivePage(value: string | null) {
  const page = Number(value);
  return Number.isInteger(page) && page > 0 ? page : 1;
}

// Shown while the id has not (yet) been turned into a readable label, and kept
// as the LAST resort when nothing on this page can name the member — neither the
// members lookup (which an audit reader without `membership:view` cannot call)
// nor the audit rows already on screen.
const UNRESOLVED_MEMBER_LABEL = "Selected member";
const RESOLVING_MEMBER_LABEL = "Loading member...";

/**
 * #2733: the member filter is restored from `memberId` ALONE. A member's name or
 * email address in the query string reaches browser history, every
 * reverse-proxy/CDN access log, and the `Referer` header of anything this page
 * links out to — none of which the log/Sentry redactor of `INV-PRIV-011` can
 * reach, because none of them is ours. The same reasoning already governs the
 * officer's member picker (`INV-GUEST-016`, `INV-LIFE-068`): carry the
 * identifier, resolve the person from it.
 *
 * The returned member is deliberately unlabelled; the effect in `AuditLogPage`
 * fills the label in from the id.
 */
function initialSelectedMember(searchParams: Pick<URLSearchParams, "get">): PickedMember | null {
  const id = searchParams.get("memberId");
  if (!id) return null;

  return { id, firstName: "", lastName: "", email: "" };
}

/**
 * True when a chip carries an id but nothing readable to show for it yet, so the
 * label still has to be resolved.
 */
function needsMemberLabelResolution(member: PickedMember | null) {
  if (!member) return false;
  return !memberName(member) && !member.email;
}

/**
 * The chip label, in order of authority:
 *
 * 1. the member the lookup (or the picker) resolved — the only source that works
 *    with zero audit rows on screen, so it stays primary;
 * 2. the name the audit rows on screen already carry for that id. This page's own
 *    API sends actor/subject `firstName`/`lastName`/`email` to this audience
 *    (`/api/admin/audit-log`, admin audience), so for a reader who cannot call the
 *    members search the name is already in front of them, repeated down the
 *    Actor/Subject columns — a neutral chip beside it protects nothing and only
 *    makes the filter harder to read (#2733 review finding 2);
 * 3. `RESOLVING_MEMBER_LABEL` while the lookup is still in flight;
 * 4. `UNRESOLVED_MEMBER_LABEL`, when nothing available can name them.
 */
function memberFilterLabel(params: {
  member: PickedMember;
  entriesLabel: string;
  resolving: boolean;
}) {
  return (
    memberName(params.member) ||
    params.member.email ||
    params.entriesLabel ||
    (params.resolving ? RESOLVING_MEMBER_LABEL : UNRESOLVED_MEMBER_LABEL)
  );
}

function PrimaryDrilldowns({
  links,
  returnTo,
}: {
  links: AuditDrilldownLink[];
  returnTo: string;
}) {
  if (links.length === 0) {
    return <span className="text-xs text-muted-foreground">No direct target</span>;
  }

  const primaryLinks = links.filter((link) => link.primary);
  const visibleLinks = (primaryLinks.length > 0 ? primaryLinks : links).slice(0, 2);

  return (
    <div className="flex flex-wrap gap-1.5">
      {visibleLinks.map((link) => (
        <Button key={link.href} asChild variant="outline" size="sm" className="h-7 px-2">
          <Link
            href={buildHrefWithReturnTo(link.href, returnTo)}
            onClick={(event) => event.stopPropagation()}
          >
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
  selectedLabel,
  onSelect,
  onClear,
}: {
  selected: PickedMember | null;
  /** Resolved by the page from `selected.id`, never read out of the URL (#2733). */
  selectedLabel: string;
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
          <span className="min-w-0 flex-1 truncate">{selectedLabel}</span>
          {selected.role ? (
            <Badge variant="secondary" className="text-[10px]">
              {selected.role}
            </Badge>
          ) : null}
          <button
            type="button"
            className="text-muted-foreground hover:text-accent-foreground"
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
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onFocus={() => results.length > 0 && setOpen(true)}
          placeholder="Name, email, or ID"
          className="pl-8"
        />
      </div>
      {loading ? (
        <p className="text-xs text-muted-foreground">Searching...</p>
      ) : null}
      {open && (
        <div className="absolute z-50 mt-1 max-h-72 w-full overflow-y-auto rounded-md border bg-card shadow-lg">
          {results.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">No members found</p>
          ) : (
            results.map((member) => (
              <button
                key={member.id}
                type="button"
                className="w-full border-b px-3 py-2 text-left last:border-b-0 hover:bg-accent"
                onClick={() => {
                  onSelect(member);
                  setQuery("");
                  setOpen(false);
                }}
              >
                <span className="block text-sm font-medium">
                  {member.firstName} {member.lastName}
                </span>
                <span className="block text-xs text-muted-foreground">
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
  const clubTime = useClubTime();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [eventType, setEventType] = useState(searchParams.get("eventType") || "all");
  const [category, setCategory] = useState(searchParams.get("category") || "all");
  const [selectedMember, setSelectedMember] = useState<PickedMember | null>(() =>
    initialSelectedMember(searchParams)
  );
  const [memberScope, setMemberScope] = useState(searchParams.get("memberScope") || "involves");
  const [from, setFrom] = useState(searchParams.get("from") || "");
  const [to, setTo] = useState(searchParams.get("to") || "");
  const [outcome, setOutcome] = useState(searchParams.get("outcome") || "all");
  const [severity, setSeverity] = useState(searchParams.get("severity") || "all");
  const [entityType, setEntityType] = useState(searchParams.get("entityType") || "all");
  const [search, setSearch] = useState(searchParams.get("q") || "");
  const [page, setPage] = useState(() => parsePositivePage(searchParams.get("page")));
  const [pageSize] = useState(25);
  const [entries, setEntries] = useState<AuditTimelineEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [facets, setFacets] = useState<AuditFacets>(emptyFacets);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Seeded, not defaulted to false: an id-only URL is resolving from the FIRST
  // paint, so the chip opens on "Loading member..." instead of flashing the
  // terminal "Selected member" for one render before the effect below runs
  // (#2733 review finding 4b).
  const [resolvingMemberLabel, setResolvingMemberLabel] = useState(() =>
    needsMemberLabelResolution(initialSelectedMember(searchParams))
  );
  const attemptedMemberLabelIdRef = useRef<string | null>(null);

  const selectedMemberId = selectedMember?.id ?? null;

  const buildAuditSearchParams = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    for (const key of [
      "eventType", "category", "memberId",
      // #2733: no longer written, still deleted, so a bookmarked or pasted
      // pre-#2733 URL stops carrying the person fields FORWARD into further
      // history entries, `Referer` headers and request lines. It is not
      // retroactive: this runs in the browser after the server has already
      // served that legacy address, so the proxy access log line and the
      // browser's own visit record for it still hold the name and email.
      // `src/proxy.ts` keeps those two keys out of the one server-side copy
      // that would otherwise persist (the `x-pathname` header, which becomes a
      // 2FA `callbackUrl` and an `AuthBounceRecord.path`).
      "memberName", "memberEmail",
      "memberScope", "from", "to", "outcome", "severity", "entityType",
      "q", "page",
    ]) {
      params.delete(key);
    }
    if (eventType !== "all") params.set("eventType", eventType);
    if (category !== "all") params.set("category", category);
    // The member filter travels as the id and nothing else (#2733).
    if (selectedMemberId) params.set("memberId", selectedMemberId);
    if (selectedMemberId && memberScope !== "involves") params.set("memberScope", memberScope);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (outcome !== "all") params.set("outcome", outcome);
    if (severity !== "all") params.set("severity", severity);
    if (entityType !== "all") params.set("entityType", entityType);
    if (search.trim()) params.set("q", search.trim());
    if (page > 1) params.set("page", String(page));
    return params;
  }, [
    category,
    entityType,
    eventType,
    from,
    memberScope,
    outcome,
    page,
    search,
    selectedMemberId,
    searchParams,
    severity,
    to,
  ]);

  const auditQuery = buildAuditSearchParams().toString();
  const currentAuditPath = auditQuery ? `/admin/audit-log?${auditQuery}` : "/admin/audit-log";

  useEffect(() => {
    router.replace(currentAuditPath, { scroll: false });
  }, [currentAuditPath, router]);

  // #2733: an id-only URL still has to render a readable chip, so the label is
  // resolved from `memberId` through the same authorized members search the
  // picker above uses. That route is gated on `membership:view` while this page
  // is gated on `support:view`, so a reader who may read the audit trail but not
  // the membership roll cannot call it — resolving the label never widens what
  // anybody can see, and for that reader the label falls through to the audit
  // rows instead (see `entriesDerivedMemberLabel`).
  //
  // One attempt per id, plus ONE immediate retry for a TRANSIENT failure (a
  // network error, or a 5xx). A 4xx is permanent — a refusal, or an id with no
  // member behind it, does not become an answer on a second ask, and retrying it
  // would hammer a route the reader may not be allowed to call at all.
  useEffect(() => {
    const selected = selectedMember;
    if (!selected) {
      attemptedMemberLabelIdRef.current = null;
      setResolvingMemberLabel(false);
      return;
    }
    // Already readable — either resolved below, or picked from the search box,
    // which never needs a lookup at all.
    if (!needsMemberLabelResolution(selected)) {
      setResolvingMemberLabel(false);
      return;
    }
    if (attemptedMemberLabelIdRef.current === selected.id) return;
    attemptedMemberLabelIdRef.current = selected.id;

    let cancelled = false;
    let settled = false;
    setResolvingMemberLabel(true);
    void (async () => {
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (cancelled) return;
          let transient = false;
          try {
            const params = new URLSearchParams({
              q: selected.id,
              pageSize: "8",
              // An archived member is still an actor and a subject in the trail,
              // and `listAdminMembers` hides archived rows unless asked; without
              // this their chip could never resolve (#2733 review finding 3). The
              // route accepts the flag from any `membership:view` holder, so this
              // widens nothing.
              includeArchived: "true",
            });
            const res = await fetch(`/api/admin/members?${params.toString()}`);
            if (res.ok) {
              const data = (await res.json()) as { members?: PickedMember[] };
              // `q` matches an id by PREFIX as well as matching names and
              // emails, so take the exact id — never the first row of a fuzzy
              // match. No matching row is a FINAL answer (a purged or unknown
              // id), not a transient failure: stop and let the label fall
              // through.
              const match = data.members?.find(
                (member) => member.id === selected.id
              );
              if (!match || cancelled) return;
              setSelectedMember((current) =>
                current && current.id === match.id ? match : current
              );
              return;
            }
            // 4xx is the reader's answer and will not change; anything else
            // (5xx, or an opaque 0) is worth exactly one more ask.
            transient = res.status < 400 || res.status >= 500;
          } catch {
            // Network error, or a body that would not parse.
            transient = true;
          }
          if (!transient) return;
        }
      } finally {
        settled = true;
        if (!cancelled) setResolvingMemberLabel(false);
      }
    })();

    return () => {
      cancelled = true;
      // React StrictMode double-invokes mount effects (this repo does not set
      // `reactStrictMode`, and Next defaults it on in dev). Run 1 is cleaned up
      // before its fetch resolves and its result is then discarded by
      // `cancelled`, so clearing the one-attempt marker for an attempt that
      // never settled is what lets run 2 attempt again — without it run 2
      // early-returns on the marker and the chip stays on "Loading member..."
      // for the life of the page (#2733 review finding 1).
      if (!settled) attemptedMemberLabelIdRef.current = null;
    };
  }, [selectedMember]);

  // #2733 review finding 2: the fallback when the members lookup cannot answer.
  // Exact-id only, and only from a row that actually carries the person (a null
  // `actor`/`subject` renders as "System"/"Unknown member", which must never
  // become a chip label).
  const entriesDerivedMemberLabel = useMemo(() => {
    if (!selectedMemberId) return "";
    for (const entry of entries) {
      if (entry.actor?.id === selectedMemberId && entry.actorDisplayName) {
        return entry.actorDisplayName;
      }
      if (entry.subject?.id === selectedMemberId && entry.subjectDisplayName) {
        return entry.subjectDisplayName;
      }
    }
    return "";
  }, [entries, selectedMemberId]);

  const selectedMemberLabel = selectedMember
    ? memberFilterLabel({
        member: selectedMember,
        entriesLabel: entriesDerivedMemberLabel,
        resolving: resolvingMemberLabel,
      })
    : "";

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = buildAuditSearchParams();
      params.set("page", String(page));
      params.set("pageSize", String(pageSize));

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
    buildAuditSearchParams,
    page,
    pageSize,
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

  const isDatasetDefault =
    eventType === "all" &&
    category === "all" &&
    selectedMember === null &&
    memberScope === "involves" &&
    from === "" &&
    to === "" &&
    outcome === "all" &&
    severity === "all" &&
    entityType === "all" &&
    search === "" &&
    page === 1;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Audit Log</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Review system, member, finance, booking, Xero, and admin activity
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-4">
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
          selectedLabel={selectedMemberLabel}
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

        <DatasetResetButton disabled={isDatasetDefault} onReset={clearFilters} />
      </div>

      {error ? (
        <div className="rounded-md border border-danger-6 bg-danger-3 px-3 py-2 text-sm text-danger-11">
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
                  <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                    <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                    Loading audit events
                  </TableCell>
                </TableRow>
              ) : entries.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
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
                        className={expandable ? "cursor-pointer hover:bg-accent" : ""}
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
                        <TableCell className="align-top text-xs text-muted-foreground">
                          {formatDateTime(clubTime, entry.createdAt)}
                        </TableCell>
                        <TableCell className="align-top">
                          <div className="space-y-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Badge
                                variant="secondary"
                                className={auditCategoryBadgeClass(
                                  entry.category
                                )}
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
                            <p className="font-medium text-foreground">
                              {entry.summary}
                            </p>
                            {entry.description ? (
                              <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
                                {entry.description}
                              </p>
                            ) : null}
                            <p className="font-mono text-[11px] text-muted-foreground">
                              {entry.action}
                            </p>
                          </div>
                        </TableCell>
                        <TableCell className="align-top text-sm">
                          <div>
                            <p>{entry.actorDisplayName}</p>
                            {entry.actor?.email ? (
                              <p className="truncate text-xs text-muted-foreground">
                                {entry.actor.email}
                              </p>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell className="align-top text-sm">
                          {entry.subject?.id ? (
                            <Link
                              href={buildHrefWithReturnTo(
                                `/admin/members/${entry.subject.id}`,
                                currentAuditPath
                              )}
                              className="text-info-11 hover:underline"
                              onClick={(event) => event.stopPropagation()}
                            >
                              {entry.subjectDisplayName}
                            </Link>
                          ) : (
                            <span className="text-muted-foreground">
                              {entry.subjectDisplayName ?? "No member"}
                            </span>
                          )}
                          {entry.subject?.email ? (
                            <p className="truncate text-xs text-muted-foreground">
                              {entry.subject.email}
                            </p>
                          ) : null}
                        </TableCell>
                        <TableCell className="align-top text-xs text-muted-foreground">
                          {entry.entityType ? (
                            <div>
                              <p className="font-medium text-muted-foreground">
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
                            <span className="text-muted-foreground">None</span>
                          )}
                        </TableCell>
                        <TableCell className="align-top">
                          <PrimaryDrilldowns links={entry.drilldowns} returnTo={currentAuditPath} />
                        </TableCell>
                      </TableRow>
                      {expanded ? (
                        <TableRow>
                          <TableCell colSpan={7} className="bg-muted p-4">
                            <div className="grid gap-4 text-xs md:grid-cols-[220px_1fr]">
                              <div className="space-y-1 text-muted-foreground">
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
                                        className="block text-info-11 hover:underline"
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
                                    <p className="mb-1 font-medium text-muted-foreground">
                                      Details
                                    </p>
                                    <pre className="max-h-56 overflow-auto rounded-md bg-card p-3 leading-relaxed text-muted-foreground">
                                      {entry.details}
                                    </pre>
                                  </div>
                                ) : null}
                                {entry.metadata ? (
                                  <div>
                                    <p className="mb-1 font-medium text-muted-foreground">
                                      Metadata
                                    </p>
                                    <pre className="max-h-72 overflow-auto rounded-md bg-card p-3 leading-relaxed text-muted-foreground">
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
        <p className="text-sm text-muted-foreground">{rangeLabel}</p>
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
