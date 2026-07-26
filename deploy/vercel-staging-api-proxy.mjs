const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export default async function handler(request, response) {
  const origin = process.env.STAGING_API_ORIGIN;
  const proxySecret = process.env.STAGING_PROXY_SECRET;
  if (!origin || !proxySecret) {
    response.statusCode = 503;
    response.end("Staging API proxy is not configured.");
    return;
  }
  const configuredOrigin = new URL(origin);
  if (configuredOrigin.protocol !== "https:") {
    response.statusCode = 503;
    response.end("Staging API origin must use HTTPS.");
    return;
  }

  const incoming = new URL(request.url, "https://staging.vesselcalls.com");
  const path = incoming.searchParams.get("path") || "";
  incoming.searchParams.delete("path");
  const target = new URL(`/api/${path}`, configuredOrigin);
  if (!target.pathname.startsWith("/api/")) {
    response.statusCode = 400;
    response.end("Invalid API path.");
    return;
  }
  target.search = incoming.searchParams.toString();

  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && value !== undefined) {
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
  }
  headers.set("x-vessel-staging-proxy", proxySecret);
  headers.set("x-forwarded-host", request.headers.host || "staging.vesselcalls.com");
  headers.set("x-forwarded-proto", "https");

  const method = request.method || "GET";
  const chunks = [];
  if (method !== "GET" && method !== "HEAD") {
    for await (const chunk of request) {
      chunks.push(chunk);
    }
  }

  let upstream;
  try {
    upstream = await fetch(target, {
      method,
      headers,
      body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (_error) {
    response.statusCode = 502;
    response.end("Staging API is unavailable.");
    return;
  }

  response.statusCode = upstream.status;
  for (const [name, value] of upstream.headers) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && name.toLowerCase() !== "set-cookie") {
      response.setHeader(name, value);
    }
  }
  const cookies = upstream.headers.getSetCookie?.() || [];
  if (cookies.length > 0) {
    response.setHeader("set-cookie", cookies);
  }
  response.end(Buffer.from(await upstream.arrayBuffer()));
}
