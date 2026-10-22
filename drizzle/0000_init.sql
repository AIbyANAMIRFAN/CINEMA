CREATE TYPE "public"."booking_status" AS ENUM('PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED', 'REFUNDED');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'REFUNDED');--> statement-breakpoint
CREATE TYPE "public"."seat_status" AS ENUM('AVAILABLE', 'HELD', 'BOOKED', 'BLOCKED');--> statement-breakpoint
CREATE TYPE "public"."seat_type" AS ENUM('STANDARD', 'PREMIUM', 'ACCESSIBLE');--> statement-breakpoint
CREATE TYPE "public"."showtime_status" AS ENUM('SCHEDULED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('USER', 'ADMIN');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"action" varchar(80) NOT NULL,
	"entity_type" varchar(40) NOT NULL,
	"entity_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auditoriums" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cinema_id" uuid NOT NULL,
	"name" varchar(60) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "booking_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"showtime_seat_id" uuid NOT NULL,
	"price_minor" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_items_price_ck" CHECK ("booking_items"."price_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" varchar(16) NOT NULL,
	"user_id" uuid NOT NULL,
	"showtime_id" uuid NOT NULL,
	"status" "booking_status" DEFAULT 'PENDING' NOT NULL,
	"subtotal_minor" integer NOT NULL,
	"fee_minor" integer NOT NULL,
	"tax_minor" integer NOT NULL,
	"total_minor" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"idempotency_key" varchar(100) NOT NULL,
	"hold_expires_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookings_amounts_ck" CHECK ("bookings"."subtotal_minor" >= 0 and "bookings"."fee_minor" >= 0 and "bookings"."tax_minor" >= 0 and "bookings"."total_minor" = "bookings"."subtotal_minor" + "bookings"."fee_minor" + "bookings"."tax_minor")
);
--> statement-breakpoint
CREATE TABLE "cinemas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"slug" varchar(140) NOT NULL,
	"city" varchar(80) NOT NULL,
	"address" text NOT NULL,
	"timezone" varchar(64) DEFAULT 'UTC' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "genres" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(60) NOT NULL,
	"slug" varchar(60) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "movie_genres" (
	"movie_id" uuid NOT NULL,
	"genre_id" uuid NOT NULL,
	CONSTRAINT "movie_genres_movie_id_genre_id_pk" PRIMARY KEY("movie_id","genre_id")
);
--> statement-breakpoint
CREATE TABLE "movies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(200) NOT NULL,
	"slug" varchar(220) NOT NULL,
	"synopsis" text NOT NULL,
	"duration_minutes" integer NOT NULL,
	"language" varchar(40) NOT NULL,
	"age_rating" varchar(10) NOT NULL,
	"release_date" date NOT NULL,
	"poster_url" text,
	"director" varchar(120),
	"cast_list" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "movies_duration_ck" CHECK ("movies"."duration_minutes" between 1 and 600),
	CONSTRAINT "movies_title_ck" CHECK (length(trim("movies"."title")) > 0)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"provider" varchar(20) DEFAULT 'stripe' NOT NULL,
	"status" "payment_status" DEFAULT 'PENDING' NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"idempotency_key" varchar(120) NOT NULL,
	"provider_session_id" varchar(255),
	"provider_payment_intent_id" varchar(255),
	"provider_refund_id" varchar(255),
	"checkout_url" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_amount_ck" CHECK ("payments"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "seats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"auditorium_id" uuid NOT NULL,
	"row_label" varchar(4) NOT NULL,
	"seat_number" integer NOT NULL,
	"seat_type" "seat_type" DEFAULT 'STANDARD' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "seats_number_ck" CHECK ("seats"."seat_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "showtime_seats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"showtime_id" uuid NOT NULL,
	"seat_id" uuid NOT NULL,
	"status" "seat_status" DEFAULT 'AVAILABLE' NOT NULL,
	"price_minor" integer NOT NULL,
	"held_by_booking_id" uuid,
	"hold_expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "showtime_seats_price_ck" CHECK ("showtime_seats"."price_minor" >= 0),
	CONSTRAINT "showtime_seats_hold_ck" CHECK (("showtime_seats"."status" in ('HELD','BOOKED') and "showtime_seats"."held_by_booking_id" is not null) or ("showtime_seats"."status" in ('AVAILABLE','BLOCKED') and "showtime_seats"."held_by_booking_id" is null and "showtime_seats"."hold_expires_at" is null)),
	CONSTRAINT "showtime_seats_hold_expiry_ck" CHECK ("showtime_seats"."status" <> 'HELD' or "showtime_seats"."hold_expires_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "showtimes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"movie_id" uuid NOT NULL,
	"auditorium_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"base_price_minor" integer NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"status" "showtime_status" DEFAULT 'SCHEDULED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "showtimes_time_ck" CHECK ("showtimes"."ends_at" > "showtimes"."starts_at"),
	CONSTRAINT "showtimes_price_ck" CHECK ("showtimes"."base_price_minor" >= 0),
	CONSTRAINT "showtimes_currency_ck" CHECK ("showtimes"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"code" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(320) NOT NULL,
	"name" varchar(120) NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'USER' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_format_ck" CHECK ("users"."email" ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
	CONSTRAINT "users_name_ck" CHECK (length(trim("users"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"provider" varchar(20) NOT NULL,
	"type" varchar(100) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auditoriums" ADD CONSTRAINT "auditoriums_cinema_id_cinemas_id_fk" FOREIGN KEY ("cinema_id") REFERENCES "public"."cinemas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_items" ADD CONSTRAINT "booking_items_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_items" ADD CONSTRAINT "booking_items_showtime_seat_id_showtime_seats_id_fk" FOREIGN KEY ("showtime_seat_id") REFERENCES "public"."showtime_seats"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_showtime_id_showtimes_id_fk" FOREIGN KEY ("showtime_id") REFERENCES "public"."showtimes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movie_genres" ADD CONSTRAINT "movie_genres_movie_id_movies_id_fk" FOREIGN KEY ("movie_id") REFERENCES "public"."movies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movie_genres" ADD CONSTRAINT "movie_genres_genre_id_genres_id_fk" FOREIGN KEY ("genre_id") REFERENCES "public"."genres"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seats" ADD CONSTRAINT "seats_auditorium_id_auditoriums_id_fk" FOREIGN KEY ("auditorium_id") REFERENCES "public"."auditoriums"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showtime_seats" ADD CONSTRAINT "showtime_seats_showtime_id_showtimes_id_fk" FOREIGN KEY ("showtime_id") REFERENCES "public"."showtimes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showtime_seats" ADD CONSTRAINT "showtime_seats_seat_id_seats_id_fk" FOREIGN KEY ("seat_id") REFERENCES "public"."seats"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showtime_seats" ADD CONSTRAINT "showtime_seats_held_by_booking_id_bookings_id_fk" FOREIGN KEY ("held_by_booking_id") REFERENCES "public"."bookings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showtimes" ADD CONSTRAINT "showtimes_movie_id_movies_id_fk" FOREIGN KEY ("movie_id") REFERENCES "public"."movies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showtimes" ADD CONSTRAINT "showtimes_auditorium_id_auditoriums_id_fk" FOREIGN KEY ("auditorium_id") REFERENCES "public"."auditoriums"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_logs_created_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "auditoriums_cinema_name_uq" ON "auditoriums" USING btree ("cinema_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_items_booking_seat_uq" ON "booking_items" USING btree ("booking_id","showtime_seat_id");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_items_active_seat_uq" ON "booking_items" USING btree ("showtime_seat_id") WHERE "booking_items"."active";--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_reference_uq" ON "bookings" USING btree ("reference");--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_user_idempotency_uq" ON "bookings" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "bookings_user_created_idx" ON "bookings" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "bookings_showtime_idx" ON "bookings" USING btree ("showtime_id");--> statement-breakpoint
CREATE INDEX "bookings_pending_hold_idx" ON "bookings" USING btree ("hold_expires_at") WHERE "bookings"."status" = 'PENDING';--> statement-breakpoint
CREATE UNIQUE INDEX "cinemas_slug_uq" ON "cinemas" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "cinemas_city_idx" ON "cinemas" USING btree ("city");--> statement-breakpoint
CREATE UNIQUE INDEX "genres_name_uq" ON "genres" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "genres_slug_uq" ON "genres" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "movie_genres_genre_idx" ON "movie_genres" USING btree ("genre_id");--> statement-breakpoint
CREATE UNIQUE INDEX "movies_slug_uq" ON "movies" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "movies_title_idx" ON "movies" USING btree ("title");--> statement-breakpoint
CREATE INDEX "movies_language_idx" ON "movies" USING btree ("language");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_idempotency_uq" ON "payments" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_session_uq" ON "payments" USING btree ("provider_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_intent_uq" ON "payments" USING btree ("provider_payment_intent_id");--> statement-breakpoint
CREATE INDEX "payments_booking_idx" ON "payments" USING btree ("booking_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_one_success_uq" ON "payments" USING btree ("booking_id") WHERE "payments"."status" = 'SUCCEEDED';--> statement-breakpoint
CREATE UNIQUE INDEX "seats_position_uq" ON "seats" USING btree ("auditorium_id","row_label","seat_number");--> statement-breakpoint
CREATE UNIQUE INDEX "showtime_seats_showtime_seat_uq" ON "showtime_seats" USING btree ("showtime_id","seat_id");--> statement-breakpoint
CREATE INDEX "showtime_seats_held_idx" ON "showtime_seats" USING btree ("hold_expires_at") WHERE "showtime_seats"."status" = 'HELD';--> statement-breakpoint
CREATE INDEX "showtime_seats_booking_idx" ON "showtime_seats" USING btree ("held_by_booking_id");--> statement-breakpoint
CREATE INDEX "showtimes_movie_starts_idx" ON "showtimes" USING btree ("movie_id","starts_at");--> statement-breakpoint
CREATE INDEX "showtimes_auditorium_starts_idx" ON "showtimes" USING btree ("auditorium_id","starts_at");--> statement-breakpoint
CREATE INDEX "showtimes_starts_idx" ON "showtimes" USING btree ("starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_booking_uq" ON "tickets" USING btree ("booking_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_code_uq" ON "tickets" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_uq" ON "users" USING btree (lower("email"));