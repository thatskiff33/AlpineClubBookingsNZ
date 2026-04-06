import { NextResponse } from "next/server";
import { z } from "zod";
import { sendEmail } from "@/lib/email";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { escapeHtml } from "@/lib/email-templates";

const contactSchema = z.object({
  name: z.string().min(1, "Name is required").max(200),
  email: z.string().email("Invalid email address").max(200),
  message: z.string().min(1, "Message is required").max(5000),
});

const CONTACT_EMAIL =
  process.env.CONTACT_EMAIL || "bookings@tacbookings.co.nz";

export async function POST(request: Request) {
  // Rate limit: 5 per hour
  const rateLimited = applyRateLimit(rateLimiters.contact, request);
  if (rateLimited) return rateLimited;

  try {
    const body = await request.json();
    const result = contactSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        { error: "Invalid input", details: result.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const { name, email, message } = result.data;

    await sendEmail({
      to: CONTACT_EMAIL,
      subject: `Website Contact: ${escapeHtml(name)}`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #1e293b;">New Contact Form Submission</h2>
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px 0; font-weight: bold; color: #475569; vertical-align: top; width: 80px;">Name:</td>
              <td style="padding: 8px 0; color: #1e293b;">${escapeHtml(name)}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; font-weight: bold; color: #475569; vertical-align: top;">Email:</td>
              <td style="padding: 8px 0; color: #1e293b;"><a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></td>
            </tr>
            <tr>
              <td style="padding: 8px 0; font-weight: bold; color: #475569; vertical-align: top;">Message:</td>
              <td style="padding: 8px 0; color: #1e293b; white-space: pre-wrap;">${escapeHtml(message)}</td>
            </tr>
          </table>
        </div>
      `,
    });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "Failed to send message. Please try again later." },
      { status: 500 }
    );
  }
}
