import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Next.js Edge Middleware — auth guard for protected routes.
 *
 * Checks for `access_token` cookie (set on login). If missing, redirects to /login.
 * This runs at the edge BEFORE the page is rendered, preventing flash of
 * protected content.
 *
 * Note: localStorage tokens are the primary auth mechanism in the SPA layer.
 * This cookie is a lightweight gate — the real validation happens via API calls.
 */

/**
 * Public routes. `/` is the marketing landing page — it must stay reachable
 * for logged-out visitors, otherwise the site entrypoint bounces to /login.
 */
const PUBLIC_PATHS = ['/', '/login', '/register', '/forgot-password'];

/**
 * Exact match, or a sub-path of a public route (`/login/sso`).
 * Deliberately not `startsWith`: that would make `/` match every route,
 * and would also expose look-alikes such as `/registered-users`.
 */
function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (p) => pathname === p || (p !== '/' && pathname.startsWith(`${p}/`)),
  );
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public routes and static assets
  if (
    isPublicPath(pathname) ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/api') ||
    pathname.includes('.')
  ) {
    return NextResponse.next();
  }

  // Check for access_token cookie (set by frontend on login)
  const token = request.cookies.get('access_token')?.value;
  if (!token) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('redirect', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)'],
};
