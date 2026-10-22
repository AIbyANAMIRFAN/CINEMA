#!/usr/bin/env node
// HTTP smoke test for a running CineBook deployment.
//
//   BASE_URL=http://localhost:3100 node tests/e2e/http-smoke.mjs
//
// Env: BASE_URL (default http://localhost:3100), ADMIN_EMAIL / ADMIN_PASSWORD (default seeded admin),
//      CRON_SECRET (default local-cron-secret), STRICT_PAYMENTS=1 to fail (not warn) when checkout returns 5xx.
// Creates two throwaway users and one or two short-lived seat holds (they expire after 10 minutes).

const BASE = (process.env.BASE_URL ?? "http://localhost:3100").replace(/\/$/, "");
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@cinebook.test";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "Admin12345!";
const CRON_SECRET = process.env.CRON_SECRET ?? "local-cron-secret";
const STRICT_PAYMENTS = process.env.STRICT_PAYMENTS === "1";

let passed = 0;
let failed = 0;
const warnings = [];

function check(name, cond, info) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${info !== undefined ? ` -> ${typeof info === "string" ? info : JSON.stringify(info)}` : ""}`);
  }
}
function warn(msg) {
  warnings.push(msg);
  console.log(`  warn ${msg}`);
}

class Client {
  constructor(name) {
    this.name = name;
    this.cookies = new Map();
  }
  async req(method, path, { body, headers = {} } = {}) {
    const h = { ...headers };
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (body !== undefined) h["content-type"] = "application/json";
    const res = await fetch(BASE + path, {
      method,
      headers: h,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      redirect: "manual",
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = c.split(";");
      const i = pair.indexOf("=");
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      const expired = attrs.some((a) => /max-age=0/i.test(a) || /expires=thu, 01 jan 1970/i.test(a));
      if (!v || expired) this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
    let json = null;
    const text = await res.text();
    try {
      json = JSON.parse(text);
    } catch {
      json = text.slice(0, 200);
    }
    return { status: res.status, json };
  }
  get = (p, o) => this.req("GET", p, o);
  post = (p, o) => this.req("POST", p, o);
}

const rand = () => Math.random().toString(36).slice(2, 10);
const idem = () => `smoke-${rand()}-${rand()}`;

async function main() {
  console.log(`CineBook HTTP smoke against ${BASE}\n`);

  console.log("health");
  const health = await new Client("anon").get("/api/health");
  check("GET /api/health -> 200", health.status === 200 && health.json?.ok === true, health);

  console.log("auth");
  const a = new Client("A");
  const b = new Client("B");
  const emailA = `smoke-a-${rand()}@example.com`;
  const emailB = `smoke-b-${rand()}@example.com`;
  const regA = await a.post("/api/auth/register", { body: { name: "Smoke A", email: emailA, password: "smoke-pass-123" } });
  check("register A -> 201", regA.status === 201 && regA.json?.user?.email === emailA, regA);
  check("register sets session cookie", a.cookies.has("cb_session"));
  const regB = await b.post("/api/auth/register", { body: { name: "Smoke B", email: emailB, password: "smoke-pass-123" } });
  check("register B -> 201", regB.status === 201, regB);
  const dup = await new Client("x").post("/api/auth/register", { body: { name: "Dup", email: emailA.toUpperCase(), password: "smoke-pass-123" } });
  check("duplicate email (case-insensitive) -> 409", dup.status === 409, dup);
  const badReg = await new Client("x").post("/api/auth/register", { body: { name: "x", email: "nope", password: "1" } });
  check("invalid registration -> 400", badReg.status === 400, badReg);
  const badJson = await new Client("x").post("/api/auth/register", { body: "{not json" });
  check("malformed JSON -> 400", badJson.status === 400, badJson);
  const me = await a.get("/api/auth/me");
  check("GET /api/auth/me (A) -> user A", me.status === 200 && me.json?.user?.email === emailA, me);
  const roleOk = me.json?.user?.role === "USER";
  check("self-registered user is USER", roleOk, me.json?.user);
  const anonMe = await new Client("anon").get("/api/auth/me");
  check("GET /api/auth/me (anon) -> user null", anonMe.status === 200 && anonMe.json?.user === null, anonMe);
  const forged = new Client("forged");
  forged.cookies.set("cb_session", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.invalid");
  const forgedMe = await forged.get("/api/auth/me");
  check("forged session cookie -> user null", forgedMe.status === 200 && forgedMe.json?.user === null, forgedMe);
  const wrongPw = await new Client("x").post("/api/auth/login", { body: { email: emailA, password: "wrong-password" } });
  const unknown = await new Client("x").post("/api/auth/login", { body: { email: `ghost-${rand()}@example.com`, password: "wrong-password" } });
  check("wrong password -> 401", wrongPw.status === 401, wrongPw);
  check("unknown email -> 401 with identical message", unknown.status === 401 && unknown.json?.error?.message === wrongPw.json?.error?.message, unknown);
  const logout = await a.post("/api/auth/logout");
  check("logout -> 200", logout.status === 200, logout);
  const meAfter = await a.get("/api/auth/me");
  check("after logout /api/auth/me -> null", meAfter.json?.user === null, meAfter);
  const login = await a.post("/api/auth/login", { body: { email: emailA.toUpperCase(), password: "smoke-pass-123" } });
  check("login A again (email case-insensitive) -> 200", login.status === 200 && a.cookies.has("cb_session"), login);

  console.log("authorization");
  const anon = new Client("anon");
  const unauthHold = await anon.post("/api/bookings", { body: { showtimeId: crypto.randomUUID(), seatIds: [crypto.randomUUID()], idempotencyKey: idem() } });
  check("unauthenticated POST /api/bookings -> 401", unauthHold.status === 401, unauthHold);
  const unauthList = await anon.get("/api/bookings");
  check("unauthenticated GET /api/bookings -> 401", unauthList.status === 401, unauthList);
  for (const p of ["/api/admin/movies", "/api/admin/showtimes"]) {
    const r = await a.get(p);
    check(`user GET ${p} -> 403`, r.status === 403, r);
  }
  const userCreate = await a.post("/api/admin/movies", { body: { title: "Nope" } });
  check("user POST /api/admin/movies -> 403", userCreate.status === 403, userCreate);
  const anonAdmin = await anon.get("/api/admin/movies");
  check("anon GET /api/admin/movies -> 401", anonAdmin.status === 401, anonAdmin);

  const admin = new Client("admin");
  const adminLogin = await admin.post("/api/auth/login", { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  check("admin login -> 200 ADMIN", adminLogin.status === 200 && adminLogin.json?.user?.role === "ADMIN", adminLogin);
  const adminMovies = await admin.get("/api/admin/movies");
  check("admin GET /api/admin/movies -> 200", adminMovies.status === 200 && Array.isArray(adminMovies.json?.movies), adminMovies.status);
  const adminShowtimes = await admin.get("/api/admin/showtimes");
  check("admin GET /api/admin/showtimes -> 200", adminShowtimes.status === 200 && Array.isArray(adminShowtimes.json?.showtimes), adminShowtimes.status);
  const ticket404 = await admin.get(`/api/admin/tickets/${rand()}`);
  check("admin ticket lookup unknown code -> 404", ticket404.status === 404, ticket404);

  console.log("CSRF");
  const evil = await a.post("/api/auth/logout", { headers: { origin: "https://evil.example" } });
  check("cross-origin POST /api/auth/logout -> 403", evil.status === 403, evil);
  const evilHold = await a.post("/api/bookings", {
    headers: { origin: "https://evil.example" },
    body: { showtimeId: crypto.randomUUID(), seatIds: [crypto.randomUUID()], idempotencyKey: idem() },
  });
  check("cross-origin POST /api/bookings -> 403", evilHold.status === 403, evilHold);
  const stillIn = await a.get("/api/auth/me");
  check("cross-origin logout did not log the user out", stillIn.json?.user?.email === emailA, stillIn);
  const sameOrigin = await a.get("/api/auth/me", { headers: { origin: BASE } });
  check("same-origin request allowed", sameOrigin.status === 200, sameOrigin);

  console.log("cron");
  const cronNone = await anon.get("/api/cron/release-holds");
  check("cron without bearer -> 401", cronNone.status === 401, cronNone);
  const cronWrong = await anon.get("/api/cron/release-holds", { headers: { authorization: "Bearer wrong" } });
  check("cron with wrong bearer -> 401", cronWrong.status === 401, cronWrong);
  const cron1 = await anon.get("/api/cron/release-holds", { headers: { authorization: `Bearer ${CRON_SECRET}` } });
  check("cron with correct bearer -> 200", cron1.status === 200 && cron1.json?.ok === true, cron1);
  const cron2 = await anon.get("/api/cron/release-holds", { headers: { authorization: `Bearer ${CRON_SECRET}` } });
  check("cron second run -> 200 (idempotent)", cron2.status === 200 && cron2.json?.released === 0, cron2);

  console.log("webhook");
  const wh = await anon.post("/api/webhooks/stripe", { body: { id: "evt_fake", type: "checkout.session.completed" } });
  check("webhook without signature -> 400", wh.status === 400, wh);
  const whBad = await anon.post("/api/webhooks/stripe", { body: { id: "evt_fake" }, headers: { "stripe-signature": "t=1,v1=bad" } });
  if (whBad.status === 500) warn("webhook with bad signature -> 500 (Stripe gateway not configured in this environment)");
  else check("webhook with bad signature -> 400", whBad.status === 400, whBad);

  console.log("catalog");
  const movies = await anon.get("/api/movies");
  check("GET /api/movies -> 200 with movies", movies.status === 200 && movies.json?.movies?.length > 0, movies.status);
  const searchPct = await anon.get("/api/movies?q=%25");
  check("GET /api/movies?q=% -> 200 (no wildcard blow-up)", searchPct.status === 200, searchPct.status);
  const seats404 = await anon.get(`/api/showtimes/${crypto.randomUUID()}/seats`);
  check("unknown showtime seats -> 404", seats404.status === 404, seats404);
  const seatsBad = await anon.get(`/api/showtimes/not-a-uuid/seats`);
  check("malformed showtime id -> 404", seatsBad.status === 404, seatsBad);

  // Pick a future scheduled showtime with free seats.
  const now = Date.now();
  const candidates = (adminShowtimes.json?.showtimes ?? []).filter(
    (s) => s.status === "SCHEDULED" && new Date(s.startsAt).getTime() > now + 3 * 3600_000,
  );
  let showtimeId = null;
  let free = [];
  for (const st of candidates.slice(-10).reverse()) {
    const r = await anon.get(`/api/showtimes/${st.id}/seats`);
    const f = (r.json?.seats ?? []).filter((s) => s.status === "AVAILABLE");
    if (f.length >= 4) {
      showtimeId = st.id;
      free = f;
      break;
    }
  }
  check("found a future showtime with free seats", !!showtimeId, candidates.length);
  if (!showtimeId) return;

  console.log("bookings");
  // Concurrent hold of the same seat by two users.
  const target = free[free.length - 1];
  const [ha, hb] = await Promise.all([
    a.post("/api/bookings", { body: { showtimeId, seatIds: [target.id], idempotencyKey: idem() } }),
    b.post("/api/bookings", { body: { showtimeId, seatIds: [target.id], idempotencyKey: idem() } }),
  ]);
  const statuses = [ha.status, hb.status].sort();
  check("concurrent hold of the same seat -> one 201, one 409", statuses[0] === 201 && statuses[1] === 409, [ha, hb]);
  const loser = ha.status === 409 ? ha : hb;
  check("loser gets SEATS_UNAVAILABLE", loser.json?.error?.code === "SEATS_UNAVAILABLE", loser.json);
  const [winner, winnerClient, otherClient] = ha.status === 201 ? [ha, a, b] : [hb, b, a];
  const bookingId = winner.json?.booking?.bookingId;
  check("hold returns booking id + totals", !!bookingId && winner.json.booking.totalMinor > 0, winner.json);

  const seatMap = await winnerClient.get(`/api/showtimes/${showtimeId}/seats`);
  const mine = seatMap.json?.seats?.find((s) => s.id === target.id);
  check("seat map shows the held seat as mine for the holder", mine?.status === "HELD" && mine?.mine === true, mine);
  const theirs = (await otherClient.get(`/api/showtimes/${showtimeId}/seats`)).json?.seats?.find((s) => s.id === target.id);
  check("seat map shows HELD (not mine) for the other user", theirs?.status === "HELD" && theirs?.mine === false, theirs);

  // Idempotent retry
  const key = idem();
  const seat2 = free[free.length - 2];
  const r1 = await winnerClient.post("/api/bookings", { body: { showtimeId, seatIds: [seat2.id], idempotencyKey: key } });
  const r2 = await winnerClient.post("/api/bookings", { body: { showtimeId, seatIds: [seat2.id], idempotencyKey: key } });
  check("hold retry with same key -> 201 then 200 same booking", r1.status === 201 && r2.status === 200 && r1.json?.booking?.bookingId === r2.json?.booking?.bookingId, [r1.status, r2.status]);
  const r3 = await winnerClient.post("/api/bookings", { body: { showtimeId, seatIds: [free[free.length - 3].id], idempotencyKey: key } });
  check("same key, different seats -> 409", r3.status === 409, r3);
  const tooMany = await winnerClient.post("/api/bookings", { body: { showtimeId, seatIds: free.slice(0, 11).map((s) => s.id), idempotencyKey: idem() } });
  check("more than 10 seats -> 400", tooMany.status === 400, tooMany.status);

  const own = await winnerClient.get(`/api/bookings/${bookingId}`);
  check("owner GET /api/bookings/[id] -> 200", own.status === 200 && own.json?.booking?.id === bookingId, own.status);
  const cross = await otherClient.get(`/api/bookings/${bookingId}`);
  check("other user GET /api/bookings/[id] -> 404", cross.status === 404, cross);
  const crossCancel = await otherClient.post(`/api/bookings/${bookingId}/cancel`);
  if (crossCancel.status === 500) warn("cross-user cancel -> 500 (gateway not configured; ownership check runs after getGateway())");
  else check("other user POST /api/bookings/[id]/cancel -> 404", crossCancel.status === 404, crossCancel);
  const crossCheckout = await otherClient.post(`/api/bookings/${bookingId}/checkout`);
  if (crossCheckout.status === 500) warn("cross-user checkout -> 500 (gateway not configured)");
  else check("other user POST /api/bookings/[id]/checkout -> 404", crossCheckout.status === 404, crossCheckout);
  const crossConfirm = await otherClient.post(`/api/bookings/${bookingId}/confirm`, { body: { sessionId: "cs_test_x" } });
  if (crossConfirm.status === 500) warn("cross-user confirm -> 500 (gateway not configured)");
  else check("other user POST /api/bookings/[id]/confirm -> 404", crossConfirm.status === 404, crossConfirm);
  const adminView = await admin.get(`/api/bookings/${bookingId}`);
  check("admin GET any booking -> 200", adminView.status === 200, adminView.status);
  const list = await winnerClient.get("/api/bookings");
  check("GET /api/bookings lists own bookings", list.status === 200 && list.json?.bookings?.some((x) => x.id === bookingId), list.status);
  const otherList = await otherClient.get("/api/bookings");
  check("other user's list excludes it", otherList.status === 200 && !otherList.json?.bookings?.some((x) => x.id === bookingId), otherList.status);

  console.log("payments");
  const co = await winnerClient.post(`/api/bookings/${bookingId}/checkout`);
  if (co.status === 200) {
    check("checkout returns a Stripe URL", typeof co.json?.url === "string" && co.json.url.startsWith("https://"), co.json);
    const co2 = await winnerClient.post(`/api/bookings/${bookingId}/checkout`);
    check("second checkout reuses the open session", co2.status === 200 && co2.json?.url === co.json.url && co2.json?.reused === true, co2.json);
  } else if (co.status >= 500 && !STRICT_PAYMENTS) {
    warn(`checkout -> ${co.status}: Stripe not configured in this environment (STRIPE_SECRET_KEY); payment flow not exercised over HTTP`);
  } else {
    check("checkout -> 200", false, co);
  }
  const cancel = await winnerClient.post(`/api/bookings/${bookingId}/cancel`);
  if (cancel.status === 200) {
    check("owner cancels pending booking -> CANCELLED", cancel.json?.status === "CANCELLED", cancel.json);
    const after = (await anon.get(`/api/showtimes/${showtimeId}/seats`)).json?.seats?.find((s) => s.id === target.id);
    check("cancelled seat is AVAILABLE again", after?.status === "AVAILABLE", after);
  } else if (cancel.status >= 500 && !STRICT_PAYMENTS) {
    warn(`cancel -> ${cancel.status}: needs the Stripe gateway in this environment; hold will expire in 10 minutes`);
  } else {
    check("owner cancel -> 200", false, cancel);
  }
}

main()
  .catch((err) => {
    failed++;
    console.error("smoke crashed:", err);
  })
  .finally(() => {
    console.log(`\n${passed} passed, ${failed} failed, ${warnings.length} warnings`);
    for (const w of warnings) console.log(`  - ${w}`);
    process.exit(failed ? 1 : 0);
  });
