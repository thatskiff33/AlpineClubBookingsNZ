"use client";

import { Save, X } from "lucide-react";
import type { UseFormReturn } from "react-hook-form";

import { ViewOnlyActionButton } from "@/components/admin/view-only-action";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Form,
  FormControl,
  FormDescription,
  FormErrorSummary,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type {
  CommitteeRoleFormValues,
  CommitteeRolePayload,
} from "@/lib/forms/committee-role-schema";

/**
 * The committee page's Add / Edit Role form, the worked example of the shared
 * form layer (#4467): its schema is the one both role routes parse with
 * (`src/lib/forms/committee-role-schema.ts`), a failed submit is listed in a
 * summary that takes focus, and a field the route refuses is marked inline.
 * The page owns the form instance and the save, so it can reset the form when
 * a role is opened and keep its request-level error banner for a refusal that
 * is not about a field (a 403, a 500).
 */
export function CommitteeRoleForm({
  form,
  editing,
  canEdit,
  saving,
  onSubmit,
  onClose,
}: {
  form: UseFormReturn<CommitteeRoleFormValues, unknown, CommitteeRolePayload>;
  editing: boolean;
  canEdit: boolean | undefined;
  saving: boolean;
  onSubmit: (payload: CommitteeRolePayload) => Promise<void>;
  onClose: () => void;
}) {
  return (
    <Form {...form}>
      <form
        noValidate
        onSubmit={form.handleSubmit(onSubmit)}
        className="rounded-md border border-border bg-card p-4 text-card-foreground"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-medium text-foreground">
            {editing ? "Edit Role" : "Add Role"}
          </h2>
          <Button type="button" variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <FormErrorSummary className="mb-4" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Role Name *</FormLabel>
                <FormControl>
                  <Input {...field} required disabled={!canEdit} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="sortOrder"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Sort Order</FormLabel>
                <FormControl>
                  <Input
                    ref={field.ref}
                    name={field.name}
                    type="number"
                    min={0}
                    value={field.value}
                    onBlur={field.onBlur}
                    onChange={(event) =>
                      field.onChange(parseInt(event.target.value, 10) || 0)
                    }
                    disabled={!canEdit}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <FormField
          control={form.control}
          name="contactEmail"
          render={({ field }) => (
            <FormItem className="mt-4">
              <FormLabel>Role Email</FormLabel>
              <FormControl>
                <Input {...field} type="email" disabled={!canEdit} />
              </FormControl>
              <FormMessage />
              {/* #2264: the example sits under the field, not in it. */}
              <FormDescription>Example: president@example.org</FormDescription>
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="description"
          render={({ field }) => (
            <FormItem className="mt-4">
              <FormLabel>Description</FormLabel>
              <FormControl>
                <Textarea
                  {...field}
                  rows={3}
                  maxLength={1000}
                  disabled={!canEdit}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="isActive"
          render={({ field }) => (
            <FormItem className="mt-4 flex items-center gap-2 space-y-0">
              <FormControl>
                <Checkbox
                  ref={field.ref}
                  name={field.name}
                  checked={field.value}
                  onBlur={field.onBlur}
                  onCheckedChange={field.onChange}
                  disabled={!canEdit}
                />
              </FormControl>
              <FormLabel className="font-normal">Active</FormLabel>
            </FormItem>
          )}
        />
        <div className="mt-4 flex gap-2">
          <ViewOnlyActionButton
            canEdit={canEdit}
            describeReason={false}
            type="submit"
            disabled={saving}
          >
            <Save className="mr-2 h-4 w-4" />
            Save Role
          </ViewOnlyActionButton>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Form>
  );
}
