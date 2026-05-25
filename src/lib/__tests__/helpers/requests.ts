/**
 * Typed test helpers for building NextRequest instances and route params.
 *
 * The Next.js App Router passes dynamic params as `Promise<{...}>` since
 * Next 15. `routeParams` wraps a plain object as that promise so tests
 * can call route handlers without manual Promise.resolve boilerplate.
 */
import { NextRequest } from "next/server";

export type RouteParams<T extends Record<string, string>> = {
  params: Promise<T>;
};

export function routeParams<T extends Record<string, string>>(
  params: T,
): RouteParams<T> {
  return { params: Promise.resolve(params) };
}

const DEFAULT_ORIGIN = "http://localhost";

function resolveUrl(input: string): string {
  if (input.startsWith("http://") || input.startsWith("https://")) return input;
  if (!input.startsWith("/")) return `${DEFAULT_ORIGIN}/${input}`;
  return `${DEFAULT_ORIGIN}${input}`;
}

/**
 * Build a NextRequest pointing at an absolute URL. Accepts a path like
 * "/api/admin/foo?bar=baz" and prepends a localhost origin so test code
 * does not need to repeat it.
 */
export function nextRequest(
  pathOrUrl: string,
  init: RequestInit = {},
): NextRequest {
  return new NextRequest(resolveUrl(pathOrUrl), init);
}

export function jsonRequest(
  pathOrUrl: string,
  body: unknown,
  init: RequestInit = {},
): NextRequest {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new NextRequest(resolveUrl(pathOrUrl), {
    method: "POST",
    ...init,
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
