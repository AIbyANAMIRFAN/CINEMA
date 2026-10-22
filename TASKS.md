# CineBook shared task list

Agents: **DB** (Database Engine, owns `src/db`, `src/server`, `src/lib`, `src/app/api`, `drizzle/`, `scripts/`),
**APP** (App, owns `src/app/**` except `src/app/api`, `src/components`, `src/proxy.ts`, styles),
**QA** (owns `tests/`, `vitest.config.ts`).

Rules: edit only files you own. Report bugs in another agent's area under **Bugs** with
`[ ] BUG-n (owner) summary — repro`. Owner fixes and ticks `[x]`; QA re-tests and appends `retested ✅`.

## Tasks

### DB
- [x] Schema: 14 required tables + webhook_events, UUID PKs, timestamptz, integer minor units
- [x] Constraints: unique screen names, seat positions, showtime seat, active booking seat; checks; FKs; indexes
- [x] Exclusion constraint: no overlapping showtimes per auditorium
- [x] Booking transaction (lock → verify → hold → price → pending booking → commit)
- [x] Confirm only after verified payment; idempotent webhooks; auto-refund orphaned payments
- [x] Idempotent expired-hold release endpoint protected by CRON_SECRET
- [x] Seed data
- [x] API routes
- [x] Vercel config, README

### APP
- [x] Layout, nav, auth-aware header, footer, design system
- [x] Home (search + filters: title, genre, language, cinema, date)
- [x] Movie details with showtimes; cinemas list + cinema page with showtimes
- [x] Seat selection (live availability), selected seats + fees + total
- [x] Checkout (hold countdown, pay via Stripe, cancelled/retry state)
- [x] Confirmation + digital ticket with reference and QR code
- [x] Booking history + cancel eligible bookings
- [x] Login / register / logout
- [x] Admin: dashboard, movies, showtimes, bookings, ticket verify
- [x] Loading, error, empty, not-found states; mobile + desktop

### QA
- [x] Test harness (embedded Postgres, migrations on a clean DB) — `npx vitest run`; HTTP smoke: `BASE_URL=… node tests/e2e/http-smoke.mjs`
- [x] Auth: registration, login, logout, authorization
- [x] Search/filter, cinema selection, showtimes, seat maps
- [x] Full booking flow through ticket confirmation (service level: fake gateway + real Stripe webhook signatures; HTTP checkout needs STRIPE_SECRET_KEY)
- [x] Concurrent booking of the same seat: exactly one succeeds
- [x] Expired holds + automatic release (idempotent)
- [x] Totals, taxes, fees, payment status
- [x] Payment success, failure, cancellation, retry, duplicate webhook delivery (open: BUG-4, BUG-5)
- [x] Cross-user access to bookings/tickets denied; admin permissions
- [x] Production build (`next build` OK, `tsc --noEmit` OK)

## Bugs

- [x] BUG-1 (DB) Correlated subqueries compare against an unqualified outer column, so they never match: `listMovies().nextShowAt` is always null, `listCinemas().screens` is always 0, `adminListMovies().upcomingShowtimes` is always 0. In single-table selects Drizzle renders `${movies.id}` / `${cinemas.id}` as a bare `"id"`, which binds to the subquery's own table (e.g. `st.movie_id = "id"` means `st.movie_id = st.id`). Fix: qualify explicitly (e.g. `"movies"."id"`) or alias the outer table. Repro: `curl localhost:3000/api/movies` returns `"nextShowAt":null` for movies that have upcoming showtimes; /admin/movies shows 0 upcoming shows. (APP hides the 0 screen count and the availability hint until this is fixed.) — FIXED (DB): outer columns qualified explicitly; genre filter had the same flaw (bare "id" bound to genres.id) and is fixed too. — retested ✅ (QA: `[BUG-1] …` tests in tests/catalog.test.ts and tests/cancellation-admin.test.ts pass)
- [x] BUG-2 (DB) `POST /api/bookings/[id]/cancel` and `PATCH /api/admin/showtimes/[id]` call `getGateway()` before `cancelBooking`/`cancelShowtime`, so releasing a PENDING hold (which needs no payment provider) returns 500 INTERNAL when `STRIPE_SECRET_KEY` is unset (local dev, previews). Fix: resolve the gateway lazily, only on the refund path. Repro: hold seats locally, then `POST /api/bookings/<id>/cancel` → 500, log `STRIPE_SECRET_KEY is not set`. The UI shows a "couldn't cancel right now" message; the hold still lapses after HOLD_MINUTES. — FIXED (DB): getGateway() is now lazy; Stripe is resolved only when a provider call is made. — retested ✅ (QA HTTP smoke without Stripe: owner cancel of a pending booking → 200 CANCELLED and the seat is AVAILABLE again; cross-user cancel → 404)
- [x] BUG-3 (DB, minor) Without Stripe configured, `POST /api/bookings/[id]/checkout` and `/confirm` return 500 INTERNAL (a plain Error from `getGateway`) instead of a typed `PAYMENT_ERROR` (502), so clients can't distinguish "payments unavailable" from a crash. The UI handles both with a clear message. — FIXED (DB): missing STRIPE_SECRET_KEY now raises AppError PAYMENT_ERROR (502). — retested ✅ (QA HTTP smoke: checkout without Stripe → 502)
- [x] BUG-4 (DB) Concurrent `startCheckout` for one booking (double click / two tabs) creates several Stripe Checkout sessions and PENDING payment rows, each with its own payable URL. The reuse check only looks at payments that already have a `checkout_url` (written after the provider call returns) and the attempt key is `count(*)+1`, so a request arriving while the first is still waiting on Stripe starts attempt #2. A customer can pay twice (the extra payment is auto-refunded, but they are charged and refunded). Fix idea: serialise attempts per booking (`select … from bookings where id = $1 for update` around the reuse check + insert), or treat a recent PENDING payment without a session as in flight and return CONFLICT. Repro: `tests/payments.test.ts` › "[BUG-4] concurrent startCheckout calls (double click) create only one provider session" (3 calls 40 ms apart, 150 ms provider latency → 3 sessions). — FIXED (DB): reuse-or-create now runs under a booking row lock; an in-flight attempt makes concurrent calls return CONFLICT. Retested ✅ (96/96).
- [x] BUG-5 (DB) A late payment can confirm a booking for a CANCELLED showtime. `confirmPaidSession` re-claims free seats for an EXPIRED booking but never checks `showtimes.status` (or that the show hasn't started). Sequence: hold → checkout → hold lapses and is swept (the Stripe session stays open; releasing a hold doesn't expire it) → admin cancels the now-empty showtime (nothing to refund) → customer pays → booking CONFIRMED with a ticket for a cancelled show, no refund. Fix: in `confirmPaidSession`, `needRefund("showtime_cancelled")` when `showtime.status <> 'SCHEDULED'` (and probably when `starts_at <= now`); optionally expire open provider sessions when a hold is released. Repro: `tests/cancellation-admin.test.ts` › "[BUG-5] late payment for an expired booking on a since-cancelled showtime is refunded, not confirmed". — FIXED (DB): confirmPaidSession refunds when the showtime is no longer SCHEDULED. Retested ✅ (96/96).
