"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowLeft, ChevronDown, Loader2, Pencil, Save } from "lucide-react";
import { ProfileForm } from "./profile-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface ProfileDetailsCardProps {
  member: {
    id: string;
    firstName: string;
    lastName: string;
    phoneCountryCode: string;
    phoneAreaCode: string;
    phoneNumber: string;
    dateOfBirth: string;
    streetAddressLine1: string;
    streetAddressLine2: string;
    streetCity: string;
    streetRegion: string;
    streetPostalCode: string;
    streetCountry: string;
    postalAddressLine1: string;
    postalAddressLine2: string;
    postalCity: string;
    postalRegion: string;
    postalPostalCode: string;
    postalCountry: string;
  };
  returnTo?: string | null;
}

const PROFILE_DETAILS_FORM_ID = "profile-details-form";
const PROFILE_DETAILS_CONTENT_ID = "profile-details-content";

export function ProfileDetailsCard({
  member,
  returnTo,
}: ProfileDetailsCardProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [isExpanded, setIsExpanded] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  function startEditing() {
    setIsExpanded(true);
    setIsEditing(true);
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>Personal Details</CardTitle>
            <CardDescription>
              View your name, phone, address, and date of birth. Changes are synced with Xero.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              aria-controls={PROFILE_DETAILS_CONTENT_ID}
              aria-expanded={isExpanded}
              aria-label={isExpanded ? "Collapse personal details" : "Expand personal details"}
              onClick={() => setIsExpanded((current) => !current)}
              size="icon"
              type="button"
              variant="outline"
            >
              <ChevronDown
                className={`h-4 w-4 transition-transform ${isExpanded ? "rotate-180" : ""}`}
              />
            </Button>
            <Button
              disabled={isSaving}
              form={isEditing ? PROFILE_DETAILS_FORM_ID : undefined}
              onClick={isEditing ? undefined : startEditing}
              type={isEditing ? "submit" : "button"}
            >
              {isSaving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : isEditing ? (
                <Save className="h-4 w-4" />
              ) : (
                <Pencil className="h-4 w-4" />
              )}
              {isSaving ? "Saving..." : isEditing ? "Save" : "Edit"}
            </Button>
            <Button asChild variant="outline">
              <Link href="/dashboard">
                <ArrowLeft className="h-4 w-4" />
                Back to Dashboard
              </Link>
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent
        className={isExpanded ? undefined : "hidden"}
        id={PROFILE_DETAILS_CONTENT_ID}
      >
        <ProfileForm
          editable={isEditing}
          formId={PROFILE_DETAILS_FORM_ID}
          member={member}
          onSaved={() => setIsEditing(false)}
          onSavingChange={setIsSaving}
          returnTo={returnTo}
          showSubmitButton={false}
        />
      </CardContent>
    </Card>
  );
}
