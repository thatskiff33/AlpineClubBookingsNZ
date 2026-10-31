"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { XCircle } from "lucide-react";
import {
  Controller,
  FormProvider,
  useFormContext,
  useFormState,
  type ControllerProps,
  type FieldErrors,
  type FieldPath,
  type FieldValues,
  type FormProviderProps,
} from "react-hook-form";

import { alertVariants } from "@/components/ui/alert";
import { FieldHint } from "@/components/ui/field-hint";
import { Label } from "@/components/ui/label";
import {
  focusAndKeepInView,
  scrollToError,
} from "@/hooks/use-scroll-to-feedback";
import { cn } from "@/lib/utils";

/*
  #4467 item 3: the shared form layer (owner decision, 27 Oct 2026: shadcn
  Form, react-hook-form + zod). These are shadcn's Form primitives, adapted in
  four places so they fit this repository rather than fight it:

  - Ids come from the FORM and the field NAME, not from a per-item `useId`, so
    the error summary can link to a control it never rendered:
    `formControlId(formId, name)`.
  - `aria-describedby` lists the error FIRST and the hint after it, the order
    `FieldHint` already fixed (#2257): "this is wrong" is heard before "here is
    an example". It never names a description that is not rendered, because
    `FormDescription` registers itself with its `FormItem`; a dangling id is
    an axe failure.
  - `FormDescription` is the existing `FieldHint`, and `FormLabel` the
    existing `Label`, so the ink and size match every other field.
  - `FormErrorSummary` is added. On a failed submit it lists every error as a
    link to its field and takes focus, through the shared failure primitive
    `scrollToError`. Only a submit moves focus: typing re-validates the inline
    messages, never the focus.

  How to build a form with these, share its schema with the API route and map
  the route's field errors back: `docs/UX_FLOW_MAP.md`, "Forms (#4467)".
*/

const FormIdContext = React.createContext<string | null>(null);

/**
 * The form root: react-hook-form's provider, plus the id every control id in
 * this form is built from. Spread the `useZodForm` result onto it.
 */
function Form<
  TFieldValues extends FieldValues,
  TContext = unknown,
  TTransformedValues = TFieldValues,
>(props: FormProviderProps<TFieldValues, TContext, TTransformedValues>) {
  const formId = React.useId();
  return (
    <FormIdContext.Provider value={formId}>
      <FormProvider {...props} />
    </FormIdContext.Provider>
  );
}

/** The DOM id of a field's control: what its label and summary link point at. */
function formControlId(formId: string, name: string): string {
  return `${formId}-${name}-control`;
}

type FormFieldContextValue = { name: string };

const FormFieldContext = React.createContext<FormFieldContextValue | null>(
  null,
);

function FormField<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
  TTransformedValues = TFieldValues,
>(props: ControllerProps<TFieldValues, TName, TTransformedValues>) {
  return (
    <FormFieldContext.Provider value={{ name: props.name }}>
      <Controller {...props} />
    </FormFieldContext.Provider>
  );
}

type FormItemContextValue = {
  hasDescription: boolean;
  setHasDescription: (present: boolean) => void;
};

const FormItemContext = React.createContext<FormItemContextValue | null>(null);

function useFormField() {
  const fieldContext = React.useContext(FormFieldContext);
  const itemContext = React.useContext(FormItemContext);
  const formId = React.useContext(FormIdContext);
  const { getFieldState } = useFormContext();
  if (!fieldContext || formId === null) {
    throw new Error("useFormField must be used inside <Form> and <FormField>");
  }
  const formState = useFormState({ name: fieldContext.name });
  const fieldState = getFieldState(fieldContext.name, formState);
  const formItemId = formControlId(formId, fieldContext.name);

  return {
    name: fieldContext.name,
    formItemId,
    formDescriptionId: `${formItemId}-description`,
    formMessageId: `${formItemId}-message`,
    hasDescription: itemContext?.hasDescription ?? false,
    setHasDescription: itemContext?.setHasDescription,
    ...fieldState,
  };
}

