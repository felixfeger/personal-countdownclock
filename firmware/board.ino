// LA-Metro-style arrival board for ESP32 + HUB75 panels.
// Libraries (Library Manager): "ESP32 HUB75 LED MATRIX PANEL DMA Display", "ArduinoJson" (v7)
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <ESP32-HUB75-MatrixPanel-I2S-DMA.h>

// ======== EDIT THESE ========
const char* WIFI_SSID = "your-wifi";
const char* WIFI_PASS = "your-password";
const char* API_URL   = "https://YOUR-PROJECT.pages.dev/api/arrivals";
const char* CF_ID     = "";   // Cloudflare Access service token (Client ID)
const char* CF_SECRET = "";   // Cloudflare Access service token (Client Secret)
#define PANEL_W 64        // pixels per panel
#define PANEL_H 32
#define CHAIN   2         // panels side by side
#define REFRESH_MS 15000
#define TAB_MS 8000      // seconds-per-tab (x1000) when a station has rail + bus tabs
#define TEXT_R 255        // sign text color (amber). Try 255,255,255 for white
#define TEXT_G 140
#define TEXT_B 0
// ============================

MatrixPanel_I2S_DMA *d;
const int W = PANEL_W * CHAIN, H = PANEL_H;
uint16_t amber, red;

uint16_t hex565(const char* h) { long v = strtol(h, 0, 16); return d->color565((v >> 16) & 255, (v >> 8) & 255, v & 255); }

void bullet(int bw, int cy, int r, uint16_t col, const String& lab, bool big) {
  int cw = big ? 12 : 6;
  d->setTextSize(big ? 2 : 1); d->setTextColor(0);
  if (lab.length() > 1) {                        // bus numbers like "720": colored pill
    int h = min(big ? 17 : 9, 2 * r + 2);
    d->fillRoundRect(0, cy - h / 2, bw, h, 2, col);
    d->setCursor(2, cy - (big ? 7 : 3)); d->print(lab);
    return;
  }
  int cx = bw / 2;                               // rail letters like "A": round bullet
  if (r >= 4) d->fillCircle(cx, cy, r, col); else d->fillRect(cx - 3, cy - 4, 8, 8, col);
  d->setCursor(cx - (big ? 5 : 2), cy - (big ? 7 : 3)); d->print(lab);
}

void draw(JsonArray rows, bool sch, bool airport) {
  d->clearScreen();
  int n = rows.size();
  if (n == 0) { d->setTextSize(1); d->setTextColor(amber); d->setCursor(30, 12); d->print(airport ? "NO FLIGHTS" : "NO TRAINS SOON"); d->flipDMABuffer(); return; }
  int rowH = H / n, i = 0;
  bool big = rowH >= 16;
  int cw = big ? 12 : 6, ch = big ? 16 : 8;
  int r = min(rowH / 2 - 1, 8);
  for (JsonObject row : rows) {
    int cy = i * rowH + rowH / 2, ty = cy - ch / 2;
    String lab = String((const char*)row["l"]);
    int bw = lab.length() > 1 ? lab.length() * cw + 4 : (r >= 4 ? 2 * r + 2 : 8);
    bullet(bw, cy, r, hex565(row["c"] | "FFFFFF"), lab, big);
    int m = row["m"];
    const char* sv = row["s"] | (const char*)nullptr;
    String t = sv ? String(sv) : (m <= 0) ? String("ARR") : (sch ? "~" : "") + String(m) + " min";
    String dest = String((const char*)row["d"]); dest.toUpperCase();
    int tx = bw + 4;
    dest = dest.substring(0, max(0, (W - tx - (int)t.length() * cw - 4) / cw));
    d->setTextSize(big ? 2 : 1); d->setTextColor(amber);
    d->setCursor(tx, ty); d->print(dest);
    d->setCursor(W - t.length() * cw, ty); d->print(t);
    i++;
  }
  d->flipDMABuffer();
}

void setup() {
  HUB75_I2S_CFG cfg(PANEL_W, PANEL_H, CHAIN);
  cfg.double_buff = true;   // no flicker between updates
  d = new MatrixPanel_I2S_DMA(cfg);
  d->begin(); d->setBrightness8(40);
  amber = d->color565(TEXT_R, TEXT_G, TEXT_B); red = d->color565(255, 0, 0);
  d->setTextColor(amber); d->setCursor(0, 0); d->print("CONNECTING..."); d->flipDMABuffer();
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) delay(300);
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) WiFi.reconnect();
  WiFiClientSecure c; c.setInsecure();   // fine for public transit data
  HTTPClient h; h.begin(c, API_URL);
  if (CF_ID[0]) { h.addHeader("CF-Access-Client-Id", CF_ID); h.addHeader("CF-Access-Client-Secret", CF_SECRET); }
  int code = h.GET();
  JsonDocument doc;
  bool ok = code == 200 && !deserializeJson(doc, h.getString());
  h.end();
  if (!ok) { d->clearScreen(); d->setTextSize(1); d->setTextColor(red); d->setCursor(0, 0); d->print("NO DATA"); d->flipDMABuffer(); delay(REFRESH_MS); return; }
  d->setBrightness8(doc["bright"] | 40);
  if (doc["off"] | false) { d->clearScreen(); d->flipDMABuffer(); delay(30000); return; }   // scheduled off
  bool air = String((const char*)doc["view"]) == "airport";
  JsonArray tabs = doc["tabs"].as<JsonArray>();
  if (tabs.size() > 1) {                 // rail + bus station: show each tab in turn (empty tabs are skipped)
    int shown = 0;
    for (JsonObject t : tabs) {
      JsonArray rows = t["rows"].as<JsonArray>();
      if (rows.size() == 0) continue;
      draw(rows, String((const char*)t["src"]) == "sched", air); delay(TAB_MS); shown++;
    }
    if (!shown) { draw(tabs[0]["rows"].as<JsonArray>(), true, air); delay(REFRESH_MS); }
  } else {
    draw(doc["rows"].as<JsonArray>(), String((const char*)doc["src"]) == "sched", air);
    delay(REFRESH_MS);
  }
}
