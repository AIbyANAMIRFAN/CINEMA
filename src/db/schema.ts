import { relations, sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// All timestamps are timestamptz and written in UTC. All money is integer minor units (e.g. cents).
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();
const updatedAt = () =>
  ts("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const pk = () => uuid("id").primaryKey().defaultRandom();

export const userRole = pgEnum("user_role", ["USER", "ADMIN"]);
export const seatType = pgEnum("seat_type", ["STANDARD", "PREMIUM", "ACCESSIBLE"]);
export const showtimeStatus = pgEnum("showtime_status", ["SCHEDULED", "CANCELLED"]);
export const seatStatus = pgEnum("seat_status", ["AVAILABLE", "HELD", "BOOKED", "BLOCKED"]);
export const bookingStatus = pgEnum("booking_status", [
  "PENDING",
  "CONFIRMED",
  "CANCELLED",
  "EXPIRED",
  "REFUNDED",
]);
export const paymentStatus = pgEnum("payment_status", [
  "PENDING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "REFUNDED",
]);

export const users = pgTable(
  "users",
  {
    id: pk(),
    email: varchar("email", { length: 320 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    passwordHash: text("password_hash").notNull(),
    role: userRole("role").notNull().default("USER"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("users_email_lower_uq").on(sql`lower(${t.email})`),
    check("users_email_format_ck", sql`${t.email} ~* '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$'`),
    check("users_name_ck", sql`length(trim(${t.name})) > 0`),
  ],
);

export const genres = pgTable(
  "genres",
  {
    id: pk(),
    name: varchar("name", { length: 60 }).notNull(),
    slug: varchar("slug", { length: 60 }).notNull(),
  },
  (t) => [uniqueIndex("genres_name_uq").on(t.name), uniqueIndex("genres_slug_uq").on(t.slug)],
);

export const movies = pgTable(
  "movies",
  {
    id: pk(),
    title: varchar("title", { length: 200 }).notNull(),
    slug: varchar("slug", { length: 220 }).notNull(),
    synopsis: text("synopsis").notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    language: varchar("language", { length: 40 }).notNull(),
    ageRating: varchar("age_rating", { length: 10 }).notNull(),
    releaseDate: date("release_date", { mode: "string" }).notNull(),
    posterUrl: text("poster_url"),
    director: varchar("director", { length: 120 }),
    castList: text("cast_list"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("movies_slug_uq").on(t.slug),
    index("movies_title_idx").on(t.title),
    index("movies_language_idx").on(t.language),
    check("movies_duration_ck", sql`${t.durationMinutes} between 1 and 600`),
    check("movies_title_ck", sql`length(trim(${t.title})) > 0`),
  ],
);

export const movieGenres = pgTable(
  "movie_genres",
  {
    movieId: uuid("movie_id")
      .notNull()
      .references(() => movies.id, { onDelete: "cascade" }),
    genreId: uuid("genre_id")
      .notNull()
      .references(() => genres.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.movieId, t.genreId] }),
    index("movie_genres_genre_idx").on(t.genreId),
  ],
);

export const cinemas = pgTable(
  "cinemas",
  {
    id: pk(),
    name: varchar("name", { length: 120 }).notNull(),
    slug: varchar("slug", { length: 140 }).notNull(),
    city: varchar("city", { length: 80 }).notNull(),
    address: text("address").notNull(),
    // IANA zone used only for display; stored times are UTC.
    timezone: varchar("timezone", { length: 64 }).notNull().default("UTC"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("cinemas_slug_uq").on(t.slug), index("cinemas_city_idx").on(t.city)],
);

export const auditoriums = pgTable(
  "auditoriums",
  {
    id: pk(),
    cinemaId: uuid("cinema_id")
      .notNull()
      .references(() => cinemas.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 60 }).notNull(),
    createdAt: createdAt(),
  },
  // Screen names are unique within a cinema.
  (t) => [uniqueIndex("auditoriums_cinema_name_uq").on(t.cinemaId, t.name)],
);

export const seats = pgTable(
  "seats",
  {
    id: pk(),
    auditoriumId: uuid("auditorium_id")
      .notNull()
      .references(() => auditoriums.id, { onDelete: "cascade" }),
    rowLabel: varchar("row_label", { length: 4 }).notNull(),
    seatNumber: integer("seat_number").notNull(),
    seatType: seatType("seat_type").notNull().default("STANDARD"),
    isActive: boolean("is_active").notNull().default(true),
  },
  (t) => [
    uniqueIndex("seats_position_uq").on(t.auditoriumId, t.rowLabel, t.seatNumber),
    check("seats_number_ck", sql`${t.seatNumber} > 0`),
  ],
);

export const showtimes = pgTable(
  "showtimes",
  {
    id: pk(),
    movieId: uuid("movie_id")
      .notNull()
      .references(() => movies.id, { onDelete: "restrict" }),
    auditoriumId: uuid("auditorium_id")
      .notNull()
      .references(() => auditoriums.id, { onDelete: "restrict" }),
    startsAt: ts("starts_at").notNull(),
    endsAt: ts("ends_at").notNull(),
    basePriceMinor: integer("base_price_minor").notNull(),
    currency: char("currency", { length: 3 }).notNull().default("USD"),
    status: showtimeStatus("status").notNull().default("SCHEDULED"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("showtimes_movie_starts_idx").on(t.movieId, t.startsAt),
    index("showtimes_auditorium_starts_idx").on(t.auditoriumId, t.startsAt),
    index("showtimes_starts_idx").on(t.startsAt),
    check("showtimes_time_ck", sql`${t.endsAt} > ${t.startsAt}`),
    check("showtimes_price_ck", sql`${t.basePriceMinor} >= 0`),
    check("showtimes_currency_ck", sql`${t.currency} ~ '^[A-Z]{3}$'`),
  ],
);

export const bookings = pgTable(
  "bookings",
  {
    id: pk(),
    reference: varchar("reference", { length: 16 }).notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    showtimeId: uuid("showtime_id")
      .notNull()
      .references(() => showtimes.id, { onDelete: "restrict" }),
    status: bookingStatus("status").notNull().default("PENDING"),
    subtotalMinor: integer("subtotal_minor").notNull(),
    feeMinor: integer("fee_minor").notNull(),
    taxMinor: integer("tax_minor").notNull(),
    totalMinor: integer("total_minor").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    // Client-supplied key: retrying the same hold request returns the same booking.
    idempotencyKey: varchar("idempotency_key", { length: 100 }).notNull(),
    holdExpiresAt: ts("hold_expires_at").notNull(),
    confirmedAt: ts("confirmed_at"),
    cancelledAt: ts("cancelled_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("bookings_reference_uq").on(t.reference),
    uniqueIndex("bookings_user_idempotency_uq").on(t.userId, t.idempotencyKey),
    index("bookings_user_created_idx").on(t.userId, t.createdAt),
    index("bookings_showtime_idx").on(t.showtimeId),
    index("bookings_pending_hold_idx")
      .on(t.holdExpiresAt)
      .where(sql`${t.status} = 'PENDING'`),
    check(
      "bookings_amounts_ck",
      sql`${t.subtotalMinor} >= 0 and ${t.feeMinor} >= 0 and ${t.taxMinor} >= 0 and ${t.totalMinor} = ${t.subtotalMinor} + ${t.feeMinor} + ${t.taxMinor}`,
    ),
  ],
);

export const showtimeSeats = pgTable(
  "showtime_seats",
  {
    id: pk(),
    showtimeId: uuid("showtime_id")
      .notNull()
      .references(() => showtimes.id, { onDelete: "cascade" }),
    seatId: uuid("seat_id")
      .notNull()
      .references(() => seats.id, { onDelete: "restrict" }),
    status: seatStatus("status").notNull().default("AVAILABLE"),
    priceMinor: integer("price_minor").notNull(),
    heldByBookingId: uuid("held_by_booking_id").references(() => bookings.id, {
      onDelete: "set null",
    }),
    holdExpiresAt: ts("hold_expires_at"),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("showtime_seats_showtime_seat_uq").on(t.showtimeId, t.seatId),
    index("showtime_seats_held_idx")
      .on(t.holdExpiresAt)
      .where(sql`${t.status} = 'HELD'`),
    index("showtime_seats_booking_idx").on(t.heldByBookingId),
    check("showtime_seats_price_ck", sql`${t.priceMinor} >= 0`),
    // A HELD or BOOKED seat must point at its booking; AVAILABLE/BLOCKED must not.
    check(
      "showtime_seats_hold_ck",
      sql`(${t.status} in ('HELD','BOOKED') and ${t.heldByBookingId} is not null) or (${t.status} in ('AVAILABLE','BLOCKED') and ${t.heldByBookingId} is null and ${t.holdExpiresAt} is null)`,
    ),
    check(
      "showtime_seats_hold_expiry_ck",
      sql`${t.status} <> 'HELD' or ${t.holdExpiresAt} is not null`,
    ),
  ],
);

export const bookingItems = pgTable(
  "booking_items",
  {
    id: pk(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    showtimeSeatId: uuid("showtime_seat_id")
      .notNull()
      .references(() => showtimeSeats.id, { onDelete: "restrict" }),
    priceMinor: integer("price_minor").notNull(),
    // True while the booking holds or owns the seat. Cleared on cancel/expiry/refund.
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("booking_items_booking_seat_uq").on(t.bookingId, t.showtimeSeatId),
    // The database-level guarantee that one showtime seat can never be in two live bookings.
    uniqueIndex("booking_items_active_seat_uq")
      .on(t.showtimeSeatId)
      .where(sql`${t.active}`),
    check("booking_items_price_ck", sql`${t.priceMinor} >= 0`),
  ],
);

export const payments = pgTable(
  "payments",
  {
    id: pk(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "restrict" }),
    provider: varchar("provider", { length: 20 }).notNull().default("stripe"),
    status: paymentStatus("status").notNull().default("PENDING"),
    amountMinor: integer("amount_minor").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 120 }).notNull(),
    providerSessionId: varchar("provider_session_id", { length: 255 }),
    providerPaymentIntentId: varchar("provider_payment_intent_id", { length: 255 }),
    providerRefundId: varchar("provider_refund_id", { length: 255 }),
    checkoutUrl: text("checkout_url"),
    failureReason: text("failure_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("payments_idempotency_uq").on(t.idempotencyKey),
    uniqueIndex("payments_session_uq").on(t.providerSessionId),
    uniqueIndex("payments_intent_uq").on(t.providerPaymentIntentId),
    index("payments_booking_idx").on(t.bookingId),
    // At most one live successful payment per booking; a duplicate charge is refunded instead.
    uniqueIndex("payments_one_success_uq")
      .on(t.bookingId)
      .where(sql`${t.status} = 'SUCCEEDED'`),
    check("payments_amount_ck", sql`${t.amountMinor} > 0`),
  ],
);

// Provider webhook event ids already processed, so duplicate deliveries are no-ops.
export const webhookEvents = pgTable("webhook_events", {
  id: varchar("id", { length: 255 }).primaryKey(),
  provider: varchar("provider", { length: 20 }).notNull(),
  type: varchar("type", { length: 100 }).notNull(),
  receivedAt: createdAt(),
});

export const tickets = pgTable(
  "tickets",
  {
    id: pk(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    code: varchar("code", { length: 64 }).notNull(),
    issuedAt: createdAt(),
    revokedAt: ts("revoked_at"),
  },
  (t) => [uniqueIndex("tickets_booking_uq").on(t.bookingId), uniqueIndex("tickets_code_uq").on(t.code)],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: pk(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    action: varchar("action", { length: 80 }).notNull(),
    entityType: varchar("entity_type", { length: 40 }).notNull(),
    entityId: uuid("entity_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_logs_entity_idx").on(t.entityType, t.entityId),
    index("audit_logs_created_idx").on(t.createdAt),
  ],
);

export const usersRelations = relations(users, ({ many }) => ({ bookings: many(bookings) }));
export const moviesRelations = relations(movies, ({ many }) => ({
  movieGenres: many(movieGenres),
  showtimes: many(showtimes),
}));
export const genresRelations = relations(genres, ({ many }) => ({ movieGenres: many(movieGenres) }));
export const movieGenresRelations = relations(movieGenres, ({ one }) => ({
  movie: one(movies, { fields: [movieGenres.movieId], references: [movies.id] }),
  genre: one(genres, { fields: [movieGenres.genreId], references: [genres.id] }),
}));
export const cinemasRelations = relations(cinemas, ({ many }) => ({ auditoriums: many(auditoriums) }));
export const auditoriumsRelations = relations(auditoriums, ({ one, many }) => ({
  cinema: one(cinemas, { fields: [auditoriums.cinemaId], references: [cinemas.id] }),
  seats: many(seats),
  showtimes: many(showtimes),
}));
export const seatsRelations = relations(seats, ({ one }) => ({
  auditorium: one(auditoriums, { fields: [seats.auditoriumId], references: [auditoriums.id] }),
}));
export const showtimesRelations = relations(showtimes, ({ one, many }) => ({
  movie: one(movies, { fields: [showtimes.movieId], references: [movies.id] }),
  auditorium: one(auditoriums, { fields: [showtimes.auditoriumId], references: [auditoriums.id] }),
  showtimeSeats: many(showtimeSeats),
}));
export const showtimeSeatsRelations = relations(showtimeSeats, ({ one }) => ({
  showtime: one(showtimes, { fields: [showtimeSeats.showtimeId], references: [showtimes.id] }),
  seat: one(seats, { fields: [showtimeSeats.seatId], references: [seats.id] }),
}));
export const bookingsRelations = relations(bookings, ({ one, many }) => ({
  user: one(users, { fields: [bookings.userId], references: [users.id] }),
  showtime: one(showtimes, { fields: [bookings.showtimeId], references: [showtimes.id] }),
  items: many(bookingItems),
  payments: many(payments),
  ticket: one(tickets, { fields: [bookings.id], references: [tickets.bookingId] }),
}));
export const bookingItemsRelations = relations(bookingItems, ({ one }) => ({
  booking: one(bookings, { fields: [bookingItems.bookingId], references: [bookings.id] }),
  showtimeSeat: one(showtimeSeats, {
    fields: [bookingItems.showtimeSeatId],
    references: [showtimeSeats.id],
  }),
}));
export const paymentsRelations = relations(payments, ({ one }) => ({
  booking: one(bookings, { fields: [payments.bookingId], references: [bookings.id] }),
}));
export const ticketsRelations = relations(tickets, ({ one }) => ({
  booking: one(bookings, { fields: [tickets.bookingId], references: [bookings.id] }),
}));
