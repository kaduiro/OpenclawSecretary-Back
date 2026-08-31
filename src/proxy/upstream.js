export async function upstreamJson({ fetchImpl, identity, backendUrl, path, method = "GET", body, userAuthorization }) {
  const serviceAuthorization = await identity.backendAuthorization();
  const headers = { Accept: "application/json", "X-Serverless-Authorization": serviceAuthorization };
  if (userAuthorization) headers.Authorization = userAuthorization;
  else headers.Authorization = serviceAuthorization;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  return fetchImpl(new URL(path, backendUrl), {
    method,
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

export async function relayResponse(upstream, res) {
  res.status(upstream.status);
  res.set("Cache-Control", "no-store");
  const contentType = upstream.headers.get("content-type");
  if (contentType) res.set("Content-Type", contentType);
  const correlationId = upstream.headers.get("x-correlation-id");
  if (correlationId) res.set("X-Correlation-Id", correlationId);
  res.send(Buffer.from(await upstream.arrayBuffer()));
}
