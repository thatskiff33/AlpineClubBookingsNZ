"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
  FOOD_ORDER_STATUSES,
  FOOD_ORDER_STATUS_LABELS,
} from "@/lib/food-order-rules";
import { apiErrorMessageFromResponse } from "@/lib/api-error-message";

import { FoodOrderRow, type FoodOrderHistoryItem } from "./food-order-row";
import { FoodOrderTotals, type FoodOrderYearTotalView } from "./food-order-totals";

/**
 * The food-order history (fork #121): filters, the order count and price total
 * for the filter, a page of orders, and a pager. Whether the viewer sees every
 * order or only their own is the server's answer (`canViewAll`), never decided
 * here.
 */

type HistoryPayload = {
  canViewAll: boolean;
  orders: FoodOrderHistoryItem[];
  page: number;
  pageSize: number;
  orderCount: number;
  pricedCount: number;
  priceTotalCents: number;
  yearTotals: FoodOrderYearTotalView[];
  /** The club's year today, from the server's club clock. */
  currentYear: number;
  /** The order the page was opened for (`?order=`), when the viewer may see it. */
  linkedOrder: FoodOrderHistoryItem | null;
  officerLabel: string;
  lodges: Array<{ id: string; name: string }>;
};

type Filters = { lodgeId: string; status: string; from: string; to: string };

const ALL = "all";
const EMPTY_FILTERS: Filters = { lodgeId: ALL, status: ALL, from: "", to: "" };

function queryFor(filters: Filters, page: number, linkedOrderId: string | null): string {
  const params = new URLSearchParams();
  if (linkedOrderId) params.set("order", linkedOrderId);
  if (filters.lodgeId !== ALL) params.set("lodgeId", filters.lodgeId);
  if (filters.status !== ALL) params.set("status", filters.status);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (page > 1) params.set("page", String(page));
  return params.toString();
}

export function FoodOrderHistory({ highlightOrderId }: { highlightOrderId: string | null }) {
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [payload, setPayload] = useState<HistoryPayload | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const query = queryFor(applied, page, highlightOrderId);
      const res = await fetch(`/api/food-orders/history${query ? `?${query}` : ""}`);
      if (!res.ok) {
        throw new Error(
          await apiErrorMessageFromResponse(res, "Could not load your food orders."),
        );
      }
      setPayload((await res.json()) as HistoryPayload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load your food orders.");
    }
  }, [applied, page, highlightOrderId]);

  // Bring the linked order into view once, when it first arrives.
  const linkedRef = useRef<HTMLDivElement>(null);
  const scrolledToLinked = useRef(false);
  const linkedOrderId = payload?.linkedOrder?.id ?? null;
  useEffect(() => {
    if (!linkedOrderId || scrolledToLinked.current) return;
    scrolledToLinked.current = true;
    linkedRef.current?.scrollIntoView?.({ block: "start" });
  }, [linkedOrderId]);

  useEffect(() => {
    void load();
  }, [load]);

  const pageCount = payload
    ? Math.max(1, Math.ceil(payload.orderCount / payload.pageSize))
    : 1;

  return (
    <div className="space-y-4">
      <form
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
        onSubmit={(event) => {
          event.preventDefault();
          setPage(1);
          setApplied(draft);
        }}
      >
        <div className="space-y-1">
          <Label htmlFor="food-history-lodge">Lodge</Label>
          <Select
            value={draft.lodgeId}
            onValueChange={(lodgeId) => setDraft({ ...draft, lodgeId })}
          >
            <SelectTrigger id="food-history-lodge">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All lodges</SelectItem>
              {(payload?.lodges ?? []).map((lodge) => (
                <SelectItem key={lodge.id} value={lodge.id}>
                  {lodge.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="food-history-status">Status</Label>
          <Select
            value={draft.status}
            onValueChange={(status) => setDraft({ ...draft, status })}
          >
            <SelectTrigger id="food-history-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Any status</SelectItem>
              {FOOD_ORDER_STATUSES.map((status) => (
                <SelectItem key={status} value={status}>
                  {FOOD_ORDER_STATUS_LABELS[status]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="food-history-from">Needed from</Label>
          <Input
            id="food-history-from"
            type="date"
            value={draft.from}
            onChange={(event) => setDraft({ ...draft, from: event.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="food-history-to">Needed to</Label>
          <Input
            id="food-history-to"
            type="date"
            value={draft.to}
            onChange={(event) => setDraft({ ...draft, to: event.target.value })}
          />
        </div>
        <div className="flex items-end gap-2">
          <Button type="submit">Apply</Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setDraft(EMPTY_FILTERS);
              setApplied(EMPTY_FILTERS);
              setPage(1);
            }}
          >
            Clear
          </Button>
        </div>
      </form>

      {error ? <Alert variant="error">{error}</Alert> : null}

      {payload ? (
        <>
          <FoodOrderTotals
            orderCount={payload.orderCount}
            pricedCount={payload.pricedCount}
            priceTotalCents={payload.priceTotalCents}
            yearTotals={payload.yearTotals}
            currentYear={payload.currentYear}
            officerLabel={payload.officerLabel}
          />

          {payload.linkedOrder ? (
            <section ref={linkedRef} aria-labelledby="food-linked-order" className="space-y-2">
              <h2 id="food-linked-order" className="text-sm font-semibold">
                Linked order
              </h2>
              <FoodOrderRow
                order={payload.linkedOrder}
                showOrderedBy={payload.canViewAll}
                highlighted
                onChanged={() => void load()}
              />
            </section>
          ) : null}

          {payload.orders.length === 0 ? (
            <p className="text-sm text-muted-foreground">No food orders match.</p>
          ) : (
            <div className="space-y-3">
              {payload.orders.map((order) => (
                <FoodOrderRow
                  key={order.id}
                  order={order}
                  showOrderedBy={payload.canViewAll}
                  highlighted={false}
                  onChanged={() => void load()}
                />
              ))}
            </div>
          )}

          {pageCount > 1 ? (
            <div className="flex items-center justify-between gap-3 border-t pt-4 text-sm">
              <Button
                type="button"
                variant="outline"
                disabled={page <= 1}
                onClick={() => setPage((current) => current - 1)}
              >
                Previous
              </Button>
              <span>
                Page {payload.page} of {pageCount}
              </span>
              <Button
                type="button"
                variant="outline"
                disabled={page >= pageCount}
                onClick={() => setPage((current) => current + 1)}
              >
                Next
              </Button>
            </div>
          ) : null}
        </>
      ) : error ? null : (
        <p className="text-sm text-muted-foreground">Loading...</p>
      )}
    </div>
  );
}
