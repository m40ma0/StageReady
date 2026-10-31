// One public port for the single-container deploy (Modal, or any Docker host): WebSockets on /ws go to the realtime server, everything else to the web app.
import http from "node:http";
import net from "node:net";

const PORT = Number(process.env.ROUTER_PORT ?? 7860);
const WEB = { host: "127.0.0.1", port: Number(process.env.WEB_PORT ?? 3000) };
const REALTIME = { host: "127.0.0.1", port: Number(process.env.REALTIME_PORT ?? 4000) };

const MARK = `<svg viewBox="0 0 512 512" width="72" height="72" aria-hidden="true"><defs><linearGradient id="t" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8B92FA"/><stop offset="1" stop-color="#4338CA"/></linearGradient><linearGradient id="b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity=".08"/></linearGradient></defs><rect width="512" height="512" rx="116" fill="url(#t)"/><path d="M214 96H298L408 372H104Z" fill="url(#b)"/><rect x="200" y="62" width="112" height="44" rx="16" fill="#fff"/><ellipse cx="256" cy="386" rx="172" ry="36" fill="#fff"/><path d="M178 254L232 306L338 196" fill="none" stroke="#fff" stroke-width="46" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// Shown while the app starts (a cold start after idling takes about a minute). Refreshes every 5 s.
const WAKING_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="5"><title>Waking up Stage Ready</title>
<style>:root{color-scheme:light dark;--bg:#f7f7fb;--fg:#14161f;--muted:#5b6070}@media (prefers-color-scheme:dark){:root{--bg:#0c0e14;--fg:#eceef5;--muted:#9aa0b2}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{display:grid;justify-items:center;gap:12px;padding:24px;text-align:center}h1{font-size:20px;font-weight:600;margin:8px 0 0}p{margin:0;color:var(--muted);font-size:14px}
.dots{display:inline-flex;gap:6px;margin-top:8px}.dots span{width:8px;height:8px;border-radius:50%;background:#6366f1;animation:p 1.2s infinite ease-in-out}.dots span:nth-child(2){animation-delay:.2s}.dots span:nth-child(3){animation-delay:.4s}
@keyframes p{0%,80%,100%{opacity:.25}40%{opacity:1}}@media (prefers-reduced-motion:reduce){.dots span{animation:none;opacity:.6}}</style></head>
<body><main>${MARK}<h1>Waking up Stage Ready…</h1><p>It sleeps when nobody is using it. This takes about a minute; the page refreshes by itself.</p><div class="dots" role="status" aria-label="Starting"><span></span><span></span><span></span></div></main></body></html>`;

const targetFor = (url = "/") => (url === "/ws" || url.startsWith("/ws?") ? REALTIME : WEB);

const probe = (target, path) =>
  fetch(`http://${target.host}:${target.port}${path}`, { signal: AbortSignal.timeout(6_000) }).then(
    async (r) => ({ ok: r.ok, status: r.status, body: await r.json().catch(() => null) }),
    () => ({ ok: false, status: 0, body: null }),
  );

// GET /healthz: the whole container at a glance (web, realtime, storage); 503 if any part is down.
async function healthz(res) {
  const [web, realtime, storage] = await Promise.all([probe(WEB, "/api/health"), probe(REALTIME, "/api/health"), probe(WEB, "/api/health/storage")]);
  const report = {
    ok: web.ok && realtime.ok && storage.ok,
    web: web.ok ? "ok" : "down",
    realtime: realtime.ok ? "ok" : "down",
    storage: storage.body ?? { ok: false, reason: "unreachable" },
  };
  res.writeHead(report.ok ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(report));
}

// One public address: Modal also serves the app on a region-specific host (e.g. <ws>--stage-ready.us-east.modal.run),
// where sign-in and the realtime origin check (WEB_ORIGIN) would fail. Send those visitors to PUBLIC_HOST.
const PUBLIC_HOST = (process.env.PUBLIC_HOST ?? process.env.SPACE_HOST ?? "").trim().toLowerCase();
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/;
function canonicalRedirect(req, res) {
  const host = (req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
  if (!PUBLIC_HOST || !host || host === PUBLIC_HOST || LOCAL.test(host)) return false;
  if (req.url === "/healthz" || req.url === "/api/health") return false;
  res.writeHead(308, { location: `https://${PUBLIC_HOST}${req.url ?? "/"}`, "cache-control": "no-store" });
  res.end();
  return true;
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/healthz") return void healthz(res);
  if (canonicalRedirect(req, res)) return;
  const target = targetFor(req.url);
  const upstream = http.request({ ...target, method: req.method, path: req.url, headers: req.headers }, (reply) => {
    res.writeHead(reply.statusCode ?? 502, reply.headers);
    reply.pipe(res);
  });
  upstream.on("error", () => {
    if (res.headersSent) return void res.end();
    // Browsers get a branded page that refreshes itself; API callers get JSON they can retry on.
    if ((req.headers.accept ?? "").includes("text/html")) {
      res.writeHead(503, { "content-type": "text/html; charset=utf-8", "retry-after": "5", "cache-control": "no-store" });
      return void res.end(WAKING_PAGE);
    }
    res.writeHead(503, { "content-type": "application/json", "retry-after": "5" });
    res.end(JSON.stringify({ error: { code: "starting", message: "Stage Ready is starting. Retry in a few seconds.", detail: null } }));
  });
  req.pipe(upstream);
});

// WebSocket upgrades: replay the request line and headers to the target, then pipe both ways.
server.on("upgrade", (req, socket, head) => {
  const host = (req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
  if (PUBLIC_HOST && host && host !== PUBLIC_HOST && !LOCAL.test(host)) {
    socket.end(`HTTP/1.1 308 Permanent Redirect\r\nLocation: https://${PUBLIC_HOST}${req.url}\r\nConnection: close\r\n\r\n`);
    return;
  }
  const target = targetFor(req.url);
  const upstream = net.connect(target.port, target.host, () => {
    const headers = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) headers.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers.join("\r\n")}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.listen(PORT, () => console.log(`router on :${PORT} (/ws -> :${REALTIME.port}, rest -> :${WEB.port})`));
