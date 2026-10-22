import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as s from "@/db/schema";
import { seedDatabase } from "@/db/seed-data";
import { holdSeats } from "@/server/bookings";
import { getFilterOptions, getSeatMap, listCinemas, listMovies, listShowtimes } from "@/server/catalog";
import { HOUR, MINUTE, buildWorld, freshDb, type TestDb, type World } from "./helpers/db";

describe("catalog with controlled fixtures", () => {
  let t: TestDb;
  let w: World;
  let pctMovie: typeof s.movies.$inferSelect;
  let underscoreMovie: typeof s.movies.$inferSelect;
  let plainMovie: typeof s.movies.$inferSelect;
  let hindiMovie: typeof s.movies.$inferSelect;
  const now = new Date();

  const mkMovie = async (title: string, language = "English") => {
    const [m] = await t.db
      .insert(s.movies)
      .values({
        title,
        slug: title.toLowerCase().replace(/[^a-z0-9]+/g, "-") + Math.random().toString(36).slice(2, 6),
        synopsis: "x",
        durationMinutes: 90,
        language,
        ageRating: "PG",
        releaseDate: "2026-01-01",
      })
      .returning();
    return m;
  };

  beforeAll(async () => {
    t = await freshDb();
    w = await buildWorld(t.db, { now });
    pctMovie = await mkMovie("100% Love");
    underscoreMovie = await mkMovie("Under_score");
    plainMovie = await mkMovie("Underscore Plain 100 Love");
    hindiMovie = await mkMovie("Dil Se", "Hindi");
    const [g] = await t.db.insert(s.genres).values({ name: "Comedy", slug: "comedy" }).returning();
    await t.db.insert(s.movieGenres).values([{ movieId: pctMovie.id, genreId: g.id }, { movieId: hindiMovie.id, genreId: g.id }]);
  });
  afterAll(() => t.close());

  it("filters by title case-insensitively", async () => {
    const r = await listMovies(t.db, { q: "  test MOVIE " });
    expect(r.map((m) => m.id)).toEqual([w.movie.id]);
  });

  it("treats % and _ in the title search literally", async () => {
    const pct = await listMovies(t.db, { q: "100%" });
    expect(pct.map((m) => m.title)).toEqual(["100% Love"]);
    const pctOnly = await listMovies(t.db, { q: "%" });
    expect(pctOnly.map((m) => m.title)).toEqual(["100% Love"]);
    const us = await listMovies(t.db, { q: "under_" });
    expect(us.map((m) => m.title)).toEqual(["Under_score"]);
    const backslash = await listMovies(t.db, { q: "\\" });
    expect(backslash).toEqual([]);
  });

  it("filters by genre and language", async () => {
    const comedy = await listMovies(t.db, { genre: "comedy" });
    expect(comedy.map((m) => m.title).sort()).toEqual(["100% Love", "Dil Se"]);
    expect(comedy.find((m) => m.title === "Dil Se")!.genres).toEqual([{ name: "Comedy", slug: "comedy" }]);
    const hindi = await listMovies(t.db, { language: "Hindi" });
    expect(hindi.map((m) => m.title)).toEqual(["Dil Se"]);
    const both = await listMovies(t.db, { genre: "comedy", language: "English" });
    expect(both.map((m) => m.title)).toEqual(["100% Love"]);
    expect(await listMovies(t.db, { genre: "does-not-exist" })).toEqual([]);
  });

  it("filters by cinema (only movies with upcoming showtimes there)", async () => {
    const r = await listMovies(t.db, { cinema: w.cinema.slug });
    expect(r.map((m) => m.id)).toEqual([w.movie.id]);
    expect(await listMovies(t.db, { cinema: "nowhere" })).toEqual([]);
  });

  it("[BUG-1] listMovies reports nextShowAt (correlated subquery)", async () => {
    const r = await listMovies(t.db, { cinema: w.cinema.slug });
    expect(r[0].nextShowAt?.getTime()).toBe(w.showtime.startsAt.getTime());
  });

  it("[BUG-1] listCinemas reports screen counts (correlated subquery)", async () => {
    const r = await listCinemas(t.db);
    expect(r.find((c) => c.id === w.cinema.id)!.screens).toBe(1);
  });

  it("filters by date in the cinema's local timezone", async () => {
    // 01:30 UTC on day D+5 is 20:30/21:30 the previous evening in New York.
    const d = new Date(now.getTime() + 5 * 24 * HOUR);
    const utcMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const startsAt = new Date(utcMidnight + 90 * MINUTE);
    const { showtime } = await w.addShowtime(startsAt);
    const nyDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(startsAt);
    const utcDate = startsAt.toISOString().slice(0, 10);
    expect(nyDate).not.toBe(utcDate);

    const local = await listShowtimes(t.db, { cinemaSlug: w.cinema.slug, date: nyDate });
    expect(local.map((x) => x.id)).toContain(showtime.id);
    const utc = await listShowtimes(t.db, { cinemaSlug: w.cinema.slug, date: utcDate });
    expect(utc.map((x) => x.id)).not.toContain(showtime.id);

    expect((await listMovies(t.db, { date: nyDate })).map((m) => m.id)).toContain(w.movie.id);
    // Malformed date is ignored rather than erroring.
    expect(Array.isArray(await listMovies(t.db, { date: "2026-13-99; drop table users" }))).toBe(true);
  });

  it("listShowtimes excludes past and cancelled showtimes", async () => {
    const past = await w.addShowtime(new Date(now.getTime() - 10 * 24 * HOUR));
    const cancelled = await w.addShowtime(new Date(now.getTime() + 20 * 24 * HOUR));
    await t.db.update(s.showtimes).set({ status: "CANCELLED" }).where(eq(s.showtimes.id, cancelled.showtime.id));
    const list = await listShowtimes(t.db, { movieId: w.movie.id });
    const ids = list.map((x) => x.id);
    expect(ids).toContain(w.showtime.id);
    expect(ids).not.toContain(past.showtime.id);
    expect(ids).not.toContain(cancelled.showtime.id);
    const first = list.find((x) => x.id === w.showtime.id)!;
    expect(first.seatsTotal).toBe(32);
    expect(first.seatsAvailable).toBe(32);
    for (let i = 1; i < list.length; i++) expect(list[i].startsAt >= list[i - 1].startsAt).toBe(true);
  });

  it("getSeatMap shows holds, `mine`, and lapsed holds as AVAILABLE", async () => {
    const st = await w.addShowtime(new Date(now.getTime() + 30 * 24 * HOUR));
    const hold = await holdSeats(t.db, {
      userId: w.alice.id,
      showtimeId: st.showtime.id,
      showtimeSeatIds: [st.seatIds[0], st.seatIds[1]],
      idempotencyKey: "seatmap-1",
    });
    const asAlice = await getSeatMap(t.db, st.showtime.id, w.alice.id);
    expect(asAlice).toHaveLength(32);
    expect(asAlice[0]).toMatchObject({ row: "A", number: 1, type: "ACCESSIBLE", status: "HELD", mine: true });
    expect(asAlice[1]).toMatchObject({ status: "HELD", mine: true });
    expect(asAlice[2]).toMatchObject({ status: "AVAILABLE", mine: false });
    expect(asAlice.at(-1)).toMatchObject({ row: "D", type: "PREMIUM", priceMinor: 1750 });

    const asBob = await getSeatMap(t.db, st.showtime.id, w.bob.id);
    expect(asBob[0]).toMatchObject({ status: "HELD", mine: false });
    const anon = await getSeatMap(t.db, st.showtime.id, null);
    expect(anon[0]).toMatchObject({ status: "HELD", mine: false });

    const later = new Date(hold.holdExpiresAt.getTime() + 1000);
    const lapsed = await getSeatMap(t.db, st.showtime.id, w.alice.id, later);
    expect(lapsed[0]).toMatchObject({ status: "AVAILABLE", mine: false });
    const counts = await listShowtimes(t.db, { movieId: w.movie.id }, later);
    expect(counts.find((x) => x.id === st.showtime.id)!.seatsAvailable).toBe(32);
    const countsNow = await listShowtimes(t.db, { movieId: w.movie.id });
    expect(countsNow.find((x) => x.id === st.showtime.id)!.seatsAvailable).toBe(30);
  });

  it("inactive movies are hidden", async () => {
    await t.db.update(s.movies).set({ isActive: false }).where(eq(s.movies.id, plainMovie.id));
    expect((await listMovies(t.db, { q: "plain" })).length).toBe(0);
    expect(underscoreMovie.id).toBeTruthy();
  });
});

