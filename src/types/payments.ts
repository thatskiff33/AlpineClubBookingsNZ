import { z } from "zod";

export const CreatePaymentIntentSchema = z.object({
  bookingId: z.string().min(1),
});

export const CreateSetupIntentSchema = z.object({
  bookingId: z.string().min(1),
});

export const ConfirmBookingPaymentSchema = z.object({
  bookingId: z.string().min(1),
  paymentIntentId: z.string().min(1),
});

export const CancelBookingSchema = z.object({
  bookingId: z.string().min(1),
});

export type CreatePaymentIntentInput = z.infer<typeof CreatePaymentIntentSchema>;
export type CreateSetupIntentInput = z.infer<typeof CreateSetupIntentSchema>;
export type ConfirmBookingPaymentInput = z.infer<typeof ConfirmBookingPaymentSchema>;
export type CancelBookingInput = z.infer<typeof CancelBookingSchema>;
