"use client";

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { MapPin, Phone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface CommitteeMember {
  id: string;
  role: string;
  name: string;
  phone: string;
  email: string | null;
  contactKey: string | null;
}

export default function ContactPage() {
  const searchParams = useSearchParams();
  const initialRecipient = searchParams.get("recipient") || "general";
  const [form, setForm] = useState({ name: "", email: "", message: "" });
  const [recipient, setRecipient] = useState(initialRecipient);
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">(
    "idle"
  );
  const [errorMessage, setErrorMessage] = useState("");
  const [members, setMembers] = useState<CommitteeMember[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(true);

  useEffect(() => {
    fetch("/api/committee")
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => {
        setMembers(data.members);
        // Validate initial recipient against loaded data
        const validKeys = data.members
          .filter((m: CommitteeMember) => m.contactKey)
          .map((m: CommitteeMember) => m.contactKey);
        if (initialRecipient !== "general" && !validKeys.includes(initialRecipient)) {
          setRecipient("general");
        }
      })
      .catch(() => setMembers([]))
      .finally(() => setLoadingMembers(false));
  }, [initialRecipient]);

  // Build recipient options from loaded committee members
  const recipientOptions: Array<{ key: string; label: string }> = [
    { key: "general", label: "General Enquiry" },
    ...members
      .filter((m) => m.contactKey)
      .map((m) => ({
        key: m.contactKey!,
        label: `${m.role} — ${m.name}`,
      })),
  ];

  // Find the booking officer for the sidebar (or first member with contactKey "bookings")
  const bookingOfficer = members.find((m) => m.contactKey === "bookings");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setErrorMessage("");

    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          recipient: recipient === "general" ? undefined : recipient,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || "Failed to send message");
      }

      setStatus("sent");
      setForm({ name: "", email: "", message: "" });
    } catch (err) {
      setStatus("error");
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to send message"
      );
    }
  }

  return (
    <>
      {/* Header */}
      <section className="bg-gradient-to-br from-brand-charcoal to-brand-deep py-16 text-brand-snow sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <span className="website-eyebrow mb-4">Get in touch</span>
          <h1 className="font-heading text-4xl font-bold tracking-tight sm:text-5xl">
            Contact Us
          </h1>
          <p className="mt-4 max-w-2xl text-lg text-brand-snow/80">
            Have a question about the club, the lodge, or booking a stay? Get in
            touch and we&apos;ll get back to you.
          </p>
        </div>
      </section>

      {/* Content */}
      <section className="bg-brand-snow py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 gap-12 lg:grid-cols-3">
            {/* Contact form */}
            <div className="lg:col-span-2">
              <h2 className="mb-6 font-heading text-2xl font-bold text-brand-charcoal">
                Send a Message
              </h2>

              {status === "sent" ? (
                <div className="rounded-2xl border border-green-200 bg-green-50 p-6">
                  <h3 className="font-semibold text-green-800 mb-1">
                    Message Sent
                  </h3>
                  <p className="text-green-700 text-sm">
                    Thanks for getting in touch. We&apos;ll get back to you as
                    soon as we can.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-4 border-brand-charcoal/20 bg-white text-brand-charcoal hover:bg-brand-mist/35 hover:text-brand-charcoal"
                    onClick={() => setStatus("idle")}
                  >
                    Send Another Message
                  </Button>
                </div>
              ) : (
                <form onSubmit={handleSubmit} className="space-y-5">
                  <div>
                    <Label htmlFor="recipient">Send to</Label>
                    <Select
                      value={recipient}
                      onValueChange={setRecipient}
                      disabled={loadingMembers}
                    >
                      <SelectTrigger className="mt-1 border-brand-ridge/20 bg-white">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="website-theme border-brand-ridge/20 bg-brand-snow">
                        {recipientOptions.map(({ key, label }) => (
                          <SelectItem key={key} value={key}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="name">Name</Label>
                    <Input
                      id="name"
                      required
                      value={form.name}
                      onChange={(e) =>
                        setForm({ ...form, name: e.target.value })
                      }
                      placeholder="Your name"
                      className="mt-1 border-brand-ridge/20 bg-white"
                    />
                  </div>
                  <div>
                    <Label htmlFor="email">Email</Label>
                    <Input
                      id="email"
                      type="email"
                      required
                      value={form.email}
                      onChange={(e) =>
                        setForm({ ...form, email: e.target.value })
                      }
                      placeholder="you@example.com"
                      className="mt-1 border-brand-ridge/20 bg-white"
                    />
                  </div>
                  <div>
                    <Label htmlFor="message">Message</Label>
                    <Textarea
                      id="message"
                      required
                      rows={5}
                      value={form.message}
                      onChange={(e) =>
                        setForm({ ...form, message: e.target.value })
                      }
                      placeholder="How can we help?"
                      className="mt-1 border-brand-ridge/20 bg-white"
                    />
                  </div>

                  {status === "error" && (
                    <p className="text-sm text-red-600">{errorMessage}</p>
                  )}

                  <Button type="submit" disabled={status === "sending"}>
                    {status === "sending" ? "Sending..." : "Send Message"}
                  </Button>
                </form>
              )}
            </div>

            {/* Contact details sidebar */}
            <div className="space-y-6">
              <h2 className="mb-6 font-heading text-2xl font-bold text-brand-charcoal">
                Club Details
              </h2>

              <Card className="border-brand-ridge/20 bg-brand-snow/90 shadow-[0_20px_45px_-35px_rgba(47,47,43,0.45)]">
                <CardContent className="pt-6 space-y-4">
                  {bookingOfficer && (
                    <div className="flex items-start gap-3">
                      <Phone className="mt-0.5 h-5 w-5 shrink-0 text-brand-gold" />
                      <div>
                        <p className="text-sm font-medium text-brand-charcoal">
                          {bookingOfficer.role}
                        </p>
                        <p className="text-sm text-brand-deep/75">
                          {bookingOfficer.name}
                        </p>
                        <a
                          href={`tel:${bookingOfficer.phone.replace(/\s/g, "")}`}
                          className="website-link text-sm"
                        >
                          {bookingOfficer.phone}
                        </a>
                      </div>
                    </div>
                  )}
                  <div className="flex items-start gap-3">
                    <MapPin className="mt-0.5 h-5 w-5 shrink-0 text-brand-gold" />
                    <div>
                      <p className="text-sm font-medium text-brand-charcoal">
                        Lodge
                      </p>
                      <p className="text-sm text-brand-deep/75">
                        Waldvogel Lodge, Iwikau Village, Mt Ruapehu, New Zealand
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-brand-ridge/20 bg-brand-mist/35 shadow-[0_20px_45px_-35px_rgba(47,47,43,0.35)]">
                <CardContent className="pt-6">
                  <h3 className="mb-3 font-heading text-lg font-semibold text-brand-charcoal">
                    Follow Us
                  </h3>
                  <a
                    href="https://www.facebook.com/TokoroaAlpineClub/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="website-link text-sm"
                  >
                    Facebook — Tokoroa Alpine Club
                  </a>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
