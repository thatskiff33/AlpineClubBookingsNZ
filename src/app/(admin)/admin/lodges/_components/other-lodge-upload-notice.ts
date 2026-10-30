import type { UploadAfterSave } from "@/lib/servernz-upload-after-save";

/**
 * What the Other lodges panel says after the club's own lodge is saved: the
 * save route uploads it to the Alpine Central Server straight away and answers
 * with the outcome (`upload`). Anything short of an upload is a warning, not
 * an error: the save itself succeeded, and the nightly sync sends the change.
 */
export function uploadAfterSaveNotice(upload: UploadAfterSave | undefined): { kind: "ok" | "warn"; text: string } | null {
  switch (upload?.status) {
    case undefined:
      return null;
    case "uploaded":
      return upload.sent > 0
        ? { kind: "ok", text: "Saved, and sent to the Alpine Central Server." }
        : { kind: "ok", text: "Saved. The Alpine Central Server already has these details." };
    case "sharing-off":
      return { kind: "warn", text: "Saved. Other Clubs sharing is off, so the change was not sent to the Alpine Central Server." };
    case "not-configured":
      return { kind: "warn", text: "Saved. This site is not connected to the Alpine Central Server, so the change was not sent." };
    case "running":
      return { kind: "warn", text: "Saved. Another sync with the Alpine Central Server is running; the nightly sync sends this change if that one did not." };
    case "paused":
      return { kind: "warn", text: "Saved. Syncing is paused because the server is on a different software version; the change is sent once syncing resumes." };
    case "owned-unknown":
    case "failed":
      return { kind: "warn", text: "Saved, but the change could not be sent to the Alpine Central Server just now. The nightly sync tries again." };
  }
}
