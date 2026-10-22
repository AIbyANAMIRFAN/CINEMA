import { and, asc, desc, eq, gt, ilike, inArray, sql, type SQL } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import {
  auditoriums,
  bookingItems,
  bookings,
  cinemas,
  genres,
  movieGenres,
  movies,
  payments,
  seats,
  showtimeSeats,
  showtimes,
  tickets,
} from "@/db/schema";

export type MovieFilters = {
  q?: string;
  genre?: string; // genre slug
  language?: string;
  cinema?: string; // cinema slug
  date?: string; // YYYY-MM-DD in the cinema's local time
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Conditions on showtimes (joined with auditoriums + cinemas) for upcoming, bookable shows. */
function showtimeConds(f: MovieFilters, now: Date): SQL[] {
  const conds: SQL[] = [eq(showtimes.status, "SCHEDULED"), gt(showtimes.startsAt, now)];
  if (f.cinema) conds.push(eq(cinemas.slug, f.cinema));
  if (f.date && DATE_RE.test(f.date)) {
    conds.push(sql`(${showtimes.startsAt} at time zone ${cinemas.timezone})::date = ${f.date}::date`);
  }
  return conds;
}

export async function listMovies(db: DbOrTx, f: MovieFilters = {}, now = new Date()) {
  const conds: SQL[] = [eq(movies.isActive, true)];
  if (f.q?.trim()) conds.push(ilike(movies.title, `%${f.q.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`));
  if (f.language) conds.push(eq(movies.language, f.language));
  if (f.genre) {
    conds.push(sql`exists (select 1 from ${movieGenres} mg join ${genres} g on g.id = mg.genre_id
      where mg.movie_id = "movies"."id" and g.slug = ${f.genre})`);
  }
  // Only movies with a matching upcoming showtime when cinema/date filters are used; otherwise all active.
  if (f.cinema || f.date) {
    const sub = db
      .select({ id: showtimes.movieId })
      .from(showtimes)
      .innerJoin(auditoriums, eq(auditoriums.id, showtimes.auditoriumId))
      .innerJoin(cinemas, eq(cinemas.id, auditoriums.cinemaId))
      .where(and(...showtimeConds(f, now)));
    conds.push(inArray(movies.id, sub));
  }

  const rows = await db
    .select({
      id: movies.id,
      title: movies.title,
      slug: movies.slug,
      synopsis: movies.synopsis,
      durationMinutes: movies.durationMinutes,
      language: movies.language,
      ageRating: movies.ageRating,
      releaseDate: movies.releaseDate,
      posterUrl: movies.posterUrl,
      nextShowAt: sql<Date | null>`(select min(st.starts_at) from ${showtimes} st
        where st.movie_id = "movies"."id" and st.status = 'SCHEDULED' and st.starts_at > ${now})`.mapWith(
        (v) => (v ? new Date(v) : null),
      ),
    })
    .from(movies)
    .where(and(...conds))
    .orderBy(asc(movies.title));

  const genreMap = await genresFor(db, rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, genres: genreMap.get(r.id) ?? [] }));
}

async function genresFor(db: DbOrTx, movieIds: string[]) {
  const map = new Map<string, { name: string; slug: string }[]>();
  if (!movieIds.length) return map;
  const rows = await db
    .select({ movieId: movieGenres.movieId, name: genres.name, slug: genres.slug })
    .from(movieGenres)
    .innerJoin(genres, eq(genres.id, movieGenres.genreId))
    .where(inArray(movieGenres.movieId, movieIds))
    .orderBy(asc(genres.name));
  for (const r of rows) map.set(r.movieId, [...(map.get(r.movieId) ?? []), { name: r.name, slug: r.slug }]);
  return map;
}

export async function getFilterOptions(db: DbOrTx) {
  const [genreRows, languageRows, cinemaRows] = await Promise.all([
    db.select({ name: genres.name, slug: genres.slug }).from(genres).orderBy(asc(genres.name)),
    db
      .selectDistinct({ language: movies.language })
      .from(movies)
      .where(eq(movies.isActive, true))
      .orderBy(asc(movies.language)),
    db.select({ name: cinemas.name, slug: cinemas.slug, city: cinemas.city }).from(cinemas).orderBy(asc(cinemas.name)),
  ]);
  return { genres: genreRows, languages: languageRows.map((l) => l.language), cinemas: cinemaRows };
}

export async function getMovieBySlug(db: DbOrTx, slug: string) {
  const [movie] = await db.select().from(movies).where(eq(movies.slug, slug));
  if (!movie) return null;
  const g = await genresFor(db, [movie.id]);
  return { ...movie, genres: g.get(movie.id) ?? [] };
}

export type ShowtimeListItem = Awaited<ReturnType<typeof listShowtimes>>[number];