describe("catalog over the seed data", () => {
  let t: TestDb;
  let counts: Awaited<ReturnType<typeof seedDatabase>>;
  const now = new Date();
  beforeAll(async () => {
    t = await freshDb();
    const h = await bcrypt.hash("Admin12345!", 4);
    counts = await seedDatabase(t.db, { days: 2, adminEmail: "admin@cinebook.test", adminPasswordHash: h, demoPasswordHash: h, now });
  });
  afterAll(() => t.close());

  it("seeds a usable catalogue", async () => {
    expect(counts).toMatchObject({ genres: 10, movies: 8, cinemas: 3, auditoriums: 7 });
    expect(counts.showtimes).toBeGreaterThan(0);
    const [admin] = await t.db.select().from(s.users).where(eq(s.users.email, "admin@cinebook.test"));
    expect(admin.role).toBe("ADMIN");
    const opts = await getFilterOptions(t.db);
    expect(opts.genres).toHaveLength(10);
    expect(opts.languages).toEqual(expect.arrayContaining(["English", "Hindi", "French", "Arabic"]));
  });

  it("filters work on seed data", async () => {
    expect((await listMovies(t.db)).length).toBe(8);
    expect((await listMovies(t.db, { genre: "sci-fi" })).map((m) => m.title)).toEqual(["Orbitfall"]);
    expect((await listMovies(t.db, { language: "Hindi" })).map((m) => m.title)).toEqual(["Dil Ki Raah"]);
    expect((await listMovies(t.db, { q: "LIGHTHOUSE" })).map((m) => m.title)).toEqual(["The Last Lighthouse"]);
    const tomorrowNy = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(now.getTime() + 24 * HOUR));
    const riverside = await listShowtimes(t.db, { cinemaSlug: "riverside", date: tomorrowNy });
    expect(riverside.length).toBe(8); // 2 screens x 4 slots
    for (const st of riverside) {
      expect(st.cinemaSlug).toBe("riverside");
      expect(new Intl.DateTimeFormat("en-CA", { timeZone: st.timezone }).format(st.startsAt)).toBe(tomorrowNy);
    }
  });
});
