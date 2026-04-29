export const config = { runtime: "edge" };

// Strip trailing slash from the upstream domain, falling back to empty string
const UPSTREAM_ORIGIN = (process.env.TARGET_DOMAIN ?? "").replace(/\/$/, "");

// Headers that must not be forwarded to the upstream target
const BLOCKED_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
]);

export default async function relay(request) {
  // Bail early if the environment is not configured correctly
  if (!UPSTREAM_ORIGIN) {
    return new Response("Missing variable: TARGET_DOMAIN is not set", { status: 500 });
  }

  try {
    // Locate the path portion of the URL (everything after the scheme + host)
    const pathIndex = request.url.indexOf("/", 8);
    const destination =
      pathIndex === -1
        ? UPSTREAM_ORIGIN + "/"
        : UPSTREAM_ORIGIN + request.url.slice(pathIndex);

    // Build a clean set of forwarded headers, resolving the client IP along the way
    const forwardedHeaders = new Headers();
    let resolvedIp = null;

    for (const [name, value] of request.headers) {
      // Drop hop-by-hop and infrastructure-specific headers
      if (BLOCKED_HEADERS.has(name)) continue;

      // Vercel's internal headers should never reach the upstream
      if (name.startsWith("x-vercel-")) continue;

      // Prefer x-real-ip as the authoritative client IP source
      if (name === "x-real-ip") {
        resolvedIp = value;
        continue;
      }

      // Fall back to x-forwarded-for only if we have no better IP yet
      if (name === "x-forwarded-for") {
        if (!resolvedIp) resolvedIp = value;
        continue;
      }

      forwardedHeaders.set(name, value);
    }

    // Re-inject the resolved client IP as a standard forwarded-for header
    if (resolvedIp) forwardedHeaders.set("x-forwarded-for", resolvedIp);

    const httpMethod = request.method;
    const shouldForwardBody = httpMethod !== "GET" && httpMethod !== "HEAD";

    // Proxy the request to the upstream and return the raw response
    return await fetch(destination, {
      method: httpMethod,
      headers: forwardedHeaders,
      body: shouldForwardBody ? request.body : undefined,
      duplex: "half",   // Required for streaming request bodies in edge runtimes
      redirect: "manual", // Let the client handle redirects rather than following them
    });
  } catch (problem) {
    console.error("relay error:", problem);
    return new Response("Bad Gateway: Tunnel Failed", { status: 502 });
  }
}
