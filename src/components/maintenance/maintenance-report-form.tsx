"use client";

import { useRef, useState } from "react";
import { Camera, Loader2, X } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

/**
 * The maintenance-report form (#2780). ONE component, rendered by BOTH doors —
 * the members' portal page and the unauthenticated QR page.
 *
 * WHY ONE COMPONENT. The two doors must ask the same questions in the same order
 * with the same validation, or a club that edits the question set gets two
 * different forms and cannot tell which one a report came through. What differs
 * between them is passed in: whether a lodge must be chosen (the QR token already
 * decided the lodge), whether the optional contact prompt appears, and what
 * happens on submit. Nothing about authentication is in here at all — this
 * component never reads a session and never sees a token.
 *
 * MOBILE FIRST, because the whole point of the issue is somebody standing in
 * front of a broken thing with a phone. One column at every width, controls at
 * comfortable tap size, the photo control wired to `capture="environment"` so a
 * phone opens the rear camera rather than the photo library, and a single
 * full-width submit button that says what it will do.
 *
 * THE PHOTO IS RESIZED IN THE BROWSER before it is sent, to a long edge of 1600px
 * and JPEG quality 0.8. That is not cosmetic: a modern phone photo is 3-8 MB and
 * the server refuses anything over 4 MB, so an un-resized upload would fail on a
 * real camera roll while passing every test with a small fixture. Resizing here
 * also means the base64 that reaches the database is a fraction of the size.
 * A browser that cannot do the resize sends nothing and says so, rather than
 * silently submitting an oversized payload for the server to reject.
 */

export type MaintenanceFormQuestion = {
  id: string;
  label: string;
  helpText: string | null;
  type: "SHORT_TEXT" | "LONG_TEXT" | "YES_NO" | "SINGLE_CHOICE";
  required: boolean;
  choices: string[];
};

export type MaintenanceFormSubmission = {
  lodgeId?: string;
  summary: string;
  answers: Array<{ questionId: string; value: string }>;
  photoDataUrl: string | null;
  reporterName?: string;
  reporterContact?: string;
};

type Props = {
  questions: MaintenanceFormQuestion[];
  photosEnabled: boolean;
  summaryMaxLength: number;
  /** Member door: the member picks. QR door: the token decided, so this is null. */
  lodges: Array<{ id: string; name: string }> | null;
  /** QR door only: the lodge the token belongs to, shown as plain text. */
  fixedLodgeName?: string;
  /** QR door only, and only when the club has left the prompt on. */
  contactPrompt?: boolean;
  submitLabel: string;
  onSubmit: (submission: MaintenanceFormSubmission) => Promise<void>;
};

const MAX_IMAGE_EDGE = 1600;
const JPEG_QUALITY = 0.8;

async function resizeToJpegDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(
      1,
      MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height),
    );
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Your browser could not prepare that photo.");
    }
    context.drawImage(bitmap, 0, 0, width, height);
    // Always JPEG: the server sniffs the bytes and refuses a declared type that
    // disagrees with them, so producing one known container here removes a whole
    // class of "my phone made a HEIC" failure.
    return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  } finally {
    bitmap.close();
  }
}

