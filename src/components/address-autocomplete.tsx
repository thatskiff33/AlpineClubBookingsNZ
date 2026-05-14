"use client";

import {
  type KeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Input, type InputProps } from "@/components/ui/input";
import { type AddressSelection } from "@/lib/addy-address";
import { cn } from "@/lib/utils";

export type { AddressSelection } from "@/lib/addy-address";

interface AddySuggestion {
  id: string;
  label: string;
}

interface SearchResponse {
  suggestions?: AddySuggestion[];
}

interface DetailsResponse {
  selection?: AddressSelection;
}

interface AddressAutocompleteProps
  extends Omit<InputProps, "onChange" | "value"> {
  value: string;
  onChange: (value: string) => void;
  onAddressSelected: (selection: AddressSelection) => void;
  addressParams?: Record<string, string>;
  countryCode?: string;
}

const MIN_SEARCH_CHARS = 3;
const SEARCH_DEBOUNCE_MS = 250;

function createSessionId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function addressParamsFromKey(key: string) {
  try {
    return JSON.parse(key) as Record<string, string>;
  } catch {
    return {};
  }
}

function isTruthy(value: string | undefined) {
  return value === "1" || value === "true" || value === "yes";
}

function appendAddressFilters(
  params: URLSearchParams,
  addressParamsKey: string,
) {
  const addressParams = addressParamsFromKey(addressParamsKey);

  if (addressParams.post_box === "0" || isTruthy(addressParams.expostbox)) {
    params.set("expostbox", "true");
  }

  if (isTruthy(addressParams.exrural)) {
    params.set("exrural", "true");
  }

  if (isTruthy(addressParams.exundeliver)) {
    params.set("exundeliver", "true");
  }
}

