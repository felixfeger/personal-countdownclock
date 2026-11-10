# LA Metro Countdown Board: Complete Setup Guide
Starting from zero. Parts A and B need **no hardware**, so do them first.

## What you're building
A wall LED sign (two 64x32 HUB75 panels = 128x32) that shows the next trains/buses at a station, or flights near an airport. An ESP32 downloads a tiny JSON from **your Cloudflare Pages site** every 15 s; the site does all the work. You change what's shown in a web portal (protected by Cloudflare Access).

**Decisions already made**
- Metro data: **official static GTFS** (rail + bus) now; **Swiftly live data** gets switched on later by adding one key.
- Airports: **OpenSky Network** (free live aircraft data). Arrivals and departures are inferred from aircraft near the airport (see Part D).
- Your setup (in `tools/config.json`): primary stations **South Pasadena, Union Station, LAX/Metro Transit Center**; all rail hubs and line terminals are found automatically; bus **Line 78** at Main/Hampden, Fremont, Atlantic, 5th, 2nd, Garfield; **all of Union Station** with a **Rail tab and a Bus tab**.

## Part A: Online setup (about 45 minutes, free)
### A1. Accounts
GitHub (free), Cloudflare (free, you have one), and optionally OpenSky (free, for airport mode).

### A2. Put the project on GitHub
1. Unzip `metro-board.zip`. On Mac, press Cmd+Shift+. in Finder to show the hidden `.github` folder.
2. GitHub > New repository > name it `metro-board` > Private > Create.
3. Click **uploading an existing file**, drag in **everything inside the unzipped folder** (including `.github`, `functions`, `tools`, `firmware`), then Commit. (If the hidden folder won't upload, use GitHub Desktop instead.)

### A3. Build the schedule data
1. Repo > **Settings > Actions > General > Workflow permissions** > choose **Read and write** > Save.
2. Repo > **Actions** > **Update schedule data** > **Run workflow**. It downloads Metro's official rail and bus data and takes a few minutes.
3. Open the finished run's log and read it:
   - `MATCH line 78 'Main/Fremont' -> stop 12345 '...'` = found. **Check each one looks right.** Stop names don't say which city, and Main St exists in more than one place, so confirm direction/location in the portal later.
   - `WARNING: no stop on line 78 matched '...'` = it lists similar stops right below it. Fix the spelling in `tools/config.json` (edit on GitHub with the pencil icon) and run it again.
   - `WARNING: primary station not found` = adjust the name in `primary`.
4. It then commits `schedule.json`, `stations.json` and a `sched/` folder, and re-runs every night automatically (picks up schedule changes and holidays).

### A4. Cloudflare Pages (dashboard only, no wrangler.toml)
1. Dashboard > **Workers & Pages > Create > Pages > Connect to Git** > pick `metro-board`. Framework: None. Build command: *(empty)*. Output directory: `/`. Deploy.
2. **KV:** Dashboard > **Storage & Databases > KV** > create a namespace named `board`.
3. Pages project > **Settings > Bindings > Add > KV namespace** > variable name `BOARD` > select `board`.
4. **Custom domain** (Access needs one): Pages project > **Custom domains** > add e.g. `board.yourdomain.com`.
5. **Access:** Zero Trust > **Access > Applications > Add an application > Self-hosted**. Domain = your custom domain, no path. Add a policy: Allow > Emails > your email. Open the app's Overview and copy the **Application Audience (AUD) Tag**. Your **team name** is the part before `.cloudflareaccess.com` (Zero Trust > Settings > General).
6. Pages project > **Settings > Variables and Secrets** (Production), add:
   - `ACCESS_TEAM` = your team name
   - `ACCESS_AUD` = the AUD tag
   - `OPENSKY_CLIENT_ID` and `OPENSKY_CLIENT_SECRET` (secrets; from your OpenSky account's API client; skip if not using airports yet)
7. **Deployments > Retry/redeploy** so everything takes effect.
8. *For the ESP32 later:* Zero Trust > Access > **Service Auth > Service Tokens > Create** `board`; copy the Client ID and Secret (shown once). Edit your Access app and add a second policy: Action **Service Auth**, Include > Service Token > `board`.

### A5. Test it online (no hardware, nothing saved)
Replace YOUR-SITE with your domain (you must be signed in through Access).
| What | Open this |
|---|---|
| LED simulator, live | `https://YOUR-SITE/sim.html?stop=80214,80409&bus=&tab=alternate` |
| Union Station, rail tab + bus tab (find bus IDs in `stations.json`) | `https://YOUR-SITE/api/arrivals?stop=80214,80409&bus=BUSID1,BUSID2` |
| South Pasadena | `https://YOUR-SITE/api/arrivals?stop=80415` |
| LAX/Metro Transit Center | `https://YOUR-SITE/api/arrivals?stop=80702` |
| Airport | `https://YOUR-SITE/api/arrivals?airport=LAX&flights=both&debug=1` |
| Station/bus list | `https://YOUR-SITE/stations.json` |
Rows with `~` are scheduled times. Empty results at night can be normal. Then open the **portal** (`https://YOUR-SITE/`): tap a quick pick (Your stations, Your bus stops, Hubs, Line ends), watch the preview (Rail/Bus tabs for Union Station), set rows, brightness and the daily off time, and **Save to board**.

**No setup needed:** `gtfs-sim.html` is a standalone simulator that runs entirely in your browser (it is also published as a temporary online page). Download Metro’s `gtfs_rail.zip` (and `gtfs_bus.zip`, large, best on a computer) from the official links on that page, choose the files, then pick a station. It uses the same logic as your site, so you can see real schedule times and the Union Station Rail/Bus tabs before deploying anything. Use “Pick a time” to test other times of day.

## Part B: Hardware (when parts arrive)
**Parts (about $35-45):** 2x 64x32 HUB75 panels (Waveshare ones work), ESP32 DevKit (ESP-WROOM-32, not S2/S3/C3), one 5V 4-5A power adapter + DC jack-to-screw-terminal adapter, female-to-female jumper wires (you have them), optional smoked acrylic and sawtooth hangers.

**Wiring** (ESP32 to panel 1's **IN** connector, using the names printed on the panel; 14 wires):
| HUB75 | ESP32 GPIO |
|---|---|
| R1 G1 B1 | 25 26 27 |
| R2 G2 B2 | 14 12 13 |
| A B C D | 23 19 5 17 |
| E | not connected |
| LAT OE CLK | 4 15 16 |
| GND | any GND |
- Ribbon cable from panel 1 **OUT** to panel 2 **IN** (data only).
- **One** 5V adapter powers **both** panels: both red wires to its +, both black to its -. Never power panels through the ESP32.
- If the ESP32 won't boot with the panel attached, unplug the G2 wire (GPIO 12), reset, plug it back in.
- Blank/garbled panel: add `cfg.driver = HUB75_I2S_CFG::FM6126A;` under the `HUB75_I2S_CFG cfg(...)` line.

**Flash the ESP32**
1. Arduino IDE > Boards Manager > **esp32 by Espressif**; board **ESP32 Dev Module**.
2. Library Manager: **ESP32 HUB75 LED MATRIX PANEL DMA Display** and **ArduinoJson** (v7).
3. Open `firmware/board.ino` and edit the top: WiFi name/password, `API_URL` (`https://YOUR-SITE/api/arrivals`), `CF_ID`/`CF_SECRET` (the service token from A4 step 8).
4. Plug in, pick the port, Upload (hold the BOOT button if it stalls at "Connecting...").

**Mount** (matte black, tinted front gives the realistic sign look)
1. Cut a back plate (black foam board or 1/4" plywood) about 10 mm larger than the two panels.
2. Mount the panels edge to edge with their studs/screws (or VHB tape). Tape the ESP32 behind them.
3. Run the adapter cord down with small clips. Screw two sawtooth hangers to the back; put two level screws in the wall (drywall anchors if no stud).
4. Black foam-board bezel, then smoked gray acrylic or dark window film over the panels.

## Part C: Add live Metro data later
Request a key from Swiftly's "API Key Access" form (rail + bus GTFS-realtime). When approved, add it in Pages as the secret `SWIFTLY_KEY` and redeploy. The board then uses live times automatically and keeps the schedule as backup. Check `/api/arrivals?stop=80214&mode=realtime&debug=1` to confirm the IDs match.

## Part D: Airport mode (OpenSky)
- Portal > Show > Airport flights > pick airport (LAX default) and arrivals / departures / both.
- OpenSky gives only aircraft positions. Within about 35 km of the airport: descending or low and heading toward it = **arrival** (callsign + estimated minutes); climbing and heading away = **departure** (`DEP`). No schedule, no origin/destination, and aircraft not yet airborne don't appear. Expect some misses.
- Credits: a free account gets 4,000/day. One refresh = 1 credit, cached 60 s: at most 1,440/day (about 1,020 with an 11pm-6am off window). Anonymous access (400/day, shared IPs) isn't enough. Personal, non-commercial use only.

## Customizing
- **Portal:** station, rail/bus tab behavior, rows, brightness, daily off time, data source, airport.
- **`tools/config.json`:** `primary` (quick-pick stations), `bus_match` (line + stop names), `combine_bus` (stations that get a Bus tab, with radius), `bus_near` (`[lat, lon, km]`), `bus_stops` (exact IDs), `extra_hubs`. Edit on GitHub, then run the workflow again.
- **Sketch:** text color (`TEXT_R/G/B`), tab time (`TAB_MS`), panel count.

## Troubleshooting
| Problem | Try |
|---|---|
| Portal list is empty | Part A3 hasn't run yet or failed; check the Actions log |
| Save says "Not signed in through Cloudflare Access" | Check `ACCESS_TEAM` / `ACCESS_AUD` and that you're using the custom domain |
| "NO DATA" on the board | WiFi, `API_URL`, or service token (`CF_ID`/`CF_SECRET`); test the URL in a browser |
| Shows `~` times | Normal until `SWIFTLY_KEY` is added |
| Panel blank/garbled | Power, ribbon in IN, FM6126A line, common ground |
| Bus stop is the wrong one | Look at the label (direction arrow), or use `bus_stops` with exact IDs |
| Nothing at night | Normal; the daily off window also blanks it |