function FormItem({ className, ...props }: React.ComponentProps<"div">) {
  const [hasDescription, setHasDescription] = React.useState(false);
  const value = React.useMemo(
    () => ({ hasDescription, setHasDescription }),
    [hasDescription],
  );
  return (
    <FormItemContext.Provider value={value}>
      <div
        data-slot="form-item"
        className={cn("space-y-1", className)}
        {...props}
      />
    </FormItemContext.Provider>
  );
}

function FormLabel({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof Label>) {
  const { error, formItemId } = useFormField();
  return (
    <Label
      data-slot="form-label"
      data-error={!!error}
      className={cn("data-[error=true]:text-destructive", className)}
      htmlFor={formItemId}
      {...props}
    />
  );
}

/**
 * Wraps the ONE control a field renders (`Input`, `Textarea`, `Checkbox`…)
 * and gives it the field's id, `aria-invalid`, and an `aria-describedby` that
 * names the error before any other description. Ids passed in
 * `aria-describedby` — a view-only reason, say — sit between the two.
 */
function FormControl({
  "aria-describedby": callerDescribedBy,
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof Slot>) {
  const {
    error,
    formItemId,
    formDescriptionId,
    formMessageId,
    hasDescription,
  } = useFormField();
  const describedBy = [
    error ? formMessageId : null,
    callerDescribedBy,
    hasDescription ? formDescriptionId : null,
  ]
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .join(" ");

  return (
    <Slot
      data-slot="form-control"
      id={formItemId}
      aria-describedby={describedBy || undefined}
      aria-invalid={!!error}
      className={cn(
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20",
        className,
      )}
      {...props}
    />
  );
}

/** The field's hint: `FieldHint`, registered so the control is described by it. */
function FormDescription({
  className,
  ...props
}: Omit<React.ComponentPropsWithoutRef<typeof FieldHint>, "id">) {
  const { formDescriptionId, setHasDescription } = useFormField();
  React.useLayoutEffect(() => {
    if (!setHasDescription) return;
    setHasDescription(true);
    return () => setHasDescription(false);
  }, [setHasDescription]);
  return (
    <FieldHint
      data-slot="form-description"
      id={formDescriptionId}
      className={className}
      {...props}
    />
  );
}

/**
 * The field's inline error. It is not a live region: the summary is what is
 * announced, and an inline message re-validated on every keystroke would
 * interrupt the person typing.
 */
function FormMessage({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<"p">) {
  const { error, formMessageId } = useFormField();
  const body = error ? String(error.message ?? "") : children;
  if (!body) return null;
  return (
    <p
      data-slot="form-message"
      id={formMessageId}
      className={cn("text-sm text-destructive", className)}
      {...props}
    >
      {body}
    </p>
  );
}

/** The `react-hook-form` error key a form-level (not per-field) error lives under. */
const FORM_LEVEL_ERROR_KEY = "root";

type SummaryEntry = { name: string | null; message: string };

/**
 * Every error message in a react-hook-form `errors` tree, in the tree's order,
 * with its field path. Form-level errors (`errors.root`, `errors.root.server`)
 * come back with a `null` name: they have no control to link to.
 */
function collectFormErrors(
  errors: FieldErrors,
  prefix = "",
): SummaryEntry[] {
  const entries: SummaryEntry[] = [];
  for (const [key, value] of Object.entries(errors)) {
    if (!value || typeof value !== "object") continue;
    const isRoot = prefix === "" && key === FORM_LEVEL_ERROR_KEY;
    const path = prefix ? `${prefix}.${key}` : key;
    const node = value as { message?: unknown; ref?: unknown };
    if (typeof node.message === "string" && node.message.trim() !== "") {
      entries.push({ name: isRoot ? null : path, message: node.message });
    }
    for (const [childKey, child] of Object.entries(value)) {
      if (childKey === "ref" || childKey === "message" || childKey === "type") {
        continue;
      }
      if (child && typeof child === "object") {
        const nested = collectFormErrors({ [childKey]: child } as FieldErrors, path);
        entries.push(
          ...nested.map((entry) => (isRoot ? { ...entry, name: null } : entry)),
        );
      }
    }
  }
  return entries;
}

/**
 * What went wrong, at the top of the form, after a submit that failed —
 * whether the schema refused it in the browser or the API route answered with
 * field errors (`applyServerValidationErrors`).
 *
 * - **Focus moves only on a submit.** The effect is keyed on react-hook-form's
 *   `submitCount`, which rises once per completed submit and never while the
 *   person types, and it uses `scrollToError`, the shared failure position.
 * - **It only ever shrinks between submits.** It lists the fields that failed
 *   at the last submit and are still failing, with their current message;
 *   a field that starts failing while the person types shows its inline
 *   message and joins the summary at the next submit.
 * - **Each entry links to its control** and focuses it.
 *
 * Render it inside `<Form>`, before the fields. `useZodForm` turns off
 * react-hook-form's own focus-the-first-error, which would otherwise take
 * focus back from the summary a tick later.
 */
function FormErrorSummary({
  title = "There is a problem",
  className,
}: {
  title?: React.ReactNode;
  className?: string;
}) {
  const formId = React.useContext(FormIdContext);
  if (formId === null) {
    throw new Error("FormErrorSummary must be used inside <Form>");
  }
  const { errors, submitCount } = useFormState();
  const ref = React.useRef<HTMLDivElement>(null);
  const titleId = `${formId}-error-summary-title`;

  // The names that failed at the last submit, captured in the render that
  // first sees the new `submitCount` (React's "adjust state while rendering"),
  // so the list and the focus land in the same commit.
  const [snapshot, setSnapshot] = React.useState<{
    submitCount: number;
    names: ReadonlySet<string | null>;
  }>({ submitCount: 0, names: new Set() });
  const current = collectFormErrors(errors);
  if (snapshot.submitCount !== submitCount) {
    setSnapshot({
      submitCount,
      names: new Set(current.map((entry) => entry.name)),
    });
  }
  const shown =
    snapshot.submitCount === submitCount
      ? current.filter((entry) => snapshot.names.has(entry.name))
      : current;

  // Only a new submit may move focus. The list shrinking as the person fixes
  // fields re-runs this effect, and the count it last acted on stops it. It
  // starts at the count on mount, so mounting after a submit moves nothing.
  const focusedFor = React.useRef(submitCount);
  const hasEntries = shown.length > 0;
  React.useEffect(() => {
    if (submitCount === focusedFor.current) return;
    focusedFor.current = submitCount;
    if (hasEntries) scrollToError(ref);
  }, [submitCount, hasEntries]);

  // Mounted only while it has something to say, like the page-level alerts
  // beside it: an empty `role="alert"` would be one more alert on the page
  // for every query and every assistive-technology "list the alerts".
  if (!hasEntries) return null;

  return (
    <div
      ref={ref}
      role="alert"
      tabIndex={-1}
      aria-labelledby={titleId}
      data-slot="form-error-summary"
      className={cn(
        alertVariants({ variant: "error" }),
        "scroll-mt-20 focus:outline-none",
        className,
      )}
    >
      <XCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 space-y-1">
        <h2 id={titleId} className="font-medium">
          {title}
        </h2>
        <ul className="list-disc space-y-1 pl-5">
          {shown.map((entry, index) => (
            <li key={`${entry.name ?? "form"}-${index}`}>
              {entry.name === null ? (
                entry.message
              ) : (
                <a
                  href={`#${formControlId(formId, entry.name)}`}
                  className="underline underline-offset-2"
                  onClick={(event) => {
                    const control = document.getElementById(
                      formControlId(formId, entry.name ?? ""),
                    );
                    if (!control) return;
                    event.preventDefault();
                    focusAndKeepInView(control);
                  }}
                >
                  {entry.message}
                </a>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export {
  Form,
  FormControl,
  FormDescription,
  FormErrorSummary,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  collectFormErrors,
  formControlId,
  useFormField,
};
