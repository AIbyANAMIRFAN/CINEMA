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
- [ ] Vercel config, README

### APP
- [ ] Layout, nav, auth-aware header, footer, design system
- [ ] Home (search + filters: title, genre, language, cinema, date)
- [ ] Movie details with showtimes; cinemas list + cinema page with showtimes
- [ ] Seat selection (live availability), selected seats + fees + total
- [ ] Checkout (hold countdown, pay via Stripe, cancelled/retry state)
- [ ] Confirmation + digital ticket with reference and QR code
- [ ] Booking history + cancel eligible bookings
- [ ] Login / register / logout
- [ ] Admin: dashboard, movies, showtimes, bookings, ticket verify
- [ ] Loading, error, empty, not-found states; mobile + desktop

### QA
- [ ] Test harness (embedded Postgres, migrations on a clean DB)
- [ ] Auth: registration, login, logout, authorization
- [ ] Search/filter, cinema selection, showtimes, seat maps
- [ ] Full booking flow through ticket confirmation
- [ ] Concurrent booking of the same seat: exactly one succeeds
- [ ] Expired holds + automatic release (idempotent)
- [ ] Totals, taxes, fees, payment status
- [ ] Payment success, failure, cancellation, retry, duplicate webhook delivery
- [ ] Cross-user access to bookings/tickets denied; admin permissions
- [ ] Production build

## Bugs

_(none yet)_
