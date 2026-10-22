import bcrypt from "bcryptjs";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { DbOrTx } from "@/db/client";
import { users } from "@/db/schema";
import { AppError, PG_UNIQUE_VIOLATION, pgCode } from "@/lib/errors";
import { audit } from "./bookings";

const BCRYPT_COST = 11;
// Compared against when the email is unknown, so response time does not reveal which emails exist.
let dummyHash: string | undefined;
const getDummyHash = async () => (dummyHash ??= await bcrypt.hash("cinebook-timing-dummy", BCRYPT_COST));

export const registerInput = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  email: z.string().trim().toLowerCase().email("Enter a valid email").max(320),
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
});

export const loginInput = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  password: z.string().min(1, "Password is required").max(200),
});

export type PublicUser = { id: string; email: string; name: string; role: "USER" | "ADMIN" };

const toPublic = (u: typeof users.$inferSelect): PublicUser => ({ id: u.id, email: u.email, name: u.name, role: u.role });

export async function hashPassword(password: string) {
  return bcrypt.hash(password, BCRYPT_COST);
}

export async function registerUser(db: DbOrTx, raw: unknown): Promise<PublicUser> {
  const input = registerInput.parse(raw);
  try {
    const [u] = await db
      .insert(users)
      .values({ name: input.name, email: input.email, passwordHash: await hashPassword(input.password) })
      .returning();
    await audit(db, { actorUserId: u.id, action: "user.registered", entityType: "user", entityId: u.id });
    return toPublic(u);
  } catch (err) {
    if (pgCode(err) === PG_UNIQUE_VIOLATION) throw new AppError("CONFLICT", "An account with this email already exists.");
    throw err;
  }
}

export async function verifyCredentials(db: DbOrTx, raw: unknown): Promise<PublicUser> {
  const input = loginInput.parse(raw);
  const [u] = await db.select().from(users).where(eq(sql`lower(${users.email})`, input.email));
  const ok = await bcrypt.compare(input.password, u?.passwordHash ?? (await getDummyHash()));
  if (!u || !ok) throw new AppError("UNAUTHENTICATED", "Incorrect email or password.");
  return toPublic(u);
}

export async function getUserById(db: DbOrTx, id: string): Promise<PublicUser | null> {
  const [u] = await db.select().from(users).where(eq(users.id, id));
  return u ? toPublic(u) : null;
}
