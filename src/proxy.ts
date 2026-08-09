import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Next.js 16 renamed Middleware to Proxy. This file must be `src/proxy.ts` —
 * a `middleware.ts` would be silently ignored.
 *
 * Its only job is refreshing the Supabase session cookie. Without it, tokens
 * expire and server-rendered pages log the user out at random.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // Do not insert code between createServerClient and getClaims(). Anything
  // that touches cookies in between causes intermittent, hard-to-debug logouts.
  const { data: claims } = await supabase.auth.getClaims();

  // The test screen (`/`) and the auth flow itself must stay public — typing
  // works with no account, results are held locally until sign-in
  // (PHASE-2.md §1, docs/ARCHITECTURE.md §3.3). Everything else (history,
  // dashboard, …) holds a signed-in user's data and requires a session.
  const { pathname } = request.nextUrl;
  const isPublic =
    pathname === "/" ||
    pathname === "/login" ||
    pathname.startsWith("/auth/");

  if (!claims && !isPublic) {
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  matcher: [
    // Everything except static assets and image files.
    "/((?!_next/static|_next/image|favicon.ico|data/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|woff2?)$).*)",
  ],
};
