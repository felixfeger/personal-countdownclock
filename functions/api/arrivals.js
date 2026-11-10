// GET /api/arrivals -> the tiny JSON the LED board downloads.
// view "metro":   LA Metro real-time via Swiftly (needs SWIFTLY_KEY), falling back to the static GTFS schedule.
// view "airport": OpenSky Network live aircraft near an airport (arrivals / departures / both).
// Add ?debug=1 to see the raw upstream response (handy for first-time setup).

const DEFAULTS = { view: "metro", name: "", rail: [], bus: [], tab: "alternate", airport: "LAX", flights: "both", max: 3, bright: 40, mode: "auto", offOn: false, offStart: "23:00", offEnd: "06:00" };
// ---------- schedule data: schedule.json (routes + calendars) and one small file per stop: sched/<stop_id>.json ----------
const C = { at: 0, meta: null, stops: new Map() };
async function asset(env, request, path) {
  const r = await env.ASSETS.fetch(new Request(new URL(path, request.url)));
  if (!r.ok) throw new Error(path + " " + r.status);
  return r.json();
}
async function loadSched(env, request, ids) {
  if (Date.now() - C.at > 30 * 60 * 1000) { C.at = Date.now(); C.meta = null; C.stops.clear(); } // refresh every 30 min
  if (!C.meta) { try { C.meta = await asset(env, request, "/schedule.json"); } catch (e) { C.meta = { routes: {}, services: [] }; C.at = 0; } }
  await Promise.all(ids.filter((s) => /^[\w-]+$/.test(s) && !C.stops.has(s)).map(async (s) => {
    try { C.stops.set(s, await asset(env, request, `/sched/${s}.json`)); } catch (e) { C.stops.set(s, { h: {}, t: [] }); }
  }));
  return { routes: C.meta.routes || {}, services: C.meta.services || [], stops: Object.fromEntries(ids.map((s) => [s, C.stops.get(s) || { h: {}, t: [] }])) };
}

function row(sd, route, dir, stop, m) {
  const r = sd.routes[route] || {};
  return { l: r.n || route || "?", c: r.c || "FFFFFF", d: ((sd.stops[stop] || {}).h || {})[`${route}|${dir}`] || "", m };
}

// Which "pages" the board shows: a station with rail AND bus gets two tabs (Rail / Bus)
function pagesFor(cfg) {
  const R = cfg.rail || [], B = cfg.bus || [];
  if (!B.length) return [["RAIL", R]];
  if (!R.length) return [["BUS", B]];
  if (cfg.tab === "rail") return [["RAIL", R]];
  if (cfg.tab === "bus") return [["BUS", B]];
  return [["RAIL", R], ["BUS", B]];
}

// ---------- LA Metro real-time via Swiftly (GTFS-realtime protobuf, needs SWIFTLY_KEY) ----------
// Tiny dependency-free protobuf reader, just enough for TripUpdates.
const dec = new TextDecoder();
function varint(b, i) { let r = 0, m = 1, c; do { c = b[i++]; r += (c & 127) * m; m *= 128; } while (c & 128); return [r, i]; }
function fields(b) {
  const out = []; let i = 0;
  while (i < b.length) {
    let tag, v, l; [tag, i] = varint(b, i);
    const f = Math.floor(tag / 8), w = tag & 7;
    if (w === 0) { [v, i] = varint(b, i); out.push([f, v]); }
    else if (w === 2) { [l, i] = varint(b, i); out.push([f, b.subarray(i, i + l)]); i += l; }
    else if (w === 1) i += 8;
    else if (w === 5) i += 4;
    else throw new Error("bad protobuf wire type " + w);
  }
  return out;
}
function parseTripUpdates(buf) {
  const out = [];
  for (const [f, ent] of fields(buf)) if (f === 2)                 // FeedMessage.entity
    for (const [ef, tu] of fields(ent)) if (ef === 3) {            // FeedEntity.trip_update
      let route = "", dir = 0; const stops = [];
      for (const [tf, v] of fields(tu)) {
        if (tf === 1) for (const [df, dv] of fields(v)) { if (df === 5) route = dec.decode(dv); if (df === 6) dir = dv; } // trip: route_id, direction_id
        if (tf === 2) {                                               // stop_time_update
          let stop = "", t = 0;
          for (const [sf, sv] of fields(v)) {
            if (sf === 4) stop = dec.decode(sv);
            if ((sf === 2 || sf === 3) && !t) for (const [xf, xv] of fields(sv)) if (xf === 2) t = xv; // arrival/departure.time
          }
          stops.push({ stop, t });
        }
      }
      for (const s of stops) out.push({ route, dir, ...s });
    }
  return out;
}

