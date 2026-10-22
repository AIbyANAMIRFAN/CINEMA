import { and, asc, count, desc, eq, gte, inArray, sql, sum } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@/db/client";
import {
  auditLogs,
  auditoriums,
  bookings,
  cinemas,
  genres,
  movieGenres,
  movies,
  seats,
  showtimeSeats,
  showtimes,
  users,
} from "@/db/schema";
import { AppError, PG_EXCLUSION_VIOLATION, PG_UNIQUE_VIOLATION, pgCode } from "@/lib/errors";
import { seatPrice } from "@/lib/pricing";
import { audit, cancelBooking } from "./bookings";
import type { PaymentGateway } from "./gateway";

export const movieInput = z.object({
  title: z.string().trim().min(1).max(200),
  synopsis: z.string().trim().min(1).max(5000),
  durationMinutes: z.coerce.number().int().min(1).max(600),
  language: z.string().trim().min(1).max(40),
  ageRating: z.string().trim().min(1).max(10),
  releaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  posterUrl: z
    .string()
    .trim()
    .url()
    .refine((u) => u.startsWith("https://"), "Poster URL must use https")
    .nullable()
    .optional(),
  director: z.string().trim().max(120).nullable().optional(),
  castList: z.string().trim().max(1000).nullable().optional(),
  isActive: z.boolean().optional(),
  genreSlugs: z.array(z.string()).max(10).default([]),
});
export type MovieInput = z.infer<typeof movieInput>;

export function slugify(s: string) {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200);
}

async function setGenres(tx: Parameters<Parameters<Database["transaction"]>[0]>[0], movieId: string, slugs: string[]) {
  await tx.delete(movieGenres).where(eq(movieGenres.movieId, movieId));
  if (!slugs.length) return;
  const rows = await tx.select({ id: genres.id }).from(genres).where(inArray(genres.slug, slugs));
  if (rows.length) await tx.insert(movieGenres).values(rows.map((g) => ({ movieId, genreId: g.id })));
}

export async function createMovie(db: Database, actorUserId: string, raw: unknown) {
  const input = movieInput.parse(raw);
  const { genreSlugs, ...data } = input;
  try {
    return await db.transaction(async (tx) => {
      const [m] = await tx
        .insert(movies)
        .values({ ...data, slug: slugify(`${data.title}-${data.releaseDate.slice(0, 4)}`) })
        .returning();
      await setGenres(tx, m.id, genreSlugs);
      await audit(tx, { actorUserId, action: "movie.created", entityType: "movie", entityId: m.id });
      return m;
    });
  } catch (err) {
    if (pgCode(err) === PG_UNIQUE_VIOLATION) throw new AppError("CONFLICT", "A movie with this title and year already exists.");
    throw err;
  }
}

export async function updateMovie(db: Database, actorUserId: string, movieId: string, raw: unknown) {
  const input = movieInput.partial().parse(raw);
  const { genreSlugs, ...data } = input;
  return db.transaction(async (tx) => {
    const [m] = await tx.update(movies).set(data).where(eq(movies.id, movieId)).returning();
    if (!m) throw new AppError("NOT_FOUND", "Movie not found.");
    if (genreSlugs) await setGenres(tx, m.id, genreSlugs);
    await audit(tx, { actorUserId, action: "movie.updated", entityType: "movie", entityId: m.id, metadata: { fields: Object.keys(input) } });
    return m;
  });
}

export const showtimeInput = z.object({
  movieId: z.string().uuid(),
  auditoriumId: z.string().uuid(),
  startsAt: z.coerce.date(),
  basePriceMinor: z.coerce.number().int().min(0).max(1_000_000),
  currency: z.string().regex(/^[A-Z]{3}$/).default("USD"),
  /** Minutes between end of film and next show, for cleaning. */
  turnaroundMinutes: z.coerce.number().int().min(0).max(120).default(15),
});

