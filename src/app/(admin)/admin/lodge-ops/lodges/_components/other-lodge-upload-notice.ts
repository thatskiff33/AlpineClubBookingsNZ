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
      if (upload.sent === 0) return { kind: "ok", text: "Saved. The Alpine Central Server already has these details." };
      if (upload.accepted === 0) {
        return { kind: "warn", text: "Saved, but the Alpine Central Server did not accept the change. The nightly sync sends it again." };
      }
      return upload.accepted < upload.sent
        ? { kind: "warn", text: "Saved and sent, but the Alpine Central Server did not accept every lodge. The nightly sync sends the rest again." }
        : { kind: "ok", text: "Saved, and sent to the Alpine Central Server." };
    case "no-upload-permission":
      return { kind: "ok", text: "Saved. The nightly sync sends the change to the Alpine Central Server; sending it straight away needs Finance edit." };
    case "sharing-off":
      return { kind: "warn", text: "Saved. Other Clubs sharing is off, so the change was not sent to the Alpine Central Server." };
    case "not-configured":
      return { kind: "warn", text: "Saved. This site is not connected to the Alpine Central Server, so the change was not sent." };
    case "running":
      return { kind: "warn", text: "Saved. Another sync with the Alpine Central Server is running; the nightly sync sends this change if that one did not." };
    case "paused":
      return { kind: "warn", text: "Saved. Syncing is paused because the server is on a different software version; the change is sent once syncing resumes." };
    case "owned-unreadable":
      return { kind: "warn", text: "Saved, but this site's list of its own lodges could not be read, so nothing was sent. The next download from the Alpine Central Server rewrites it." };
    case "owned-unknown":
    case "failed":
      return { kind: "warn", text: "Saved, but the change could not be sent to the Alpine Central Server just now. The nightly sync tries again." };
  }
}
