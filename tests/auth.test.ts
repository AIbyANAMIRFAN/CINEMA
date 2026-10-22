import { eq } from "drizzle-orm";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { users } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { signSession, verifySession } from "@/lib/session-token";
import { getUserById, registerUser, verifyCredentials } from "@/server/users";
import { caught, freshDb, type TestDb } from "./helpers/db";

const SECRET = "test-secret-0123456789abcdef0123456789";

describe("registerUser / verifyCredentials", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await freshDb();
  });
  afterAll(() => t.close());

  it("registers a user with a normalised email and hashed password", async () => {
    const u = await registerUser(t.db, { name: "  Carol ", email: "  Carol@Example.COM ", password: "longenough1" });
    expect(u).toMatchObject({ email: "carol@example.com", name: "Carol", role: "USER" });
    expect(u).not.toHaveProperty("passwordHash");
    const [row] = await t.db.select().from(users).where(eq(users.id, u.id));
    expect(row.passwordHash).not.toContain("longenough1");
    expect(row.passwordHash).toMatch(/^\$2[aby]\$/);
  });

  it("validates input", async () => {
    for (const bad of [
      { name: "", email: "a@b.co", password: "longenough1" },
      { name: "x", email: "not-an-email", password: "longenough1" },
      { name: "x", email: "a@b.co", password: "short" },
      {},
    ]) {
      const e = await caught(() => registerUser(t.db, bad));
      expect(e.name).toBe("ZodError");
    }
  });

  it("rejects duplicate emails case-insensitively with CONFLICT", async () => {
    await registerUser(t.db, { name: "Dup", email: "dup@example.com", password: "longenough1" });
    const e = await caught(() => registerUser(t.db, { name: "Dup2", email: "DUP@Example.com", password: "longenough1" }));
    expect(e).toBeInstanceOf(AppError);
    expect(e.code).toBe("CONFLICT");
  });

  it("users cannot self-register as admin", async () => {
    const u = await registerUser(t.db, { name: "Eve", email: "eve@example.com", password: "longenough1", role: "ADMIN" });
    expect(u.role).toBe("USER");
  });

  it("verifies credentials (case-insensitive email)", async () => {
    await registerUser(t.db, { name: "Login", email: "login@example.com", password: "correct-horse" });
    const u = await verifyCredentials(t.db, { email: "LOGIN@example.com", password: "correct-horse" });
    expect(u.email).toBe("login@example.com");
    expect(await getUserById(t.db, u.id)).toEqual(u);
  });

  it("wrong password and unknown email fail identically", async () => {
    const wrong = await caught(() => verifyCredentials(t.db, { email: "login@example.com", password: "nope-nope" }));
    const unknown = await caught(() => verifyCredentials(t.db, { email: "ghost@example.com", password: "nope-nope" }));
    expect(wrong).toBeInstanceOf(AppError);
    expect(unknown).toBeInstanceOf(AppError);
    expect(wrong.code).toBe("UNAUTHENTICATED");
    expect(unknown.code).toBe("UNAUTHENTICATED");
    expect(wrong.message).toBe(unknown.message);
  });
});

describe("session tokens", () => {
  it("round-trips the user id", async () => {
    const tok = await signSession("user-123", SECRET);
    expect(await verifySession(tok, SECRET)).toBe("user-123");
  });

  it("rejects missing, tampered, wrong-secret and expired tokens", async () => {
    const tok = await signSession("user-123", SECRET);
    expect(await verifySession(undefined, SECRET)).toBeNull();
    expect(await verifySession("garbage", SECRET)).toBeNull();
    const [h, p, s] = tok.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ sub: "admin-id", iss: "cinebook", exp: 9999999999 })).toString("base64url");
    expect(await verifySession(`${h}.${forgedPayload}.${s}`, SECRET)).toBeNull();
    expect(await verifySession(`${h}.${p}.${s.slice(0, -2)}xx`, SECRET)).toBeNull();
    expect(await verifySession(tok, "another-secret-0123456789abcdef012345")).toBeNull();

    const key = new TextEncoder().encode(SECRET);
    const expired = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user-123")
      .setIssuer("cinebook")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(key);
    expect(await verifySession(expired, SECRET)).toBeNull();

    const wrongIssuer = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject("u").setIssuer("evil").setExpirationTime("1h").sign(key);
    expect(await verifySession(wrongIssuer, SECRET)).toBeNull();

    const unsigned = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify({ sub: "u", iss: "cinebook" })).toString("base64url")}.`;
    expect(await verifySession(unsigned, SECRET)).toBeNull();
  });

  it("refuses to sign with a short secret", async () => {
    await expect(signSession("u", "short")).rejects.toThrow();
  });
});