/** Create a showtime and one showtime_seats row per active seat, priced by seat type. */
export async function createShowtime(db: Database, actorUserId: string, raw: unknown, now = new Date()) {
  const input = showtimeInput.parse(raw);
  if (input.startsAt <= now) throw new AppError("BAD_REQUEST", "Showtimes must start in the future.");
  try {
    return await db.transaction(async (tx) => {
      const [movie] = await tx.select().from(movies).where(eq(movies.id, input.movieId));
      if (!movie) throw new AppError("NOT_FOUND", "Movie not found.");
      const auditoriumSeats = await tx
        .select()
        .from(seats)
        .where(and(eq(seats.auditoriumId, input.auditoriumId), eq(seats.isActive, true)));
      if (!auditoriumSeats.length) throw new AppError("BAD_REQUEST", "This auditorium has no seats.");
      const endsAt = new Date(
        input.startsAt.getTime() + (movie.durationMinutes + input.turnaroundMinutes) * 60_000,
      );
      const [st] = await tx
        .insert(showtimes)
        .values({
          movieId: input.movieId,
          auditoriumId: input.auditoriumId,
          startsAt: input.startsAt,
          endsAt,
          basePriceMinor: input.basePriceMinor,
          currency: input.currency,
        })
        .returning();
      await tx.insert(showtimeSeats).values(
        auditoriumSeats.map((s) => ({
          showtimeId: st.id,
          seatId: s.id,
          priceMinor: seatPrice(input.basePriceMinor, s.seatType),
        })),
      );
      await audit(tx, { actorUserId, action: "showtime.created", entityType: "showtime", entityId: st.id });
      return st;
    });
  } catch (err) {
    if (pgCode(err) === PG_EXCLUSION_VIOLATION) {
      throw new AppError("CONFLICT", "This auditorium already has a showtime overlapping that time.");
    }
    throw err;
  }
}

/** Cancel a showtime: refunds confirmed bookings and releases pending ones. */
export async function cancelShowtime(db: Database, gateway: PaymentGateway, actorUserId: string, showtimeId: string) {
  const [st] = await db
    .update(showtimes)
    .set({ status: "CANCELLED" })
    .where(and(eq(showtimes.id, showtimeId), eq(showtimes.status, "SCHEDULED")))
    .returning();
  if (!st) throw new AppError("NOT_FOUND", "Scheduled showtime not found.");
  await audit(db, { actorUserId, action: "showtime.cancelled", entityType: "showtime", entityId: showtimeId });
  const live = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(and(eq(bookings.showtimeId, showtimeId), inArray(bookings.status, ["PENDING", "CONFIRMED"])));
  let refunded = 0;
  let released = 0;
  const failures: string[] = [];
  for (const b of live) {
    try {
      const r = await cancelBooking(db, gateway, { bookingId: b.id, actorUserId, isAdmin: true, reason: "showtime_cancelled" });
      if (r.status === "REFUNDED") refunded++;
      else released++;
    } catch {
      failures.push(b.id);
    }
  }
  return { refunded, released, failures };
}

/** Block or unblock a single seat for a showtime (e.g. broken seat). Only AVAILABLE/BLOCKED seats change. */
export async function setSeatBlocked(db: Database, actorUserId: string, showtimeSeatId: string, blocked: boolean) {
  const [row] = await db
    .update(showtimeSeats)
    .set({ status: blocked ? "BLOCKED" : "AVAILABLE" })
    .where(and(eq(showtimeSeats.id, showtimeSeatId), eq(showtimeSeats.status, blocked ? "AVAILABLE" : "BLOCKED")))
    .returning();
  if (!row) throw new AppError("CONFLICT", "Only available seats can be blocked, and only blocked seats unblocked.");
  await audit(db, { actorUserId, action: blocked ? "seat.blocked" : "seat.unblocked", entityType: "showtime_seat", entityId: row.id });
  return row;
}

export async function adminStats(db: Database, now = new Date()) {
  const since = new Date(now.getTime() - 30 * 24 * 3600_000);
  const [[rev], [conf], [upcoming], [userCount], byStatus] = await Promise.all([
    db
      .select({ total: sum(bookings.totalMinor).mapWith(Number) })
      .from(bookings)
      .where(and(eq(bookings.status, "CONFIRMED"), gte(bookings.confirmedAt, since))),
    db.select({ n: count() }).from(bookings).where(and(eq(bookings.status, "CONFIRMED"), gte(bookings.confirmedAt, since))),
    db.select({ n: count() }).from(showtimes).where(and(eq(showtimes.status, "SCHEDULED"), gte(showtimes.startsAt, now))),
    db.select({ n: count() }).from(users),
    db.select({ status: bookings.status, n: count() }).from(bookings).groupBy(bookings.status),
  ]);
  return {
    revenue30dMinor: rev?.total ?? 0,
    confirmed30d: conf?.n ?? 0,
    upcomingShowtimes: upcoming?.n ?? 0,
    users: userCount?.n ?? 0,
    bookingsByStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.n])) as Record<string, number>,
  };
}

