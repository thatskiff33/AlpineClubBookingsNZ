"use client";

import { useEffect, useRef } from "react";
import { Input, type InputProps } from "@/components/ui/input";

declare global {
  interface Window {
    AddressFinder?: {
      Widget: new (
        input: HTMLElement,
        apiKey: string,
        countryCode: string,
        options?: Record<string, unknown>,
      ) => AddressFinderWidget;
    };
  }
}

interface AddressFinderWidget {
  on(eventName: string, callback: (value: string, metadata: AddressMetadata) => void): void;
  enable?: () => void;
  disable?: () => void;
}

export interface AddressSelection {
  addressLine1: string;
  addressLine2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
}

interface AddressMetadata {
  address_line_1?: string;
  address_line_2?: string;
  suburb?: string;
  locality_name?: string;
  city?: string;
  region?: string;
  state?: string;
  state_territory?: string;
  postcode?: string;
  postal_code?: string;
  post_code?: string;
  country?: string;
  country_code?: string;
}

interface AddressAutocompleteProps
  extends Omit<InputProps, "onChange" | "value"> {
  value: string;
  onChange: (value: string) => void;
  onAddressSelected: (selection: AddressSelection) => void;
  addressParams?: Record<string, string>;
  countryCode?: string;
}

const ADDRESSFINDER_SCRIPT_URL =
  "https://api.addressfinder.io/assets/v3/widget.js";

let addressfinderScriptPromise: Promise<void> | null = null;
let hasWarnedAboutMissingKey = false;
let hasWarnedAboutLoadFailure = false;

function loadAddressfinderScript() {
  if (typeof window === "undefined") {
    return Promise.resolve();
  }

  if (window.AddressFinder?.Widget) {
    return Promise.resolve();
  }

  if (!addressfinderScriptPromise) {
    addressfinderScriptPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>(
        `script[src="${ADDRESSFINDER_SCRIPT_URL}"]`,
      );

      if (existing) {
        if (window.AddressFinder?.Widget) {
          resolve();
          return;
        }

        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener(
          "error",
          () => reject(new Error("Failed to load Addressfinder")),
          { once: true },
        );
        return;
      }

      const script = document.createElement("script");
      script.src = ADDRESSFINDER_SCRIPT_URL;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () =>
        reject(new Error("Failed to load Addressfinder"));
      document.body.appendChild(script);
    });
  }

  return addressfinderScriptPromise;
}

function firstNonEmpty(...values: Array<string | undefined>) {
  return values.find((value) => value && value.trim())?.trim() ?? "";
}

function mapMetadataToSelection(metadata: AddressMetadata): AddressSelection {
  return {
    addressLine1: firstNonEmpty(metadata.address_line_1),
    addressLine2: firstNonEmpty(metadata.address_line_2),
    city: firstNonEmpty(metadata.city, metadata.locality_name, metadata.suburb),
    region: firstNonEmpty(
      metadata.region,
      metadata.state,
      metadata.state_territory,
    ),
    postalCode: firstNonEmpty(
      metadata.postcode,
      metadata.postal_code,
      metadata.post_code,
    ),
    country: firstNonEmpty(metadata.country_code, metadata.country, "NZ"),
  };
}

export function AddressAutocomplete({
  addressParams,
  autoComplete = "disable-autocomplete",
  countryCode = "NZ",
  disabled,
  onAddressSelected,
  onChange,
  value,
  ...props
}: AddressAutocompleteProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const widgetRef = useRef<AddressFinderWidget | null>(null);
  const addressfinderKey = process.env.NEXT_PUBLIC_ADDRESSFINDER_KEY;
  const addressParamsKey = JSON.stringify(addressParams ?? {});

  useEffect(() => {
    if (!addressfinderKey) {
      if (!hasWarnedAboutMissingKey) {
        hasWarnedAboutMissingKey = true;
        console.warn(
          "Addressfinder autocomplete is disabled because NEXT_PUBLIC_ADDRESSFINDER_KEY is not set at build time.",
        );
      }
      return;
    }

    if (!inputRef.current || widgetRef.current) {
      return;
    }

    let cancelled = false;

    loadAddressfinderScript()
      .then(() => {
        if (
          cancelled ||
          !inputRef.current ||
          !window.AddressFinder?.Widget
        ) {
          return;
        }

        const widget = new window.AddressFinder.Widget(
          inputRef.current,
          addressfinderKey,
          countryCode,
          {
            address_params: addressParams,
            container: inputRef.current.parentElement ?? document.body,
          },
        );

        widget.on("address:select", (_selectedAddress, metadata) => {
          const selection = mapMetadataToSelection(metadata);
          onChange(selection.addressLine1);
          onAddressSelected(selection);
        });

        widgetRef.current = widget;

        if (disabled) {
          widget.disable?.();
        }
      })
      .catch((error) => {
        if (!hasWarnedAboutLoadFailure) {
          hasWarnedAboutLoadFailure = true;
          console.warn(
            "Addressfinder autocomplete failed to initialise. Check CSP and outbound access to api.addressfinder.io.",
            error,
          );
        }
        widgetRef.current = null;
      });

    return () => {
      cancelled = true;
      widgetRef.current?.disable?.();
      widgetRef.current = null;
    };
  }, [
    addressParamsKey,
    addressfinderKey,
    countryCode,
    disabled,
    onAddressSelected,
    onChange,
  ]);

  useEffect(() => {
    if (!widgetRef.current) {
      return;
    }

    if (disabled) {
      widgetRef.current.disable?.();
      return;
    }

    widgetRef.current.enable?.();
  }, [disabled]);

  return (
    <Input
      {...props}
      autoComplete={autoComplete}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      ref={inputRef}
      value={value}
    />
  );
}