async function metro(env, sd, ids, now, dbg, kind) {
  if (!env.SWIFTLY_KEY) throw new Error("no SWIFTLY_KEY yet, using schedule");
  const url = (kind === "BUS" ? env.RT_URL_BUS : env.RT_URL_RAIL) || `https://api.goswift.ly/real-time/${kind === "BUS" ? "lametro" : "lametro-rail"}/gtfs-rt-trip-updates`;
  const r = await fetch(url, { headers: { Authorization: env.SWIFTLY_KEY }, cf: { cacheTtl: 30 } });
  if (!r.ok) throw new Error("Swiftly HTTP " + r.status);
  const all = parseTripUpdates(new Uint8Array(await r.arrayBuffer()));
  dbg[kind] = { entries: all.length, sampleStopIds: [...new Set(all.map((x) => x.stop))].slice(0, 12) };
  return all.filter((x) => ids.includes(x.stop) && x.t && x.t >= now - 30).map((x) => row(sd, x.route, x.dir, x.stop, Math.max(0, Math.round((x.t - now) / 60))));
}

// Which service_ids run on a given Los Angeles date (weekly pattern + holiday add/remove exceptions)
const ymd = (d) => d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
function active(sched, d) {
  const n = ymd(d), dow = d.getDay(), out = new Set();
  (sched.services || []).forEach((s, i) => {
    const on = s.d[dow] === 1 && n >= s.s && n <= s.e && !(s.x || []).includes(n);
    if (on || (s.a || []).includes(n)) out.add(i);
  });
  return out;
}

function schedule(sd, ids) {
  const la = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const sec = la.getHours() * 3600 + la.getMinutes() * 60 + la.getSeconds();
  // today's service, plus yesterday's trips that run past midnight (times >= 24:00:00)
  const days = [[active(sd, la), sec], [active(sd, new Date(la.getTime() - 864e5)), sec + 86400]];
  const out = [];
  for (const s of ids)
    for (const [set, now] of days)
      for (const [t, route, dir, svc] of (sd.stops[s] || {}).t || [])
        if (set.has(svc) && t >= now && t <= now + 5400) out.push(row(sd, route, dir, s, Math.round((t - now) / 60)));
  return out;
}

// ---------- Airports via OpenSky Network (live ADS-B state vectors) ----------
// OpenSky has no schedule and no origin/destination, so arrivals/departures are INFERRED from
// aircraft near the airport: descending + heading toward it = arriving, climbing + heading away = departing.
const AIRPORTS = {
  LAX: [33.9425, -118.4081], BUR: [34.2007, -118.359], LGB: [33.8177, -118.1516], SNA: [33.6757, -117.8682],
  ONT: [34.056, -117.6012], SAN: [32.7336, -117.1897], SFO: [37.6213, -122.379], OAK: [37.7213, -122.2208],
  SJC: [37.3626, -121.9291], LAS: [36.084, -115.1537], PHX: [33.4343, -112.0116], SEA: [47.4502, -122.3088],
  PDX: [45.5898, -122.5951], DEN: [39.8561, -104.6737], DFW: [32.8998, -97.0403], ORD: [41.9742, -87.9073],
  ATL: [33.6407, -84.4277], JFK: [40.6413, -73.7781], LGA: [40.7769, -73.874], EWR: [40.6895, -74.1745],
  BOS: [42.3656, -71.0096], MIA: [25.7959, -80.287], LHR: [51.47, -0.4543],
};
let OS_TOKEN = { v: "", exp: 0 };
const rad = (d) => (d * Math.PI) / 180;
const distKm = (a, b, c, d) => { const x = Math.sin(rad(c - a) / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(rad(d - b) / 2) ** 2; return 12742 * Math.asin(Math.sqrt(x)); };
const bearing = (a, b, c, d) => { const y = Math.sin(rad(d - b)) * Math.cos(rad(c)); const x = Math.cos(rad(a)) * Math.sin(rad(c)) - Math.sin(rad(a)) * Math.cos(rad(c)) * Math.cos(rad(d - b)); return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360; };
const angDiff = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

async function osToken(env) {
  if (!env.OPENSKY_CLIENT_ID || !env.OPENSKY_CLIENT_SECRET) return null; // anonymous
  if (OS_TOKEN.exp > Date.now() + 60000) return OS_TOKEN.v;
  const r = await fetch("https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: env.OPENSKY_CLIENT_ID, client_secret: env.OPENSKY_CLIENT_SECRET }),
  });
  if (!r.ok) throw new Error("OpenSky auth HTTP " + r.status);
  const j = await r.json();
  OS_TOKEN = { v: j.access_token, exp: Date.now() + (j.expires_in || 1800) * 1000 };
  return OS_TOKEN.v;
}

