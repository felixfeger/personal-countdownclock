// GET /api/config  -> current settings.
// POST /api/config -> save settings. Only allowed with a valid Cloudflare Access login (JWT verified here).
const b64 = (x) => Uint8Array.from(atob(x.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function verifyAccess(request, env) {
  const jwt = request.headers.get("cf-access-jwt-assertion");
  if (!jwt || !env.ACCESS_TEAM || !env.ACCESS_AUD) return false;
  const [h, p, sig] = jwt.split(".");
  const header = JSON.parse(new TextDecoder().decode(b64(h)));
  const payload = JSON.parse(new TextDecoder().decode(b64(p)));
  if (!payload.exp || payload.exp * 1000 < Date.now()) return false;
  if (![].concat(payload.aud).includes(env.ACCESS_AUD)) return false;
  const certs = await (await fetch(`https://${env.ACCESS_TEAM}.cloudflareaccess.com/cdn-cgi/access/certs`, { cf: { cacheTtl: 3600 } })).json();
  const jwk = certs.keys.find((k) => k.kid === header.kid);
  if (!jwk) return false;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64(sig), new TextEncoder().encode(`${h}.${p}`));
}

export async function onRequestGet({ env }) {
  return new Response((await env.BOARD.get("config")) || "{}", { headers: { "content-type": "application/json" } });
}

export async function onRequestPost({ request, env }) {
  let ok = false;
  try { ok = await verifyAccess(request, env); } catch (e) { console.log("Access check failed:", e.message); }
  if (!ok) return new Response("Not signed in through Cloudflare Access (check ACCESS_TEAM / ACCESS_AUD)", { status: 401 });
  const b = await request.json();
  const ids = (v, n) => (Array.isArray(v) ? v : []).map(String).filter((x) => /^[\w-]+$/.test(x)).slice(0, n);
  const hhmm = (v, d) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : d);
  const cfg = {
    view: b.view === "airport" ? "airport" : "metro",
    name: String(b.name || "").slice(0, 40),
    rail: ids(b.rail, 20),
    bus: ids(b.bus, 60),
    tab: ["alternate", "rail", "bus"].includes(b.tab) ? b.tab : "alternate",
    airport: String(b.airport || "LAX").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4) || "LAX",
    flights: ["arrivals", "departures", "both"].includes(b.flights) ? b.flights : "both",
    max: Math.min(4, Math.max(1, +b.max || 3)),
    bright: Math.min(255, Math.max(5, +b.bright || 40)),
    mode: ["auto", "realtime", "schedule"].includes(b.mode) ? b.mode : "auto",
    offOn: !!b.offOn,
    offStart: hhmm(b.offStart, "23:00"),
    offEnd: hhmm(b.offEnd, "06:00"),
  };
  await env.BOARD.put("config", JSON.stringify(cfg));
  return Response.json(cfg);
}