export function AddressAutocomplete({
  addressParams,
  autoComplete = "disable-autocomplete",
  className,
  countryCode = "NZ",
  disabled,
  onAddressSelected,
  onChange,
  readOnly,
  value,
  ...props
}: AddressAutocompleteProps) {
  const generatedId = useId();
  const inputId = props.id ?? generatedId;
  const listboxId = `${inputId}-addy-listbox`;
  const addressParamsKey = JSON.stringify(addressParams ?? {});
  const [hasFocus, setHasFocus] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [isOpen, setIsOpen] = useState(false);
  const [loadingAddressId, setLoadingAddressId] = useState<string | null>(null);
  const [searchStatus, setSearchStatus] = useState<
    "idle" | "loading" | "error"
  >("idle");
  const [suggestions, setSuggestions] = useState<AddySuggestion[]>([]);
  const detailsAbortRef = useRef<AbortController | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  function getSessionId() {
    if (!sessionIdRef.current) {
      sessionIdRef.current = createSessionId();
    }

    return sessionIdRef.current;
  }

  const trimmedValue = value.trim();
  const canSearch =
    !disabled &&
    !readOnly &&
    countryCode.toUpperCase() === "NZ" &&
    trimmedValue.length >= MIN_SEARCH_CHARS;
  const showPanel =
    hasFocus &&
    isOpen &&
    (searchStatus === "loading" ||
      searchStatus === "error" ||
      suggestions.length > 0 ||
      (hasSearched && canSearch));

  useEffect(() => {
    if (!canSearch) {
      setHasSearched(false);
      setHighlightedIndex(-1);
      setSearchStatus("idle");
      setSuggestions([]);
      return;
    }

    let cancelled = false;
    let controller: AbortController | null = null;

    const timeout = window.setTimeout(async () => {
      controller = new AbortController();
      setSearchStatus("loading");
      setHasSearched(true);

      const params = new URLSearchParams({
        q: trimmedValue,
        session: getSessionId(),
      });
      appendAddressFilters(params, addressParamsKey);

      try {
        const response = await fetch(
          `/api/address-autocomplete/search?${params.toString()}`,
          {
            signal: controller.signal,
          },
        );

        if (!response.ok) {
          throw new Error("Address search failed");
        }

        const data = (await response.json()) as SearchResponse;

        if (cancelled) {
          return;
        }

        setSuggestions(data.suggestions ?? []);
        setHighlightedIndex(-1);
        setSearchStatus("idle");
        setIsOpen(true);
      } catch (error) {
        if (cancelled || controller.signal.aborted) {
          return;
        }

        console.warn("Addy address search failed.", error);
        setSuggestions([]);
        setHighlightedIndex(-1);
        setSearchStatus("error");
        setIsOpen(true);
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      controller?.abort();
    };
  }, [addressParamsKey, canSearch, trimmedValue]);

  useEffect(() => {
    return () => {
      detailsAbortRef.current?.abort();
    };
  }, []);

  async function selectSuggestion(suggestion: AddySuggestion) {
    detailsAbortRef.current?.abort();
    const controller = new AbortController();
    detailsAbortRef.current = controller;
    setLoadingAddressId(suggestion.id);

    const params = new URLSearchParams({ session: getSessionId() });

    try {
      const response = await fetch(
        `/api/address-autocomplete/details/${encodeURIComponent(
          suggestion.id,
        )}?${params.toString()}`,
        { signal: controller.signal },
      );

      if (!response.ok) {
        throw new Error("Address details failed");
      }

      const data = (await response.json()) as DetailsResponse;

      if (!data.selection) {
        throw new Error("Address details were missing");
      }

      onChange(data.selection.addressLine1);
      onAddressSelected(data.selection);
      setSuggestions([]);
      setHighlightedIndex(-1);
      setIsOpen(false);
      setSearchStatus("idle");
    } catch (error) {
      if (!controller.signal.aborted) {
        console.warn("Addy address details failed.", error);
        setSearchStatus("error");
        setIsOpen(true);
      }
    } finally {
      if (detailsAbortRef.current === controller) {
        detailsAbortRef.current = null;
      }
      setLoadingAddressId(null);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    props.onKeyDown?.(event);

    if (event.defaultPrevented || !showPanel || suggestions.length === 0) {
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlightedIndex((current) =>
        Math.min(current + 1, suggestions.length - 1),
      );
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedIndex((current) =>
        current <= 0 ? suggestions.length - 1 : current - 1,
      );
      return;
    }

    if (event.key === "Enter" && highlightedIndex >= 0) {
      event.preventDefault();
      void selectSuggestion(suggestions[highlightedIndex]);
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      setIsOpen(false);
    }
  }

  return (
    <div className="relative">
      <Input
        {...props}
        aria-activedescendant={
          showPanel && highlightedIndex >= 0
            ? `${listboxId}-${highlightedIndex}`
            : undefined
        }
        aria-autocomplete="list"
        aria-controls={
          showPanel && suggestions.length > 0 ? listboxId : undefined
        }
        aria-expanded={showPanel}
        aria-haspopup="listbox"
        autoComplete={autoComplete}
        className={className}
        disabled={disabled}
        id={inputId}
        onBlur={(event) => {
          props.onBlur?.(event);
          setHasFocus(false);
          setIsOpen(false);
        }}
        onChange={(event) => {
          onChange(event.target.value);
          setIsOpen(true);
        }}
        onFocus={(event) => {
          props.onFocus?.(event);
          setHasFocus(true);
          if (canSearch || suggestions.length > 0) {
            setIsOpen(true);
          }
        }}
        onKeyDown={handleKeyDown}
        readOnly={readOnly}
        role="combobox"
        value={value}
      />

      {showPanel ? (
        <div
          className="absolute z-50 mt-1 w-full overflow-hidden rounded-md border bg-background text-sm shadow-lg"
          onMouseDown={(event) => event.preventDefault()}
        >
          {suggestions.length > 0 ? (
            <ul
              aria-busy={Boolean(loadingAddressId)}
              className="max-h-60 overflow-y-auto py-1"
              id={listboxId}
              role="listbox"
            >
              {suggestions.map((suggestion, index) => (
                <li
                  aria-selected={highlightedIndex === index}
                  id={`${listboxId}-${index}`}
                  key={suggestion.id}
                  role="option"
                >
                  <button
                    className={cn(
                      "block w-full px-3 py-2 text-left",
                      highlightedIndex === index
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-accent hover:text-accent-foreground",
                    )}
                    disabled={loadingAddressId !== null}
                    onClick={() => void selectSuggestion(suggestion)}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    type="button"
                  >
                    {suggestion.label}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-3 py-2 text-muted-foreground">
              {searchStatus === "loading"
                ? "Searching addresses..."
                : searchStatus === "error"
                  ? "Address lookup unavailable; enter address manually."
                  : "No matching addresses found."}
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
