import { Alert } from "@/components/ui/alert"

export function Message({
  tone,
  message,
  onDismiss,
}: {
  tone: "error" | "success"
  message: string
  onDismiss: () => void
}) {
  return (
    <Alert variant={tone === "error" ? "error" : "success"} className="mb-4">
      <div className="flex items-start justify-between gap-3">
        <span>{message}</span>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded-sm underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Dismiss
        </button>
      </div>
    </Alert>
  )
}
