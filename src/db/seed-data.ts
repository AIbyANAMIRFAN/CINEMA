import { sql } from "drizzle-orm";
import type { Database } from "./client";
import { auditoriums, cinemas, genres, movieGenres, movies, seats, showtimeSeats, showtimes, users } from "./schema";
import { seatPrice, type SeatTypeName } from "@/lib/pricing";

// Fictional sample catalogue: titles, people and cinemas are invented for demo purposes.

const GENRES = ["Action", "Adventure", "Animation", "Comedy", "Drama", "Horror", "Romance", "Sci-Fi", "Thriller", "Family"];

const MOVIES: {
  title: string;
  synopsis: string;
  durationMinutes: number;
  language: string;
  ageRating: string;
  releaseDate: string;
  director: string;
  castList: string;
  genres: string[];
  basePriceMinor: number;
}[] = [
  {
    title: "The Last Lighthouse",
    synopsis: "A retired keeper returns to a storm-battered island to find the lamp burning again, and someone waiting for her.",
    durationMinutes: 118, language: "English", ageRating: "PG-13", releaseDate: "2026-09-18",
    director: "Mara Okonkwo", castList: "Ines Halvorsen, Theo Brandt, Nadia Rahimi", genres: ["Drama", "Thriller"], basePriceMinor: 1400,
  },
  {
    title: "Orbitfall",
    synopsis: "When a mining station loses its orbit, a crew of six has ninety minutes to steer it away from a populated moon.",
    durationMinutes: 132, language: "English", ageRating: "PG-13", releaseDate: "2026-10-02",
    director: "Dev Castellano", castList: "Ryo Tanaka, Amara Diallo, Felix Novak", genres: ["Sci-Fi", "Action"], basePriceMinor: 1600,
  },
  {
    title: "Paper Kites",
    synopsis: "Three siblings rebuild their grandfather's kite shop over one windy summer and uncover the reason it closed.",
    durationMinutes: 97, language: "English", ageRating: "PG", releaseDate: "2026-08-21",
    director: "Lucía Ferrer", castList: "Sam Whitlock, Priya Menon, Oscar Lund", genres: ["Family", "Comedy"], basePriceMinor: 1200,
  },
  {
    title: "Midnight at Marrow Lane",
    synopsis: "A night-shift radio host starts receiving calls from listeners describing events that haven't happened yet.",
    durationMinutes: 104, language: "English", ageRating: "R", releaseDate: "2026-10-09",
    director: "Gideon Hart", castList: "Elena Varga, Marcus Bell", genres: ["Horror", "Thriller"], basePriceMinor: 1400,
  },
  {
    title: "Dil Ki Raah",
    synopsis: "Two rival wedding planners in Jaipur are forced to organise the same ceremony and slowly fall for each other.",
    durationMinutes: 141, language: "Hindi", ageRating: "PG", releaseDate: "2026-09-25",
    director: "Anjali Kapoor", castList: "Rohan Malhotra, Sana Qureshi", genres: ["Romance", "Comedy"], basePriceMinor: 1300,
  },
  {
    title: "Le Dernier Train",
    synopsis: "On the final run of a night train to Marseille, a conductor pieces together a decades-old disappearance.",
    durationMinutes: 112, language: "French", ageRating: "PG-13", releaseDate: "2026-07-30",
    director: "Claire Dumont", castList: "Julien Moreau, Aïcha Benali", genres: ["Drama", "Thriller"], basePriceMinor: 1300,
  },
  {
    title: "Sprocket & the Moon Garden",
    synopsis: "A small repair robot sets out to grow the first garden on the Moon, with help from a very opinionated beetle.",
    durationMinutes: 88, language: "English", ageRating: "G", releaseDate: "2026-10-16",
    director: "Hana Sato", castList: "Voices of Leo Park, Maya Chen", genres: ["Animation", "Family", "Adventure"], basePriceMinor: 1100,
  },
  {
    title: "Desert Crown",
    synopsis: "A cartographer and a disgraced guard cross an uncharted desert to return a stolen crown before war breaks out.",
    durationMinutes: 149, language: "Arabic", ageRating: "PG-13", releaseDate: "2026-09-04",
    director: "Yusuf Haddad", castList: "Layla Nasser, Omar Farouk", genres: ["Adventure", "Action"], basePriceMinor: 1500,
  },
];

const CINEMAS = [
  {
    name: "CineBook Riverside", slug: "riverside", city: "Springfield", address: "12 River Walk, Springfield",
    timezone: "America/New_York", screens: [{ name: "Screen 1", rows: 8, perRow: 12 }, { name: "Screen 2", rows: 6, perRow: 10 }],
  },
  {
    name: "CineBook Downtown", slug: "downtown", city: "Springfield", address: "300 Main Street, Springfield",
    timezone: "America/New_York", screens: [{ name: "Screen 1", rows: 10, perRow: 14 }, { name: "IMAX", rows: 9, perRow: 16 }, { name: "Screen 3", rows: 6, perRow: 10 }],
  },
  {
    name: "CineBook Harbour", slug: "harbour", city: "Lakeview", address: "5 Harbour Quay, Lakeview",
    timezone: "America/Chicago", screens: [{ name: "Screen A", rows: 7, perRow: 12 }, { name: "Screen B", rows: 7, perRow: 12 }],
  },
];

