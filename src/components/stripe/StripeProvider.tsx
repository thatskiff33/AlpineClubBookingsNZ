"use client";

import { loadStripe } from "@stripe/stripe-js";
import { Elements } from "@stripe/react-stripe-js";
import { ReactNode } from "react";

const stripePublishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;

if (!stripePublishableKey) {
  console.warn("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is not set");
}

const stripePromise = stripePublishableKey
  ? loadStripe(stripePublishableKey)
  : null;

interface StripeProviderProps {
  children: ReactNode;
  clientSecret: string;
}

/**
 * Wraps children with Stripe Elements context.
 * Requires a clientSecret from a PaymentIntent or SetupIntent.
 */
export default function StripeProvider({
  children,
  clientSecret,
}: StripeProviderProps) {
  if (!stripePromise) {
    return (
      <div className="text-red-500 p-4">
        Stripe is not configured. Please set NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY.
      </div>
    );
  }

  return (
    <Elements
      stripe={stripePromise}
      options={{
        clientSecret,
        appearance: {
          theme: "stripe",
          variables: {
            colorPrimary: "#2563eb",
            borderRadius: "8px",
          },
        },
      }}
    >
      {children}
    </Elements>
  );
}
