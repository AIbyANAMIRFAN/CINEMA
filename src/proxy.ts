import { NextResponse, type NextRequest } from "next/server";

// Cheap optimistic gate: no session cookie means a guaranteed redirect to sign in.
// Real authorization (valid session, ownership, admin role) is enforced in server code.
const SESSION_COOKIE = "cb_session";

export function proxy(request: NextRequest) {
  if (request.cookies.has(SESSION_COOKIE)) return NextResponse.next();
  const { pathname, search } = request.nextUrl;
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/bookings/:path*", "/checkout/:path*", "/admin/:path*"],
};
