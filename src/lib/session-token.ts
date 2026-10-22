import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "cb_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

function key(secret = process.env.AUTH_SECRET) {
  if (!secret || secret.length < 32) throw new Error("AUTH_SECRET must be set to at least 32 characters");
  return new TextEncoder().encode(secret);
}

/** Signed (HS256) session token carrying only the user id. Role is always re-read from the database. */
export async function signSession(userId: string, secret?: string) {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setIssuer("cinebook")
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(key(secret));
}

export async function verifySession(token: string | undefined, secret?: string): Promise<string | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(secret), { issuer: "cinebook", algorithms: ["HS256"] });
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}
