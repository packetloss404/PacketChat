import { NextRequest, NextResponse } from "next/server";

const refreshCookieName = "packetchat_refresh";

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (isPublicPage(pathname) || request.cookies.has(refreshCookieName)) {
    return NextResponse.next();
  }

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  loginUrl.searchParams.set("next", `${pathname}${search}`);

  return NextResponse.redirect(loginUrl);
}

function isPublicPage(pathname: string) {
  return pathname === "/login" || pathname.startsWith("/login/");
}

export const config = {
  matcher: ["/((?!api|_next|favicon.ico|.*\\..*).*)"]
};
