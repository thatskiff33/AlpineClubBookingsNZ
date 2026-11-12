"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, ShoppingBasket } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  FoodOrderForm,
  type FoodOrderFormSubmission,
} from "@/components/food-orders/food-order-form";
import { apiErrorMessageFromResponse } from "@/lib/api-error-message";
import { DEFAULT_FOOD_OFFICER_LABEL } from "@/lib/food-order-rules";

/**
 * The members' Order food screen (fork #121), shaped like `/maintenance-report`:
 * it fetches what the form needs from `GET /api/food-orders` and posts back to
 * the same address. `src/app/(authenticated)/food-order/page.tsx` renders it
 * only while the module is on. With no food officer email set the API says
 * `ready: false` and this explains ordering is not set up instead of showing
 * the form.
 */

type FormPayload = {
  ready: boolean;
  officerLabel: string;
  lodges: Array<{ id: string; name: string }>;
  today: string;
};

export function FoodOrderPageClient() {
  const [payload, setPayload] = useState<FormPayload | null>(null);
  const [loadError, setLoadError] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const res = await fetch("/api/food-orders");
      if (!res.ok) {
        throw new Error(
          await apiErrorMessageFromResponse(res, "The order form could not be loaded. Please try again."),
        );
      }
      setPayload((await res.json()) as FormPayload);
    } catch (err) {
      setLoadError(
        err instanceof Error
          ? err.message
          : "The order form could not be loaded. Please try again.",
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(submission: FoodOrderFormSubmission) {
    const res = await fetch("/api/food-orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(submission),
    });
    if (!res.ok) {
      throw new Error(
        await apiErrorMessageFromResponse(res, "Something went wrong placing that order. Please try again."),
      );
    }
    setSubmitted(true);
  }

  // Shown as the club entered it (INV-CONFIG-001).
  const officer = payload?.officerLabel ?? DEFAULT_FOOD_OFFICER_LABEL;

  if (submitted) {
    return (
      <div className="mx-auto max-w-xl space-y-6 p-4 sm:p-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-primary" aria-hidden="true" />
              Thank you — your order has been placed
            </CardTitle>
            <CardDescription>
              Your order is saved, and the club&apos;s {officer} is notified by
              email. You can see it, and whether it has arrived, in your food
              order history.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 sm:flex-row">
            <Button
              variant="outline"
              onClick={() => {
                setSubmitted(false);
                void load();
              }}
            >
              Order something else
            </Button>
            <Button asChild>
              <Link href="/food-orders">See my food orders</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl space-y-6 p-4 sm:p-6">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <ShoppingBasket className="h-6 w-6" aria-hidden="true" />
          Order food
        </h1>
        <p className="text-sm text-muted-foreground">
          Order food for a lodge stay. The club&apos;s {officer} is notified of
          each order by email.{" "}
          <Link href="/food-orders" className="underline">
            See my food orders
          </Link>
        </p>
      </div>

      {loadError ? <Alert variant="error">{loadError}</Alert> : null}

      {payload && !payload.ready ? (
        <Alert variant="info">
          Food ordering is not set up yet: the club has not said where orders
          should go. Please contact the committee.
        </Alert>
      ) : null}

      {payload?.ready ? (
        <FoodOrderForm
          lodges={payload.lodges}
          today={payload.today}
          officerLabel={payload.officerLabel}
          onSubmit={submit}
        />
      ) : payload || loadError ? null : (
        <p className="text-sm text-muted-foreground">Loading the form...</p>
      )}
    </div>
  );
}
