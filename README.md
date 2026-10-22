# CineBook

Cinema ticket booking on **Next.js 16 (App Router) · TypeScript · Tailwind CSS v4 · Neon PostgreSQL · Drizzle ORM · Stripe (test mode)**, deployed on **Vercel**.

Customers browse and filter movies (title, genre, language, cinema, date), pick a showtime, choose seats on a live seat map, pay through Stripe Checkout, and receive a digital ticket with a booking reference and QR code. They can view their booking history and cancel eligible bookings for a refund. Admins manage movies and showtimes, block seats, view bookings, verify tickets, and read the audit log.

---

## Architecture

```
src/
  app/                 pages (Server Components read the DB through src/server)
  app/api/             Vercel Functions (JSON route handlers)
  components/          UI components
  db/schema.ts         Drizzle schema (single source of truth)
  db/client.ts         pg Pool + Drizzle factory (used by app, scripts and tests)
  db/seed-data.ts      sample catalogue
  server/bookings.ts   hold / release / confirm / cancel / refund: the booking engine
  server/checkout.ts   Stripe Checkout sessions + webhook processing
  server/gateway.ts    PaymentGateway interface + Stripe implementation
  server/catalog.ts    read queries (movies, showtimes, seat maps, bookings)
  server/admin.ts      admin operations
  server/users.ts      registration and credential checks (bcrypt)
  lib/pricing.ts       integer-money pricing rules
  proxy.ts             redirects signed-out users away from private pages
drizzle/               SQL migrations (generated + one custom)
scripts/               migrate, seed, local Postgres
tests/                 Vitest integration tests against a real PostgreSQL
```

### Data model

`users, genres, movies, movie_genres, cinemas, auditoriums, seats, showtimes, showtime_seats, bookings, booking_items, payments, tickets, audit_logs` (plus `webhook_events` for webhook de-duplication).

- UUID primary keys (`gen_random_uuid()`), `timestamptz` columns written in UTC, money as **integer minor units** (cents).
- Seat status `AVAILABLE | HELD | BOOKED | BLOCKED`; booking status `PENDING | CONFIRMED | CANCELLED | EXPIRED | REFUNDED`; payment status `PENDING | SUCCEEDED | FAILED | CANCELLED | REFUNDED`, stored separately from booking status.
- Integrity enforced in the database:
  - unique `(cinema_id, name)` screen names, unique `(auditorium_id, row_label, seat_number)` seat positions, unique `(showtime_id, seat_id)`;
  - **partial unique index `booking_items(showtime_seat_id) WHERE active`**, so one showtime seat can never belong to two live bookings even if application code were wrong;
  - exclusion constraint so scheduled showtimes cannot overlap in one auditorium;
  - check constraints on prices, durations, seat/hold consistency and `total = subtotal + fee + tax`;
  - one `SUCCEEDED` payment per booking, unique provider session/intent ids and idempotency keys.

### Booking transaction

`holdSeats()` in [src/server/bookings.ts](src/server/bookings.ts):

1. `BEGIN`
2. `SELECT … FROM showtime_seats WHERE id IN (…) ORDER BY id FOR UPDATE` (a consistent lock order prevents deadlocks)
3. lapsed holds on those seats are released; every seat must be `AVAILABLE`, otherwise the request is rejected with `409 SEATS_UNAVAILABLE`
4. seats → `HELD` with `hold_expires_at = now + 10 min`
5. price computed on the server from stored seat prices (`calculateTotals`)
6. `PENDING` booking + `booking_items` inserted
7. `COMMIT`

The client sends an **idempotency key** per selection, so retries return the same booking. Starting checkout extends the hold to cover the 30-minute Stripe session. Seats become `BOOKED` **only after a verified payment**: the Stripe webhook (signature-checked) or the success page, which re-fetches the session from Stripe server-side. Both paths call the same idempotent `confirmPaidSession()`. Webhook events are de-duplicated by event id. If a payment arrives after its seats were lost, it is **refunded automatically** using an idempotency key, so it can never be refunded twice.

### Expired holds

- Read paths treat lapsed holds as available, and new holds release lapsed holds lazily, so correctness never depends on the cron schedule.
- `GET /api/cron/release-holds` releases lapsed holds in batches (`FOR UPDATE SKIP LOCKED`). It is idempotent and safe to run concurrently, and it requires `Authorization: Bearer $CRON_SECRET`.

### Pricing

Seat price = showtime base price × seat-type multiplier (Standard 100%, Premium 140%, Accessible 100%). Service fee is $1.50 per seat. Tax is 8% of tickets + fees, rounded half-up to the cent. All of this is integer arithmetic in [src/lib/pricing.ts](src/lib/pricing.ts).

### Security

- Sessions use an HS256-signed, httpOnly, `SameSite=Lax` cookie containing only the user id. Role and existence are re-read from the database on every request.
- Passwords are hashed with bcrypt, and login responses don't reveal whether an email exists.
- State-changing API requests from another origin are rejected (CSRF).
- Authorization is enforced in server code (`requireUser` / `requireAdmin`, and every booking query is scoped to its owner). Another user's booking returns `404`.
- All secrets are server-only (none are `NEXT_PUBLIC_`). Non-production environments refuse live Stripe keys.
- Structured JSON logs (`src/lib/logger.ts`) record each API request, webhook and cron run with a request id.

---

## Local setup

Requirements: Node.js ≥ 20.9 (tested on 24).

```bash
npm install
cp .env.example .env.local      # then fill in values (see below)
```

