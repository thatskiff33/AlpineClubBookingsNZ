"use client";

import { useEffect, useState } from "react";

import { useClubFormat } from "@/components/club-format-provider";
import { useClubTime } from "@/components/club-time-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/ui/money-input";
import { formatStayDate, requireInstant } from "@/lib/club-time";
import { apiErrorMessageFromResponse } from "@/lib/api-error-message";
import {
  FOOD_ORDER_PRICE_CENTS_MAX,
  FOOD_ORDER_STATUS_LABELS,
  isValidFoodOrderPriceCents,
  type FoodOrderStatusValue,
} from "@/lib/food-order-rules";
import { parseDecimalDollarsToCents } from "@/lib/money-input";
import { formatCents, formatCentsPlain } from "@/lib/utils";

import { FoodOrderItems, type FoodOrderItemView } from "./food-order-items";

/**
 * One order in the food-order history (fork #121).
 *
 * The received checklist and the price editor appear only when the server said
 * `canManage` for this row — the value `canManageFoodOrder` computed. This
 * component has no access rule of its own (INV-SSOT); the routes re-check.
 *
 * Items are ticked received one or several at a time (owner change, 13 Nov
 * 2026); the order closes on the server when its last item is. The footer
 * holds both actions — "Mark selected received" and the price — as one row of
 * default-height controls that wraps on a narrow screen.
 */

export type FoodOrderHistoryItem = {
  id: string;
  lodgeName: string;
  orderedBy: string | null;
  isOwn: boolean;
  neededBy: string;
  notes: string | null;
  status: FoodOrderStatusValue;
  items: FoodOrderItemView[];
  receivedAt: string | null;
  receivedBy: string | null;
  priceCents: number | null;
  priceUpdatedBy: string | null;
  canManage: boolean;
};

export function FoodOrderRow({
  order,
  showOrderedBy,
  highlighted,
  onChanged,
}: {
  order: FoodOrderHistoryItem;
  showOrderedBy: boolean;
  highlighted: boolean;
  onChanged: () => void;
}) {
  const format = useClubFormat();
  const club = useClubTime();
  const [priceDraft, setPriceDraft] = useState(
    order.priceCents === null ? "" : formatCentsPlain(order.priceCents),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const unreceivedIds = order.items
    .filter((item) => item.receivedAt === null)
    .map((item) => item.id);
  const receivedCount = order.items.length - unreceivedIds.length;
  const checklist = order.canManage && order.status === "OPEN";

  // After a reload, drop any selection the server has since received.
  const unreceivedKey = unreceivedIds.join(",");
  useEffect(() => {
    const open = new Set(unreceivedKey ? unreceivedKey.split(",") : []);
    setSelected((current) => new Set([...current].filter((itemId) => open.has(itemId))));
  }, [unreceivedKey]);

  function toggle(itemId: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(itemId);
      else next.delete(itemId);
      return next;
    });
  }

  // A reload brings the stored price; the box follows it rather than keeping
  // what was typed against an older one.
  useEffect(() => {
    setPriceDraft(order.priceCents === null ? "" : formatCentsPlain(order.priceCents));
  }, [order.priceCents]);

  async function markSelectedReceived() {
    if (selected.size === 0) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/food-orders/${encodeURIComponent(order.id)}/received`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemIds: [...selected] }),
      });
      if (res.status === 409) {
        setError(await apiErrorMessageFromResponse(res, "This order changed. It has been reloaded."));
        onChanged();
        return;
      }
      if (!res.ok) throw new Error(await apiErrorMessageFromResponse(res, "Could not mark those items received."));
      setSelected(new Set());
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not mark those items received.");
    } finally {
      setBusy(false);
    }
  }

  async function savePrice() {
    const priceCents = parseDecimalDollarsToCents(priceDraft);
    if (!isValidFoodOrderPriceCents(priceCents)) {
      setError("Enter the price as an amount of zero or more, such as 42.50.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/food-orders/${encodeURIComponent(order.id)}/price`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // The price this screen showed: the server refuses (409) if it changed.
        body: JSON.stringify({ priceCents, expectedCents: order.priceCents }),
      });
      if (res.status === 409) {
        setError(await apiErrorMessageFromResponse(res, "This order changed. It has been reloaded."));
        onChanged();
        return;
      }
      if (!res.ok) throw new Error(await apiErrorMessageFromResponse(res, "Could not save the price."));
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the price.");
    } finally {
      setBusy(false);
    }
  }

  // The linked copy of an order can sit above the same order in the list, so
  // its element ids differ.
  const domKey = highlighted ? `linked-${order.id}` : order.id;
  const priceInputId = `food-order-price-${domKey}`;
  const parsedDraft = parseDecimalDollarsToCents(priceDraft);
  const priceDirty = parsedDraft !== order.priceCents;

  return (
    <Card id={`food-order-${domKey}`} className={highlighted ? "ring-2 ring-primary" : undefined}>
      <CardContent className="space-y-3 pt-6">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="font-medium">
              {order.lodgeName} — needed by {formatStayDate(order.neededBy, format)}
            </p>
            {showOrderedBy ? (
              <p className="text-sm text-muted-foreground">
                Ordered by {order.orderedBy ?? "a former member"}
                {order.isOwn ? " (you)" : ""}
              </p>
            ) : null}
          </div>
          <Badge variant={order.status === "RECEIVED" ? "success" : "warning"}>
            {FOOD_ORDER_STATUS_LABELS[order.status]}
            {order.status === "OPEN" && receivedCount > 0
              ? ` — ${receivedCount} of ${order.items.length} items received`
              : ""}
          </Badge>
        </div>

        <FoodOrderItems
          orderKey={domKey}
          items={order.items}
          selectable={checklist}
          selected={selected}
          disabled={busy}
          onToggle={toggle}
        />
        {order.notes ? (
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{order.notes}</p>
        ) : null}

        <div className="text-sm text-muted-foreground">
          {order.status === "RECEIVED" && order.receivedAt ? (
            <p>
              All items received {club.instantDate(requireInstant(order.receivedAt))}
              {order.receivedBy ? `, the last confirmed by ${order.receivedBy}` : ""}
            </p>
          ) : null}
          <p>
            Price:{" "}
            {order.priceCents === null
              ? "not recorded"
              : formatCents(order.priceCents, format)}
            {order.priceCents !== null && order.priceUpdatedBy
              ? ` (recorded by ${order.priceUpdatedBy})`
              : ""}
          </p>
        </div>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {order.canManage ? (
          // One level line: every control is h-9 and centred, the Price label
          // sits inline beside its box, and each wrapped row stays level.
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t pt-4 sm:justify-between">
            {checklist ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setSelected(new Set(unreceivedIds))}
                  disabled={busy || selected.size === unreceivedIds.length}
                >
                  Select all
                </Button>
                <Button
                  type="button"
                  onClick={() => void markSelectedReceived()}
                  disabled={busy || selected.size === 0}
                >
                  Mark selected received
                </Button>
              </div>
            ) : (
              <span aria-hidden="true" className="hidden sm:block" />
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Label htmlFor={priceInputId} className="whitespace-nowrap">
                Price
              </Label>
              {/* Typed only: no step buttons (owner, 13 Nov 2026). */}
              <MoneyInput
                id={priceInputId}
                className="w-32"
                value={priceDraft}
                onValueChange={setPriceDraft}
                minCents={0}
                maxCents={FOOD_ORDER_PRICE_CENTS_MAX}
                stepButtons={false}
                disabled={busy}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => void savePrice()}
                disabled={busy || !priceDirty || priceDraft.trim() === ""}
              >
                Save price
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
