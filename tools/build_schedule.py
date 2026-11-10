"""Builds the board's data from LA Metro's OFFICIAL static GTFS (rail + bus).
Writes:  schedule.json (routes + service calendars), stations.json (portal list), sched/<stop_id>.json (one per stop).

  python tools/build_schedule.py --config tools/config.json
  python tools/build_schedule.py --rail gtfs_rail.zip --bus gtfs_bus.zip --config tools/config.json    # local zips
  python tools/build_schedule.py --bus-near 34.0561,-118.2342,0.5                                     # quick extras
See GUIDE.md for what goes in config.json.
"""
import argparse, collections, csv, datetime, difflib, io, json, math, os, re, shutil, tempfile, urllib.request, zipfile

RAIL = "https://gitlab.com/LACMTA/gtfs_rail/raw/master/gtfs_rail.zip"
BUS = "https://gitlab.com/LACMTA/gtfs_bus/raw/master/gtfs_bus.zip"
DAYS = ("sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ap = argparse.ArgumentParser()
ap.add_argument("--config", help="JSON settings file, e.g. tools/config.json")
ap.add_argument("--rail", default=RAIL, help="rail GTFS zip (path or URL)")
ap.add_argument("--bus", default=BUS, help="bus GTFS zip (path or URL)")
ap.add_argument("--out", default=ROOT, help="output folder (default: repo root)")
ap.add_argument("--bus-near", action="append", default=[], help="LAT,LON,KM (repeatable)")
ap.add_argument("--bus-stops", default="", help="comma-separated bus stop_ids")
a = ap.parse_args()
cfg = json.load(open(a.config)) if a.config else {}
near = [tuple(float(v) for v in x) for x in cfg.get("bus_near", [])] + [tuple(float(v) for v in x.split(",")) for x in a.bus_near]
ids = {str(x) for x in cfg.get("bus_stops", [])} | {x.strip() for x in a.bus_stops.split(",") if x.strip()}
specs, combine = cfg.get("bus_match", []), cfg.get("combine_bus", [])
primary, extra_hubs = cfg.get("primary", []), cfg.get("extra_hubs", [])

today = datetime.date.today()
LO = int((today - datetime.timedelta(days=1)).strftime("%Y%m%d"))
HI = int((today + datetime.timedelta(days=90)).strftime("%Y%m%d"))
services, routes = [], {}
norm = lambda s: re.sub(r"[^a-z0-9]", "", s.lower())
STOP = {"st", "street", "ave", "av", "avenue", "blvd", "boulevard", "ter", "terr", "terrace", "rd", "road", "dr", "drive", "pl", "place", "and", "at"}
words = lambda s: [w for w in re.findall(r"[a-z0-9]+", s.lower()) if w not in STOP]


def name_match(spec, stop_name):          # "Main/Fremont" matches "Main St / Fremont Av" (typo-tolerant)
    nw = words(stop_name)
    return all(any(t == w or difflib.SequenceMatcher(None, t, w).ratio() >= 0.82 for w in nw) for t in words(spec))


def open_zip(src):
    if src.startswith("http"):
        path = os.path.join(tempfile.gettempdir(), os.path.basename(src))
        print("downloading", src)
        urllib.request.urlretrieve(src, path)
        src = path
    return zipfile.ZipFile(src)


def rd(z, name):
    with z.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))


def label(r):
    for t in (r.get("route_short_name") or "", r.get("route_long_name") or ""):
        m = re.search(r"\b([A-Z])\s+Line\b", t)
        if m: return m.group(1)
    return ((r.get("route_short_name") or "").strip() or (r.get("route_long_name") or "").strip())[:4]


def km(lat1, lon1, lat2, lon2):
    p = math.pi / 180
    x = math.sin((lat2 - lat1) * p / 2) ** 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lon2 - lon1) * p / 2) ** 2
    return 12742 * math.asin(math.sqrt(x))


def ll(s):
    try: return float(s["stop_lat"]), float(s["stop_lon"])
    except (ValueError, KeyError): return None


