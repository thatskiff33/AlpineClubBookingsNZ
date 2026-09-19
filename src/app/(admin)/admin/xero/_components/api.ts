"use client"

import { apiErrorMessageFromBody } from "@/lib/api-error-message"

type ErrorBody = {
  error?: string
  message?: string
  warning?: string
}

export const XERO_ACTION_NETWORK_ERROR =
  "The service could not be reached. Your selections are still here. Check the current status, then try again."

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T
}

async function readOptionalJson<T>(res: Response, fallback: T): Promise<T> {
  try {
    return (await res.json()) as T
  } catch {
    return fallback
  }
}

// The Xero routes are the one admin surface whose refusals sometimes carry a
// `message` key rather than `error`. That second key is read here, once, and
// only as the fallback the shared rule is handed: a blank or non-text `error`
// then lands on `message`, and a blank or non-text `message` on the caller's
// own sentence — never on an empty alert or "[object Object]" (#3445).
async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  const data = await readOptionalJson<ErrorBody | null>(res, null)
  const message = typeof data?.message === "string" ? data.message.trim() : ""
  return apiErrorMessageFromBody(data, message === "" ? fallback : message)
}

export async function fetchJson<T>(url: string, options?: RequestInit, fallbackMessage = "Request failed"): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, options)
  } catch {
    throw new Error(XERO_ACTION_NETWORK_ERROR)
  }
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, fallbackMessage))
  }
  return readJson<T>(res)
}

export async function postJson<T>(url: string, body?: unknown, fallbackMessage = "Request failed"): Promise<T> {
  return fetchJson<T>(
    url,
    {
      method: "POST",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    fallbackMessage
  )
}

export type ActionResponse = {
  message?: string
  warning?: string
  memberId?: string
  memberFirstName?: string
  memberLastName?: string
  memberEmail?: string
  active?: boolean
  xeroContactId?: string
}
