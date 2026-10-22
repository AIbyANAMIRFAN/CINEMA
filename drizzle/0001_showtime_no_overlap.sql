-- Two scheduled showtimes may never overlap in the same auditorium.
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
ALTER TABLE "showtimes" ADD CONSTRAINT "showtimes_no_overlap_ex"
  EXCLUDE USING gist ("auditorium_id" WITH =, tstzrange("starts_at", "ends_at", '[)') WITH &&)
  WHERE ("status" = 'SCHEDULED');