export async function adminListBookings(db: Database, opts: { status?: string; limit?: number } = {}) {
  const statuses = ["PENDING", "CONFIRMED", "CANCELLED", "EXPIRED", "REFUNDED"] as const;
  const status = statuses.find((s) => s === opts.status);
  return db
    .select({
      id: bookings.id,
      reference: bookings.reference,
      status: bookings.status,
      totalMinor: bookings.totalMinor,
      currency: bookings.currency,
      createdAt: bookings.createdAt,
      userEmail: users.email,
      movieTitle: movies.title,
      startsAt: showtimes.startsAt,
      cinemaName: cinemas.name,
      timezone: cinemas.timezone,
    })
    .from(bookings)
    .innerJoin(users, eq(users.id, bookings.userId))
    .innerJoin(showtimes, eq(showtimes.id, bookings.showtimeId))
    .innerJoin(movies, eq(movies.id, showtimes.movieId))
    .innerJoin(auditoriums, eq(auditoriums.id, showtimes.auditoriumId))
    .innerJoin(cinemas, eq(cinemas.id, auditoriums.cinemaId))
    .where(status ? eq(bookings.status, status) : undefined)
    .orderBy(desc(bookings.createdAt))
    .limit(Math.min(opts.limit ?? 100, 500));
}

export async function adminListMovies(db: Database) {
  return db
    .select({
      id: movies.id,
      title: movies.title,
      slug: movies.slug,
      language: movies.language,
      durationMinutes: movies.durationMinutes,
      isActive: movies.isActive,
      releaseDate: movies.releaseDate,
      upcomingShowtimes: sql<number>`(select count(*)::int from ${showtimes} s where s.movie_id = ${movies.id}
        and s.status = 'SCHEDULED' and s.starts_at > now())`,
    })
    .from(movies)
    .orderBy(asc(movies.title));
}

export async function adminListAuditoriums(db: Database) {
  return db
    .select({
      id: auditoriums.id,
      name: auditoriums.name,
      cinemaName: cinemas.name,
      timezone: cinemas.timezone,
      seats: sql<number>`(select count(*)::int from ${seats} s where s.auditorium_id = ${auditoriums.id} and s.is_active)`,
    })
    .from(auditoriums)
    .innerJoin(cinemas, eq(cinemas.id, auditoriums.cinemaId))
    .orderBy(asc(cinemas.name), asc(auditoriums.name));
}

export async function adminListShowtimes(db: Database, now = new Date()) {
  return db
    .select({
      id: showtimes.id,
      startsAt: showtimes.startsAt,
      status: showtimes.status,
      basePriceMinor: showtimes.basePriceMinor,
      currency: showtimes.currency,
      movieTitle: movies.title,
      auditoriumName: auditoriums.name,
      cinemaName: cinemas.name,
      timezone: cinemas.timezone,
      booked: sql<number>`(select count(*)::int from ${showtimeSeats} ss where ss.showtime_id = ${showtimes.id} and ss.status = 'BOOKED')`,
      total: sql<number>`(select count(*)::int from ${showtimeSeats} ss where ss.showtime_id = ${showtimes.id})`,
    })
    .from(showtimes)
    .innerJoin(movies, eq(movies.id, showtimes.movieId))
    .innerJoin(auditoriums, eq(auditoriums.id, showtimes.auditoriumId))
    .innerJoin(cinemas, eq(cinemas.id, auditoriums.cinemaId))
    .where(gte(showtimes.startsAt, new Date(now.getTime() - 24 * 3600_000)))
    .orderBy(asc(showtimes.startsAt))
    .limit(300);
}

export async function adminRecentAudit(db: Database, limit = 50) {
  return db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      createdAt: auditLogs.createdAt,
      actorEmail: users.email,
    })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.actorUserId))
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit);
}