export function MaintenanceReportForm({
  questions,
  photosEnabled,
  summaryMaxLength,
  lodges,
  fixedLodgeName,
  contactPrompt,
  submitLabel,
  onSubmit,
}: Props) {
  const [lodgeId, setLodgeId] = useState(lodges?.[0]?.id ?? "");
  const [summary, setSummary] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [photoDataUrl, setPhotoDataUrl] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [reporterName, setReporterName] = useState("");
  const [reporterContact, setReporterContact] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const setAnswer = (questionId: string, value: string) =>
    setAnswers((current) => ({ ...current, [questionId]: value }));

  async function handlePhoto(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Reset the input straight away so choosing the same file twice still fires.
    event.target.value = "";
    if (!file) return;

    setError("");
    setPhotoBusy(true);
    try {
      setPhotoDataUrl(await resizeToJpegDataUrl(file));
    } catch {
      setPhotoDataUrl(null);
      setError(
        "That photo could not be prepared on this device. You can send the report without it.",
      );
    } finally {
      setPhotoBusy(false);
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;

    const trimmedSummary = summary.trim();
    if (!trimmedSummary) {
      setError("Please say briefly what needs fixing.");
      return;
    }
    if (lodges && !lodgeId) {
      setError("Please choose which lodge this is about.");
      return;
    }
    // Required questions are checked here as well as on the server, so somebody
    // filling the form in gets told before the round trip. The server check is
    // the one that counts.
    const missing = questions.find(
      (question) => question.required && !(answers[question.id] ?? "").trim(),
    );
    if (missing) {
      setError(`Please answer: ${missing.label}`);
      return;
    }

    setError("");
    setSubmitting(true);
    try {
      await onSubmit({
        ...(lodges ? { lodgeId } : {}),
        summary: trimmedSummary,
        answers: questions
          .map((question) => ({
            questionId: question.id,
            value: (answers[question.id] ?? "").trim(),
          }))
          .filter((answer) => answer.value.length > 0),
        photoDataUrl,
        ...(contactPrompt
          ? {
              reporterName: reporterName.trim(),
              reporterContact: reporterContact.trim(),
            }
          : {}),
      });
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Something went wrong sending that report. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error ? <Alert variant="error">{error}</Alert> : null}

      {lodges ? (
        <div className="space-y-2">
          <Label htmlFor="maintenance-lodge">Which lodge is this about?</Label>
          {lodges.length === 1 && lodges[0] ? (
            <p className="text-sm text-muted-foreground">{lodges[0].name}</p>
          ) : (
            <Select value={lodgeId} onValueChange={setLodgeId}>
              <SelectTrigger id="maintenance-lodge" className="h-11">
                <SelectValue placeholder="Choose a lodge" />
              </SelectTrigger>
              <SelectContent>
                {lodges.map((lodge) => (
                  <SelectItem key={lodge.id} value={lodge.id}>
                    {lodge.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      ) : fixedLodgeName ? (
        <p className="text-sm text-muted-foreground">
          This report goes to whoever looks after{" "}
          <span className="font-medium text-foreground">{fixedLodgeName}</span>.
        </p>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor="maintenance-summary">What needs fixing?</Label>
        <Input
          id="maintenance-summary"
          className="h-11"
          value={summary}
          maxLength={summaryMaxLength}
          onChange={(event) => setSummary(event.target.value)}
          placeholder="A short description — e.g. the shower in room 2 is leaking"
          required
        />
      </div>

      {questions.map((question) => {
        const inputId = `maintenance-q-${question.id}`;
        const value = answers[question.id] ?? "";
        return (
          <div key={question.id} className="space-y-2">
            <Label htmlFor={inputId}>
              {question.label}
              {question.required ? (
                <span aria-hidden="true" className="ml-1 text-destructive">
                  *
                </span>
              ) : null}
            </Label>
            {question.helpText ? (
              <p className="text-xs text-muted-foreground">{question.helpText}</p>
            ) : null}

            {question.type === "LONG_TEXT" ? (
              <Textarea
                id={inputId}
                rows={4}
                value={value}
                onChange={(event) => setAnswer(question.id, event.target.value)}
                required={question.required}
              />
            ) : question.type === "YES_NO" ? (
              <Select
                value={value}
                onValueChange={(next) => setAnswer(question.id, next)}
              >
                <SelectTrigger id={inputId} className="h-11">
                  <SelectValue placeholder="Choose yes or no" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Yes">Yes</SelectItem>
                  <SelectItem value="No">No</SelectItem>
                </SelectContent>
              </Select>
            ) : question.type === "SINGLE_CHOICE" ? (
              <Select
                value={value}
                onValueChange={(next) => setAnswer(question.id, next)}
              >
                <SelectTrigger id={inputId} className="h-11">
                  <SelectValue placeholder="Choose one" />
                </SelectTrigger>
                <SelectContent>
                  {question.choices.map((choice) => (
                    <SelectItem key={choice} value={choice}>
                      {choice}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                id={inputId}
                className="h-11"
                value={value}
                onChange={(event) => setAnswer(question.id, event.target.value)}
                required={question.required}
              />
            )}
          </div>
        );
      })}

      {photosEnabled ? (
        <div className="space-y-2">
          <Label htmlFor="maintenance-photo">Add a photo (optional)</Label>
          <input
            ref={fileInput}
            id="maintenance-photo"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            // Opens the rear camera on a phone instead of the photo library,
            // which is the whole point on this surface.
            capture="environment"
            className="sr-only"
            onChange={handlePhoto}
          />
          {photoDataUrl ? (
            <div className="space-y-2">
              {/* eslint-disable-next-line @next/next/no-img-element -- a client-side
                  data: URL that never reaches the server as a URL; next/image
                  cannot optimise it and would only add a proxy hop. */}
              <img
                src={photoDataUrl}
                alt="The photo you are about to send"
                className="max-h-64 w-full rounded-md border object-contain"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setPhotoDataUrl(null)}
              >
                <X className="mr-2 h-4 w-4" aria-hidden="true" />
                Remove photo
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              variant="outline"
              className="h-11 w-full"
              disabled={photoBusy}
              onClick={() => fileInput.current?.click()}
            >
              {photoBusy ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Camera className="mr-2 h-4 w-4" aria-hidden="true" />
              )}
              {photoBusy ? "Preparing photo..." : "Take or choose a photo"}
            </Button>
          )}
        </div>
      ) : null}

      {contactPrompt ? (
        <fieldset className="space-y-4 rounded-md border p-4">
          <legend className="px-1 text-sm font-medium">
            Your details (optional)
          </legend>
          <p className="text-xs text-muted-foreground">
            Only if you would like somebody to be able to ask you about it. You do
            not have to give either.
          </p>
          <div className="space-y-2">
            <Label htmlFor="maintenance-reporter-name">Your name</Label>
            <Input
              id="maintenance-reporter-name"
              className="h-11"
              value={reporterName}
              maxLength={120}
              onChange={(event) => setReporterName(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="maintenance-reporter-contact">
              Phone or email to reach you on
            </Label>
            <Input
              id="maintenance-reporter-contact"
              className="h-11"
              value={reporterContact}
              maxLength={200}
              onChange={(event) => setReporterContact(event.target.value)}
            />
          </div>
        </fieldset>
      ) : null}

      <Button type="submit" className="h-12 w-full" disabled={submitting || photoBusy}>
        {submitting ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
        ) : null}
        {submitting ? "Sending..." : submitLabel}
      </Button>
    </form>
  );
}