**Database.** Either:
- use a Neon database: put its pooled URL in `DATABASE_URL` and its direct URL in `DATABASE_URL_UNPOOLED`; or
- run a real local PostgreSQL without Docker: `npm run db:local` (leave it running), and set both URLs to `postgres://postgres:postgres@localhost:54322/cinebook`.

```bash
npm run db:migrate              # apply migrations
npm run db:seed                 # sample movies, cinemas, screens, seats, 7 days of showtimes
npm run dev                     # http://localhost:3000
```

`npm run db:seed -- --reset` wipes all data and reseeds (refused in production). Showtimes are generated relative to the current date, so reseed after a week.

Seed accounts: the admin is `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`. If `SEED_DEMO_PASSWORD` is set, a customer `demo@cinebook.test` is also created.

**Stripe (test mode).** Put `sk_test_…` in `STRIPE_SECRET_KEY`. To receive webhooks locally:

```bash
stripe listen --forward-to localhost:3000/api/webhooks/stripe   # prints whsec_… → STRIPE_WEBHOOK_SECRET
```

Without the CLI, payments still confirm through the success-page redirect. Test cards: `4242 4242 4242 4242` succeeds, `4000 0000 0000 0002` is declined, and `4000 0025 0000 3155` requires 3-D Secure.

### Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `DATABASE_URL` | all | Neon **pooled** connection, used for app requests |
| `DATABASE_URL_UNPOOLED` | all | Neon direct connection, used by migrations and seeding only |
| `AUTH_SECRET` | all | session signing key, 32+ chars, different per environment |
| `STRIPE_SECRET_KEY` | all | Stripe secret key (`sk_test_…` outside production) |
| `STRIPE_WEBHOOK_SECRET` | all | signing secret of the webhook endpoint for that environment |
| `CRON_SECRET` | all | bearer token Vercel Cron sends to `/api/cron/release-holds` |
| `APP_URL` | optional | base URL for Stripe redirects (auto-derived on Vercel) |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_DEMO_PASSWORD` | local/scripts | seed accounts |

## Migrations

- Change `src/db/schema.ts`, then run `npm run db:generate` and commit the new SQL file in `drizzle/`.
- For SQL that Drizzle can't express (such as the exclusion constraint), run `npx drizzle-kit generate --custom --name <name>` and edit the file.
- `npm run db:migrate` applies pending migrations through the **direct** connection. It is a no-op when the database is up to date.
- Migrations run automatically on every Vercel deployment (`vercel-build` = `db:migrate && next build`) before the new version goes live. Keep migrations backwards-compatible (expand, then contract) so the previous deployment keeps working while the new one builds.

## Testing

```bash
npm test                         # Vitest: starts a throwaway PostgreSQL 18, migrates a fresh DB per file
npm run typecheck && npm run lint
npm run build
BASE_URL=http://localhost:3000 node tests/e2e/http-smoke.mjs   # HTTP checks against a running app
```

The integration suite runs against a real PostgreSQL (via `embedded-postgres`, no Docker needed) and covers:
- migrations on a clean database
- auth
- search and filters
- seat maps
- the full booking flow
- **concurrent booking of the same seat** (exactly one wins)
- hold expiry and release
- totals, tax and fees
- Stripe success, failure, cancellation and retry, including duplicate and concurrent webhook delivery with real signatures
- automatic refunds
- cross-user access
- admin permissions

## Deploying to Vercel

1. **Project.** `vercel login`, then `vercel link` in this folder (or import the Git repository in the Vercel dashboard).
2. **Database.** In the project, open **Storage → Marketplace → Neon → Create**, connect it to the project for **Production and Preview**, and enable **"Create database branch for deployment"** for Preview. Vercel then injects `DATABASE_URL` (pooled) and `DATABASE_URL_UNPOOLED` (direct) for each environment, and every preview deployment gets an isolated Neon branch.
3. **Secrets.** Add these per environment (`vercel env add <NAME> production` / `preview`), using different values for each:
   - `AUTH_SECRET`
   - `CRON_SECRET`
   - `STRIPE_SECRET_KEY` (test key)
   - `STRIPE_WEBHOOK_SECRET`
4. **Stripe webhook.** In Stripe (test mode) go to **Developers → Webhooks → Add endpoint** with URL `https://<production-domain>/api/webhooks/stripe` and these events:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
   - `checkout.session.expired`
   - `payment_intent.payment_failed`
   - `charge.refunded`

   Copy its signing secret into `STRIPE_WEBHOOK_SECRET`. Preview URLs change per deployment, so add a separate endpoint for a stable preview alias if you need webhooks there. Otherwise previews confirm payments through the success-page redirect.
5. **Deploy.** Run `vercel` for a preview and `vercel --prod` for production. The build runs migrations first.
6. **Seed** (once per database): `vercel env pull .env.production.local --environment=production`, then `DATABASE_URL_UNPOOLED=… SEED_ADMIN_PASSWORD=… npm run db:seed`.
7. **Cron.** `vercel.json` schedules `/api/cron/release-holds` daily, the maximum on the Hobby plan. On Pro, change the schedule to `*/5 * * * *`. Expired holds are also released lazily, so seats free up correctly in either case.
8. **Verify.** Check `GET /api/health`, then run `BASE_URL=https://<deployment> node tests/e2e/http-smoke.mjs`, then make a test booking with card `4242 4242 4242 4242`.

### Operations

- **Logs:** Vercel → Project → Logs (JSON lines; filter by `msg`, e.g. `webhook.processed`, `payment.auto_refund`, `cron.release_holds`, `api.unhandled`).
- **Rotating `AUTH_SECRET`** signs everyone out.
- **Rotating `CRON_SECRET`:** update the env var and redeploy; Vercel Cron picks it up automatically.