const slug = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

function seatTypeFor(rowIdx: number, rows: number, seatNo: number, perRow: number): SeatTypeName {
  if (rowIdx === 0 && (seatNo === 1 || seatNo === perRow)) return "ACCESSIBLE";
  if (rowIdx >= rows - 2) return "PREMIUM";
  return "STANDARD";
}

/** Local wall-clock time in an IANA zone -> UTC Date. */
function zonedTimeToUtc(y: number, m: number, d: number, hh: number, mm: number, timeZone: string) {
  const guess = new Date(Date.UTC(y, m - 1, d, hh, mm));
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(guess);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asLocal = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"));
  return new Date(guess.getTime() - (asLocal - guess.getTime()));
}

export type SeedOptions = { days?: number; adminEmail: string; adminPasswordHash: string; demoPasswordHash?: string; now?: Date };

/** Inserts the sample catalogue. Expects an empty catalogue; returns counts. */
export async function seedDatabase(db: Database, opts: SeedOptions) {
  const now = opts.now ?? new Date();
  const days = opts.days ?? 7;
  return db.transaction(async (tx) => {
    await tx
      .insert(users)
      .values({ email: opts.adminEmail, name: "CineBook Admin", passwordHash: opts.adminPasswordHash, role: "ADMIN" })
      .onConflictDoNothing();
    if (opts.demoPasswordHash) {
      await tx
        .insert(users)
        .values({ email: "demo@cinebook.test", name: "Demo Customer", passwordHash: opts.demoPasswordHash })
        .onConflictDoNothing();
    }

    const genreRows = await tx.insert(genres).values(GENRES.map((name) => ({ name, slug: slug(name) }))).returning();
    const genreId = new Map(genreRows.map((g) => [g.name, g.id]));

    const movieRows = await tx
      .insert(movies)
      .values(MOVIES.map(({ genres: _g, basePriceMinor: _p, ...m }) => ({ ...m, slug: slug(`${m.title}-${m.releaseDate.slice(0, 4)}`) })))
      .returning();
    await tx.insert(movieGenres).values(
      movieRows.flatMap((m, i) => MOVIES[i].genres.map((g) => ({ movieId: m.id, genreId: genreId.get(g)! }))),
    );

    let seatCount = 0;
    const screens: { auditoriumId: string; timezone: string; seats: { id: string; type: SeatTypeName }[] }[] = [];
    for (const c of CINEMAS) {
      const [cinema] = await tx
        .insert(cinemas)
        .values({ name: c.name, slug: c.slug, city: c.city, address: c.address, timezone: c.timezone })
        .returning();
      for (const s of c.screens) {
        const [aud] = await tx.insert(auditoriums).values({ cinemaId: cinema.id, name: s.name }).returning();
        const values = [];
        for (let r = 0; r < s.rows; r++) {
          for (let n = 1; n <= s.perRow; n++) {
            values.push({ auditoriumId: aud.id, rowLabel: String.fromCharCode(65 + r), seatNumber: n, seatType: seatTypeFor(r, s.rows, n, s.perRow) });
          }
        }
        const inserted = await tx.insert(seats).values(values).returning({ id: seats.id, type: seats.seatType });
        seatCount += inserted.length;
        screens.push({ auditoriumId: aud.id, timezone: c.timezone, seats: inserted });
      }
    }

    // Each screen runs a rotating line-up of four daily slots, starting today in the cinema's zone.
    const SLOTS: [number, number][] = [[11, 0], [14, 30], [18, 0], [21, 15]];
    let showtimeCount = 0;
    for (let day = 0; day < days; day++) {
      for (const [si, screen] of screens.entries()) {
        const localDay = new Intl.DateTimeFormat("en-CA", { timeZone: screen.timezone }).format(new Date(now.getTime() + day * 86_400_000));
        const [y, m, d] = localDay.split("-").map(Number);
        for (const [slotIdx, [hh, mm]] of SLOTS.entries()) {
          const movieIdx = (si * 3 + slotIdx + day) % movieRows.length;
          const movie = movieRows[movieIdx];
          const startsAt = zonedTimeToUtc(y, m, d, hh, mm, screen.timezone);
          if (startsAt <= now) continue;
          const base = MOVIES[movieIdx].basePriceMinor + (hh >= 18 ? 200 : 0);
          const [st] = await tx
            .insert(showtimes)
            .values({
              movieId: movie.id,
              auditoriumId: screen.auditoriumId,
              startsAt,
              endsAt: new Date(startsAt.getTime() + (movie.durationMinutes + 15) * 60_000),
              basePriceMinor: base,
              currency: "USD",
            })
            .returning({ id: showtimes.id });
          await tx.insert(showtimeSeats).values(screen.seats.map((s) => ({ showtimeId: st.id, seatId: s.id, priceMinor: seatPrice(base, s.type) })));
          showtimeCount++;
        }
      }
    }
    await tx.execute(sql`analyze`);
    return { genres: genreRows.length, movies: movieRows.length, cinemas: CINEMAS.length, auditoriums: screens.length, seats: seatCount, showtimes: showtimeCount };
  });
}