export async function listShowtimes(
  db: DbOrTx,
  opts: { movieId?: string; cinemaSlug?: string; date?: string },
  now = new Date(),
) {
  const conds = showtimeConds({ cinema: opts.cinemaSlug, date: opts.date }, now);
  if (opts.movieId) conds.push(eq(showtimes.movieId, opts.movieId));
  return db
    .select({
      id: showtimes.id,
      startsAt: showtimes.startsAt,
      endsAt: showtimes.endsAt,
      basePriceMinor: showtimes.basePriceMinor,
      currency: showtimes.currency,
      movieId: movies.id,
      movieTitle: movies.title,
      movieSlug: movies.slug,
      auditoriumName: auditoriums.name,
      cinemaName: cinemas.name,
      cinemaSlug: cinemas.slug,
      cinemaCity: cinemas.city,
      timezone: cinemas.timezone,
      seatsAvailable: sql<number>`(select count(*)::int from ${showtimeSeats} ss where ss.showtime_id = "showtimes"."id"
        and (ss.status = 'AVAILABLE' or (ss.status = 'HELD' and ss.hold_expires_at <= ${now})))`,
      seatsTotal: sql<number>`(select count(*)::int from ${showtimeSeats} ss where ss.showtime_id = "showtimes"."id"
        and ss.status <> 'BLOCKED')`,
    })
    .from(showtimes)
    .innerJoin(movies, eq(movies.id, showtimes.movieId))
    .innerJoin(auditoriums, eq(auditoriums.id, showtimes.auditoriumId))
    .innerJoin(cinemas, eq(cinemas.id, auditoriums.cinemaId))
    .where(and(...conds, eq(movies.isActive, true)))
    .orderBy(asc(showtimes.startsAt));
}

export async function listCinemas(db: DbOrTx) {
  return db
    .select({
      id: cinemas.id,
      name: cinemas.name,
      slug: cinemas.slug,
      city: cinemas.city,
      address: cinemas.address,
      timezone: cinemas.timezone,
      screens: sql<number>`(select count(*)::int from ${auditoriums} a where a.cinema_id = "cinemas"."id")`,
    })
    .from(cinemas)
    .orderBy(asc(cinemas.name));
}

export async function getCinemaBySlug(db: DbOrTx, slug: string) {
  const [cinema] = await db.select().from(cinemas).where(eq(cinemas.slug, slug));
  return cinema ?? null;
}

export async function getShowtime(db: DbOrTx, showtimeId: string) {
  const [row] = await db
    .select({
      id: showtimes.id,
      startsAt: showtimes.startsAt,
      endsAt: showtimes.endsAt,
      status: showtimes.status,
      basePriceMinor: showtimes.basePriceMinor,
      currency: showtimes.currency,
      movieId: movies.id,
      movieTitle: movies.title,
      movieSlug: movies.slug,
      posterUrl: movies.posterUrl,
      ageRating: movies.ageRating,
      durationMinutes: movies.durationMinutes,
      language: movies.language,
      auditoriumId: auditoriums.id,
      auditoriumName: auditoriums.name,
      cinemaName: cinemas.name,
      cinemaSlug: cinemas.slug,
      cinemaAddress: cinemas.address,
      timezone: cinemas.timezone,
    })
    .from(showtimes)
    .innerJoin(movies, eq(movies.id, showtimes.movieId))
    .innerJoin(auditoriums, eq(auditoriums.id, showtimes.auditoriumId))
    .innerJoin(cinemas, eq(cinemas.id, auditoriums.cinemaId))
    .where(eq(showtimes.id, showtimeId));
  return row ?? null;
}

export type SeatMapSeat = {
  id: string; // showtime_seat id: the id clients send when holding
  row: string;
  number: number;
  type: "STANDARD" | "PREMIUM" | "ACCESSIBLE";
  priceMinor: number;
  status: "AVAILABLE" | "HELD" | "BOOKED" | "BLOCKED";
  mine: boolean; // held by the viewer's own pending booking
};

/** Seat map with effective status: holds that have lapsed are shown as available. */
export async function getSeatMap(db: DbOrTx, showtimeId: string, viewerUserId?: string | null, now = new Date()) {
  const rows = await db
    .select({
      id: showtimeSeats.id,
      row: seats.rowLabel,
      number: seats.seatNumber,
      type: seats.seatType,
      priceMinor: showtimeSeats.priceMinor,
      status: showtimeSeats.status,
      holdExpiresAt: showtimeSeats.holdExpiresAt,
      holderUserId: bookings.userId,
    })
    .from(showtimeSeats)
    .innerJoin(seats, eq(seats.id, showtimeSeats.seatId))
    .leftJoin(bookings, eq(bookings.id, showtimeSeats.heldByBookingId))
    .where(eq(showtimeSeats.showtimeId, showtimeId))
    .orderBy(asc(seats.rowLabel), asc(seats.seatNumber));

  return rows.map<SeatMapSeat>((r) => {
    const lapsed = r.status === "HELD" && r.holdExpiresAt !== null && r.holdExpiresAt <= now;
    return {
      id: r.id,
      row: r.row,
      number: r.number,
      type: r.type,
      priceMinor: r.priceMinor,
      status: lapsed ? "AVAILABLE" : r.status,
      mine: !lapsed && r.status === "HELD" && !!viewerUserId && r.holderUserId === viewerUserId,
    };
  });
}