def load(z, pick):
    names, svc = set(z.namelist()), {}
    if "calendar.txt" in names:
        for c in rd(z, "calendar.txt"):
            if int(c["end_date"]) < LO: continue
            svc[c["service_id"]] = {"d": [int(c[d]) for d in DAYS], "s": int(c["start_date"]), "e": int(c["end_date"]), "a": [], "x": []}
    if "calendar_dates.txt" in names:
        for c in rd(z, "calendar_dates.txt"):
            d = int(c["date"])
            if not LO <= d <= HI: continue
            sv = svc.setdefault(c["service_id"], {"d": [0] * 7, "s": 0, "e": 0, "a": [], "x": []})
            sv["a" if c["exception_type"] == "1" else "x"].append(d)
    idx = {}
    for sid, sv in svc.items():
        idx[sid] = len(services); services.append(sv)
    for r in rd(z, "routes.txt"):
        lab = label(r)
        if r["route_id"] in routes and routes[r["route_id"]]["n"] != lab: raise SystemExit("route_id %s is in both feeds" % r["route_id"])
        routes[r["route_id"]] = {"n": lab, "c": (r.get("route_color") or "").strip() or "FFFFFF"}
    trips = {t["trip_id"]: (t["route_id"], int(t.get("direction_id") or 0), t.get("trip_headsign", ""), idx[t["service_id"]])
             for t in rd(z, "trips.txt") if t["service_id"] in idx}
    stops, parents = {}, {}
    for s in rd(z, "stops.txt"):
        lt = s.get("location_type") or "0"
        if lt == "0": stops[s["stop_id"]] = s
        elif lt == "1": parents[s["stop_id"]] = s["stop_name"]
    chosen = {sid for sid, s in stops.items() if pick(s)}
    last, hits = {}, []                    # one streaming pass (bus stop_times is millions of rows)
    for r in rd(z, "stop_times.txt"):
        tid = r["trip_id"]
        if tid not in trips: continue
        seq = int(r["stop_sequence"])
        if seq > last.get(tid, 0): last[tid] = seq
        if r["stop_id"] in chosen:
            h, m, s = map(int, (r["departure_time"] or r["arrival_time"]).strip().split(":"))
            hits.append((tid, seq, r["stop_id"], h * 3600 + m * 60 + s))
    ent, heads, ends = {}, {}, collections.defaultdict(collections.Counter)
    for tid, seq, sid, sec in hits:
        route, d, head, sv = trips[tid]
        if seq == last[tid]:
            ends[(route, d)][sid] += 1     # trip ends here: a terminal, not a departure
            continue
        ent.setdefault(sid, []).append([sec, route, d, sv])
        heads.setdefault(sid, collections.defaultdict(collections.Counter))["%s|%d" % (route, d)][head] += 1
    return {"stops": stops, "parents": parents, "ent": ent, "heads": heads, "ends": ends}


# ---------------- rail: every station, grouped by parent station ----------------
rail = load(open_zip(a.rail), lambda s: True)
grp = collections.defaultdict(list)
for sid in rail["ent"]:
    grp[rail["stops"][sid].get("parent_station") or sid].append(sid)
G = []
for key, sids in grp.items():
    pts = [ll(rail["stops"][x]) for x in sids]
    G.append({"key": key, "n": rail["parents"].get(key) or rail["stops"][sids[0]]["stop_name"], "rail": sorted(sids),
              "lat": sum(p[0] for p in pts) / len(pts), "lon": sum(p[1] for p in pts) / len(pts),
              "lines": sorted({routes[e[1]]["n"] for x in sids for e in rail["ent"][x]})})
term = {rail["stops"][c.most_common(1)[0][0]].get("parent_station") or c.most_common(1)[0][0] for c in rail["ends"].values()}
for g in G:
    g["tag"] = ""
    if g["key"] in term: g["tag"] = "terminal"
    if (len(g["rail"]) > 1 or any(h is not g and km(g["lat"], g["lon"], h["lat"], h["lon"]) < 0.25 and set(h["lines"]) != set(g["lines"]) for h in G)
            or any(norm(x) == norm(g["n"]) for x in extra_hubs)): g["tag"] = "hub"
for p in primary:
    hit = [g for g in G if norm(g["n"]) == norm(p)] or [g for g in G if norm(p) in norm(g["n"])]
    if not hit: print("WARNING: primary station not found:", p)
    for g in hit: g["tag"] = "primary"

# ---------------- bus: only the stops you ask for ----------------
cents = []
for c in combine:
    g = next((g for g in G if norm(g["n"]) == norm(c["station"])), None) or next((g for g in G if norm(c["station"]) in norm(g["n"])), None)
    if g: cents.append((g, float(c.get("radius_km", 0.35)), norm(c["station"])))
    else: print("WARNING: combine_bus station not found:", c["station"])


