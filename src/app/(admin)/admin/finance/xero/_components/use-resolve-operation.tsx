"use client"

import type { ReactNode } from "react"
import type { PromptOptions } from "@/components/confirm-dialog"
import { useClubFormat } from "@/components/club-format-provider"
import { formatCents } from "@/lib/utils"
import { postJson } from "./api"
import { resolveDialogDescription } from "./resolve-dialog-copy"
import { useResolveWithNoteDialog } from "./resolve-with-note-dialog"
import type { XeroOperation } from "./types"

/**
 * The Xero operations panel's "Resolve (fixed in Xero)" action (#3635), with
 * #4421's refund credit note branch: a row the route will refuse says why
 * before anything is typed; a refund credit note the app never raised is
 * resolved with the number of the note made in Xero, through a dialog that
 * stays open while the route checks it; every other row asks only for a
 * reason. Its own module so the panel stays within its file-size budget.
 */
export function useResolveOperation(input: {
  prompt: (options: PromptOptions) => Promise<string | null>
  setError: (message: string) => void
  onMessage: (message: string) => void
  setResolvingOperationId: (operationId: string | null) => void
  fetchOperations: () => Promise<void>
  onRefreshDiagnostics: () => void
}): { resolveOperation: (operation: XeroOperation) => Promise<void>; resolveWithNoteDialog: ReactNode } {
  const { prompt, setError, onMessage, setResolvingOperationId, fetchOperations, onRefreshDiagnostics } = input
  const { openResolveWithNote, resolveWithNoteDialog } = useResolveWithNoteDialog()
  const clubFormat = useClubFormat()

  /** Sends one resolve; resolves to the route's refusal, or null once it is marked. */
  const send = async (operationId: string, body: { reason: string; creditNoteNumber?: string }): Promise<string | null> => {
    setResolvingOperationId(operationId)
    setError("")
    onMessage("")
    try {
      const data = await postJson<{ message?: string }>(
        `/api/admin/xero/operations/${operationId}/resolve`,
        body,
        "Failed to resolve Xero operation"
      )
      onMessage(data.message || "Xero operation marked resolved.")
      await fetchOperations()
      onRefreshDiagnostics()
      return null
    } catch (err) {
      return err instanceof Error ? err.message : "Failed to resolve Xero operation"
    } finally {
      setResolvingOperationId(null)
    }
  }

  const resolveOperation = async (operation: XeroOperation) => {
    // #4421: a row the route will refuse says why before anything is typed.
    if (operation.resolveRefusal) {
      onMessage("")
      setError(operation.resolveRefusal)
      return
    }
    // #4421: the route checks and records the note while the dialog stays
    // open, and a refusal is shown in the dialog.
    if (operation.resolveAsksCreditNoteNumber) {
      openResolveWithNote({
        amountLabel: operation.resolveCreditNoteAmountCents === null ? null : formatCents(operation.resolveCreditNoteAmountCents, clubFormat),
        submit: (answer) => send(operation.id, answer),
      })
      return
    }
    const reason = await prompt({
      title: "Resolve this Xero operation?",
      description: resolveDialogDescription(operation.entityType),
      inputLabel: "Reason",
      defaultValue: "Resolved manually in Xero",
      confirmLabel: "Resolve",
    })
    if (reason === null) return
    const refused = await send(operation.id, { reason })
    if (refused !== null) setError(refused)
  }

  return { resolveOperation, resolveWithNoteDialog }
}