// ---------------------------------------------------------------------------
// Bookings (read side). Every function is scoped to a user unless called with { admin: true }.
// ---------------------------------------------------------------------------

const bookingSelect = {
  id: bookings.id,
  reference: bookings.reference,
  userId: bookings.userId,
  status: bookings.status,
  subtotalMinor: bookings.subtotalMinor,
  feeMinor: bookings.feeMinor,
  taxMinor: bookings.taxMinor,
  totalMinor: bookings.totalMinor,
  currency: bookings.currency,
  holdExpiresAt: bookings.holdExpiresAt,
  confirmedAt: bookings.confirmedAt,
  cancelledAt: bookings.cancelledAt,
  createdAt: bookings.createdAt,
  showtimeId: showtimes.id,
  startsAt: showtimes.startsAt,
  endsAt: showtimes.endsAt,
  movieTitle: movies.title,
  movieSlug: movies.slug,
  posterUrl: movies.posterUrl,
  ageRating: movies.ageRating,
  auditoriumName: auditoriums.name,
  cinemaName: cinemas.name,
  cinemaAddress: cinemas.address,
  timezone: cinemas.timezone,
};

function bookingQuery(db: DbOrTx) {
  return db
    .select(bookingSelect)
    .from(bookings)
    .innerJoin(showtimes, eq(showtimes.id, bookings.showtimeId))
    .innerJoin(movies, eq(movies.id, showtimes.movieId))
    .innerJoin(auditoriums, eq(auditoriums.id, showtimes.auditoriumId))
    .innerJoin(cinemas, eq(cinemas.id, auditoriums.cinemaId));
}

export async function listUserBookings(db: DbOrTx, userId: string) {
  const rows = await bookingQuery(db).where(eq(bookings.userId, userId)).orderBy(desc(bookings.createdAt));
  const seatMap = await seatLabelsFor(db, rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, seats: seatMap.get(r.id) ?? [] }));
}

async function seatLabelsFor(db: DbOrTx, bookingIds: string[]) {
  const map = new Map<string, { row: string; number: number; type: string; priceMinor: number }[]>();
  if (!bookingIds.length) return map;
  const rows = await db
    .select({
      bookingId: bookingItems.bookingId,
      row: seats.rowLabel,
      number: seats.seatNumber,
      type: seats.seatType,
      priceMinor: bookingItems.priceMinor,
    })
    .from(bookingItems)
    .innerJoin(showtimeSeats, eq(showtimeSeats.id, bookingItems.showtimeSeatId))
    .innerJoin(seats, eq(seats.id, showtimeSeats.seatId))
    .where(inArray(bookingItems.bookingId, bookingIds))
    .orderBy(asc(seats.rowLabel), asc(seats.seatNumber));
  for (const r of rows) {
    const { bookingId, ...seat } = r;
    map.set(bookingId, [...(map.get(bookingId) ?? []), seat]);
  }
  return map;
}

export type BookingDetail = NonNullable<Awaited<ReturnType<typeof getBookingDetail>>>;

/** Returns null when the booking does not exist or belongs to someone else (never leak existence). */
export async function getBookingDetail(db: DbOrTx, bookingId: string, viewer: { userId: string; admin?: boolean }) {
  const [row] = await bookingQuery(db).where(eq(bookings.id, bookingId));
  if (!row || (!viewer.admin && row.userId !== viewer.userId)) return null;
  const [seatMap, paymentRows, [ticket]] = await Promise.all([
    seatLabelsFor(db, [row.id]),
    db
      .select({
        id: payments.id,
        status: payments.status,
        amountMinor: payments.amountMinor,
        currency: payments.currency,
        failureReason: payments.failureReason,
        createdAt: payments.createdAt,
      })
      .from(payments)
      .where(eq(payments.bookingId, row.id))
      .orderBy(desc(payments.createdAt)),
    db.select().from(tickets).where(eq(tickets.bookingId, row.id)),
  ]);
  return { ...row, seats: seatMap.get(row.id) ?? [], payments: paymentRows, ticket: ticket ?? null };
}

export async function findTicketByCode(db: DbOrTx, code: string) {
  const [t] = await db.select().from(tickets).where(eq(tickets.code, code));
  return t ?? null;
}
