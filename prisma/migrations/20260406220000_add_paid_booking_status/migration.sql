-- Add PAID to BookingStatus enum
ALTER TYPE "BookingStatus" ADD VALUE IF NOT EXISTS 'PAID' AFTER 'CONFIRMED';
