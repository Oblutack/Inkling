// Where another app's Share menu sends what it shares (see the manifest). The service worker normally answers this itself and
// keeps the share for the /share page. This is for the moment the worker is not running yet (the very first visit, or a
// browser that has switched it off): the person lands on the share page, which says the share did not arrive.
export function POST(request: Request) {
  return Response.redirect(new URL("/share?missing=1", request.url), 303);
}

export function GET(request: Request) {
  return Response.redirect(new URL("/share", request.url), 303);
}