async function airport(env, cfg, now, dbg) {
  const code = String(cfg.airport).toUpperCase();
  const [lat, lon] = AIRPORTS[code] || AIRPORTS.LAX;
  const ttl = env.OPENSKY_CLIENT_ID ? 60 : 300; // seconds between real OpenSky calls (1 credit each)
  const key = "os:" + code;
  let cached = JSON.parse((await env.BOARD.get(key)) || "null");
  if (!cached || now - cached.t > ttl) {
    try {
      const token = await osToken(env), d = 0.35;
      const r = await fetch(`https://opensky-network.org/api/states/all?lamin=${lat - d}&lamax=${lat + d}&lomin=${lon - d}&lomax=${lon + d}`, { headers: token ? { Authorization: "Bearer " + token } : {} });
      if (!r.ok) throw new Error("OpenSky HTTP " + r.status);
      cached = { t: now, states: (await r.json()).states || [] };
      await env.BOARD.put(key, JSON.stringify(cached), { expirationTtl: 900 });
    } catch (e) { if (!cached) throw e; dbg.stale = e.message; } // fall back to last good data
  }
  dbg.aircraftInBox = cached.states.length; dbg.dataAgeSec = now - cached.t;
  const arr = [], dep = [];
  for (const st of cached.states) {
    const [icao, callsign, , , , lo, la, alt, ground, vel, trk, vr] = st;
    if (la == null || lo == null || ground || !vel) continue;
    const km = distKm(lat, lon, la, lo), toward = angDiff(trk ?? 0, bearing(la, lo, lat, lon)) < 60, away = angDiff(trk ?? 0, bearing(la, lo, lat, lon)) > 120;
    const name = String(callsign || icao).trim();
    if (toward && km < 40 && ((vr ?? 0) < -1 || (alt ?? 9e3) < 1200)) arr.push({ l: "A", c: "2E9E4F", d: name, m: Math.round((km / (vel * 3.6)) * 60), km });
    else if (away && km < 30 && (vr ?? 0) > 1) dep.push({ l: "D", c: "0072BC", d: name, m: 0, s: "DEP", km });
  }
  arr.sort((a, b) => a.m - b.m);
  dep.sort((a, b) => a.km - b.km); // nearest first = most recently departed
  const max = cfg.max;
  if (cfg.flights === "arrivals") return arr.slice(0, max);
  if (cfg.flights === "departures") return dep.slice(0, max);
  const nA = Math.ceil(max / 2);
  const a = arr.slice(0, nA), d = dep.slice(0, max - nA);
  return [...a, ...d, ...[...arr.slice(a.length), ...dep.slice(d.length)].slice(0, max - a.length - d.length)];
}

// Daily off window, in Los Angeles time. Wraps past midnight (e.g. 23:00 -> 06:00).
function isOff(cfg) {
  if (!cfg.offOn || cfg.offStart === cfg.offEnd) return false;
  const t = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
  return cfg.offStart < cfg.offEnd ? t >= cfg.offStart && t < cfg.offEnd : t >= cfg.offStart || t < cfg.offEnd;
}

export async function onRequestGet({ request, env }) {
  const cfg = { ...DEFAULTS, ...JSON.parse((await env.BOARD.get("config")) || "{}") };
  const q = new URL(request.url).searchParams;
  // Test overrides (nothing is saved):  ?stop=RAIL_IDS&bus=BUS_IDS[&tab=alternate]   or   ?airport=LAX&flights=both
  const testing = q.has("stop") || q.has("bus") || q.has("airport");
  if (q.has("stop") || q.has("bus")) {
    cfg.view = "metro";
    cfg.rail = (q.get("stop") || "").split(",").filter(Boolean);
    cfg.bus = (q.get("bus") || "").split(",").filter(Boolean);
    if (q.get("tab")) cfg.tab = q.get("tab");
    if (q.get("mode")) cfg.mode = q.get("mode");
  }
  if (q.has("airport")) { cfg.view = "airport"; cfg.airport = q.get("airport"); cfg.flights = q.get("flights") || cfg.flights; }
  if (isOff(cfg) && !testing)  // scheduled off: skip upstream calls, save credits
    return Response.json({ off: true, src: "off", view: cfg.view, name: cfg.name, bright: cfg.bright, rows: [] }, { headers: { "cache-control": "no-store" } });
  const now = Math.floor(Date.now() / 1000);
  const dbg = {};
  let rows = [], src = "none", tabs;

  if (cfg.view === "airport") {
    try { rows = await airport(env, cfg, now, dbg); src = "opensky"; } catch (e) { console.log(e.message); src = "error"; dbg.error = e.message; }
  } else {
    const pages = pagesFor(cfg);
    const sd = await loadSched(env, request, pages.flatMap(([, ids]) => ids));
    tabs = [];
    for (const [kind, ids] of pages) {
      let r = [], sr = "none";
      if (cfg.mode !== "schedule") { try { r = await metro(env, sd, ids, now, dbg, kind); sr = "rt"; } catch (e) { dbg.error = e.message; } }
      if (!r.length && cfg.mode !== "realtime") { r = schedule(sd, ids); sr = "sched"; }
      r.sort((a, b) => a.m - b.m);
      tabs.push({ t: kind, src: sr, rows: r.slice(0, cfg.max) });
    }
    rows = tabs[0].rows; src = tabs[0].src;
    if (tabs.length < 2) tabs = undefined;
  }
  if (q.has("debug")) return Response.json(dbg);
  return Response.json({ src, view: cfg.view, name: cfg.name, bright: cfg.bright, rows, tabs }, { headers: { "cache-control": "no-store" } });
}