def near_hub(s):                         # bus stop belongs to a combined station?
    p = ll(s)
    return [g["key"] for g, r, nm in cents if p and (km(*p, g["lat"], g["lon"]) <= r or (nm in norm(s["stop_name"]) and km(*p, g["lat"], g["lon"]) <= 2 * r))]


def near_pt(s):
    p = ll(s)
    return s["stop_id"] in ids or bool(p and any(km(*p, a_, b_) <= r for a_, b_, r in near))


bus = {"stops": {}, "ent": {}, "heads": {}}
if near or ids or specs or cents:
    bus = load(open_zip(a.bus), lambda s: near_pt(s) or bool(near_hub(s)) or any(name_match(n, s["stop_name"]) for sp in specs for n in sp["names"]))
combined = collections.defaultdict(list)
for sid in bus["ent"]:
    for k in near_hub(bus["stops"][sid]): combined[k].append(sid)
absorbed = {x for v in combined.values() for x in v}
other = {sid for sid in bus["ent"] if near_pt(bus["stops"][sid])}
focus = {}                               # sid -> set of route_ids to keep (stops found by name on a given line)
for sp in specs:
    rids = {rid for rid, r in routes.items() if r["n"] == str(sp["route"]) or rid == str(sp["route"]) or rid.startswith(str(sp["route"]) + "-")}
    for nm in sp["names"]:
        found = [sid for sid in bus["ent"] if name_match(nm, bus["stops"][sid]["stop_name"]) and any(e[1] in rids for e in bus["ent"][sid])]
        for sid in found:
            print("MATCH  line %s '%s' -> stop %s '%s'" % (sp["route"], nm, sid, bus["stops"][sid]["stop_name"]))
            focus.setdefault(sid, set()).update(rids)
        if not found:
            print("WARNING: no stop on line %s matched '%s'. Stops on that line with a similar name:" % (sp["route"], nm))
            t = words(nm)[0]
            for sid, e in bus["ent"].items():
                if any(x[1] in rids for x in e) and t in norm(bus["stops"][sid]["stop_name"]): print("   ", sid, bus["stops"][sid]["stop_name"])


def blabel(sid, filt):
    parts = []
    for k, c in sorted(bus["heads"].get(sid, {}).items()):
        rid = k.split("|")[0]
        if filt and rid not in filt: continue
        p = "%s>%s" % (routes[rid]["n"], c.most_common(1)[0][0])
        if p not in parts: parts.append(p)
    return "%s [%s] (bus %s)" % (bus["stops"][sid]["stop_name"], sid, ", ".join(parts[:3]))


out = a.out
shutil.rmtree(os.path.join(out, "sched"), ignore_errors=True)
os.makedirs(os.path.join(out, "sched"))


def write(sid, feed, filt=None):
    t = sorted(e for e in feed["ent"][sid] if not filt or e[1] in filt)
    h = {k: c.most_common(1)[0][0] for k, c in feed["heads"][sid].items() if not filt or k.split("|")[0] in filt}
    json.dump({"h": h, "t": t}, open(os.path.join(out, "sched", sid + ".json"), "w"), separators=(",", ":"))


stations = []
for g in sorted(G, key=lambda g: g["n"]):
    stations.append({"n": g["n"], "rail": g["rail"], "bus": sorted(combined.get(g["key"], [])), "tag": g["tag"], "lines": g["lines"]})
    for sid in g["rail"]: write(sid, rail)
for sid in sorted(absorbed): write(sid, bus)
for sid in sorted(set(focus) | other):
    if sid in absorbed: continue
    filt = focus[sid] if (sid in focus and sid not in other) else None
    write(sid, bus, filt)
    stations.append({"n": blabel(sid, filt), "rail": [], "bus": [sid], "tag": "focus" if filt else "", "lines": []})
json.dump({"routes": routes, "services": services}, open(os.path.join(out, "schedule.json"), "w"), separators=(",", ":"))
json.dump(stations, open(os.path.join(out, "stations.json"), "w"), separators=(",", ":"))
mb = sum(os.path.getsize(os.path.join(out, "sched", f)) for f in os.listdir(os.path.join(out, "sched"))) / 1e6
print("%d stations/stops listed (%d rail stations, %d with a bus tab), per-stop data %.1f MB" % (len(stations), len(G), sum(1 for s in stations if s["rail"] and s["bus"]), mb))
