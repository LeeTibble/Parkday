import { useState, useEffect, useCallback, useRef } from "react";

// ─── Liquid Glass system ──────────────────────────────────────────────────────
// Three tiers matching Apple's iOS 26 usage:
//   GLASS_HEAVY  — hero overlays, modals, prominent surfaces
//   GLASS_MID    — cards, section rows, interactive elements  
//   GLASS_LIGHT  — pills, badges, subtle overlays

const GLASS_HEAVY = {
  background: "linear-gradient(135deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.06) 100%)",
  backdropFilter: "blur(24px) saturate(180%) brightness(1.08)",
  WebkitBackdropFilter: "blur(24px) saturate(180%) brightness(1.08)",
  border: "1px solid rgba(255,255,255,0.28)",
  boxShadow: "0 8px 32px rgba(0,0,0,0.28), inset 0 1px 0 rgba(255,255,255,0.35), inset 0 -1px 0 rgba(0,0,0,0.12)",
};

const GLASS_MID = {
  background: "linear-gradient(135deg, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0.04) 100%)",
  backdropFilter: "blur(16px) saturate(160%)",
  WebkitBackdropFilter: "blur(16px) saturate(160%)",
  border: "1px solid rgba(255,255,255,0.18)",
  boxShadow: "0 4px 16px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.25)",
};

const GLASS_LIGHT = {
  background: "linear-gradient(135deg, rgba(255,255,255,0.16) 0%, rgba(255,255,255,0.06) 100%)",
  backdropFilter: "blur(10px) saturate(140%)",
  WebkitBackdropFilter: "blur(10px) saturate(140%)",
  border: "1px solid rgba(255,255,255,0.22)",
  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.3)",
};

// Liquid Glass SVG filter for edge refraction (Chromium only, gracefully ignored elsewhere)
const LG_FILTER_ID = "lg-refract";
function LiquidGlassSVG() {
  return (
    <svg style={{ position:"fixed", width:0, height:0, overflow:"hidden" }} aria-hidden="true">
      <defs>
        <filter id={LG_FILTER_ID} x="-20%" y="-20%" width="140%" height="140%" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="3" seed="2" result="noise" />
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="3" xChannelSelector="R" yChannelSelector="G" result="displaced" />
          <feComposite in="displaced" in2="SourceGraphic" operator="in" />
        </filter>
      </defs>
    </svg>
  );
}

// ─── Worker fetch (real live data) ───────────────────────────────────────────
async function fetchFromWorker(workerUrl, parkId) {
  // Try the Cloudflare worker first if URL provided
  if (workerUrl) {
    const url = workerUrl.replace(/\/+$/, "") + "/queues?parkId=" + parkId;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Worker " + res.status);
    const json = await res.json();
    if (json.error) throw new Error(json.error);
    const map = {};
    (json.lands || []).forEach(land => {
      (land.rides || []).forEach(ride => {
        map[ride.name] = { name: ride.name, wait: ride.wait_time, status: ride.is_open ? "open" : "closed" };
      });
    });
    return map;
  }
  throw new Error("No worker URL");
}

// Fetch live queue times via Anthropic API (works from artifact sandbox)
async function fetchViaAnthropicProxy(parkId) {
  const parkUrls = {
    1: "https://queue-times.com/parks/1/queue_times",
    2: "https://queue-times.com/parks/2/queue_times",
    3: "https://queue-times.com/parks/3/queue_times",
    49: "https://queue-times.com/parks/49/queue_times",
    273: "https://queue-times.com/parks/273/queue_times",
  };
  const url = parkUrls[parkId];
  if (!url) throw new Error("Unknown park");

  // Use Anthropic API with web_search to fetch live queue times
  // The artifact environment handles auth automatically
  const makeRequest = async (messages) => {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages,
      })
    });
    if (!res.ok) throw new Error("API " + res.status);
    return res.json();
  };

  // First turn: ask Claude to fetch queue times
  let messages = [{
    role: "user",
    content: `Visit ${url} and return a JSON object of current queue times. Format exactly: {"Ride Name": {"name":"Ride Name","wait":15,"status":"open"}} for each ride. status is "open" or "closed". wait is integer minutes. Return ONLY the JSON, no other text.`
  }];

  let data = await makeRequest(messages);

  // Handle tool_use turns (web_search needs multiple rounds)
  let maxTurns = 5;
  while (data.stop_reason === "tool_use" && maxTurns-- > 0) {
    const toolUseBlocks = data.content.filter(b => b.type === "tool_use");
    const toolResults = toolUseBlocks.map(b => ({
      type: "tool_result",
      tool_use_id: b.id,
      content: "Please search for the queue times and return them as JSON."
    }));
    messages = [
      ...messages,
      { role: "assistant", content: data.content },
      { role: "user", content: toolResults }
    ];
    data = await makeRequest(messages);
  }

  // Extract JSON from final response
  const text = data.content
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("");

  const jsonMatch = text.match(/\{[\s\S]*\}/s);
  if (!jsonMatch) throw new Error("No JSON found");
  const parsed = JSON.parse(jsonMatch[0]);

  // Validate it looks like ride data
  const keys = Object.keys(parsed);
  if (keys.length < 3) throw new Error("Too few rides in response");
  // Normalise format
  const map = {};
  keys.forEach(k => {
    const v = parsed[k];
    if (v && typeof v === "object") {
      map[v.name || k] = {
        name: v.name || k,
        wait: parseInt(v.wait) || 0,
        status: v.status || "open"
      };
    }
  });
  return map;
}

// ─── Simulated queue engine (fallback) ───────────────────────────────────────
// queue-times.com blocks all browser & proxy requests due to CORS + allowlist.
// We simulate realistic wait times based on time-of-day curves + thrill level.

function getTimeMultiplier() {
  const h = new Date().getHours() + new Date().getMinutes() / 60;
  if (h < 9)  return 0.10;
  if (h < 10) return 0.30;
  if (h < 11) return 0.60;
  if (h < 12) return 0.82;
  if (h < 14) return 1.00;
  if (h < 15) return 0.92;
  if (h < 16) return 0.78;
  if (h < 17) return 0.62;
  if (h < 18) return 0.44;
  if (h < 19) return 0.28;
  return 0.14;
}

const THRILL_BASE = { "🔴": 75, "🟠": 50, "🟡": 35, "🟢": 30 };
const _seeds = {};
function rideSeed(name) {
  if (!_seeds[name]) _seeds[name] = 0.55 + Math.random() * 0.9;
  return _seeds[name];
}
function simulateQueues(rides) {
  const mult = getTimeMultiplier();
  const map  = {};
  rides.forEach(ride => {
    const base   = THRILL_BASE[ride.thrill] || 20;
    const jitter = (Math.random() - 0.5) * 8;
    const wait   = Math.max(0, Math.round(base * mult * rideSeed(ride.name) + jitter));
    const closed = Math.random() < 0.07;
    map[ride.name] = { name: ride.name, wait: closed ? 0 : wait, status: closed ? "closed" : "open" };
  });
  return map;
}



// Park themes — CSS gradient covers, no external images needed (sandbox safe)
// Each theme has a gradient, accent colour, emoji motif and label
const PARK_THEMES = {
  "Alton Towers": [
    { gradient: "linear-gradient(135deg,#1a1a2e 0%,#16213e 40%,#8B0000 100%)", emoji:"🎢", label:"Nemesis — Forbidden Valley", accent:"#cc0000" },
    { gradient: "linear-gradient(135deg,#0d0d0d 0%,#1a0a00 50%,#FF4500 100%)", emoji:"😱", label:"Oblivion — The Drop", accent:"#FF4500" },
    { gradient: "linear-gradient(135deg,#1a1a2e 0%,#2d1b69 50%,#FFD700 100%)", emoji:"🌀", label:"The Smiler — 14 Loops", accent:"#FFD700" },
    { gradient: "linear-gradient(135deg,#2d4a1e 0%,#1a3a0e 50%,#8B4513 100%)", emoji:"🏰", label:"The Estate & Gardens", accent:"#6B8E23" },
  ],
  "Thorpe Park": [
    { gradient: "linear-gradient(135deg,#0a0a0a 0%,#1a0000 50%,#DC143C 100%)", emoji:"⚡", label:"Stealth — 0 to 80mph", accent:"#DC143C" },
    { gradient: "linear-gradient(135deg,#000814 0%,#001d3d 50%,#003566 100%)", emoji:"🌊", label:"The Swarm", accent:"#0077b6" },
    { gradient: "linear-gradient(135deg,#1a0a2e 0%,#16213e 50%,#4B0082 100%)", emoji:"💀", label:"SAW — The Ride", accent:"#8B008B" },
    { gradient: "linear-gradient(135deg,#0d1117 0%,#21262d 50%,#30363d 100%)", emoji:"🎡", label:"Park at Dusk", accent:"#58a6ff" },
  ],
  "Chessington World of Adventures": [
    { gradient: "linear-gradient(135deg,#1a0a00 0%,#2d1b00 40%,#8B4513 70%,#228B22 100%)", emoji:"🦁", label:"Wild Africa Safari", accent:"#DAA520" },
    { gradient: "linear-gradient(135deg,#0d1f0d 0%,#1a3a1a 50%,#006400 100%)", emoji:"🌿", label:"Jumanji Jungle", accent:"#32CD32" },
    { gradient: "linear-gradient(135deg,#1a0a2e 0%,#2d003e 50%,#800080 100%)", emoji:"🧛", label:"Vampire — Transylvania", accent:"#9400D3" },
    { gradient: "linear-gradient(135deg,#001f3f 0%,#003d7a 50%,#0074D9 100%)", emoji:"🌊", label:"Tiger Rock Rapids", accent:"#00B4DB" },
  ],
  "Blackpool Pleasure Beach": [
    { gradient: "linear-gradient(135deg,#001a4d 0%,#003080 50%,#FFD700 100%)", emoji:"🎡", label:"Illuminations & Rides", accent:"#FFD700" },
    { gradient: "linear-gradient(135deg,#4a0000 0%,#800000 50%,#FF6347 100%)", emoji:"🎢", label:"The Big One — 235ft", accent:"#FF4500" },
    { gradient: "linear-gradient(135deg,#001a33 0%,#003366 40%,#0077b6 70%,#48cae4 100%)", emoji:"🌊", label:"Valhalla — Get Drenched", accent:"#48cae4" },
    { gradient: "linear-gradient(135deg,#2d1b00 0%,#4a2f00 50%,#8B6914 100%)", emoji:"🎪", label:"Classic Pleasure Beach", accent:"#DAA520" },
  ],
  "Paultons Park": [
    { gradient: "linear-gradient(135deg,#003300 0%,#006600 50%,#90EE90 100%)", emoji:"🌿", label:"Green & Family Fun", accent:"#32CD32" },
    { gradient: "linear-gradient(135deg,#ff6b9d 0%,#c44b8a 50%,#a0006e 100%)", emoji:"🐷", label:"Peppa Pig World", accent:"#FF69B4" },
    { gradient: "linear-gradient(135deg,#001a33 0%,#002b52 50%,#0077b6 100%)", emoji:"⛈", label:"Storm Surge", accent:"#00B4DB" },
    { gradient: "linear-gradient(135deg,#1a3300 0%,#2d5200 50%,#52b788 100%)", emoji:"🦕", label:"Lost Kingdom", accent:"#52b788" },
  ],
  "Drayton Manor": [
    { gradient: "linear-gradient(135deg,#001a4d 0%,#003380 50%,#0055cc 100%)", emoji:"🌊", label:"Stormforce 10", accent:"#0077b6" },
    { gradient: "linear-gradient(135deg,#1a0033 0%,#330066 50%,#6600cc 100%)", emoji:"🎢", label:"Shockwave", accent:"#9933ff" },
    { gradient: "linear-gradient(135deg,#1a1a00 0%,#333300 50%,#666600 100%)", emoji:"🏰", label:"Manor Grounds", accent:"#999900" },
    { gradient: "linear-gradient(135deg,#330000 0%,#660000 50%,#cc2200 100%)", emoji:"🔥", label:"Apocalypse", accent:"#ff4400" },
  ],
};

// Fallback themes for custom parks
const DEFAULT_THEMES = [
  { gradient: "linear-gradient(135deg,#FF6B6B,#FFD93D)", emoji:"🎢", label:"Sunny Day Out", accent:"#FFD93D" },
  { gradient: "linear-gradient(135deg,#4D96FF,#C77DFF)", emoji:"⚡", label:"Thrill Seeker", accent:"#C77DFF" },
  { gradient: "linear-gradient(135deg,#6BCB77,#4D96FF)", emoji:"🌿", label:"Family Adventure", accent:"#6BCB77" },
  { gradient: "linear-gradient(135deg,#FF9A3C,#FF6B6B)", emoji:"🌅", label:"Golden Hour", accent:"#FF9A3C" },
];

function getParkThemes(parkName) {
  return PARK_THEMES[parkName] || DEFAULT_THEMES;
}

function unsplashUrl(url) { return url; }

const PRESET_PARKS = [
  {
    name: "Alton Towers",
    emoji: "🏰",
    openTime: "10:00",
    closeTime: "18:00",
    gradIdx: 0,
    queueTimesId: 1,
    rides: [
      { name: "Drakon",                        thrill:"🔴", height:"130cm", rating:5, mustRide:true,  tip:"Brand new 2026 inverting coaster — the park's most intense yet" },
      { name: "Storm Chaser",                  thrill:"🟠", height:"120cm", rating:4, mustRide:true,  tip:"Exhilarating spinning ride in Tornado Springs" },
      { name: "EDGE",                          thrill:"🟠", height:"130cm", rating:3, mustRide:false, tip:"Swings you out over the park — great views" },
      { name: "Magma",                         thrill:"🟠", height:"110cm", rating:3, mustRide:false, tip:"High-speed water ride with a big final drop" },
      { name: "Raging River Ride",             thrill:"🟠", height:"—",     rating:3, mustRide:false, tip:"River rapids adventure — expect to get wet" },
      { name: "Buffalo Falls",                 thrill:"🟠", height:"—",     rating:3, mustRide:false, tip:"Water ride in Tornado Springs" },
      { name: "Cyclonator",                    thrill:"🟡", height:"110cm", rating:3, mustRide:false, tip:"Spinning pendulum ride — surprisingly intense" },
      { name: "Ghostly Manor",                 thrill:"🟡", height:"—",     rating:4, mustRide:true,  tip:"New 2025 dark ride — spooky fun for all the family" },
      { name: "Pirate Ship",                   thrill:"🟡", height:"100cm", rating:3, mustRide:false, tip:"Classic swinging ship — great for families" },
      { name: "Cobra",                         thrill:"🟡", height:"100cm", rating:3, mustRide:false, tip:"Fun family coaster with good turns" },
      { name: "The Sky Swinger",               thrill:"🟡", height:"100cm", rating:3, mustRide:false, tip:"Swing high above the park" },
      { name: "Flight of the Pterosaur",       thrill:"🟡", height:"105cm", rating:3, mustRide:false, tip:"Soar above Lost Kingdom on this suspended coaster" },
      { name: "Splash Lagoon",                 thrill:"🟡", height:"90cm",  rating:3, mustRide:false, tip:"Family flume in Lost Kingdom" },
      { name: "Farmyard Flyer",                thrill:"🟡", height:"90cm",  rating:3, mustRide:false, tip:"Fun mini coaster in Tornado Springs" },
      { name: "Kontiki",                       thrill:"🟡", height:"—",     rating:2, mustRide:false, tip:"Classic swinging disc ride" },
      { name: "Viking Boats",                  thrill:"🟢", height:"—",     rating:3, mustRide:false, tip:"Splashy water ride for all ages" },
      { name: "Cat-O-Pillar Coaster",          thrill:"🟢", height:"—",     rating:3, mustRide:false, tip:"Gentle starter coaster for little ones" },
      { name: "Peppa's Big Balloon Ride",      thrill:"🟢", height:"—",     rating:3, mustRide:false, tip:"The iconic Peppa Pig World balloon ride" },
      { name: "Daddy Pig's Car Ride",          thrill:"🟢", height:"—",     rating:3, mustRide:false, tip:"Drive through Peppa Pig World" },
      { name: "George's Dinosaur Adventure",   thrill:"🟢", height:"—",     rating:3, mustRide:false, tip:"Little ones love the dinosaur theming" },
      { name: "Miss Rabbit's Helicopter Flight", thrill:"🟢", height:"—",   rating:3, mustRide:false, tip:"Helicopter ride in Peppa Pig World" },
      { name: "Grampy Rabbit's Sailing Club",  thrill:"🟢", height:"—",     rating:2, mustRide:false, tip:"Gentle sailing boat ride" },
      { name: "Grandpa Pig's Boat Trip",       thrill:"🟢", height:"—",     rating:2, mustRide:false, tip:"Gentle boat trip in Peppa Pig World" },
      { name: "Grandpa Pig's Little Train",    thrill:"🟢", height:"—",     rating:2, mustRide:false, tip:"Little train ride through Peppa Pig World" },
      { name: "The Victorian Carousel",        thrill:"🟢", height:"—",     rating:3, mustRide:false, tip:"Beautiful Victorian carousel" },
      { name: "Rio Grande Train Ride",         thrill:"🟢", height:"—",     rating:2, mustRide:false, tip:"Train tour around the park" },
      { name: "Vild Swing",                    thrill:"🟠", height:"—",     rating:3, mustRide:false, tip:"New giant swing ride for 2026" },
      { name: "Al's Auto Academy",             thrill:"🟢", height:"—",     rating:2, mustRide:false, tip:"Children's driving school in Tornado Springs" },
    ],
des: [
      { name: "Nemesis Reborn",                    thrill:"🔴", height:"140cm", rating:5, mustRide:true,  tip:"UK's most iconic coaster — ride it first thing" },
      { name: "The Smiler",                        thrill:"🔴", height:"140cm", rating:5, mustRide:true,  tip:"World record 14 loops — intense from start to finish" },
      { name: "Oblivion",                          thrill:"🔴", height:"140cm", rating:4, mustRide:true,  tip:"The vertical drop is terrifying — don't look down" },
      { name: "Toxicator",                         thrill:"🔴", height:"140cm", rating:4, mustRide:false, tip:"New for 2025 — intense spinning with great effects" },
      { name: "Galactica",                         thrill:"🔴", height:"140cm", rating:4, mustRide:false, tip:"Lie face-down for a flying sensation" },
      { name: "Rita",                              thrill:"🟠", height:"140cm", rating:3, mustRide:false, tip:"Short but punchy launch — great for thrill seekers" },
      { name: "Wicker Man",                        thrill:"🟠", height:"120cm", rating:4, mustRide:true,  tip:"Best wooden coaster in the UK — brilliant theming" },
      { name: "TH13TEEN",                          thrill:"🟠", height:"120cm", rating:3, mustRide:false, tip:"The surprise drop at the end is genuinely shocking" },
      { name: "The Blade",                         thrill:"🟠", height:"100cm", rating:3, mustRide:false, tip:"Classic swinging ship — good fun for all" },
      { name: "Spinball Whizzer",                  thrill:"🟡", height:"120cm", rating:3, mustRide:false, tip:"Fun spinning coaster — great for families" },
      { name: "The Curse at Alton Manor",          thrill:"🟡", height:"90cm",  rating:4, mustRide:true,  tip:"One of the best dark rides in the UK — great for all ages" },
      { name: "Hex - The Legend of the Towers",    thrill:"🟡", height:"—",     rating:3, mustRide:false, tip:"Unique disorientation ride inside the towers" },
      { name: "Gangsta Granny: The Ride",          thrill:"🟡", height:"—",     rating:3, mustRide:false, tip:"Family dark ride based on the David Walliams book" },
      { name: "Congo River Rapids",                thrill:"🟡", height:"90cm",  rating:3, mustRide:false, tip:"Classic river rapids — expect to get wet" },
      { name: "Nemesis Sub-Terra",                 thrill:"🟡", height:"140cm", rating:3, mustRide:false, tip:"Claustrophobic underground drop ride — genuinely unsettling" },
      { name: "Runaway Mine Train",                thrill:"🟡", height:"90cm",  rating:3, mustRide:false, tip:"Great family coaster — good starter for younger riders" },
      { name: "Marauder's Mayhem",                 thrill:"🟡", height:"—",     rating:3, mustRide:false, tip:"Spinning ride in Katanga Canyon" },
      { name: "Heave Ho",                          thrill:"🟡", height:"—",     rating:2, mustRide:false, tip:"Gentle swinging boat ride" },
      { name: "Battle Galleons",                   thrill:"🟢", height:"90cm",  rating:3, mustRide:false, tip:"Water cannon battle ride — great fun for kids" },
      { name: "Octonauts Rollercoaster Adventure", thrill:"🟢", height:"—",     rating:3, mustRide:false, tip:"Great CBeebies coaster for young children" },
      { name: "In The Night Garden Magical Boat Ride", thrill:"🟢", height:"—", rating:3, mustRide:false, tip:"Gentle boat ride for toddlers" },
      { name: "Go Jetters Vroomster Zoom Ride",    thrill:"🟢", height:"—",     rating:3, mustRide:false, tip:"Fun ride for Go Jetters fans" },
      { name: "Bluey the Ride: Here Come The Grannies!", thrill:"🟢", height:"—", rating:3, mustRide:false, tip:"New Bluey-themed family ride" },
      { name: "Bugbie-Go-Round",                   thrill:"🟢", height:"—",     rating:2, mustRide:false, tip:"Gentle carousel for little ones" },
      { name: "Get Set Go Tree Top Adventure",     thrill:"🟢", height:"—",     rating:2, mustRide:false, tip:"Gentle family ride in CBeebies Land" },
      { name: "Peter Rabbit Hippity Hop",          thrill:"🟢", height:"—",     rating:2, mustRide:false, tip:"Bouncy ride for very young children" },
      { name: "Justin's House Pie-O-Matic Factory", thrill:"🟢", height:"—",    rating:2, mustRide:false, tip:"Interactive dark ride for young fans" },
    ],
  },
  {
    name: "Thorpe Park",
    emoji: "⚡",
    openTime: "10:00",
    closeTime: "18:00",
    gradIdx: 1,
    queueTimesId: 2,
    rides: [
      { name: "Hyperia",                     thrill:"🔴", height:"130cm", rating:5, mustRide:true,  tip:"UK's tallest coaster — 14.8 seconds of weightlessness" },
      { name: "Stealth",                     thrill:"🔴", height:"140cm", rating:5, mustRide:true,  tip:"0-80mph in under 2 seconds — blink and it's over" },
      { name: "Colossus",                    thrill:"🔴", height:"140cm", rating:4, mustRide:true,  tip:"10 inversions — relentless from start to finish" },
      { name: "SAW - The Ride",              thrill:"🔴", height:"140cm", rating:4, mustRide:false, tip:"Beyond vertical drop plus great horror theming" },
      { name: "The Swarm",                   thrill:"🟠", height:"140cm", rating:4, mustRide:false, tip:"Smooth wing coaster with brilliant near-miss elements" },
      { name: "Nemesis Inferno",             thrill:"🟠", height:"140cm", rating:4, mustRide:false, tip:"Inverted coaster — feet dangling, great sustained G-force" },
      { name: "The Walking Dead©: The Ride", thrill:"🟠", height:"130cm", rating:3, mustRide:false, tip:"Intense indoor coaster with great horror theming" },
      { name: "Rush",                        thrill:"🟠", height:"130cm", rating:3, mustRide:false, tip:"Giant swinging arm — great views, intense forces" },
      { name: "Detonator",                   thrill:"🟠", height:"120cm", rating:3, mustRide:false, tip:"Drop tower — short, sharp and terrifying" },
      { name: "Samurai",                     thrill:"🟠", height:"140cm", rating:3, mustRide:false, tip:"Top scan ride — disorientating and intense" },
      { name: "Storm Surge",                 thrill:"🟡", height:"100cm", rating:3, mustRide:false, tip:"Spinning water ride — expect to get completely soaked" },
      { name: "Tidal Wave",                  thrill:"🟡", height:"100cm", rating:3, mustRide:false, tip:"Massive water splash — the biggest soaking in the park" },
      { name: "Quantum",                     thrill:"🟡", height:"140cm", rating:3, mustRide:false, tip:"Pendulum ride with great views over the park" },
      { name: "Ghost Train",                 thrill:"🟡", height:"—",     rating:3, mustRide:false, tip:"Horror dark ride — not for the faint hearted" },
      { name: "Depth Charge",                thrill:"🟡", height:"—",     rating:3, mustRide:false, tip:"Fun water slide ride — a park classic" },
      { name: "Zodiac",                      thrill:"🟡", height:"120cm", rating:2, mustRide:false, tip:"Flat spinning ride" },
      { name: "Vortex",                      thrill:"🟡", height:"120cm", rating:2, mustRide:false, tip:"Suspended chairs swing out over the water" },
      { name: "Flying Fish",                 thrill:"🟢", height:"—",     rating:3, mustRide:false, tip:"Gentle family coaster — great for younger kids" },
      { name: "Mr Monkey's Banana Ride",     thrill:"🟢", height:"—",     rating:2, mustRide:false, tip:"Gentle family ride near Flying Fish" },
      { name: "Dobble Tea Party",            thrill:"🟢", height:"—",     rating:2, mustRide:false, tip:"Classic teacup spinning ride" },
      { name: "Big Easy Bumpers",            thrill:"🟢", height:"—",     rating:2, mustRide:false, tip:"Bumper cars for the whole family" },
    ],
  },
  {
    name: "Chessington World of Adventures",
    emoji: "🦁",
    openTime: "10:00",
    closeTime: "17:00",
    gradIdx: 3,
    queueTimesId: 3,
    rides: [
      { name: "Mandrill Mayhem",             thrill:"🔴", height:"130cm", rating:5, mustRide:true,  tip:"World's first Jumanji coaster — launches forwards AND backwards" },
      { name: "Vampire",                     thrill:"🟠", height:"120cm", rating:4, mustRide:true,  tip:"Classic Chessington icon — dangling feet, brilliant views" },
      { name: "Croc Drop",                   thrill:"🟠", height:"120cm", rating:4, mustRide:true,  tip:"Excellent drop tower with great Sobek theming" },
      { name: "Mamba Strike",                thrill:"🟠", height:"110cm", rating:3, mustRide:false, tip:"Jumanji spinning ride — fun and unpredictable" },
      { name: "Dragon's Fury",               thrill:"🟡", height:"110cm", rating:4, mustRide:false, tip:"Spinning coaster that's surprisingly intense" },
      { name: "Tiger Rock",                  thrill:"🟡", height:"100cm", rating:3, mustRide:false, tip:"Water rapids ride through the Land of the Tiger" },
      { name: "Tomb Blaster",                thrill:"🟡", height:"90cm",  rating:3, mustRide:false, tip:"Interactive shooting dark ride — compete with your group" },
      { name: "ZUFARI",                      thrill:"🟡", height:"—",     rating:3, mustRide:false, tip:"Safari truck tour past real animals" },
      { name: "River Rafts",                 thrill:"🟡", height:"—",     rating:3, mustRide:false, tip:"Rainforest river raft ride — expect to get wet" },
      { name: "Seastorm",                    thrill:"🟡", height:"100cm", rating:3, mustRide:false, tip:"Spinning ride in Shipwreck Shore" },
      { name: "Rattlesnake",                 thrill:"🟡", height:"—",     rating:3, mustRide:false, tip:"Classic mine train roller coaster in Mexicana" },
      { name: "Jungle Rangers",              thrill:"🟡", height:"—",     rating:3, mustRide:false, tip:"Jeep ride through the rainforest" },
      { name: "Ostrich Stampede",            thrill:"🟡", height:"100cm", rating:3, mustRide:false, tip:"Family coaster in World of Jumanji" },
      { name: "Barrel Bail Out!",            thrill:"🟡", height:"—",     rating:3, mustRide:false, tip:"Spinning barrel ride in Shipwreck Shore" },
      { name: "Tiny Truckers",               thrill:"🟡", height:"—",     rating:2, mustRide:false, tip:"Children's driving ride in Adventure Point" },
      { name: "Blue Barnacle",               thrill:"🟢", height:"90cm",  rating:3, mustRide:false, tip:"Family ship ride in Shipwreck Shore" },
      { name: "Chase's Mountain Mission",    thrill:"🟢", height:"90cm",  rating:3, mustRide:false, tip:"PAW Patrol roller coaster for young riders" },
      { name: "Skye's Helicopter Heroes",    thrill:"🟢", height:"90cm",  rating:3, mustRide:false, tip:"PAW Patrol helicopter ride" },
      { name: "Zuma's Hovercraft Adventure", thrill:"🟢", height:"—",     rating:3, mustRide:false, tip:"New PAW Patrol water ride" },
      { name: "Marshall's Firetruck Rescue", thrill:"🟢", height:"—",     rating:2, mustRide:false, tip:"PAW Patrol firetruck ride for little ones" },
      { name: "The Gruffalo River Ride Adventure", thrill:"🟢", height:"90cm", rating:3, mustRide:false, tip:"Lovely family boat ride through the Gruffalo story" },
      { name: "Room on the Broom - A Magical Journey", thrill:"🟢", height:"—", rating:3, mustRide:false, tip:"Gentle magical dark ride for young children" },
      { name: "Treetop Hoppers",             thrill:"🟢", height:"—",     rating:2, mustRide:false, tip:"Gentle family ride in the Rainforest" },
      { name: "Griffin's Galleon",           thrill:"🟢", height:"—",     rating:2, mustRide:false, tip:"Pirate ship for younger children" },
      { name: "Sea Dragons",                 thrill:"🟢", height:"—",     rating:2, mustRide:false, tip:"Gentle water ride in Land of the Dragons" },
      { name: "Canopy Capers",               thrill:"🟢", height:"—",     rating:2, mustRide:false, tip:"Aerial adventure in the tree canopy" },
    ],
  },
  {
    name: "Blackpool Pleasure Beach",
    emoji: "🎡",
    openTime: "11:00",
    closeTime: "21:00",
    gradIdx: 2,
    queueTimesId: 273,
    rides: [
      { name: "Big One",                     thrill:"🔴", height:"132cm", rating:4, mustRide:true,  tip:"235ft iconic skyline coaster — the Blackpool experience" },
      { name: "ICON",                        thrill:"🔴", height:"132cm", rating:5, mustRide:true,  tip:"UK's first double-launch — smooth, fast and rerideable" },
      { name: "Launch Pad",                  thrill:"🔴", height:"132cm", rating:4, mustRide:false, tip:"Redesigned drop/launch tower — intense forces" },
      { name: "Infusion",                    thrill:"🔴", height:"132cm", rating:3, mustRide:false, tip:"Inverted coaster over the lake — classic park icon" },
      { name: "Aviktas",                     thrill:"🔴", height:"132cm", rating:4, mustRide:false, tip:"Brand new 2025 thrill coaster" },
      { name: "Revolution",                  thrill:"🟠", height:"132cm", rating:3, mustRide:false, tip:"Vertical loop coaster — a Blackpool classic since 1979" },
      { name: "Grand National",              thrill:"🟠", height:"117cm", rating:4, mustRide:false, tip:"Racing wooden coaster since 1935 — a Blackpool legend" },
      { name: "Steeplechase",                thrill:"🟠", height:"122cm", rating:3, mustRide:false, tip:"Racing horse coaster — unique and fun" },
      { name: "Valhalla",                    thrill:"🟠", height:"132cm", rating:5, mustRide:true,  tip:"World's best water ride 7 times over — you WILL get soaked" },
      { name: "Avalanche",                   thrill:"🟠", height:"122cm", rating:3, mustRide:false, tip:"Bobsled coaster — fast and smooth" },
      { name: "Big Dipper",                  thrill:"🟠", height:"122cm", rating:3, mustRide:false, tip:"Classic wooden coaster — a British seaside icon" },
      { name: "Nickelodeon Streak",          thrill:"🟡", height:"117cm", rating:3, mustRide:false, tip:"Family wooden coaster in Nickelodeon Land" },
      { name: "Alice in Wonderland",         thrill:"🟡", height:"—",     rating:3, mustRide:false, tip:"Classic dark ride — a Blackpool institution" },
      { name: "Ghost Train",                 thrill:"🟡", height:"117cm", rating:3, mustRide:false, tip:"Seaside ghost train — brilliantly old school" },
      { name: "Wallace & Gromit's Thrill-o-Matic", thrill:"🟡", height:"117cm", rating:3, mustRide:false, tip:"Fun family dark ride with Wallace & Gromit" },
      { name: "Impossible",                  thrill:"🟡", height:"—",     rating:3, mustRide:false, tip:"Magic-themed thrill ride" },
      { name: "Pleasure Beach Express",      thrill:"🟡", height:"—",     rating:2, mustRide:false, tip:"Train tour around the park — great for a rest" },
      { name: "Derby Racer",                 thrill:"🟡", height:"—",     rating:2, mustRide:false, tip:"Classic carousel horses racing around the track" },
      { name: "Flying Machines",             thrill:"🟢", height:"—",     rating:2, mustRide:false, tip:"Classic flying machine chairs" },
      { name: "Avatar Airbender",            thrill:"🟢", height:"—",     rating:2, mustRide:false, tip:"Nickelodeon themed gentle ride" },
      { name: "Blue Flyer",                  thrill:"🟢", height:"—",     rating:2, mustRide:false, tip:"Junior coaster in Nickelodeon Land" },
      { name: "Rugrats Lost River",          thrill:"🟢", height:"—",     rating:2, mustRide:false, tip:"Gentle water ride for families" },
    ],
  },
  {
    name: "Paultons Park",
    emoji: "🌿",
    openTime: "10:00",
    closeTime: "17:00",
    gradIdx: 5,
    queueTimesId: 49,
    rides: [
      { name: "Drakon",                         thrill: "🔴", height: "130cm", rating: 5, mustRide: true,  tip: "Brand new 2026 inverting coaster — the park's most intense yet" },
      { name: "Storm Chaser",                   thrill: "🟠", height: "120cm", rating: 4, mustRide: true,  tip: "Exhilarating spinning ride in Tornado Springs — a real crowd pleaser" },
      { name: "Edge",                           thrill: "🟠", height: "130cm", rating: 3, mustRide: false, tip: "Swings you out over the park — great views" },
      { name: "Storm Surge",                    thrill: "🟠", height: "110cm", rating: 4, mustRide: true,  tip: "Brilliant water ride — you WILL get wet" },
      { name: "Magma",                          thrill: "🟠", height: "110cm", rating: 3, mustRide: false, tip: "High-speed water ride with a big final drop" },
      { name: "Cyclonator",                     thrill: "🟡", height: "110cm", rating: 3, mustRide: false, tip: "Spinning pendulum ride — surprisingly intense" },
      { name: "Ghostly Manor",                  thrill: "🟡", height: "—",     rating: 4, mustRide: true,  tip: "New 2025 dark ride — spooky fun for all the family" },
      { name: "Flight of the Pterosaur",        thrill: "🟡", height: "105cm", rating: 3, mustRide: false, tip: "Soar above Lost Kingdom on this suspended coaster" },
      { name: "Splash Lagoon",                  thrill: "🟡", height: "90cm",  rating: 3, mustRide: false, tip: "Family flume in Lost Kingdom" },
      { name: "Cobra",                          thrill: "🟡", height: "100cm", rating: 3, mustRide: false, tip: "Fun family coaster with good turns" },
      { name: "Pirate Ship",                    thrill: "🟡", height: "100cm", rating: 3, mustRide: false, tip: "Classic swinging ship — great for families" },
      { name: "Sky Swinger",                    thrill: "🟡", height: "100cm", rating: 3, mustRide: false, tip: "Swing high above the park" },
      { name: "Farmyard Flyer",                 thrill: "🟡", height: "90cm",  rating: 3, mustRide: false, tip: "Fun mini coaster in Tornado Springs" },
      { name: "Viking Boats",                   thrill: "🟢", height: "—",     rating: 3, mustRide: false, tip: "Splashy water ride for all ages" },
      { name: "Cat-O-Pillar Coaster",           thrill: "🟢", height: "—",     rating: 3, mustRide: false, tip: "Gentle starter coaster for little ones" },
      { name: "Peppa Pig's Big Balloon Ride",   thrill: "🟢", height: "—",     rating: 3, mustRide: false, tip: "The iconic Peppa Pig World balloon ride" },
      { name: "Daddy Pig's Car Boot",           thrill: "🟢", height: "—",     rating: 3, mustRide: false, tip: "Drive through Peppa Pig World" },
      { name: "George's Dinosaur Adventure",    thrill: "🟢", height: "—",     rating: 3, mustRide: false, tip: "Little ones love the dinosaur theming" },
      { name: "Tea Cup Ride",                   thrill: "🟢", height: "—",     rating: 3, mustRide: false, tip: "Classic spinning teacups — always popular" },
      { name: "Victorian Carousel",             thrill: "🟢", height: "—",     rating: 3, mustRide: false, tip: "Beautiful Victorian carousel" },
    ],
  },
  {
    name: "Drayton Manor",
    emoji: "🌊",
    openTime: "10:00",
    closeTime: "17:00",
    gradIdx: 4,
    queueTimesId: null, // not in queue-times.com
    rides: [
      { name: "Apocalypse",                         thrill: "🔴", height: "140cm", rating: 5, mustRide: true,  tip: "UK's tallest standalone drop tower — 54m of pure terror" },
      { name: "Shockwave",                          thrill: "🔴", height: "140cm", rating: 4, mustRide: true,  tip: "Europe's only stand-up coaster — a completely unique experience" },
      { name: "Gold Rush",                          thrill: "🟠", height: "120cm", rating: 4, mustRide: true,  tip: "Best ride in the park — smooth launch coaster, great for families" },
      { name: "Maelstrom",                          thrill: "🟠", height: "120cm", rating: 4, mustRide: false, tip: "Spinning coaster that gets surprisingly intense" },
      { name: "Thor",                               thrill: "🟠", height: "120cm", rating: 3, mustRide: false, tip: "Disk'o coaster in the Vikings area — good fun" },
      { name: "Loki",                               thrill: "🟠", height: "120cm", rating: 3, mustRide: false, tip: "Air Race ride with great Viking theming" },
      { name: "Sleipnir",                           thrill: "🟠", height: "110cm", rating: 3, mustRide: false, tip: "Viking power surge — fast and fun" },
      { name: "Accelerator",                        thrill: "🟠", height: "100cm", rating: 3, mustRide: false, tip: "Family boomerang coaster that goes backwards" },
      { name: "Air Race",                           thrill: "🟠", height: "130cm", rating: 3, mustRide: false, tip: "Fly like a plane — surprisingly thrilling" },
      { name: "Stormforce 10",                      thrill: "🟡", height: "100cm", rating: 4, mustRide: true,  tip: "Massive 30ft drop water ride — prepare to get soaked" },
      { name: "Flying Dutchman",                    thrill: "🟡", height: "—",     rating: 3, mustRide: false, tip: "Classic family ghost ship ride" },
      { name: "Bounty Pirate Ship",                 thrill: "🟡", height: "100cm", rating: 3, mustRide: false, tip: "Classic swinging ship — great for families" },
      { name: "Wave Swinger",                       thrill: "🟡", height: "120cm", rating: 3, mustRide: false, tip: "Swinging chairs with great views" },
      { name: "Troublesome Trucks Runaway Coaster", thrill: "🟢", height: "90cm",  rating: 3, mustRide: false, tip: "Thomas Land's best coaster for young thrill-seekers" },
      { name: "Thomas & Percy's Submarine Splash",  thrill: "🟢", height: "—",     rating: 3, mustRide: false, tip: "New water ride in Thomas Land — very popular with kids" },
      { name: "James and the Red Balloon",          thrill: "🟢", height: "—",     rating: 3, mustRide: false, tip: "Gentle balloon ride — a Thomas Land classic" },
      { name: "Harold's Helicopter Tours",          thrill: "🟢", height: "—",     rating: 3, mustRide: false, tip: "Helicopter ride for little ones" },
      { name: "Jeremy Jet's Flying Academy",        thrill: "🟢", height: "—",     rating: 3, mustRide: false, tip: "Up-down ride perfect for toddlers" },
    ],
  },

];


// ─── Preloaded park dining ────────────────────────────────────────────────────
const PARK_DINING = {
  "Alton Towers": {
    restaurants: [
      { name: "Rollercoaster Restaurant", type: "🍽 Restaurant", desc: "Food delivered via rollercoaster tracks — a must-visit experience", location: "Forbidden Valley", tip: "Book in advance, especially evenings", bookable: true },
      { name: "Explorer's Pizza & Pasta Buffet", type: "🍕 Buffet", desc: "Unlimited pizza, pasta and salad — great value for families", location: "Katanga Canyon", tip: "Go early to avoid queues at peak times", bookable: false },
      { name: "Just Chicken", type: "🍗 Fast Food", desc: "Crispy chicken meals, burgers and fries in the Oblivion-themed restaurant", location: "X Sector", tip: "One of the better value quick-service spots", bookable: false },
      { name: "Burger Kitchen", type: "🍔 Fast Food", desc: "Classic burgers, loaded fries and soft drinks", location: "Towers Street", tip: "Gets busy 12–2pm, try before or after the rush", bookable: false },
      { name: "Ground Command Coffee", type: "☕ Café", desc: "Sandwiches, pastries, cakes and handcrafted coffee", location: "Forbidden Valley", tip: "Great mid-morning pit stop before the queue builds", bookable: false },
      { name: "Corner Coffee", type: "☕ Café", desc: "Coffee, cakes and sandwiches on Towers Street", location: "Towers Street", tip: "Good for a quick breakfast on arrival", bookable: false },
    ],
    snacks: [
      { name: "Towers Street Donuts", emoji: "🍩", desc: "Fresh hot donuts with glazes and toppings — a park classic" },
      { name: "Heat Generator Co.", emoji: "🌶", desc: "Spicy chicken and loaded fries — great for a quick bite" },
      { name: "Coach House Confectioneers", emoji: "🍦", desc: "Ice creams, frozen treats and sweets near the entrance" },
      { name: "Churros Cart", emoji: "🥐", desc: "Cinnamon churros found near the main areas throughout the day" },
      { name: "Popcorn Kiosks", emoji: "🍿", desc: "Salted and sweet popcorn available at multiple points around the park" },
    ],
    tips: ["Bring a refillable water bottle — free water points are dotted around", "Pre-book the Rollercoaster Restaurant to guarantee a table", "Dining plans available if staying on-site — good value"],
  },
  "Thorpe Park": {
    restaurants: [
      { name: "Pizza & Pasta Buffet", type: "🍕 Buffet", desc: "Unlimited pizza and pasta near Amity Beach — best value in the park", location: "Amity Beach", tip: "Book online to save — walk-in adds a couple of pounds", bookable: true },
      { name: "Burger King", type: "🍔 Fast Food", desc: "Classic BK menu with indoor seating — two locations in the park", location: "Big Easy Boulevard / Amity", tip: "Quickest option during peak lunch hours", bookable: false },
      { name: "KFC", type: "🍗 Fast Food", desc: "Full KFC menu with indoor seating near Stealth", location: "Amity", tip: "Often has shorter queues than Burger King", bookable: false },
      { name: "Amity Fish & Chips", type: "🐟 British", desc: "Classic fish and chips with indoor seating next to Stealth", location: "Amity", tip: "Proper sit-down option — good for a mid-day break", bookable: false },
      { name: "Jungle BBQ Bar & Grill", type: "🥩 BBQ", desc: "Char-grilled ribs, burgers, salads and jacket potatoes", location: "Jungle", tip: "One of the better quality sit-down meals in the park", bookable: false },
      { name: "Cadbury Chocolate Lodge", type: "☕ Café", desc: "Hot chocolates, iced coffee and Cadbury snacks", location: "Nemesis Inferno area", tip: "Perfect afternoon treat after a morning of rides", bookable: false },
    ],
    snacks: [
      { name: "Donut Factory", emoji: "🍩", desc: "Fresh hot donuts and specialty donuts throughout the day" },
      { name: "Churros Cart", emoji: "🥐", desc: "Warm cinnamon churros — a Thorpe Park staple" },
      { name: "Popcorn & Slushies", emoji: "🍿", desc: "Colourful slushies and popcorn from carts across the park" },
      { name: "Candypips Pick & Mix", emoji: "🍬", desc: "Giant pick and mix selection — kids love it" },
      { name: "Ice Cream Kiosks", emoji: "🍦", desc: "Soft serve and ice cream bars near Colossus and Hyperia" },
    ],
    tips: ["Refillable drink cups are great value if you're staying all day", "Buy pizza buffet online in advance — saves money and queue time", "Boulevard Bites does loaded hot dogs if you want something quick"],
  },
  "Chessington World of Adventures": {
    restaurants: [
      { name: "Wild Asia BBQ", type: "🥩 BBQ", desc: "12-hour smoked meats — pulled pork, beef brisket, ribs. One of the best in any UK park", location: "Wild Asia", tip: "Go at 12 before the lunchtime queue builds", bookable: false },
      { name: "Pirates Pizza & Pasta", type: "🍕 Italian", desc: "Fresh pizza and pasta with a drink meal deal", location: "Pirate Cove", tip: "Good value with the meal deal — works for families", bookable: false },
      { name: "Harbourside Burger Bar", type: "🍔 Fast Food", desc: "Burgers and kids' meals in a nautical setting", location: "Shipwreck Coast", tip: "Decent kids' meals if you have little ones", bookable: false },
      { name: "Shipwreck Coast Fish & Chips", type: "🐟 British", desc: "Freshly cooked cod and chips — great seaside feel", location: "Shipwreck Coast", tip: "Try the mushy peas — underrated", bookable: false },
      { name: "Costa Coffee", type: "☕ Café", desc: "Full Costa menu with cakes, muffins and sandwiches", location: "Multiple locations", tip: "Two locations in the park — good for a morning kick", bookable: false },
    ],
    snacks: [
      { name: "Hot Dog Stand", emoji: "🌭", desc: "Build your own hot dog with a great range of toppings" },
      { name: "Sweet Treat Kiosks", emoji: "🍭", desc: "Candyfloss, toffee apples and pick-and-mix throughout the park" },
      { name: "Ice Cream Parlour", emoji: "🍦", desc: "Soft serve and premium scoops near the main plaza" },
      { name: "Churros", emoji: "🥐", desc: "Cinnamon dusted churros at the main snack carts" },
      { name: "Popcorn & Frozen Drinks", emoji: "🍿", desc: "Slushies and popcorn available near the main ride areas" },
    ],
    tips: ["Wild Asia BBQ is genuinely excellent — don't skip it", "Costa is dotted around — handy for parents who need a coffee fix", "Bring your own packed lunch — there are picnic areas near the entrance"],
  },
  "Blackpool Pleasure Beach": {
    restaurants: [
      { name: "Ice Cream Parlour", type: "🍦 Desserts", desc: "Classic seaside ice creams and sundaes — a Pleasure Beach tradition", location: "Main boulevard", tip: "Get a 99 Flake on a sunny day — it's obligatory", bookable: false },
      { name: "Mr. Ripley's Diner", type: "🍔 American", desc: "American-style diner with burgers, hot dogs and milkshakes", location: "Central park", tip: "Great atmosphere, worth a sit-down visit", bookable: false },
      { name: "Fish & Chip Shop", type: "🐟 British", desc: "Traditional seaside fish and chips — Blackpool at its best", location: "Seafront end", tip: "The proper British theme park experience", bookable: false },
      { name: "Burger Bar", type: "🍔 Fast Food", desc: "Quick-service burgers and fries for a fast refuel", location: "Various", tip: "Multiple locations — easy to find near most coasters", bookable: false },
      { name: "The Sports Bar & Grill", type: "🍺 Bar & Grill", desc: "Sit-down meals with drinks — good for adults after the rides", location: "Central", tip: "Good for groups who want a proper sit-down meal", bookable: false },
    ],
    snacks: [
      { name: "Rock & Candy Stalls", emoji: "🍬", desc: "Traditional Blackpool rock and seaside sweets — iconic" },
      { name: "Toffee Apples", emoji: "🍎", desc: "Classic fairground toffee apples throughout the park" },
      { name: "Candyfloss", emoji: "🍭", desc: "Pink clouds of candyfloss — a seaside staple" },
      { name: "Hot Donuts", emoji: "🍩", desc: "Fresh donuts from the carts near the entrance" },
      { name: "Churros & Crepes", emoji: "🥐", desc: "Warm churros and sweet crepes at the snack stands" },
    ],
    tips: ["Blackpool town centre is right next to the park — tons of fish & chip shops outside", "The park is close to the Pleasure Beach South Shore beach — great for picnics", "Bring cash for some of the smaller snack stalls"],
  },
  "Paultons Park": {
    restaurants: [
      { name: "The Pavilion Restaurant", type: "🍽 Restaurant", desc: "Sit-down family meals with a good range of hot food", location: "Central park", tip: "The best sit-down option — book a table for busy days", bookable: true },
      { name: "Peppa Pig World Diner", type: "🐷 Kids", desc: "Peppa-themed kids' meals and light bites — kids absolutely love it", location: "Peppa Pig World", tip: "Go early for lunch — fills up fast with families", bookable: false },
      { name: "Storm Surge Café", type: "☕ Café", desc: "Sandwiches, paninis and hot drinks near the water rides", location: "Storm area", tip: "Handy after getting soaked on Storm Surge", bookable: false },
      { name: "Pizza & Pasta Bar", type: "🍕 Italian", desc: "Affordable pizzas and pasta dishes for the whole family", location: "Central", tip: "Good value especially with kids — big portions", bookable: false },
    ],
    snacks: [
      { name: "Peppa Pig Ice Cream", emoji: "🍦", desc: "Peppa-themed ice lollies and soft serve — the kids will demand one" },
      { name: "Churros Stand", emoji: "🥐", desc: "Cinnamon churros near the main plaza" },
      { name: "Popcorn & Slushies", emoji: "🍿", desc: "Classic fairground treats throughout the park" },
      { name: "Sweet Shop", emoji: "🍬", desc: "Pick and mix and sweets near the main entrance" },
    ],
    tips: ["Great picnic facilities — one of the most family-friendly parks for packed lunches", "Peppa Pig World Diner is tiny — get there well before noon", "The park is smaller so food outlets are never too far away"],
  },
  "Drayton Manor": {
    restaurants: [
      { name: "The Manor Restaurant", type: "🍽 Restaurant", desc: "Main sit-down restaurant with hot meals and family favourites", location: "Central park", tip: "The only proper sit-down option — can get busy at peak times", bookable: false },
      { name: "Burger Bar", type: "🍔 Fast Food", desc: "Classic burgers, chicken and fries — quick and reliable", location: "Various", tip: "Multiple locations — easiest option for a quick refuel", bookable: false },
      { name: "Pizza Station", type: "🍕 Italian", desc: "Pizza slices and pasta — good for the kids", location: "Central", tip: "Often quicker than the burger bar at peak times", bookable: false },
      { name: "Coffee & Snacks Kiosk", type: "☕ Café", desc: "Hot drinks, cakes and light snacks throughout the day", location: "Various", tip: "Good for a mid-morning coffee and cake break", bookable: false },
    ],
    snacks: [
      { name: "Candyfloss & Rock", emoji: "🍭", desc: "Traditional fairground sweets near the main entrance" },
      { name: "Ice Cream Van", emoji: "🍦", desc: "Soft serve ice creams roving around the park" },
      { name: "Churros Stand", emoji: "🥐", desc: "Warm churros available at the main snack areas" },
      { name: "Popcorn Cart", emoji: "🍿", desc: "Salted and sweet popcorn near the main attractions" },
    ],
    tips: ["Smaller park so food outlets are all fairly central", "The manor grounds have decent picnic spots if you want to bring your own food", "Book the main restaurant for groups — limited seating at busy times"],
  },
};


// ─── Park travel & route data ─────────────────────────────────────────────────
const PARK_TRAVEL = {
  "Alton Towers": {
    postcode: "ST10 4DB",
    ticketUrl: "https://www.altontowers.com/tickets-passes/day-passes/",
    fastPassUrl: "https://www.altontowers.com/tickets-passes/extras/fastrack/",
    fastPassName: "Fastrack",
    fastPassNote: "Packages available online in advance. One Shot tickets via the AT app on the day. Book early — sells out on busy days.",
        fastPassUrl: "https://www.thorpepark.com/tickets-passes/extras/fastrack/",
    fastPassName: "Fastrack",
    fastPassNote: "From £6 per ride via the Thorpe Park app or QR codes at ride entrances. Sold on a limited basis.",
        fastPassUrl: "https://www.chessington.com/tickets-passes/extras/reserve-and-ride/",
    fastPassName: "Reserve & Ride",
    fastPassNote: "Virtual queuing — reserve your slot on the app then explore freely. Free with Annual Pass (10% off for passholders).",
        fastPassUrl: "https://www.blackpoolpleasurebeach.com/speedy-pass-virtual-queuing/",
    fastPassName: "Speedy Pass",
    fastPassNote: "VIP Speedy Pass reduces wait times by up to 90%. Book in advance online for best price.",
        fastPassUrl: null,
    fastPassName: null,
    fastPassNote: "Paultons Park doesn\'t offer a paid fast pass — queues are generally shorter than larger parks.",
        fastPassUrl: "https://www.draytonmanor.co.uk/tickets/fast-pass/",
    fastPassName: "Easy Pass",
    fastPassNote: "Fast Pass & Easy Pass available on selected rides. Buy at the park or book online.",
        parkingBookUrl: "https://www.altontowers.com/plan-your-visit/before-you-visit/car-parking/",
    address: "Alton Towers Resort, Farley Lane, Alton, Staffordshire, ST10 4DB",
    mapsQuery: "Alton+Towers+Resort+ST10+4DB",
    appleMapsQuery: "Alton Towers Resort, Staffordshire",
    parking: {
      standard: "£12 per car (pre-book on app to save)",
      express: "£20 per car — 1–3 min walk to entrance",
      tip: "Express sells out fast — book well in advance. Standard is 15–25 min walk or take the free monorail",
    },
    byTrain: {
      station: "Uttoxeter",
      detail: "10 miles away — then X41 bus direct to the park (30 min). Stoke-on-Trent also works — 15 miles, taxi ~25 min",
      trainLink: "https://www.thetrainline.com",
    },
    byRoad: {
      detail: "M1 J23a (northbound) or J28 (southbound). M6 J15 (northbound) or J16 (southbound). Follow brown tourist signs",
      warning: "Avoid Wootton Lane on sat-nav — it's a single-track road. Arrive by 9:15am to beat traffic",
    },
    byBus: {
      detail: "National Express coaches from London, Birmingham and Manchester direct to the park",
    },
    arrivalTip: "Arrive 30 min before opening. Traffic builds sharply after 9:30am on busy days",
    ulez: false,
  },
  "Thorpe Park": {
    postcode: "KT16 8PN",
    ticketUrl: "https://www.thorpepark.com/tickets-passes/day-tickets/",
    parkingBookUrl: "https://www.thorpepark.com/tickets-passes/extras/parking/",
    address: "Thorpe Park Resort, Staines Road, Chertsey, Surrey, KT16 8PN",
    mapsQuery: "Thorpe+Park+Resort+KT16+8PN",
    appleMapsQuery: "Thorpe Park Resort, Chertsey, Surrey",
    parking: {
      standard: "£12 per car (pre-book online)",
      express: "£20 per car — priority parking near entrance",
      tip: "Pre-book online to guarantee a space. Park fills up fast on sunny weekends",
    },
    byTrain: {
      station: "Staines",
      detail: "950 Express Bus runs direct from Staines station every 15–20 min when park is open. ~30–50 min from London Waterloo",
      trainLink: "https://www.southwesternrailway.com",
    },
    byRoad: {
      detail: "M25 J11 or J13, then follow A320 directly to the park. Well signposted",
      warning: "Sat-nav postcode KT16 8PN may route via Norlands Lane — look for the coaster track over Staines Road",
    },
    byBus: {
      detail: "950 Express Bus from Staines train and bus stations. Also 446 from Chertsey station",
    },
    arrivalTip: "20 miles from central London — aim to arrive at opening time to beat the M25",
    ulez: false,
  },
  "Chessington World of Adventures": {
    postcode: "KT9 2NE",
    ticketUrl: "https://www.chessington.com/tickets-passes/day-tickets/",
    parkingBookUrl: "https://www.chessington.com/tickets-passes/extras/parking/",
    address: "Chessington World of Adventures Resort, Leatherhead Road, Chessington, Surrey, KT9 2NE",
    mapsQuery: "Chessington+World+of+Adventures+KT9+2NE",
    appleMapsQuery: "Chessington World of Adventures, Surrey",
    parking: {
      standard: "£9 pre-booked / £12 on the day",
      express: "£15 per car — right next to Lodge Gate entrance",
      tip: "⚠️ ULEZ zone — check your vehicle before visiting. Pre-book to save £3",
    },
    byTrain: {
      station: "Chessington South",
      detail: "Just 10–12 min walk from the station. South Western Railway from London Waterloo via Wimbledon. ~35 min from central London. Zone 6 — Oyster accepted",
      trainLink: "https://www.southwesternrailway.com",
    },
    byRoad: {
      detail: "M25 J9 (from south) or J10 (from north), then A243. 2 miles from the M25. From London take A3 to Hook, signposted on A243",
      warning: "Within ULEZ — check your vehicle is compliant before driving in",
    },
    byBus: {
      detail: "Bus 71 from Kingston, Bus 465 or 467 from Epsom. Stop within 150m of entrance",
    },
    arrivalTip: "One of the easiest parks to reach by train — great option to avoid parking costs",
    ulez: true,
  },
  "Blackpool Pleasure Beach": {
    postcode: "FY4 1EZ",
    ticketUrl: "https://www.blackpoolpleasurebeach.com/tickets/",
    parkingBookUrl: "https://www.blackpoolpleasurebeach.com/getting-here-parking/",
    address: "Pleasure Beach Resort, Ocean Boulevard, Blackpool, FY4 1EZ",
    mapsQuery: "Blackpool+Pleasure+Beach+FY4+1EZ",
    appleMapsQuery: "Blackpool Pleasure Beach, Ocean Boulevard, Blackpool",
    parking: {
      standard: "3 on-site car parks — from £9/day",
      express: "Limited spaces near entrance",
      tip: "Street parking available nearby from £2. Blackpool has lots of parking options — arrive early for best spots",
    },
    byTrain: {
      station: "Blackpool Pleasure Beach",
      detail: "The park has its own mainline station — direct trains from Preston. Also Blackpool North for connections from Manchester and beyond",
      trainLink: "https://www.northernrailway.co.uk",
    },
    byRoad: {
      detail: "M6 J32 onto the M55. Follow signs for Blackpool South Shore (via Blackpool Airport) then brown tourist signs",
      warning: "Blackpool seafront can get congested on peak summer days — allow extra time",
    },
    byBus: {
      detail: "Tram stop right outside the entrance on the Blackpool Tramway. Excellent tram links along the promenade",
    },
    arrivalTip: "The park has its own train station — the easiest UK park to reach by rail",
    ulez: false,
  },
  "Paultons Park": {
    postcode: "SO51 6AL",
    ticketUrl: "https://www.paultonspark.co.uk/plan-your-visit/tickets/",
    parkingBookUrl: null, // Free parking, no pre-booking needed
    address: "Paultons Park, Ower, Romsey, Hampshire, SO51 6AL",
    mapsQuery: "Paultons+Park+SO51+6AL",
    appleMapsQuery: "Paultons Park, Romsey, Hampshire",
    parking: {
      standard: "Free on-site parking",
      express: "Free — included with entry",
      tip: "Free parking is a real bonus — no need to pre-book. Arrive early for best spaces near the entrance",
    },
    byTrain: {
      station: "Southampton Central",
      detail: "~8 miles from the park. Taxi from Southampton Central takes ~20 min. No direct bus service to the park",
      trainLink: "https://www.southwesternrailway.com",
    },
    byRoad: {
      detail: "M27 J2 — the park is directly off the motorway, clearly signposted. Very easy to find",
      warning: "No direct public transport — car is by far the easiest option for this park",
    },
    byBus: {
      detail: "Limited public transport — taxi from Southampton or Romsey is the best non-car option",
    },
    arrivalTip: "Free parking and right off the M27 — one of the easiest parks to drive to",
    ulez: false,
  },
  "Drayton Manor": {
    postcode: "B78 3TW",
    ticketUrl: "https://www.draytonmanor.co.uk/plan-your-visit/tickets/",
    parkingBookUrl: null, // Free parking, no pre-booking needed
    address: "Drayton Manor Theme Park, Drayton Manor Drive, Tamworth, Staffordshire, B78 3TW",
    mapsQuery: "Drayton+Manor+Theme+Park+B78+3TW",
    appleMapsQuery: "Drayton Manor Theme Park, Tamworth",
    parking: {
      standard: "Free on-site parking",
      express: "Free — included with entry",
      tip: "Free parking included — a real bonus for families. Large car park right next to the entrance",
    },
    byTrain: {
      station: "Tamworth",
      detail: "~2 miles from the park. Taxi takes about 10 min. Regular services from Birmingham New Street (~20 min)",
      trainLink: "https://www.crosscountrytrains.co.uk",
    },
    byRoad: {
      detail: "M42 J9 or J10 — well signposted. Also accessible from A4091. Centrally located in the Midlands",
      warning: "Can get congested on school holiday peak days — arrive early",
    },
    byBus: {
      detail: "Bus 110 from Tamworth town centre runs near the park entrance",
    },
    arrivalTip: "Central Midlands location — easily reachable from Birmingham, Coventry and Derby in under an hour",
    ulez: false,
  },
};

function getParkTravel(parkName) {
  return PARK_TRAVEL[parkName] || null;
}

function getParkDining(parkName) {
  return PARK_DINING[parkName] || null;
}

const THRILL_LABEL  = { "🔴": "Extreme", "🟠": "Thrilling", "🟡": "Moderate", "🟢": "Family" };
const GRADIENTS     = [
  ["#FF6B6B","#FFD93D"], ["#4D96FF","#C77DFF"], ["#6BCB77","#4D96FF"],
  ["#FF9A3C","#FF6B6B"], ["#C77DFF","#FF6B6B"], ["#00B4DB","#0083B0"],
];
const EMOJIS = ["🏰","🎡","🎢","🌋","🦁","🐉","🚀","⚡","🌊","🎪","🦕","🌈","🦩","🌿","🐯"];
const CATEGORIES = [
  { key:"rides",     icon:"🎢", label:"Rides",    color:"#5B8BF5", bg:"#EEF2FF" },
  { key:"itinerary", icon:"📅", label:"Schedule", color:"#27AE60", bg:"#EAFAF1" },
  { key:"dining",    icon:"🍽", label:"Dining",   color:"#F5922E", bg:"#FFF3E8" },
  { key:"budget",    icon:"💰", label:"Budget",   color:"#E8445A", bg:"#FFECEF" },
  { key:"packing",   icon:"🎒", label:"Packing",  color:"#00B4DB", bg:"#E0F7FF" },
  { key:"notes",     icon:"📓", label:"Notes",    color:"#9B59B6", bg:"#F5EEFF" },
  { key:"travel",    icon:"🗺️", label:"Getting There",     color:"#00B4DB", bg:"#E0F7FF" },
  { key:"booking",   icon:"🎟", label:"Tickets & Booking",  color:"#F5922E", bg:"#FFF3E8" },
  { key:"visitinfo", icon:"📊", label:"Visit Info",           color:"#9B59B6", bg:"#F5EEFF" },
  { key:"summary",   icon:"📋", label:"Summary",              color:"#27AE60", bg:"#EAFAF1" },
];

// Default packing categories pre-loaded for theme park visits
const DEFAULT_PACKING = [
  { id:"p1",  category:"Essentials", name:"Tickets / passes", checked:false },
  { id:"p2",  category:"Essentials", name:"Photo ID", checked:false },
  { id:"p3",  category:"Essentials", name:"Cash & cards", checked:false },
  { id:"p4",  category:"Essentials", name:"Phone & charger", checked:false },
  { id:"p5",  category:"Essentials", name:"Car keys", checked:false },
  { id:"p6",  category:"Clothing",   name:"Comfortable shoes", checked:false },
  { id:"p7",  category:"Clothing",   name:"Change of clothes", checked:false },
  { id:"p8",  category:"Clothing",   name:"Waterproof jacket", checked:false },
  { id:"p9",  category:"Clothing",   name:"Sunglasses", checked:false },
  { id:"p10", category:"Clothing",   name:"Sun hat / cap", checked:false },
  { id:"p11", category:"Health",     name:"Suncream", checked:false },
  { id:"p12", category:"Health",     name:"Painkillers", checked:false },
  { id:"p13", category:"Health",     name:"Plasters", checked:false },
  { id:"p14", category:"Health",     name:"Hand sanitiser", checked:false },
  { id:"p15", category:"Food & Drink", name:"Water bottle", checked:false },
  { id:"p16", category:"Food & Drink", name:"Snacks", checked:false },
  { id:"p17", category:"Kids",       name:"Nappies / wipes", checked:false },
  { id:"p18", category:"Kids",       name:"Pushchair / carrier", checked:false },
  { id:"p19", category:"Kids",       name:"Kids' snacks", checked:false },
  { id:"p20", category:"Kids",       name:"Entertainment for queues", checked:false },
];
const RIDE_STATUS = {
  open:     { label:"Open",     color:"#27AE60", bg:"#EAFAF1", dot:"🟢" },
  busy:     { label:"Busy",     color:"#F5922E", bg:"#FFF3E8", dot:"🟡" },
  closed:   { label:"Closed",   color:"#E8445A", bg:"#FFECEF", dot:"🔴" },
  fastpass: { label:"FastPass", color:"#5B8BF5", bg:"#EEF2FF", dot:"⚡" },
};
const ITEM_TYPES = {
  ride:  { icon:"🎢", color:"#5B8BF5" },
  food:  { icon:"🍔", color:"#F5922E" },
  show:  { icon:"🎭", color:"#9B59B6" },
  break: { icon:"☕", color:"#27AE60" },
  photo: { icon:"📸", color:"#E8445A" },
  other: { icon:"📌", color:"#8E8E93" },
};
const QUEUE_REFRESH_MS = 5 * 60 * 1000; // 5 minutes


function isParkOpen(openTime, closeTime) {
  if (!openTime || !closeTime) return null; // unknown
  const now = new Date();
  const [oh, om] = openTime.split(":").map(Number);
  const [ch, cm] = closeTime.split(":").map(Number);
  const nowMins  = now.getHours() * 60 + now.getMinutes();
  const openMins = oh * 60 + om;
  const closeMins = ch * 60 + cm;
  return nowMins >= openMins && nowMins < closeMins;
}

function uid()    { return Math.random().toString(36).slice(2,9); }
function fmtDate(d) {
  if (!d) return "";
  return new Date(d).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"});
}
function blankData() {
  return { rides:[], itinerary:[], dining:[], budget:{ total:"", items:[] }, notes:"", packing: DEFAULT_PACKING.map(i=>({...i})), booking:{ ticketsBooked:false, parkingBooked:false, fastPassBooked:false, merlinPassHolder:false, merlinPreBooked:false } };
}

// Fuzzy match ride name from API to preloaded ride
function fuzzyMatch(apiName, localName) {
  // Strip to lowercase alphanumeric only — handles apostrophes, hyphens, © etc
  const norm  = s => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  // Also keep word-level comparison before stripping
  const words = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim().split(/\s+/);

  const a = norm(apiName),  b = norm(localName);
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;

  // Word-level overlap on original spacing
  const wa = words(apiName), wb = words(localName);
  const significant = w => w.length > 3;
  const sigA = wa.filter(significant);
  const sigB = wb.filter(significant);
  if (sigA.length === 0 || sigB.length === 0) return false;
  const overlap = sigA.filter(w => sigB.includes(w));
  // Need majority overlap (>50% of shorter list matches)
  const threshold = Math.min(sigA.length, sigB.length);
  return overlap.length >= Math.max(1, Math.ceil(threshold * 0.6));
}




// ─── Crowd calendar ──────────────────────────────────────────────────────────
// Busyness scores 0-100 based on historical patterns
// weekday[0=Mon..6=Sun], schoolHols boost, bankHoliday boost
const CROWD_CALENDAR = {
  // Base weekday scores (term time)
  weekdayBase: [35, 35, 38, 42, 55, 85, 80], // Mon-Sun
  // School holiday multiplier (England)
  schoolHolMultiplier: 1.5,
  // UK school holiday periods (approximate, England)
  schoolHols: [
    { name: "Easter", start: "04-05", end: "04-22" },
    { name: "May Half Term", start: "05-22", end: "06-01" },
    { name: "Summer", start: "07-19", end: "09-03" },
    { name: "October Half Term", start: "10-25", end: "11-02" },
    { name: "Christmas", start: "12-20", end: "01-05" },
    { name: "Feb Half Term", start: "02-15", end: "02-23" },
  ],
  // UK Bank holidays 2025-2026
  bankHolidays: [
    "2025-08-25","2025-12-25","2025-12-26",
    "2026-01-01","2026-04-03","2026-04-06","2026-05-04","2026-05-25","2026-08-31",
  ],
};

function getCrowdScore(dateStr) {
  if (!dateStr) return null;
  const date = new Date(dateStr);
  const dayOfWeek = date.getDay(); // 0=Sun..6=Sat → remap to Mon=0
  const monFirst = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  let score = CROWD_CALENDAR.weekdayBase[monFirst];

  // Check school hols (month-day format)
  const md = dateStr.slice(5); // "MM-DD"
  const isSchoolHol = CROWD_CALENDAR.schoolHols.some(h => {
    if (h.start <= h.end) return md >= h.start && md <= h.end;
    return md >= h.start || md <= h.end; // wrap around year
  });
  if (isSchoolHol) score = Math.min(100, Math.round(score * CROWD_CALENDAR.schoolHolMultiplier));

  // Bank holidays
  if (CROWD_CALENDAR.bankHolidays.includes(dateStr)) score = Math.min(100, score + 20);

  return Math.min(100, score);
}

function getCrowdLabel(score) {
  if (score === null) return null;
  if (score <= 30) return { label: "Very Quiet", color: "#27AE60", emoji: "😊", tip: "Great day to visit — short queues expected" };
  if (score <= 50) return { label: "Moderate",   color: "#F5922E", emoji: "🙂", tip: "Reasonable queues — most rides 15–30 min" };
  if (score <= 70) return { label: "Busy",        color: "#E8445A", emoji: "😬", tip: "Popular day — arrive early and use FastPass" };
  if (score <= 85) return { label: "Very Busy",   color: "#E8445A", emoji: "😰", tip: "School holidays or weekend — expect 45–90 min queues on top rides" };
  return               { label: "Peak Day",       color: "#c0392b", emoji: "🔥", tip: "Extremely busy — FastPass strongly recommended" };
}

// ─── Park zone / area data for route optimisation ────────────────────────────
// Zones are ordered by recommended walking route to minimise backtracking
const PARK_ZONES = {
  "Alton Towers": {
    order: ["Forbidden Valley","X Sector","Gloomy Wood","Dark Forest","Katanga Canyon","CBeebies Land","Cloud Cuckoo Land","Towers Street"],
    rides: {
      "Nemesis Reborn":                    "Forbidden Valley",
      "Toxicator":                         "Forbidden Valley",
      "Galactica":                         "Forbidden Valley",
      "Nemesis Sub-Terra":                 "Forbidden Valley",
      "The Blade":                         "Forbidden Valley",
      "The Smiler":                        "X Sector",
      "Oblivion":                          "X Sector",
      "Wicker Man":                        "Dark Forest",
      "Rita":                              "Dark Forest",
      "TH13TEEN":                          "Dark Forest",
      "The Curse at Alton Manor":          "Gloomy Wood",
      "Hex - The Legend of the Towers":    "Gloomy Wood",
      "Gangsta Granny: The Ride":          "Gloomy Wood",
      "Congo River Rapids":                "Katanga Canyon",
      "Spinball Whizzer":                  "Katanga Canyon",
      "Runaway Mine Train":                "Katanga Canyon",
      "Battle Galleons":                   "Katanga Canyon",
      "Octonauts Rollercoaster Adventure": "CBeebies Land",
      "In The Night Garden Magical Boat Ride": "CBeebies Land",
      "Go Jetters Vroomster Zoom Ride":    "CBeebies Land",
    },
  },
  "Thorpe Park": {
    order: ["Fearless Valley","Amity","The Dock Yard","Lost City","Old Town","Jungle"],
    rides: {
      "Hyperia":                    "Fearless Valley",
      "Stealth":                    "Amity",
      "Tidal Wave":                 "Amity",
      "Rumba Rapids":               "Amity",
      "SAW - The Ride":             "The Dock Yard",
      "Ghost Train":                "The Dock Yard",
      "Colossus":                   "Lost City",
      "Quantum":                    "Lost City",
      "Vortex":                     "Lost City",
      "The Swarm":                  "Old Town",
      "Storm in a Teacup":          "Old Town",
      "Nemesis Inferno":            "Jungle",
      "Samurai":                    "Jungle",
      "The Walking Dead: The Ride": "Jungle",
    },
  },
  "Chessington World of Adventures": {
    order: ["Jumanji","Forbidden Kingdom","Transylvania","Land of the Dragons","Pirate Cove","Shipwreck Coast","Adventure Bay","Wild Asia"],
    rides: {
      "Mandrill Mayhem":            "World of Jumanji",
      "Mamba Strike":               "World of Jumanji",
      "Ostrich Stampede":           "World of Jumanji",
      "Croc Drop":                  "Forbidden Kingdom",
      "Kobra":                      "Forbidden Kingdom",
      "Tomb Blaster":               "Forbidden Kingdom",
      "Vampire":                    "Transylvania",
      "Dragon's Fury":              "Land of the Dragons",
      "Blue Barnacle":              "Shipwreck Coast",
      "Seastorm":                   "Shipwreck Coast",
      "Tiger Rock":                 "Land of the Tiger",
      "ZUFARI":                     "Wanyama",
      "Chase's Mountain Mission":   "Adventure Bay",
      "Skye's Helicopter Heroes":   "Adventure Bay",
      "The Gruffalo River Ride Adventure": "Land of the Dragons",
    },
  },
  "Blackpool Pleasure Beach": {
    order: ["Big Coaster Row","Nickelodeon Land","South End","North End","Central"],
    rides: {
      "Big One":                        "Big Coaster Row",
      "ICON":                           "Big Coaster Row",
      "Infusion":                       "Big Coaster Row",
      "Launch Pad":                     "Big Coaster Row",
      "Grand National":                 "North End",
      "Revolution":                     "North End",
      "Steeplechase":                   "North End",
      "Valhalla":                       "South End",
      "Ghost Train":                    "Central",
      "River Caves":                    "Central",
      "Alice Ride":                     "Central",
      "Wallace & Gromit's Thrill-O-Matic": "Central",
      "Derby Racer":                    "Central",
      "Nickelodeon Streak":             "Nickelodeon Land",
    },
  },
};

function getParkZones(parkName) {
  return PARK_ZONES[parkName] || null;
}

function getZoneForRide(parkName, rideName) {
  const zones = getParkZones(parkName);
  if (!zones) return "Park";
  return zones.rides[rideName] || "Park";
}

// Sort rides by zone walking order to minimise backtracking
function sortRidesByZone(parkName, rides) {
  const zones = getParkZones(parkName);
  if (!zones) return rides;
  return [...rides].sort((a, b) => {
    const zA = zones.order.indexOf(getZoneForRide(parkName, a.name));
    const zB = zones.order.indexOf(getZoneForRide(parkName, b.name));
    const idxA = zA === -1 ? 999 : zA;
    const idxB = zB === -1 ? 999 : zB;
    return idxA - idxB;
  });
}

// ─── Auto-day planner ─────────────────────────────────────────────────────────
// Strategy:
//  1. Start at park open time
//  2. First hour: hit starred rides while queues are shortest
//  3. Sort remaining rides by live wait (or thrill desc if no live data)
//  4. Slot a lunch break 12:00–13:00
//  5. Afternoon: remaining rides lowest-wait first
//  6. Slot dining stops if user has planned any
//  7. Add buffer time between rides based on park walking time (~10 min)

function generateAutoPlan(park, pdata, liveQueues) {
  const rides    = pdata.rides  || [];
  const dining   = pdata.dining || [];
  const openTime = park.openTime  || "10:00";
  const closeTime = park.closeTime || "18:00";

  // ── Crowd-aware settings ───────────────────────────────────────────────────
  const crowdScore = getCrowdScore(park.date); // null if no date
  const crowd      = getCrowdLabel(crowdScore);

  // Queue multiplier based on crowd level
  const queueMult = crowdScore === null ? 1.0
    : crowdScore <= 30 ? 0.4   // Very Quiet — short queues
    : crowdScore <= 50 ? 0.7   // Moderate
    : crowdScore <= 70 ? 1.2   // Busy
    : crowdScore <= 85 ? 1.7   // Very Busy
    : 2.5;                     // Peak Day

  // Walk time grows on busier days (more people = slower movement)
  const WALK   = crowdScore === null ? 8
    : crowdScore <= 30 ? 5
    : crowdScore <= 50 ? 8
    : crowdScore <= 70 ? 10
    : crowdScore <= 85 ? 13
    : 16;

  const BUFFER = crowdScore !== null && crowdScore > 70 ? 8 : 5;

  function timeToMins(t) {
    const [h,m] = t.split(":").map(Number);
    return h*60 + m;
  }
  function minsToTime(m) {
    const h = Math.floor(m/60);
    const min = m%60;
    return `${String(h).padStart(2,"0")}:${String(min).padStart(2,"0")}`;
  }

  function getRideWait(ride) {
    if (ride.fastPass) return 5;
    if (liveQueues?.data) {
      // Live data — still scale by crowd for consistency when park date differs from today
      const live = Object.values(liveQueues.data).find(r =>
        r.name === ride.name || r.name.toLowerCase() === ride.name.toLowerCase()
      );
      if (live && live.status !== "closed") return Math.round((live.wait || 10) * queueMult);
      if (live && live.status === "closed") return 999;
    }
    // No live data — estimate by thrill level then apply crowd multiplier
    // Bases reflect realistic UK park waits on an average day (not peak)
    const base = { "🔴":75, "🟠":45, "🟡":25, "🟢":12 };
    return Math.round((base[ride.thrill] || 25) * queueMult);
  }

  const plannable = rides.filter(r => !r.done && getRideWait(r) < 999);

  const starred   = plannable.filter(r => r.star);
  const unstarred = plannable.filter(r => !r.star);

  const zoneSort = (arr) => {
    const byZone = sortRidesByZone(park.name, arr);
    const zones  = getParkZones(park.name);
    if (!zones) return byZone.sort((a,b) => getRideWait(a)-getRideWait(b));
    return byZone;
  };

  const sorted = [...zoneSort(starred), ...zoneSort(unstarred)];

  const items = [];
  let cursor = timeToMins(openTime);
  const closesMins = timeToMins(closeTime);
  let lunchAdded          = false;
  let afternoonSnackAdded = false;
  let diningIdx           = 0;

  // On peak/very busy days, add a FastPass nudge at the start
  if (crowdScore !== null && crowdScore > 70) {
    const pdata_booking = pdata.booking || {};
    if (!pdata_booking.fastPassBooked) {
      items.push({
        id: uid(), time: minsToTime(cursor), activity: "⚡ FastPass recommended",
        type: "break", duration: null,
        notes: `${crowd?.label} day — pre-booking FastPass will save you 1–2 hours today`,
      });
    }
  }

  for (let i = 0; i < sorted.length; i++) {
    const ride     = sorted[i];
    const wait     = getRideWait(ride);
    const rawWait  = ride.fastPass ? 5 : Math.round((liveQueues?.data
      ? (Object.values(liveQueues.data).find(r=>r.name.toLowerCase()===ride.name.toLowerCase())?.wait || 10)
      : ({ "🔴":75, "🟠":45, "🟡":25, "🟢":12 }[ride.thrill] || 25)) * queueMult);

    const rideTime = Math.ceil(Math.min(wait, 120) / 5) * 5;

    // Lunch ~12:00
    if (!lunchAdded && cursor >= timeToMins("12:00") && cursor < timeToMins("13:30")) {
      const lunchDur = crowdScore !== null && crowdScore > 70 ? 55 : 45; // longer lunch on busy days
      if (dining[diningIdx]) {
        items.push({ id:uid(), time:minsToTime(cursor), activity:dining[diningIdx].name, type:"food", duration:lunchDur, notes:"Planned dining stop" });
        diningIdx++;
      } else {
        items.push({ id:uid(), time:minsToTime(cursor), activity:"Lunch break 🍽", type:"food", duration:lunchDur,
          notes: crowdScore !== null && crowdScore > 70 ? "Queues peak 12–2pm — good time to eat" : "Refuel for the afternoon!" });
      }
      cursor += lunchDur;
      lunchAdded = true;
    }

    // Afternoon break ~15:00
    if (!afternoonSnackAdded && cursor >= timeToMins("15:00") && cursor < timeToMins("16:00")) {
      items.push({ id:uid(), time:minsToTime(cursor), activity:"Snack break ☕", type:"break", duration:20,
        notes: crowdScore !== null && crowdScore > 70 ? "Queues ease off after 15:00 — good time to re-ride favourites" : "Grab a drink and rest your feet" });
      cursor += 20;
      afternoonSnackAdded = true;
    }

    const queueNote = ride.fastPass
      ? "⚡ FastPass"
      : rawWait > 1
        ? `~${rawWait} min queue${crowdScore !== null && crowdScore > 70 && !liveQueues?.data ? " (busy day estimate)" : ""}`
        : "";

    items.push({
      id: uid(), time: minsToTime(cursor),
      activity: ride.name, type: "ride",
      duration: rideTime + BUFFER,
      notes: queueNote,
    });

    cursor += rideTime + BUFFER + WALK;

    if (cursor > closesMins - 30) break; // stop 30 min before closing
  }

  while (diningIdx < dining.length) {
    items.push({ id:uid(), time:minsToTime(cursor), activity:dining[diningIdx].name, type:"food", duration:30, notes:"Planned dining stop" });
    cursor += 30;
    diningIdx++;
  }

  return items;
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [route,        setRoute]        = useState("home");
  const [parks,        setParks]        = useState([]);
  const [activeId,     setActiveId]     = useState(null);
  const [section,      setSection]      = useState(null);
  const [parkData,     setParkData]     = useState({});
  const [timers,       setTimers]       = useState({});
  const [liveQueues,   setLiveQueues]   = useState({});
  const [workerUrl,    setWorkerUrl]    = useState("");
  const workerUrlRef = useRef("");
  // Load saved worker URL + test network on first render
  const [networkOk, setNetworkOk] = useState(null); // null=testing, true=ok, false=blocked
  useEffect(() => {
    try {
      const saved = localStorage.getItem("parkday_worker") || "";
      if (saved) { setWorkerUrl(saved); workerUrlRef.current = saved; }
    } catch(e) {}
    // Test if outbound fetch works at all
    fetch("https://queue-times.com/parks/1/queue_times.json", { mode:"cors" })
      .then(() => setNetworkOk(true))
      .catch(() => {
        // Try worker directly
        const wUrl = (() => { try { return localStorage.getItem("parkday_worker")||""; } catch(e){ return ""; }})();
        if (wUrl) {
          fetch(wUrl + "/queues?parkId=1")
            .then(() => setNetworkOk(true))
            .catch(() => setNetworkOk(false));
        } else {
          setNetworkOk(false);
        }
      });
  }, []);
  const [showSettings, setShowSettings] = useState(false);
  useEffect(() => { workerUrlRef.current = workerUrl; }, [workerUrl]);
  const [showCustomize,setShowCustomize]= useState(false);
  const [showCover,    setShowCover]    = useState(false);
  const [showGuests,   setShowGuests]   = useState(false);
  const [parkGuests,   setParkGuests]   = useState({});
  const [amoled,       setAmoled]       = useState(() => { try { return localStorage.getItem('parkday_amoled')==='1'; } catch(e) { return false; }}); // { [parkId]: [{id,name,emoji}] }

  // Per-park UI prefs: { [parkId]: { widgetOrder, coverType, coverValue } }
  const [parkPrefs, setParkPrefs] = useState({});

  useEffect(() => {
    const t = setInterval(() => {
      setTimers(p => {
        const n = {...p};
        Object.keys(n).forEach(k => { if (n[k]>0) n[k]--; });
        return n;
      });
    }, 1000);
    return () => clearInterval(t);
  }, []);

  const park   = parks.find(p => p.id === activeId);
  const pdata  = (activeId && parkData[activeId]) || blankData();
  const lq     = (activeId && liveQueues[activeId]) || null;
  const rides  = pdata.rides;
  const prefs  = (activeId && parkPrefs[activeId]) || defaultPrefs();

  function defaultPrefs() {
    return {
      widgetOrder: ["booking","visitinfo","travel","rides","itinerary","dining","budget","packing","notes","summary"],
      coverType: "gradient",   // "gradient" | "color" | "image"
      coverValue: null,        // null = use park gradIdx, "#hex" for color, dataURL for image
      accentColor: null,       // null = derive from gradient
    };
  }

  function setPrefs(fn) {
    setParkPrefs(prev => {
      const cur = prev[activeId] || defaultPrefs();
      return { ...prev, [activeId]: fn(cur) };
    });
  }

  function mutatePark(fn) {
    setParkData(prev => {
      const cur = prev[activeId] || blankData();
      return { ...prev, [activeId]: fn(cur) };
    });
  }

  const fetchQueues = useCallback(async (pid, rideList, parkQtId) => {
    if (!pid || !rideList || !rideList.length) return;
    setLiveQueues(prev => ({ ...prev, [pid]: { ...(prev[pid]||{}), loading: true, error: null, simulated: false } }));
    let map, simulated = false;
    const wUrl = workerUrlRef.current || workerUrl || (() => { try { return localStorage.getItem("parkday_worker") || ""; } catch(e) { return ""; }})();
    if (parkQtId) {
      try {
        if (wUrl) {
          map = await fetchFromWorker(wUrl, parkQtId);
        } else {
          map = await fetchViaAnthropicProxy(parkQtId);
        }
      } catch(e) {
        try {
          if (wUrl) map = await fetchViaAnthropicProxy(parkQtId);
          else throw e;
        } catch(e2) {
          map = simulateQueues(rideList); simulated = true;
        }
      }
    } else {
      await new Promise(r => setTimeout(r, 600 + Math.random() * 400));
      map = simulateQueues(rideList);
      simulated = true;
    }
    setLiveQueues(prev => ({ ...prev, [pid]: { data: map, lastFetched: new Date(), loading: false, error: null, simulated } }));
  }, [workerUrl]);

  const activeParkId    = park?.id || null;
  const activeRideCount = rides.length;

  useEffect(() => {
    if (!activeParkId || !activeRideCount) return;
    const snap = rides.slice();
    const qtId = park?.queueTimesId || null;
    fetchQueues(activeParkId, snap, qtId);
    const iv = setInterval(() => fetchQueues(activeParkId, snap, qtId), QUEUE_REFRESH_MS);
    return () => clearInterval(iv);
  }, [activeParkId, activeRideCount]);

  function getLiveWait(ride) {
    if (!lq?.data) return null;
    if (lq.data[ride.name]) return lq.data[ride.name];
    const lower = ride.name.toLowerCase();
    const ci = Object.values(lq.data).find(r => r.name.toLowerCase() === lower);
    if (ci) return ci;
    return Object.values(lq.data).find(r => fuzzyMatch(r.name, ride.name)) || null;
  }

  function createPark(p, presetRides) {
    const id = uid();
    const np = { ...p, id };
    setParks(prev => [...prev, np]);
    const data = blankData();
    if (presetRides?.length) {
      data.rides = presetRides.map(r => ({ id:uid(), name:r.name, wait:0, status:"open", done:false, star:false, height:r.height, thrill:r.thrill, fastPass:false, mustRide:r.mustRide||false, rating:r.rating||3, tip:r.tip||"" }));
    }
    setParkData(prev => ({ ...prev, [id]: data }));
    setActiveId(id);
    setRoute("park");
  }

  function goBack() {
    if (route==="section") { setRoute("park"); setSection(null); }
    else if (route==="park")   { setRoute("home"); setActiveId(null); }
    else if (route==="create") setRoute("home");
  }



  // Derive hero visuals
  const GRADS = GRADIENTS[park?.gradIdx||0];
  const heroStyle = (() => {
    if (!park) return {};
    if (prefs.coverType === "image" && prefs.coverValue) {
      return { backgroundImage:`url(${prefs.coverValue})`, backgroundSize:"cover", backgroundPosition:"center" };
    }
    if (prefs.coverType === "parkphoto" && prefs.coverValue) {
      // coverValue is a CSS gradient string
      return { background: prefs.coverValue };
    }
    if (prefs.coverType === "color" && prefs.coverValue) {
      return { background: prefs.coverValue };
    }
    if (prefs.coverType === "gradient" && prefs.coverValue !== null) {
      const g = COVER_COLORS[prefs.coverValue] || GRADS;
      return { background:`linear-gradient(160deg,${g[0]},${g[1]})` };
    }
    return { background:`linear-gradient(160deg,${GRADS[0]},${GRADS[1]})` };
  })();

  const itinerary = pdata.itinerary;
  const dining    = pdata.dining;
  const budget    = pdata.budget;
  const notes     = pdata.notes;
  const doneRides  = rides.filter(r => r.done).length;
  const totalSpent = budget.items.reduce((s,i) => s+(parseFloat(i.amount)||0), 0);
  const budgetLeft = (parseFloat(budget.total)||0) - totalSpent;

  // Countdown
  const daysUntil = park?.date ? Math.ceil((new Date(park.date) - new Date()) / 86400000) : null;

  const WIDGET_META = {
    rides:     { icon:"🎢", label:"Rides",    color:"#5B8BF5", bg:"rgba(91,139,245,0.15)",
                 subtitle: `${doneRides} done · ${rides.filter(r=>r.star).length} starred`, count: rides.length },
    itinerary: { icon:"📅", label:"Schedule", color:"#27AE60", bg:"rgba(39,174,96,0.15)",
                 subtitle: `${itinerary.length} item${itinerary.length!==1?"s":""}`, count: itinerary.length },
    dining:    { icon:"🍽", label:"Dining",   color:"#F5922E", bg:"rgba(245,146,46,0.15)",
                 subtitle: `${dining.filter(d=>d.booked).length} booked`, count: dining.length },
    budget:    { icon:"💰", label:"Budget",   color:"#E8445A", bg:"rgba(232,68,90,0.15)",
                 subtitle: budget.total ? `£${totalSpent.toFixed(2)} of £${budget.total}` : "Set a budget", count: budget.items.length },
    packing:   { icon:"🎒", label:"Packing",  color:"#00B4DB", bg:"rgba(0,180,219,0.15)",
                 subtitle: (() => { const p = pdata.packing||[]; const done = p.filter(i=>i.checked).length; return `${done}/${p.length} packed`; })(), count: (pdata.packing||[]).filter(i=>!i.checked).length },
    notes:     { icon:"📓", label:"Notes",    color:"#9B59B6", bg:"rgba(155,89,182,0.15)",
                 subtitle: notes.trim() ? "Tap to view" : "Add notes & memories", count: notes.trim()?1:0 },
    booking:   { icon:"🎟", label:"Tickets & Booking", color:"#F5922E", bg:"rgba(245,146,46,0.15)",
                 subtitle: (() => {
                   const b = pdata.booking||{};
                   const done = [b.ticketsBooked, b.parkingBooked].filter(Boolean).length;
                   return done === 0 ? "Nothing booked yet" : done === 1 ? "1 of 2 booked" : "✓ All pre-booked";
                 })(), count: 0 },
    visitinfo: { icon:"📊", label:"Visit Info", color:"#9B59B6", bg:"rgba(155,89,182,0.15)",
                 subtitle: (() => {
                   const crowd = park?.date ? getCrowdLabel(getCrowdScore(park.date)) : null;
                   return crowd ? `${crowd.emoji} ${crowd.label} · ${park?.openTime}–${park?.closeTime}` : "Opening times & crowd forecast";
                 })(), count: 0 },
    travel:    { icon:"🗺️", label:"Getting There", color:"#00B4DB", bg:"rgba(0,180,219,0.15)",
                 subtitle: (() => {
                   const t = getParkTravel(park?.name);
                   return t ? `${t.postcode} · Directions & parking` : "Directions & parking";
                 })(), count: 0 },
    summary:   { icon:"📋", label:"Summary",  color:"#27AE60", bg:"rgba(39,174,96,0.15)",
                 subtitle: rides.length && itinerary.length ? "Your full day at a glance" : rides.length ? "Add a schedule to complete your plan" : "Start by adding rides", count: 0 },
  };

  return (
    <div style={{ fontFamily:"-apple-system,BlinkMacSystemFont,'SF Pro Display','Segoe UI',sans-serif", fontSynthesis:"none", WebkitFontSmoothing:"antialiased", minHeight:"100vh", maxWidth:430, margin:"0 auto", paddingBottom:40, color:"#fff", background:amoled?"#000000":"linear-gradient(160deg,#0d0d12 0%,#12101a 40%,#0d1117 70%,#0f0d0d 100%)", position:"relative" }}>
      <LiquidGlassSVG />
      {/* Ambient colour blobs — give glass elements something to refract */}
      <div style={{ position:"fixed", inset:0, pointerEvents:"none", zIndex:0, overflow:"hidden" }}>
        <div style={{ position:"absolute", top:"-20%", left:"-10%", width:"60%", height:"60%", borderRadius:"50%", background:"radial-gradient(circle,rgba(91,139,245,0.18) 0%,transparent 70%)", filter:"blur(40px)" }} />
        <div style={{ position:"absolute", top:"30%", right:"-15%", width:"50%", height:"50%", borderRadius:"50%", background:"radial-gradient(circle,rgba(245,146,46,0.14) 0%,transparent 70%)", filter:"blur(50px)" }} />
        <div style={{ position:"absolute", bottom:"-10%", left:"20%", width:"55%", height:"45%", borderRadius:"50%", background:"radial-gradient(circle,rgba(155,89,182,0.12) 0%,transparent 70%)", filter:"blur(45px)" }} />
      </div>
      <div style={{ position:"relative", zIndex:1 }}>

      {route==="home" && <HomeScreen parks={parks} parkPrefs={parkPrefs} parkData={parkData} onOpen={id=>{setActiveId(id);setRoute("park");}} onCreate={()=>setRoute("create")} onSettings={()=>setShowSettings(true)} amoled={amoled} />}
      {route==="create" && <CreateFlow onDone={createPark} onBack={goBack} />}

      {route==="park" && park && (
        <div>
          {/* ── Full-bleed hero ── */}
          {/* ── Hero ── */}
          <div style={{ position:"relative", height:280, overflow:"visible", ...heroStyle }}>
            <div style={{ position:"absolute", inset:0, background:"linear-gradient(to bottom, rgba(0,0,0,0.25) 0%, transparent 30%, transparent 50%, rgba(13,13,18,0.8) 85%, rgba(13,13,18,1) 100%)", overflow:"hidden" }} />
            <div style={{ position:"absolute", top:0, left:0, right:0, padding:"52px 16px 0", display:"flex", justifyContent:"space-between", alignItems:"center", zIndex:2 }}>
              <button onClick={goBack} style={darkBtn}>‹ Parks</button>
              <div style={{ display:"flex", gap:8 }}>
                <button onClick={() => setShowCover(true)} style={darkBtn}>🖼</button>
                <button onClick={() => setShowSettings(true)} style={darkBtn}>⚙️</button>
              </div>
            </div>
            <div style={{ position:"absolute", bottom:24, left:0, right:0, padding:"0 20px", textAlign:"center", zIndex:2 }}>
              <div style={{ fontSize:48, marginBottom:4, filter:"drop-shadow(0 4px 12px rgba(0,0,0,0.4))" }}>{park.emoji||"🏰"}</div>
              <h1 style={{ margin:"0 0 8px", fontSize:30, fontWeight:900, color:"#fff", textShadow:"0 2px 12px rgba(0,0,0,0.5)", letterSpacing:"-0.3px" }}>{park.name}</h1>
              <div style={{ display:"flex", gap:10, justifyContent:"center", flexWrap:"wrap" }}>
                {daysUntil !== null && daysUntil >= 0 && <span style={{ fontSize:14, color:"rgba(255,255,255,0.95)", fontWeight:700 }}>{daysUntil===0?"Today! 🎉":`${daysUntil} day${daysUntil!==1?"s":""} to go`}</span>}
                {park.date && (()=>{ const c=getCrowdLabel(getCrowdScore(park.date)); return c?<span style={{ fontSize:13,color:c.color,fontWeight:700,...GLASS_LIGHT,padding:"2px 10px",borderRadius:20 }}>{c.emoji} {c.label}</span>:null; })()}
                {park.date && <span style={{ fontSize:14, color:"rgba(255,255,255,0.75)" }}>{fmtDate(park.date)}</span>}
                {park.openTime && <span style={{ fontSize:14, color:"rgba(255,255,255,0.6)" }}>🕘 {park.openTime}–{park.closeTime}</span>}
                {!park.date && <span style={{ fontSize:13, color:"rgba(255,255,255,0.4)", fontStyle:"italic" }}>Set a visit date →</span>}
              </div>
            </div>
          </div>

          {/* ── Live queue status bar ── */}
          {park.queueTimesId && isParkOpen(park.openTime, park.closeTime) && (
            <div style={{ ...GLASS_MID, padding:"10px 16px", display:"flex", alignItems:"center", justifyContent:"space-between", position:"relative", zIndex:3, margin:"0 14px 10px", borderRadius:14 }}>
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                <div style={{ width:8, height:8, borderRadius:"50%", background:lq?.loading?"#FFD93D":lq?.simulated?"#F5922E":"#27AE60" }} />
                <span style={{ fontSize:13, color:"#EBEBF5", fontWeight:600 }}>
                  {lq?.loading ? "Fetching queue times…"
                    : lq?.lastFetched
                      ? lq.simulated
                        ? "⚠️ Estimated only · Add worker URL in ⚙️ Settings for live times"
                        : `Live queues · ${lq.lastFetched.toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"})}`
                      : "Loading…"}
                </span>
              </div>
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                {lq?.lastFetched && <span style={{ fontSize:11, color:"#8E8E93" }}>↻ 5 min</span>}
                <button onClick={()=>fetchQueues(park.id, rides, park?.queueTimesId)} disabled={lq?.loading}
                  style={{ ...GLASS_LIGHT, border:GLASS_LIGHT.border, borderRadius:8, padding:"5px 10px", color:"#fff", fontSize:13, fontWeight:700, cursor:"pointer" }}>
                  {lq?.loading?"…":"↻"}
                </button>
              </div>
            </div>
          )}

          {/* ── Scrollable widgets ── */}
          <div style={{ padding:"8px 14px 0" }}>
{/* Quick stats row */}
            <div style={{ display:"flex", gap:8, marginBottom:14 }}>
              <QuickStat emoji="🎢" value={`${doneRides}/${rides.length}`} label="Rides" />
              <QuickStat emoji="🍽" value={dining.length} label="Dining" />
              {budget.total && <QuickStat emoji="💰" value={`£${Math.abs(budgetLeft).toFixed(0)}`} label={budgetLeft<0?"over":"left"} warn={budgetLeft<0} />}
              {rides.filter(r=>r.star).length > 0 && <QuickStat emoji="⭐" value={rides.filter(r=>r.star).length} label="starred" />}
            </div>

            {/* Widgets in customisable order */}
            {prefs.widgetOrder.map(key => {
              const meta = WIDGET_META[key];
              if (!meta) return null;
              return (
                <button key={key} onClick={()=>{setSection(key);setRoute("section");}}
                  style={{ width:"100%", ...GLASS_MID, border:GLASS_MID.border, borderRadius:18, padding:"16px", marginBottom:10, cursor:"pointer", textAlign:"left", display:"flex", alignItems:"center", gap:14 }}>
                  <div style={{ width:50, height:50, borderRadius:14, background:meta.bg, display:"flex", alignItems:"center", justifyContent:"center", fontSize:26, flexShrink:0 }}>{meta.icon}</div>
                  <div style={{ flex:1 }}>
                    <p style={{ margin:0, fontSize:16, fontWeight:700, color:"#fff" }}>{meta.label}</p>
                    <p style={{ margin:"3px 0 0", fontSize:13, color:"rgba(255,255,255,0.4)" }}>{meta.subtitle}</p>
                  </div>
                  <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                    {meta.count > 0 && <span style={{ background:meta.bg, color:meta.color, fontSize:13, fontWeight:800, padding:"3px 9px", borderRadius:20 }}>{meta.count}</span>}
                    <span style={{ color:"#48484A", fontSize:20 }}>›</span>
                  </div>
                </button>
              );
            })}

            {/* Must-do rides preview */}
            {rides.filter(r=>r.star).length > 0 && (
              <div style={{ ...GLASS_MID, borderRadius:18, padding:"16px", marginBottom:10 }}>
                <p style={{ margin:"0 0 12px", fontSize:11, fontWeight:600, color:"rgba(255,255,255,0.35)", textTransform:"uppercase", letterSpacing:1.5 }}>⭐ Your Starred Rides</p>
                {rides.filter(r=>r.star).map(r => {
                  const live = getLiveWait(r);
                  return (
                    <div key={r.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 0", borderBottom:"1px solid rgba(255,255,255,0.06)" }}>
                      <span style={{ fontSize:18 }}>🎢</span>
                      <span style={{ flex:1, fontSize:15, fontWeight:600, color:r.done?"#48484A":"#fff", textDecoration:r.done?"line-through":"none" }}>{r.name}</span>
                      {live && <span style={{ fontSize:13, fontWeight:800, color:live.wait<=15?"#27AE60":live.wait<=40?"#F5922E":"#E8445A" }}>{live.status==="closed"?"Closed":`${live.wait}m`}</span>}
                      {r.done && <span style={{ fontSize:12, background:"rgba(39,174,96,0.2)", color:"#27AE60", padding:"3px 8px", borderRadius:20, fontWeight:700 }}>Done ✓</span>}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Guests card — only shown when guests have been added */}
            {(() => {
              const guests = (activeId && parkGuests[activeId]) || [];
              if (!guests.length) return (
                <button onClick={()=>setShowGuests(true)} style={{ width:"100%", ...GLASS_MID, border:GLASS_MID.border, borderRadius:18, padding:"14px 16px", marginBottom:10, cursor:"pointer", textAlign:"left", display:"flex", alignItems:"center", gap:12 }}>
                  <div style={{ width:50, height:50, borderRadius:14, background:"rgba(245,146,46,0.1)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:24, flexShrink:0 }}>👥</div>
                  <div style={{ flex:1 }}>
                    <p style={{ margin:0, fontSize:16, fontWeight:700, color:"#fff" }}>Invite Guests</p>
                    <p style={{ margin:"3px 0 0", fontSize:13, color:"rgba(255,255,255,0.4)" }}>Add people to your visit</p>
                  </div>
                  <span style={{ color:"#48484A", fontSize:20 }}>›</span>
                </button>
              );
              return (
                <div style={{ ...GLASS_MID, borderRadius:18, padding:"16px", marginBottom:10 }}>
                  <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12 }}>
                    <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                      <div style={{ width:50, height:50, borderRadius:14, background:"rgba(245,146,46,0.15)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:26 }}>👥</div>
                      <div>
                        <p style={{ margin:0, fontSize:16, fontWeight:700, color:"#fff" }}>Guests</p>
                        <p style={{ margin:"3px 0 0", fontSize:13, color:"rgba(255,255,255,0.4)" }}>{guests.length} invited</p>
                      </div>
                    </div>
                    <button onClick={()=>setShowGuests(true)} style={{ background:"#F5922E", border:"none", borderRadius:10, padding:"7px 14px", color:"#fff", fontSize:14, fontWeight:700, cursor:"pointer" }}>Manage</button>
                  </div>
                  <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                    {guests.map(g => (
                      <div key={g.id} style={{ display:"flex", alignItems:"center", gap:6, ...GLASS_LIGHT, borderRadius:20, padding:"5px 12px" }}>
                        <span style={{ fontSize:16 }}>{g.emoji}</span>
                        <span style={{ fontSize:14, fontWeight:600, color:"#fff" }}>{g.name}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {/* Customize button — Tripsy style floating pill */}
            <div style={{ textAlign:"center", padding:"16px 0 8px" }}>
              <button onClick={()=>setShowCustomize(true)}
                style={{ ...GLASS_LIGHT, border:GLASS_LIGHT.border, borderRadius:20, padding:"11px 24px", color:"#fff", fontSize:15, fontWeight:700, cursor:"pointer", display:"inline-flex", alignItems:"center", gap:8 }}>
                <span>⊞</span> Customise
              </button>
            </div>
          </div>
        </div>
      )}
      {false && <div />}

      {route==="section" && park && section && (
        <SectionScreen section={section} park={park} pdata={pdata} mutatePark={mutatePark}
          timers={timers} setTimers={setTimers} heroStyle={heroStyle} onBack={goBack}
          liveQueues={lq} getLiveWait={getLiveWait} onRefreshQueues={()=>fetchQueues(park.id, rides, park?.queueTimesId)} />
      )}

      {/* Modals */}
      {showSettings && (
        <SettingsModal workerUrl={workerUrl} amoled={amoled} onAmoledToggle={()=>{ const v=!amoled; setAmoled(v); try{localStorage.setItem('parkday_amoled',v?'1':'0');}catch(e){} }}
          onSave={url => {
            const clean = url.trim();
            try { localStorage.setItem("parkday_worker", clean); } catch(e) {}
            workerUrlRef.current = clean;
            setWorkerUrl(clean);
            setShowSettings(false);
            if (clean && park) setTimeout(() => fetchQueues(park.id, rides, park.queueTimesId), 200);
            if (park && rides.length) fetchQueues(park.id, rides, park?.queueTimesId);
          }}
          onClose={() => setShowSettings(false)} />
      )}

      {showCustomize && park && (
        <CustomizeModal
          prefs={prefs}
          onSave={newPrefs => { setPrefs(() => newPrefs); setShowCustomize(false); }}
          onClose={() => setShowCustomize(false)} />
      )}

      {showCover && park && (
        <CoverModal
          park={park}
          prefs={prefs}
          onSave={updates => { setPrefs(p => ({...p, ...updates})); setShowCover(false); }}
          onClose={() => setShowCover(false)} />
      )}

      {showGuests && park && (
        <GuestsModal
          guests={(activeId && parkGuests[activeId]) || []}
          onSave={guests => { setParkGuests(prev => ({...prev, [activeId]: guests})); setShowGuests(false); }}
          onClose={() => setShowGuests(false)} />
      )}
      </div>
    </div>
  );
}


// ─── QuickStat ────────────────────────────────────────────────────────────────
function QuickStat({ emoji, value, label, warn }) {
  return (
    <div style={{ flex:1, ...GLASS_MID, borderRadius:14, padding:"10px 8px", textAlign:"center" }}>
      <p style={{ margin:0, fontSize:11, color:"rgba(255,255,255,0.4)", fontWeight:600, textTransform:"uppercase", letterSpacing:0.3 }}>{emoji} {label}</p>
      <p style={{ margin:"3px 0 0", fontSize:18, fontWeight:900, color:warn?"#E8445A":"#fff" }}>{value}</p>
    </div>
  );
}

// ─── Customize modal ──────────────────────────────────────────────────────────
const WIDGET_LABELS = { rides:"🎢 Rides", itinerary:"📅 Schedule", dining:"🍽 Dining", budget:"💰 Budget", packing:"🎒 Packing", notes:"📓 Notes", travel:"🗺️ Getting There", booking:"🎟 Tickets & Booking", visitinfo:"📊 Visit Info", summary:"📋 Summary" };

function CustomizeModal({ prefs, onSave, onClose }) {
  const [order, setOrder] = useState([...prefs.widgetOrder]);
  const [dragging, setDragging] = useState(null);
  const [dragOver, setDragOver] = useState(null);

  function move(from, to) {
    const arr = [...order];
    const [item] = arr.splice(from, 1);
    arr.splice(to, 0, item);
    setOrder(arr);
  }

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.6)", zIndex:60, display:"flex", alignItems:"flex-end", justifyContent:"center" }} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{ ...GLASS_HEAVY, borderRadius:"22px 22px 0 0", padding:"0 0 44px", width:"100%", maxWidth:430 }}>
        {/* Header */}
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"16px 20px 12px" }}>
          <button onClick={onClose} style={{ background:"#2C2C2E", border:"none", borderRadius:10, padding:"7px 14px", color:"#fff", fontSize:14, fontWeight:600, cursor:"pointer" }}>Cancel</button>
          <p style={{ margin:0, fontSize:16, fontWeight:800, color:"#fff" }}>Customise Overview</p>
          <button onClick={() => onSave({ ...prefs, widgetOrder: order })}
            style={{ background:"#F5922E", border:"none", borderRadius:10, padding:"7px 14px", color:"#fff", fontSize:14, fontWeight:700, cursor:"pointer" }}>Save</button>
        </div>
        <div style={{ height:1, background:"#3A3A3C", margin:"0 0 16px" }} />

        <p style={{ margin:"0 8px 10px 20px", fontSize:13, fontWeight:700, color:"#8E8E93", textTransform:"uppercase", letterSpacing:0.5 }}>Sections</p>
        <p style={{ margin:"0 20px 12px", fontSize:13, color:"#8E8E93" }}>Drag to reorder the sections on your park overview</p>

        <div style={{ padding:"0 16px" }}>
          {order.map((key, idx) => (
            <div key={key}
              draggable
              onDragStart={() => setDragging(idx)}
              onDragOver={e => { e.preventDefault(); setDragOver(idx); }}
              onDrop={() => { if (dragging !== null && dragging !== idx) move(dragging, idx); setDragging(null); setDragOver(null); }}
              onDragEnd={() => { setDragging(null); setDragOver(null); }}
              style={{
                background: dragOver===idx ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.07)",
                borderRadius:14, padding:"14px 16px", marginBottom:8,
                display:"flex", alignItems:"center", gap:12,
                opacity: dragging===idx ? 0.5 : 1,
                transition:"background 0.15s",
                cursor:"grab",
              }}>
              <span style={{ fontSize:20 }}>{WIDGET_LABELS[key].split(" ")[0]}</span>
              <span style={{ flex:1, fontSize:16, fontWeight:600, color:"#fff" }}>{WIDGET_LABELS[key].split(" ").slice(1).join(" ")}</span>
              <span style={{ color:"#48484A", fontSize:22, letterSpacing:1 }}>≡</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Cover modal ──────────────────────────────────────────────────────────────
const COVER_COLORS = [
  ["#FF6B6B","#FFD93D"], ["#4D96FF","#C77DFF"], ["#6BCB77","#4D96FF"],
  ["#FF9A3C","#FF6B6B"], ["#C77DFF","#FF6B6B"], ["#00B4DB","#0083B0"],
  ["#F7971E","#FFD200"], ["#11998e","#38ef7d"], ["#8E2DE2","#4A00E0"],
  ["#fc4a1a","#f7b733"],
];
const SOLID_COLORS = ["#1C1C1E","#2C2C2E","#3A3A3C","#1a1a2e","#0f3460","#533483","#2d6a4f","#b5179e"];

function CoverModal({ park, prefs, onSave, onClose }) {
  const [tab, setTab]     = useState(prefs.coverType==="parkphoto" ? "parkphoto" : prefs.coverType==="color" ? "color" : prefs.coverType==="image" ? "photo" : "gradient");
  const [sel, setSel]     = useState(prefs.coverType === "gradient" ? (park.gradIdx||0) : null);
  const [color, setColor] = useState(prefs.coverType === "color" ? prefs.coverValue : SOLID_COLORS[0]);
  const [selPhoto, setSelPhoto] = useState(prefs.coverType === "parkphoto" ? prefs.coverValue : null);
  const fileRef = useRef(null);

  function handleFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => onSave({ coverType:"image", coverValue: ev.target.result });
    reader.readAsDataURL(file);
  }

  function save() {
    if (tab === "gradient") onSave({ coverType:"gradient", coverValue: sel });
    else if (tab === "color") onSave({ coverType:"color", coverValue: color });
    else if (tab === "parkphoto" && selPhoto) onSave({ coverType:"parkphoto", coverValue: selPhoto });
  }

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.7)", zIndex:60, display:"flex", alignItems:"flex-end", justifyContent:"center" }} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{ ...GLASS_HEAVY, borderRadius:"22px 22px 0 0", padding:"0 0 44px", width:"100%", maxWidth:430, maxHeight:"85vh", overflowY:"auto" }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"16px 20px 12px" }}>
          <button onClick={onClose} style={{ background:"#2C2C2E", border:"none", borderRadius:10, padding:"7px 14px", color:"#fff", fontSize:14, fontWeight:600, cursor:"pointer" }}>Cancel</button>
          <p style={{ margin:0, fontSize:16, fontWeight:800, color:"#fff" }}>Cover Photo</p>
          <button onClick={save} style={{ background:"#F5922E", border:"none", borderRadius:10, padding:"7px 14px", color:"#fff", fontSize:14, fontWeight:700, cursor:"pointer" }}>Save</button>
        </div>
        <div style={{ height:1, background:"#3A3A3C" }} />

        {/* Tabs */}
        <div style={{ display:"flex", padding:"12px 16px", gap:6, overflowX:"auto", scrollbarWidth:"none" }}>
          {[["gradient","🎨 Gradients"],["color","◼ Colours"],["parkphoto","🏰 Park Photos"],["photo","📷 My Photo"]].map(([t,l])=>(
            <button key={t} onClick={()=>setTab(t)} style={{ flexShrink:0, background:tab===t?"#F5922E":"#2C2C2E", border:"none", borderRadius:10, padding:"8px 10px", color:tab===t?"#fff":"#8E8E93", fontSize:13, fontWeight:700, cursor:"pointer" }}>{l}</button>
          ))}
        </div>

        <div style={{ padding:"4px 16px" }}>
          {tab === "gradient" && (
            <div style={{ display:"flex", flexWrap:"wrap", gap:10 }}>
              {COVER_COLORS.map(([a,b], i) => (
                <button key={i} onClick={()=>setSel(i)} style={{ width:"calc(33% - 7px)", aspectRatio:"16/9", borderRadius:14, border:"none", cursor:"pointer", background:`linear-gradient(135deg,${a},${b})`, outline: sel===i ? "3px solid #F5922E" : "none", transition:"outline 0.1s" }} />
              ))}
            </div>
          )}
          {tab === "color" && (
            <div style={{ display:"flex", flexWrap:"wrap", gap:10 }}>
              {SOLID_COLORS.map((c,i) => (
                <button key={i} onClick={()=>setColor(c)} style={{ width:"calc(25% - 8px)", aspectRatio:"1", borderRadius:14, border:"none", cursor:"pointer", background:c, outline: color===c ? "3px solid #F5922E" : "none" }} />
              ))}
              <div style={{ width:"100%", marginTop:8 }}>
                <p style={{ margin:"0 0 8px", fontSize:13, color:"#8E8E93" }}>Custom colour</p>
                <input type="color" value={color} onChange={e=>setColor(e.target.value)}
                  style={{ width:"100%", height:44, borderRadius:12, border:"none", cursor:"pointer", background:"transparent" }} />
              </div>
            </div>
          )}
          {tab === "parkphoto" && (
            <div>
              <p style={{ margin:"0 0 12px", fontSize:13, color:"#8E8E93" }}>Park-inspired themes for {park.name}</p>
              <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                {getParkThemes(park.name).map((theme, i) => {
                  const isSelected = selPhoto === theme.gradient;
                  return (
                    <button key={i} onClick={()=>setSelPhoto(theme.gradient)}
                      style={{ position:"relative", width:"100%", height:100, borderRadius:16, border:"none", cursor:"pointer", overflow:"hidden", background:theme.gradient, outline: isSelected ? `3px solid ${theme.accent}` : "2px solid transparent", transition:"outline 0.1s" }}>
                      <div style={{ position:"absolute", top:-20, right:-20, width:80, height:80, borderRadius:"50%", background:"rgba(255,255,255,0.08)" }} />
                      <div style={{ position:"absolute", bottom:-15, left:-15, width:60, height:60, borderRadius:"50%", background:"rgba(255,255,255,0.05)" }} />
                      <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center", padding:"0 18px", gap:14 }}>
                        <span style={{ fontSize:34 }}>{theme.emoji}</span>
                        <div style={{ textAlign:"left" }}>
                          <p style={{ margin:0, fontSize:15, fontWeight:800, color:"#fff", textShadow:"0 1px 4px rgba(0,0,0,0.5)" }}>{theme.label}</p>
                          <div style={{ width:32, height:3, borderRadius:2, background:theme.accent, marginTop:6 }} />
                        </div>
                      </div>
                      {isSelected && (
                        <div style={{ position:"absolute", top:10, right:10, width:26, height:26, borderRadius:"50%", background:theme.accent, display:"flex", alignItems:"center", justifyContent:"center", fontSize:14, fontWeight:900, color:"#fff" }}>✓</div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {tab === "photo" && (
            <div style={{ textAlign:"center", padding:"20px 0" }}>
              <div style={{ fontSize:52, marginBottom:12 }}>📷</div>
              <p style={{ color:"#8E8E93", fontSize:15, marginBottom:20 }}>Upload a photo from your camera roll to use as the park cover</p>
              <input ref={fileRef} type="file" accept="image/*" onChange={handleFile} style={{ display:"none" }} />
              <button onClick={()=>fileRef.current?.click()} style={{ background:"#F5922E", border:"none", borderRadius:14, padding:"13px 32px", color:"#fff", fontSize:16, fontWeight:800, cursor:"pointer" }}>
                Choose Photo
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Settings modal ───────────────────────────────────────────────────────────
function SettingsModal({ workerUrl, onSave, onClose, amoled, onAmoledToggle }) {
  const [url, setUrl] = useState(workerUrl || "");
  return (
    <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.4)",zIndex:60,display:"flex",alignItems:"flex-end",justifyContent:"center" }} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{ ...GLASS_HEAVY, borderRadius:"22px 22px 0 0", padding:"0 20px 44px", width:"100%", maxWidth:430 }}>
        <div style={{ width:36,height:4,background:"#C7C7CC",borderRadius:2,margin:"10px auto 24px" }} />
        <h2 style={{ margin:"0 0 6px",fontSize:20,fontWeight:800,color:"#fff" }}>⚙️ Settings</h2>
        <p style={{ margin:"0 0 20px",fontSize:14,color:"#8E8E93" }}>Connect your Cloudflare Worker for real live queue times</p>

        <p style={{ margin:"0 0 6px",fontSize:13,fontWeight:700,color:"#8E8E93",textTransform:"uppercase",letterSpacing:0.4 }}>Queue Proxy URL</p>
        <input
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="https://parkday-queues.your-name.workers.dev"
          style={{ width:"100%",background:"#2C2C2E",border:"none",borderRadius:12,padding:"13px 14px",fontSize:15,color:"#fff",boxSizing:"border-box",outline:"none",fontFamily:"inherit",marginBottom:10 }}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />

        {!url && (
          <div style={{ background:"rgba(245,146,46,0.1)",borderRadius:12,padding:"12px 14px",marginBottom:12 }}>
            <p style={{ margin:"0 0 4px",fontSize:13,fontWeight:700,color:"#F5922E" }}>🟠 Using estimated queue times</p>
            <p style={{ margin:0,fontSize:13,color:"#8E8E93" }}>Follow the setup guide to deploy your free Cloudflare Worker and get real data</p>
          </div>
        )}
        {url && (
          <div style={{ background:"rgba(39,174,96,0.1)",borderRadius:12,padding:"12px 14px",marginBottom:12 }}>
            <p style={{ margin:"0 0 4px",fontSize:13,fontWeight:700,color:"#27AE60" }}>🟢 Worker URL set</p>
            <p style={{ margin:0,fontSize:13,color:"#8E8E93" }}>Queue times will be fetched live from queue-times.com via your worker</p>
          </div>
        )}

        <div style={{ height:1,background:"rgba(255,255,255,0.08)",margin:"16px 0" }} />
        <p style={{ margin:"0 0 6px",fontSize:13,fontWeight:700,color:"#8E8E93",textTransform:"uppercase",letterSpacing:0.4 }}>Display</p>
        <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",background:"rgba(255,255,255,0.07)",borderRadius:12,padding:"14px 16px",marginBottom:16 }}>
          <div>
            <p style={{ margin:0,fontSize:15,fontWeight:700,color:"#fff" }}>AMOLED Mode</p>
            <p style={{ margin:"2px 0 0",fontSize:13,color:"#8E8E93" }}>Pure black background — saves battery on OLED screens</p>
          </div>
          <button onClick={onAmoledToggle} style={{ width:50,height:30,borderRadius:15,border:"none",cursor:"pointer",background:amoled?"#27AE60":"#48484A",position:"relative",transition:"background 0.2s",flexShrink:0 }}>
            <div style={{ position:"absolute",top:3,left:amoled?23:3,width:24,height:24,borderRadius:"50%",background:"#fff",transition:"left 0.2s",boxShadow:"0 1px 4px rgba(0,0,0,0.3)" }} />
          </button>
        </div>
        <button onClick={() => onSave(url)} style={{ width:"100%",background:"#5B8BF5",border:"none",borderRadius:14,padding:15,color:"#fff",fontSize:17,fontWeight:800,cursor:"pointer",marginBottom:10 }}>
          Save
        </button>
        {url && (
          <button onClick={() => { setUrl(""); onSave(""); }} style={{ width:"100%",background:"rgba(232,68,90,0.15)",border:"none",borderRadius:14,padding:13,color:"#E8445A",fontSize:15,fontWeight:700,cursor:"pointer" }}>
            Remove Worker URL
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Home ─────────────────────────────────────────────────────────────────────
function HomeScreen({ parks, parkPrefs, parkData, onOpen, onCreate, onSettings, amoled }) {
  const nextPark = parks
    .filter(p => p.date)
    .sort((a,b) => new Date(a.date)-new Date(b.date))
    .find(p => new Date(p.date) >= new Date(new Date().toDateString()));

  const daysUntilNext = nextPark?.date
    ? Math.ceil((new Date(nextPark.date) - new Date()) / 86400000)
    : null;

  return (
    <div style={{ minHeight:"100vh" }}>

      {/* ── Full-bleed hero ── */}
      <div style={{ position:"relative", background:"linear-gradient(160deg,#1a0a2e 0%,#0d1117 50%,#1a0500 100%)", overflow:"hidden", paddingBottom:32 }}>
        {/* Background coaster silhouette */}
        <div style={{ position:"absolute", bottom:0, left:0, right:0, height:120, background:"linear-gradient(to top,rgba(0,0,0,0.4),transparent)", pointerEvents:"none" }} />
        <div style={{ position:"absolute", top:"-10%", right:"-5%", width:"55%", height:"55%", borderRadius:"50%", background:"radial-gradient(circle,rgba(245,146,46,0.2) 0%,transparent 70%)", filter:"blur(30px)", pointerEvents:"none" }} />
        <div style={{ position:"absolute", bottom:"10%", left:"-5%", width:"40%", height:"40%", borderRadius:"50%", background:"radial-gradient(circle,rgba(91,139,245,0.15) 0%,transparent 70%)", filter:"blur(25px)", pointerEvents:"none" }} />

        {/* Top bar */}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"56px 20px 0" }}>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <div style={{ width:34, height:34, borderRadius:10, background:"linear-gradient(135deg,#F5922E,#FF6B6B)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:18 }}>🎢</div>
            <span style={{ fontSize:17, fontWeight:900, color:"#fff", letterSpacing:"-0.3px" }}>ParkDay</span>
          </div>
          <button onClick={onSettings} style={{ ...GLASS_LIGHT, border:GLASS_LIGHT.border, borderRadius:12, width:38, height:38, fontSize:16, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" }}>⚙️</button>
        </div>

        {/* Hero content */}
        <div style={{ padding:"28px 20px 0" }}>
          {parks.length === 0 ? (
            // Empty state hero
            <div style={{ textAlign:"center", padding:"20px 0 8px" }}>
              <div style={{ fontSize:72, marginBottom:12, filter:"drop-shadow(0 8px 24px rgba(245,146,46,0.5))" }}>🎢</div>
              <h1 style={{ margin:"0 0 8px", fontSize:36, fontWeight:900, color:"#fff", letterSpacing:"-0.5px", lineHeight:1.1 }}>
                Plan your perfect<br />park day
              </h1>
              <p style={{ margin:"0 0 24px", fontSize:16, color:"rgba(255,255,255,0.5)", lineHeight:1.5 }}>
                Live queue times · Smart scheduling<br />Dining guides · Route planning
              </p>
              <div style={{ display:"flex", justifyContent:"center", gap:8, flexWrap:"wrap" }}>
                {["🎢 Rides","🍽 Dining","📊 Crowd","🗺️ Travel","⚡ FastPass"].map(tag => (
                  <span key={tag} style={{ ...GLASS_LIGHT, borderRadius:20, padding:"5px 12px", fontSize:12, fontWeight:600, color:"rgba(255,255,255,0.7)" }}>{tag}</span>
                ))}
              </div>
            </div>
          ) : (
            // Has parks — show countdown to next visit
            <div style={{ padding:"4px 0 8px" }}>
              <h1 style={{ margin:"0 0 4px", fontSize:32, fontWeight:900, color:"#fff", letterSpacing:"-0.5px" }}>My Parks</h1>
              {nextPark ? (
                <div style={{ display:"flex", alignItems:"center", gap:10, marginTop:12, ...GLASS_LIGHT, borderRadius:16, padding:"12px 16px" }}>
                  <span style={{ fontSize:28 }}>{nextPark.emoji||"🏰"}</span>
                  <div style={{ flex:1 }}>
                    <p style={{ margin:0, fontSize:13, color:"rgba(255,255,255,0.45)", fontWeight:500 }}>Next visit</p>
                    <p style={{ margin:"1px 0 0", fontSize:15, fontWeight:800, color:"#fff" }}>{nextPark.name}</p>
                  </div>
                  <div style={{ textAlign:"right" }}>
                    <p style={{ margin:0, fontSize:22, fontWeight:900, color:daysUntilNext===0?"#27AE60":"#F5922E" }}>
                      {daysUntilNext===0?"Today!":daysUntilNext===1?"Tomorrow":`${daysUntilNext}d`}
                    </p>
                    {daysUntilNext > 0 && <p style={{ margin:0, fontSize:11, color:"rgba(255,255,255,0.35)" }}>to go</p>}
                  </div>
                </div>
              ) : (
                <p style={{ margin:"6px 0 0", fontSize:15, color:"rgba(255,255,255,0.4)" }}>
                  {parks.length} park{parks.length!==1?"s":""} planned
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Parks list ── */}
      <div style={{ padding:"16px 16px 20px" }}>
        {parks.map(park => {
          const g       = GRADIENTS[park.gradIdx];
          const pdata   = parkData?.[park.id] || {};
          const rides   = pdata.rides   || [];
          const dining  = pdata.dining  || [];
          const booking = pdata.booking || {};
          const doneRides = rides.filter(r=>r.done).length;
          const crowd   = park.date ? getCrowdLabel(getCrowdScore(park.date)) : null;
          const dUntil  = park.date ? Math.ceil((new Date(park.date)-new Date())/86400000) : null;

          return (
            <button key={park.id} onClick={()=>onOpen(park.id)}
              style={{ width:"100%", border:"none", borderRadius:22, overflow:"hidden", marginBottom:14, cursor:"pointer", textAlign:"left", display:"block", boxShadow:"0 8px 32px rgba(0,0,0,0.4)" }}>
              {/* Hero */}
              <div style={{ background:`linear-gradient(135deg,${g[0]},${g[1]})`, height:130, position:"relative", display:"flex", alignItems:"flex-end", padding:"14px 16px" }}>
                <div style={{ position:"absolute", top:-20, right:-20, width:100, height:100, borderRadius:"50%", background:"rgba(255,255,255,0.1)" }} />
                <div style={{ fontSize:42, position:"absolute", top:12, right:14, filter:"drop-shadow(0 4px 8px rgba(0,0,0,0.3))" }}>{park.emoji||"🏰"}</div>
                <div style={{ position:"absolute", inset:0, background:"linear-gradient(to top, rgba(0,0,0,0.55) 0%, transparent 55%)" }} />
                {/* Top-right badges */}
                <div style={{ position:"absolute", top:12, left:14, display:"flex", gap:6 }}>
                  {crowd && <span style={{ fontSize:11, fontWeight:700, background:"rgba(0,0,0,0.35)", color:crowd.color, padding:"2px 8px", borderRadius:20 }}>{crowd.emoji} {crowd.label}</span>}
                  {booking.ticketsBooked && <span style={{ fontSize:11, fontWeight:700, background:"rgba(39,174,96,0.3)", color:"#27AE60", padding:"2px 8px", borderRadius:20 }}>✓ Booked</span>}
                </div>
                <div style={{ position:"relative", flex:1 }}>
                  <p style={{ margin:0, fontSize:20, fontWeight:900, color:"#fff", letterSpacing:"-0.2px" }}>{park.name}</p>
                  <div style={{ display:"flex", alignItems:"center", gap:8, marginTop:3 }}>
                    {park.date && <span style={{ fontSize:12, color:"rgba(255,255,255,0.75)" }}>{fmtDate(park.date)}</span>}
                    {dUntil !== null && dUntil >= 0 && (
                      <span style={{ fontSize:12, fontWeight:700, color:dUntil===0?"#27AE60":"rgba(255,255,255,0.9)" }}>
                        {dUntil===0?"· Today 🎉":dUntil===1?"· Tomorrow":`· ${dUntil}d to go`}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              {/* Footer — real data */}
              <div style={{ ...GLASS_MID, padding:"11px 16px", display:"flex", gap:0, alignItems:"center" }}>
                <div style={{ flex:1, textAlign:"center", borderRight:"1px solid rgba(255,255,255,0.07)", padding:"0 8px" }}>
                  <p style={{ margin:0, fontSize:16, fontWeight:800, color:"#fff" }}>{doneRides}/{rides.length}</p>
                  <p style={{ margin:0, fontSize:10, color:"rgba(255,255,255,0.35)", textTransform:"uppercase", letterSpacing:0.5 }}>Rides</p>
                </div>
                <div style={{ flex:1, textAlign:"center", borderRight:"1px solid rgba(255,255,255,0.07)", padding:"0 8px" }}>
                  <p style={{ margin:0, fontSize:16, fontWeight:800, color:"#fff" }}>{dining.length}</p>
                  <p style={{ margin:0, fontSize:10, color:"rgba(255,255,255,0.35)", textTransform:"uppercase", letterSpacing:0.5 }}>Dining</p>
                </div>
                <div style={{ flex:1, textAlign:"center", borderRight:"1px solid rgba(255,255,255,0.07)", padding:"0 8px" }}>
                  <p style={{ margin:0, fontSize:16, fontWeight:800, color: (()=>{const b=booking;const done=[b.ticketsBooked,b.parkingBooked].filter(Boolean).length;return done===2?"#27AE60":"#fff";})() }}>
                    {(()=>{const b=booking;return [b.ticketsBooked,b.parkingBooked].filter(Boolean).length;})()}/2
                  </p>
                  <p style={{ margin:0, fontSize:10, color:"rgba(255,255,255,0.35)", textTransform:"uppercase", letterSpacing:0.5 }}>Booked</p>
                </div>
                <div style={{ paddingLeft:12, display:"flex", alignItems:"center", gap:8 }}>
                  {(() => { const open = isParkOpen(park.openTime, park.closeTime); return open === false ? <span style={{ fontSize:11,color:"#E8445A",fontWeight:700 }}>Closed</span> : park.queueTimesId ? <span style={{ fontSize:11,color:"#27AE60",fontWeight:700 }}>📡 Live</span> : <span style={{ fontSize:11,color:"rgba(255,255,255,0.4)",fontWeight:600 }}>Open</span>; })()}
                  <span style={{ color:"rgba(255,255,255,0.2)", fontSize:18 }}>›</span>
                </div>
              </div>
            </button>
          );
        })}

        <button onClick={onCreate} style={{
          width:"100%", background:"linear-gradient(135deg,#F5922E,#FF6B6B)", border:"none",
          borderRadius:18, padding:"17px", color:"#fff", fontSize:17, fontWeight:800,
          cursor:"pointer", marginTop: parks.length ? 4 : 0,
          boxShadow:"0 8px 24px rgba(245,146,46,0.35)", letterSpacing:"-0.2px",
          display:"flex", alignItems:"center", justifyContent:"center", gap:8,
        }}>
          <span style={{ fontSize:20 }}>＋</span> Plan a Park Visit
        </button>
      </div>
    </div>
  );
}

// ─── Create flow ──────────────────────────────────────────────────────────────
function CreateFlow({ onDone, onBack }) {
  const [step,   setStep]   = useState(0);
  const [chosen, setChosen] = useState(null);
  const [custom, setCustom] = useState(false);
  const [form,   setForm]   = useState({ name:"", date:"", openTime:"09:00", closeTime:"21:00", emoji:"🏰", gradIdx:0 });

  function selectPreset(preset) {
    setChosen(preset);
    setForm(f=>({ ...f, name:preset.name, emoji:preset.emoji, openTime:preset.openTime, closeTime:preset.closeTime, gradIdx:preset.gradIdx }));
    setStep(2);
  }
  function selectCustom() { setChosen(null); setCustom(true); setStep(1); }
  function back() {
    if (step===1||step===2) { setStep(0); setChosen(null); setCustom(false); }
    else if (step===0) onBack();
    else setStep(s=>s-1);
  }
  function finish() { onDone({ name:form.name,date:form.date,openTime:form.openTime,closeTime:form.closeTime,emoji:form.emoji,gradIdx:form.gradIdx }, chosen?.rides||[]); }

  const totalSteps = custom?3:2;
  const stepIdx    = custom?step:step-1;
  const grad       = GRADIENTS[form.gradIdx];
  const isLast     = (custom&&step===3)||(!custom&&step===2);
  const canNext    = step===1 ? form.name.trim().length>0 : true;

  return (
    <div style={{ minHeight:"100vh",background:"linear-gradient(160deg,#0d0d12,#12101a,#0d1117)",display:"flex",flexDirection:"column" }}>
      <div style={{ ...GLASS_MID,padding:"56px 20px 16px",display:"flex",alignItems:"center",gap:12 }}>
        <button onClick={back} style={{ background:"none",border:"none",color:"#5B8BF5",fontSize:16,fontWeight:700,cursor:"pointer",padding:"4px 0" }}>{step===0?"Cancel":"‹ Back"}</button>
        {step>0&&(
          <div style={{ flex:1,display:"flex",gap:4,justifyContent:"center" }}>
            {Array.from({length:totalSteps}).map((_,i)=>(
              <div key={i} style={{ height:4,borderRadius:2,flex:1,maxWidth:40,background:i<stepIdx?"#5B8BF5":i===stepIdx-1?"#5B8BF5":"#E5E5EA",transition:"background 0.2s" }} />
            ))}
          </div>
        )}
        <div style={{ width:60 }} />
      </div>

      <div style={{ flex:1,padding:"28px 24px 24px",overflowY:"auto",overflowX:"hidden",boxSizing:"border-box" }}>
        {step===0 && (
          <div>
            <h2 style={{ ...createH2, color:"#fff" }}>Which park?</h2>
            <p style={{ ...createSub, color:"#8E8E93" }}>Pick a popular UK park or add your own</p>
            {PRESET_PARKS.map(preset=>{
              const g=GRADIENTS[preset.gradIdx];
              return (
                <button key={preset.name} onClick={()=>selectPreset(preset)} style={{ width:"100%",border:"none",borderRadius:16,overflow:"hidden",marginBottom:10,cursor:"pointer",textAlign:"left",boxShadow:"0 1px 4px rgba(0,0,0,0.08)",display:"block" }}>
                  <div style={{ background:`linear-gradient(135deg,${g[0]},${g[1]})`,padding:"14px 16px",display:"flex",alignItems:"center",gap:12 }}>
                    <span style={{ fontSize:28,flexShrink:0 }}>{preset.emoji}</span>
                    <div style={{ flex:1,minWidth:0 }}>
                      <p style={{ margin:0,fontSize:16,fontWeight:800,color:"#fff",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis" }}>{preset.name}</p>
                      <div style={{ display:"flex",alignItems:"center",gap:6,marginTop:2,flexWrap:"wrap" }}>
                        <span style={{ fontSize:12,color:"rgba(255,255,255,0.8)" }}>{preset.rides.length} rides</span>
                        <span style={{ fontSize:12,color:"rgba(255,255,255,0.5)" }}>·</span>
                        <span style={{ fontSize:12,color:"rgba(255,255,255,0.8)" }}>🕘 {preset.openTime}–{preset.closeTime}</span>
                        {(() => {
                          const open = isParkOpen(preset.openTime, preset.closeTime);
                          if (open === false) return <span style={{ fontSize:11,background:"rgba(232,68,90,0.2)",color:"#E8445A",padding:"1px 7px",borderRadius:20,fontWeight:700 }}>Closed</span>;
                          if (preset.queueTimesId) return <span style={{ fontSize:11,background:"rgba(39,174,96,0.25)",color:"#6BCB77",padding:"1px 7px",borderRadius:20,fontWeight:700 }}>📡 Live</span>;
                          return <span style={{ fontSize:11,background:"rgba(255,255,255,0.1)",color:"rgba(255,255,255,0.5)",padding:"1px 7px",borderRadius:20,fontWeight:600 }}>Open</span>;
                        })()}
                      </div>
                    </div>
                    <span style={{ color:"rgba(255,255,255,0.6)",fontSize:20,flexShrink:0 }}>›</span>
                  </div>
                </button>
              );
            })}
            <button onClick={selectCustom} style={{ width:"100%",background:"#2C2C2E",border:"2px dashed #48484A",borderRadius:16,padding:"16px",cursor:"pointer",display:"flex",alignItems:"center",gap:12,marginTop:4 }}>
              <div style={{ width:44,height:44,borderRadius:12,background:"#3A3A3C",display:"flex",alignItems:"center",justifyContent:"center",fontSize:22 }}>✏️</div>
              <div style={{ textAlign:"left" }}>
                <p style={{ margin:0,fontSize:16,fontWeight:700,color:"#fff" }}>Add a custom park</p>
                <p style={{ margin:"2px 0 0",fontSize:13,color:"#8E8E93" }}>Enter your own park and rides</p>
              </div>
            </button>
          </div>
        )}

        {step===1 && (
          <div>
            <PreviewCard form={form} grad={GRADIENTS[form.gradIdx]} />
            <h2 style={{ ...createH2, color:"#fff" }}>Name your park</h2>
            <p style={{ ...createSub, color:"#8E8E93" }}>What park are you visiting?</p>
            <input autoFocus value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} placeholder="e.g. Thorpe Park" style={{ ...createInput, background:"#2C2C2E", color:"#fff" }} />
          </div>
        )}
        {step===2 && (
          <div>
            <PreviewCard form={form} grad={grad} />
            <h2 style={{ ...createH2, color:"#fff" }}>When are you going?</h2>
            <p style={{ ...createSub, color:"#8E8E93" }}>Pick your visit date</p>
            {/* Styled date button — avoids iOS small-then-expand behaviour */}
            <div style={{ position:"relative", width:"100%", marginBottom:12 }}>
              <button
                onClick={()=>document.getElementById("date-picker-hidden").showPicker?.() || document.getElementById("date-picker-hidden").click()}
                style={{ ...createInput, background:"#2C2C2E", color: form.date?"#fff":"rgba(255,255,255,0.35)", display:"flex", alignItems:"center", justifyContent:"space-between", cursor:"pointer", marginBottom:0, textAlign:"left", width:"100%", boxSizing:"border-box" }}>
                <span>{form.date ? new Date(form.date).toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long",year:"numeric"}) : "Select a date"}</span>
                <span style={{ fontSize:18, opacity:0.5 }}>📅</span>
              </button>
              <input
                id="date-picker-hidden"
                type="date"
                value={form.date}
                onChange={e=>setForm(f=>({...f,date:e.target.value}))}
                style={{ position:"absolute", top:0, left:0, width:"100%", height:"100%", opacity:0, cursor:"pointer", zIndex:2 }}
              />
            </div>
          </div>
        )}
        {step===3 && custom && (
          <div>
            <PreviewCard form={form} grad={grad} />
            <h2 style={{ ...createH2, color:"#fff" }}>Pick an icon</h2>
            <p style={{ ...createSub, color:"#8E8E93" }}>Choose something that fits</p>
            <div style={{ display:"flex",flexWrap:"wrap",gap:10,justifyContent:"center" }}>
              {EMOJIS.map(e=>(
                <button key={e} onClick={()=>setForm(f=>({...f,emoji:e}))} style={{ width:56,height:56,borderRadius:14,fontSize:28,border:"none",cursor:"pointer",background:form.emoji===e?"rgba(245,146,46,0.2)":"#2C2C2E",outline:form.emoji===e?"2px solid #F5922E":"none" }}>{e}</button>
              ))}
            </div>
          </div>
        )}

      </div>

      {step>0&&(
        <div style={{ padding:"0 24px 40px" }}>
          <button onClick={()=>canNext&&(isLast?finish():setStep(s=>s+1))} style={{ width:"100%",border:"none",borderRadius:16,padding:16,color:"#fff",fontSize:17,fontWeight:800,cursor:canNext?"pointer":"default",background:canNext?"#F5922E":"#48484A" }}>
            {isLast ? "Create Park ✓" : "Continue →"}
          </button>
        </div>
      )}
    </div>
  );
}

function PreviewCard({ form, grad }) {
  return (
    <div style={{ background:`linear-gradient(135deg,${grad[0]},${grad[1]})`,borderRadius:20,padding:"22px 20px",marginBottom:28,position:"relative",overflow:"hidden" }}>
      <div style={{ position:"absolute",top:-30,right:-30,width:100,height:100,borderRadius:"50%",background:"rgba(255,255,255,0.15)" }} />
      <div style={{ fontSize:38,marginBottom:6 }}>{form.emoji||"🏰"}</div>
      <p style={{ margin:0,fontSize:22,fontWeight:900,color:"#fff" }}>{form.name||"Your park"}</p>
      {form.date&&<p style={{ margin:"4px 0 0",fontSize:13,color:"rgba(255,255,255,0.8)",fontWeight:600 }}>{fmtDate(form.date)}</p>}
    </div>
  );
}

// ─── Section screen ───────────────────────────────────────────────────────────
function SectionScreen({ section, park, pdata, mutatePark, timers, setTimers, heroStyle, onBack, liveQueues, getLiveWait, onRefreshQueues }) {
  const cat = CATEGORIES.find(c=>c.key===section);
  const [sheet, setSheet] = useState(null);
  const [sheetPrefill, setSheetPrefill] = useState(null);
  const [thrillFilter, setThrillFilter] = useState("all");

  const rides     = pdata.rides;
  const itinerary = pdata.itinerary;
  const dining    = pdata.dining;
  const budget    = pdata.budget;
  const notes     = pdata.notes;
  const totalSpent = budget.items.reduce((s,i)=>s+(parseFloat(i.amount)||0),0);
  const budgetLeft = (parseFloat(budget.total)||0)-totalSpent;

  function mutRides(fn)  { mutatePark(d=>({...d,rides:fn(d.rides)})); }
  function mutItin(fn)   { mutatePark(d=>({...d,itinerary:fn(d.itinerary)})); }
  function mutDining(fn) { mutatePark(d=>({...d,dining:fn(d.dining)})); }
  function mutBudget(fn) { mutatePark(d=>({...d,budget:fn(d.budget)})); }
  function setNotes(v)   { mutatePark(d=>({...d,notes:v})); }

  const THRILL_FILTERS = [["all","All"],["🔴","Extreme"],["🟠","Thrilling"],["🟡","Moderate"],["🟢","Family"]];
  const filteredRides = thrillFilter==="all" ? rides : rides.filter(r=>r.thrill===thrillFilter);

  // Sort rides: if live data, sort by wait time ascending (closed last)
  const sortedRides = liveQueues?.data
    ? [...filteredRides].sort((a,b) => {
        const la = getLiveWait(a), lb = getLiveWait(b);
        if (!la && !lb) return 0;
        if (!la) return 1;
        if (!lb) return -1;
        if (la.status==="closed" && lb.status!=="closed") return 1;
        if (lb.status==="closed" && la.status!=="closed") return -1;
        return (la.wait||0) - (lb.wait||0);
      })
    : filteredRides;

  return (
    <div>
      <div style={{ ...heroStyle, padding:"52px 20px 24px", position:"relative", overflow:"hidden", minHeight:160, zIndex:2 }}>
        <div style={{ position:"absolute", inset:0, background:"linear-gradient(to bottom, rgba(0,0,0,0.3), rgba(0,0,0,0.6))" }} />
        <div style={{ position:"absolute",top:-40,right:-40,width:140,height:140,borderRadius:"50%",background:"rgba(255,255,255,0.1)" }} />
        <button onClick={onBack} style={{ ...backBtn, position:'relative', zIndex:2 }}>‹ {park.name}</button>
        <div style={{ display:"flex",alignItems:"center",gap:12 }}>
          <div style={{ width:52,height:52,borderRadius:16,background:"rgba(255,255,255,0.25)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:26 }}>{cat.icon}</div>
          <h1 style={{ margin:0,fontSize:26,fontWeight:900,color:"#fff",position:"relative",zIndex:2 }}>{cat.label}</h1>
        </div>
      </div>

      {/* Live queue status bar (rides section only) */}
      {section==="rides" && rides.length > 0 && (
        <div style={{ ...GLASS_MID, padding:"10px 16px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <div style={{ display:"flex",alignItems:"center",gap:8 }}>
            <div style={{ width:8,height:8,borderRadius:"50%",background:liveQueues?.loading?"#FFD93D":!isParkOpen(park.openTime,park.closeTime)?"#E8445A":liveQueues?.simulated?"#F5922E":"#27AE60" }} />
            <span style={{ fontSize:13,color:"#EBEBF5",fontWeight:600 }}>
              {liveQueues?.loading ? "Fetching…"
              : !isParkOpen(park.openTime, park.closeTime) ? `Closed · opens ${park.openTime}`
              : liveQueues?.lastFetched
                ? liveQueues.simulated
                  ? "⚠️ Estimated only · Add worker URL in ⚙️ Settings for live times"
                  : `Live · ${liveQueues.lastFetched.toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"})}`
                : "Loading…"}
            </span>
          </div>
          <div style={{ display:"flex",alignItems:"center",gap:6 }}>
            {liveQueues?.lastFetched&&<span style={{ fontSize:11,color:"#8E8E93" }}>↻ 5 min</span>}
            <button onClick={onRefreshQueues} disabled={liveQueues?.loading} style={{ ...GLASS_LIGHT, border:GLASS_LIGHT.border, borderRadius:8, padding:"5px 10px", color:"#fff", fontSize:13, fontWeight:700, cursor:"pointer" }}>Refresh</button>
          </div>
        </div>
      )}

      <div style={{ padding:"16px 16px 60px", minHeight:"100vh" }}>

        {section==="rides" && <>
          {/* Must-ride recommendations */}
          {(() => {
            const mustRides = rides.filter(r => r.mustRide && !r.done);
            if (!mustRides.length) return null;
            return (
              <div style={{ marginBottom:16 }}>
                <p style={{ margin:"0 0 10px", fontSize:11, fontWeight:600, color:"rgba(255,255,255,0.35)", textTransform:"uppercase", letterSpacing:1.5 }}>✨ Recommended Rides</p>
                <div style={{ display:"flex", gap:10, overflowX:"auto", paddingBottom:4, scrollbarWidth:"none" }}>
                  {mustRides.map(ride => {
                    const live = getLiveWait(ride);
                    const wait = live ? live.wait : null;
                    const waitColor = wait===null?"#8E8E93":wait<=15?"#27AE60":wait<=40?"#F5922E":"#E8445A";
                    return (
                      <div key={ride.id} style={{ flexShrink:0, width:200, ...GLASS_MID, borderRadius:16, padding:"14px", position:"relative", overflow:"hidden" }}>
                        <div style={{ position:"absolute", top:-15, right:-15, width:60, height:60, borderRadius:"50%", background:"rgba(255,255,255,0.05)" }} />
                        <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:8 }}>
                          <span style={{ fontSize:14 }}>{ride.thrill}</span>
                          {"★".repeat(ride.rating||3).split("").map((_,i)=><span key={i} style={{ fontSize:11, color:"#FFD93D" }}>★</span>)}
                        </div>
                        <p style={{ margin:"0 0 4px", fontSize:14, fontWeight:800, color:"rgba(255,255,255,0.95)", lineHeight:1.2 }}>{ride.name}</p>
                        {ride.tip && <p style={{ margin:"0 0 8px", fontSize:11, color:"rgba(255,255,255,0.45)", lineHeight:1.4 }}>{ride.tip}</p>}
                        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                          {live && live.status!=="closed" ? (
                            <span style={{ fontSize:12, fontWeight:800, color:waitColor }}>{wait}m wait</span>
                          ) : live?.status==="closed" ? (
                            <span style={{ fontSize:12, color:"#E8445A", fontWeight:700 }}>Closed</span>
                          ) : (
                            <span style={{ fontSize:11, color:"rgba(255,255,255,0.3)" }}>{ride.height!=="—"?`↕ ${ride.height}`:""}</span>
                          )}
                          <button onClick={()=>mutRides(rs=>rs.map(r=>r.id===ride.id?{...r,star:!r.star}:r))}
                            style={{ background:"none",border:"none",fontSize:16,cursor:"pointer",padding:0,opacity:0.7 }}>
                            {ride.star?"⭐":"☆"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          {/* Thrill filter */}
          <div style={{ display:"flex",gap:6,marginBottom:14,overflowX:"auto",paddingBottom:2,scrollbarWidth:"none" }}>
            {THRILL_FILTERS.map(([key,label])=>(
              <button key={key} onClick={()=>setThrillFilter(key)} style={{ background:thrillFilter===key?"#F5922E":"#2C2C2E",border:"none",borderRadius:20,padding:"6px 14px",color:thrillFilter===key?"#fff":"rgba(255,255,255,0.5)",fontSize:13,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap",flexShrink:0 }}>
                {key!=="all"&&key+" "}{label}
              </button>
            ))}
          </div>

          <SectionHeader title={`${filteredRides.length} Ride${filteredRides.length!==1?"s":""}`} onAdd={()=>setSheet("ride")} />
          {sortedRides.length===0&&<EmptyState icon="🎢" text="No rides in this category" />}
          {sortedRides.map(ride => {
            const st = RIDE_STATUS[ride.status]||RIDE_STATUS.open;
            const t  = timers[ride.id];
            const mins = parseInt(ride.wait)||0;
            const pct  = t!=null&&mins>0?Math.max(0,Math.min(1,(mins*60-t)/(mins*60))):0;
            const live = getLiveWait(ride);
            const displayWait = live ? live.wait : (parseInt(ride.wait)||0);
            const displayStatus = live ? live.status : ride.status;
            const waitColor = displayWait<=15?"#27AE60":displayWait<=40?"#F5922E":"#E8445A";

            return (
              <div key={ride.id} style={{ ...GLASS_MID, borderRadius:18, padding:"16px", marginBottom:12, opacity:ride.done?0.65:1 }}>
                <div style={{ display:"flex",gap:12,alignItems:"flex-start" }}>
                  <button onClick={()=>mutRides(rs=>rs.map(r=>r.id===ride.id?{...r,done:!r.done}:r))} style={{ width:26,height:26,borderRadius:8,border:`2px solid ${ride.done?"#27AE60":"#D1D1D6"}`,background:ride.done?"#27AE60":"transparent",cursor:"pointer",flexShrink:0,marginTop:3,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontSize:14,fontWeight:900 }}>{ride.done?"✓":""}</button>
                  <div style={{ flex:1,minWidth:0 }}>
                    <div style={{ display:"flex",alignItems:"center",gap:6 }}>
                      <p style={{ margin:0,fontSize:17,fontWeight:700,color:ride.done?"#555":"rgba(255,255,255,0.9)",textDecoration:ride.done?"line-through":"none",flex:1,lineHeight:1.2,fontWeight:600,fontSize:16 }}>{ride.name}</p>
                      <button onClick={()=>mutRides(rs=>rs.map(r=>r.id===ride.id?{...r,fastPass:!r.fastPass}:r))}
                        title="Toggle FastPass"
                        style={{ background:ride.fastPass?"rgba(91,139,245,0.25)":"none", border:ride.fastPass?"1px solid rgba(91,139,245,0.4)":"none", borderRadius:8, padding:"2px 7px", fontSize:12, fontWeight:800, cursor:"pointer", color:ride.fastPass?"#5B8BF5":"rgba(255,255,255,0.25)", letterSpacing:0.3 }}>⚡</button>
                      <button onClick={()=>mutRides(rs=>rs.map(r=>r.id===ride.id?{...r,star:!r.star}:r))} style={{ background:"none",border:"none",fontSize:16,cursor:"pointer",padding:0,lineHeight:1,opacity:0.6 }}>{ride.star?"⭐":"☆"}</button>
                      <button onClick={()=>mutRides(rs=>rs.filter(r=>r.id!==ride.id))} style={{ background:"none",border:"none",color:"rgba(255,255,255,0.25)",fontSize:20,cursor:"pointer",padding:0,lineHeight:1 }}>×</button>
                    </div>

                    {/* Ride metadata row */}
                    <div style={{ display:"flex",gap:6,marginTop:5,flexWrap:"wrap",alignItems:"center" }}>
                      {ride.thrill&&<span style={{ fontSize:12,color:"rgba(255,255,255,0.45)",fontWeight:500 }}>{ride.thrill} {THRILL_LABEL[ride.thrill]||""}</span>}
                      {ride.rating && <span style={{ fontSize:11,color:"#FFD93D",letterSpacing:1 }}>{"★".repeat(ride.rating)}</span>}
                      {ride.mustRide && <span style={{ fontSize:11,background:"rgba(245,146,46,0.2)",color:"#F5922E",padding:"2px 7px",borderRadius:20,fontWeight:700 }}>✨ Must-ride</span>}
                      {getZoneForRide(park.name, ride.name) !== "Park" && <span style={{ fontSize:11,background:"rgba(255,255,255,0.06)",color:"rgba(255,255,255,0.3)",padding:"2px 7px",borderRadius:20 }}>📍 {getZoneForRide(park.name, ride.name)}</span>}
                      {ride.height&&ride.height!=="—"&&<span style={{ fontSize:11,background:"rgba(255,255,255,0.07)",color:"rgba(255,255,255,0.4)",padding:"2px 7px",borderRadius:20 }}>↕ {ride.height}</span>}
                    </div>

                    {/* Insider tip */}
                    {ride.tip && !ride.done && (
                      <div style={{ marginTop:6, background:"rgba(255,200,50,0.07)", borderRadius:8, padding:"5px 10px", display:"flex", gap:6 }}>
                        <span style={{ fontSize:11, flexShrink:0 }}>💡</span>
                        <p style={{ margin:0, fontSize:11, color:"rgba(255,200,50,0.7)", lineHeight:1.4 }}>{ride.tip}</p>
                      </div>
                    )}
                    {/* Live wait time — prominent display */}
                    {live ? (
                      <div style={{ marginTop:10,display:"flex",alignItems:"center",gap:10 }}>
                        {ride.fastPass ? (
                          <div style={{ flex:1,background:"rgba(91,139,245,0.15)",borderRadius:10,padding:"10px 14px",display:"flex",alignItems:"center",gap:10 }}>
                            <span style={{ fontSize:20 }}>⚡</span>
                            <div>
                              <p style={{ margin:0,fontSize:10,fontWeight:600,color:"rgba(91,139,245,0.7)",textTransform:"uppercase",letterSpacing:1 }}>FastPass Active</p>
                              <p style={{ margin:"2px 0 0",fontSize:15,fontWeight:800,color:"#5B8BF5" }}>Skip the queue</p>
                            </div>
                          </div>
                        ) : (
                          <div style={{ flex:1,background:displayStatus==="closed"?"rgba(232,68,90,0.15)":displayWait<=15?"rgba(39,174,96,0.15)":displayWait<=40?"rgba(245,146,46,0.15)":"rgba(232,68,90,0.15)",borderRadius:10,padding:"8px 12px",display:"flex",alignItems:"center",justifyContent:"space-between" }}>
                            <div>
                              <p style={{ margin:0,fontSize:10,fontWeight:500,color:"rgba(255,255,255,0.4)",textTransform:"uppercase",letterSpacing:1.2 }}>live wait</p>
                              <p style={{ margin:"2px 0 0",fontSize:20,fontWeight:800,color:displayStatus==="closed"?"#E8445A":waitColor,lineHeight:1 }}>
                                {displayStatus==="closed" ? "Closed" : `${liveQueues?.simulated?"~":""}${displayWait} min`}
                              </p>
                            </div>
                            {displayStatus!=="closed" && (
                              <div style={{ textAlign:"right" }}>
                                <p style={{ margin:0,fontSize:10,color:"rgba(255,255,255,0.35)",letterSpacing:0.5,textTransform:"uppercase" }}>Queue</p>
                                <p style={{ margin:0,fontSize:12,fontWeight:600,color:waitColor }}>{displayWait<=15?"Short":displayWait<=40?"Moderate":"Long"}</p>
                              </div>
                            )}
                          </div>
                        )}
                        {!ride.fastPass && <button onClick={()=>setTimers(p=>({...p,[ride.id]:displayWait*60}))} style={{ ...GLASS_LIGHT, border:GLASS_LIGHT.border, borderRadius:10, padding:"8px 10px", color:"#fff", fontSize:12, fontWeight:700, cursor:"pointer", flexShrink:0 }}>⏱<br/>Start</button>}
                      </div>
                    ) : (
                      // Manual mode when no live data
                      <div style={{ display:"flex",gap:8,marginTop:8,flexWrap:"wrap",alignItems:"center" }}>
                        <select value={ride.status} onChange={e=>mutRides(rs=>rs.map(r=>r.id===ride.id?{...r,status:e.target.value}:r))} style={{ background:st.bg,border:"none",borderRadius:8,padding:"5px 10px",color:st.color,fontSize:13,fontWeight:700,cursor:"pointer" }}>
                          {Object.entries(RIDE_STATUS).map(([k,v])=><option key={k} value={k}>{v.dot} {v.label}</option>)}
                        </select>
                        <div style={{ display:"flex",alignItems:"center",gap:4,background:"#3A3A3C",borderRadius:8,padding:"4px 10px" }}>
                          <span style={{ fontSize:12,color:"#8E8E93" }}>Wait</span>
                          <input type="number" value={ride.wait||0} onChange={e=>mutRides(rs=>rs.map(r=>r.id===ride.id?{...r,wait:e.target.value}:r))} style={{ background:"transparent",border:"none",width:36,fontSize:14,fontWeight:700,color:"#1C1C1E",textAlign:"center" }} />
                          <span style={{ fontSize:12,color:"#8E8E93" }}>min</span>
                        </div>
                        <button onClick={()=>setTimers(p=>({...p,[ride.id]:mins*60}))} style={{ ...GLASS_LIGHT, border:GLASS_LIGHT.border, borderRadius:8, padding:"5px 10px", color:"#fff", fontSize:13, fontWeight:700, cursor:"pointer" }}>⏱ Start</button>
                      </div>
                    )}

                    {/* Countdown timer progress bar */}
                    {t!=null&&(
                      <div style={{ marginTop:10 }}>
                        <div style={{ display:"flex",justifyContent:"space-between",marginBottom:4 }}>
                          <span style={{ fontSize:10,color:"rgba(255,255,255,0.35)",textTransform:"uppercase",letterSpacing:1 }}>Queue countdown</span>
                          <span style={{ fontSize:13,fontWeight:800,color:t>0?"#F5922E":"#27AE60" }}>
                            {t>0?`${Math.floor(t/60)}:${(t%60).toString().padStart(2,"0")}`:"🎉 Time's up!"}
                          </span>
                        </div>
                        <div style={{ height:5,background:"#3A3A3C",borderRadius:3 }}>
                          <div style={{ height:"100%",borderRadius:3,background:t>0?"#5B8BF5":"#27AE60",width:`${pct*100}%`,transition:"width 0.9s" }} />
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          {/* Attribution required by queue-times.com */}
          {liveQueues?.lastFetched&&(
            <p style={{ textAlign:"center",fontSize:11,color:"#48484A",marginTop:8 }}>
              Live data powered by <a href="https://queue-times.com" target="_blank" rel="noreferrer" style={{ color:"#8E8E93" }}>Queue-Times.com</a>
            </p>
          )}
        </>}

        {section==="itinerary"&&<>
          <div style={{ marginBottom:12 }}>
            <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8 }}>
              <p style={{ margin:0,fontSize:11,fontWeight:600,color:"rgba(255,255,255,0.35)",textTransform:"uppercase",letterSpacing:1.5 }}>{itinerary.length} Item{itinerary.length!==1?"s":""}</p>
              <button onClick={()=>setSheet("itin")} style={{ background:"#F5922E",border:"none",borderRadius:10,padding:"7px 16px",color:"#fff",fontSize:14,fontWeight:700,cursor:"pointer" }}>＋ Add</button>
            </div>
            {rides.length > 0 && (
              <button onClick={()=>{
                if (itinerary.length > 0 && !window.confirm("This will replace your current schedule. Continue?")) return;
                const plan = generateAutoPlan(park, pdata, liveQueues);
                mutatePark(d=>({...d, itinerary: plan}));
              }} style={{ width:"100%",...GLASS_MID,border:GLASS_MID.border,borderRadius:14,padding:"13px 16px",cursor:"pointer",display:"flex",alignItems:"center",gap:12,marginBottom:4 }}>
                <span style={{ fontSize:22 }}>✨</span>
                <div style={{ textAlign:"left" }}>
                  <p style={{ margin:0,fontSize:15,fontWeight:700,color:"#fff" }}>Auto-plan my day</p>
                  <p style={{ margin:"2px 0 0",fontSize:12,color:"rgba(255,255,255,0.4)" }}>
                    {(() => {
                      const score = getCrowdScore(park.date);
                      const crowd = getCrowdLabel(score);
                      const base = "Zone-optimised · minimises walking";
                      if (liveQueues?.data) return base + " · live queue times";
                      if (crowd) return `${crowd.emoji} ${crowd.label} day · ${base}`;
                      return base + " · set a date for crowd-aware timings";
                    })()}
                  </p>
                </div>
                <span style={{ marginLeft:"auto",color:"rgba(255,255,255,0.25)",fontSize:18 }}>›</span>
              </button>
            )}
          </div>
          {itinerary.length===0&&<EmptyState icon="📅" text="Tap Auto-plan to generate your day, or add items manually" />}
          {[...itinerary].sort((a,b)=>a.time.localeCompare(b.time)).map((item,idx,arr)=>{
            const t=ITEM_TYPES[item.type]||ITEM_TYPES.other;
            return (
              <div key={item.id} style={{ display:"flex",gap:12,marginBottom:4 }}>
                <div style={{ display:"flex",flexDirection:"column",alignItems:"center",paddingTop:16,width:28 }}>
                  <div style={{ width:10,height:10,borderRadius:"50%",background:t.color,flexShrink:0 }} />
                  {idx<arr.length-1&&<div style={{ width:2,flex:1,background:"rgba(255,255,255,0.1)",margin:"3px 0",minHeight:24 }} />}
                </div>
                <div style={{ flex:1,...GLASS_MID,borderRadius:14,padding:"12px 14px",marginBottom:6 }}>
                  <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:6 }}>
                    <span style={{ fontSize:13,fontWeight:800,color:t.color }}>{item.time}</span>
                    <span style={{ fontSize:18 }}>{t.icon}</span>
                    <span style={{ flex:1,fontSize:15,fontWeight:600,color:"rgba(255,255,255,0.9)" }}>{item.activity||"—"}</span>
                    <button onClick={()=>mutItin(is=>is.filter(i=>i.id!==item.id))} style={{ background:"none",border:"none",color:"rgba(255,255,255,0.25)",fontSize:18,cursor:"pointer",padding:0 }}>×</button>
                  </div>
                  <div style={{ display:"flex",gap:6,flexWrap:"wrap" }}>
                    {item.duration > 0 && <span style={{ fontSize:11,color:"rgba(255,255,255,0.4)",background:"rgba(255,255,255,0.08)",padding:"2px 8px",borderRadius:20 }}>{item.duration} mins</span>}
                    {item.notes&&<span style={{ fontSize:12,color:"rgba(255,255,255,0.4)" }}>{item.notes}</span>}
                    {item.type==="ride" && getZoneForRide(park.name, item.activity) !== "Park" && <span style={{ fontSize:11,color:"rgba(255,255,255,0.3)",background:"rgba(255,255,255,0.06)",padding:"2px 8px",borderRadius:20 }}>📍 {getZoneForRide(park.name, item.activity)}</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </>}

        {section==="dining"&&<>
          {/* My planned stops */}
          <SectionHeader title={`${dining.length} Planned Stop${dining.length!==1?"s":""}`} onAdd={()=>setSheet("dining")} />
          {dining.length===0&&<EmptyState icon="🍽" text="Plan your meals — or browse the park's options below" />}
          {dining.map(d=>(
            <div key={d.id} style={{ ...GLASS_MID, borderRadius:16, padding:16, marginBottom:10 }}>
              <div style={{ display:"flex",alignItems:"center",gap:12 }}>
                <div style={{ width:46,height:46,borderRadius:14,background:"rgba(245,146,46,0.15)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:24,flexShrink:0 }}>
                  {d.type==="snack"?"🍦":d.type==="drinks"?"🥤":d.type==="dessert"?"🍰":d.type==="fastfood"?"🍟":"🍽"}
                </div>
                <div style={{ flex:1 }}>
                  <p style={{ margin:0,fontSize:16,fontWeight:600,color:"rgba(255,255,255,0.9)" }}>{d.name||"Unnamed"}</p>
                  <p style={{ margin:"2px 0 0",fontSize:13,color:"rgba(255,255,255,0.4)" }}>{d.time||"Time TBC"}{d.cost?` · £${d.cost}`:""}{d.notes?` · ${d.notes}`:""}</p>
                </div>
                <div style={{ display:"flex",gap:8,alignItems:"center" }}>
                  {d.booked&&<span style={{ fontSize:12,background:"rgba(39,174,96,0.15)",color:"#27AE60",padding:"3px 8px",borderRadius:20,fontWeight:700 }}>Booked</span>}
                  <button onClick={()=>mutDining(ds=>ds.filter(x=>x.id!==d.id))} style={{ background:"none",border:"none",color:"rgba(255,255,255,0.25)",fontSize:20,cursor:"pointer" }}>×</button>
                </div>
              </div>
            </div>
          ))}

          {/* Preloaded park dining guide */}
          {(() => {
            const pd = getParkDining(park.name);
            if (!pd) return null;
            return (
              <>
                {/* Restaurants */}
                <p style={{ margin:"20px 0 10px",fontSize:11,fontWeight:600,color:"rgba(255,255,255,0.35)",textTransform:"uppercase",letterSpacing:1.5 }}>🍽 Restaurants at {park.name}</p>
                {pd.restaurants.map((r,i) => (
                  <div key={i} style={{ ...GLASS_MID, borderRadius:16, padding:"14px 16px", marginBottom:10 }}>
                    <div style={{ display:"flex",alignItems:"flex-start",gap:12 }}>
                      <div style={{ width:44,height:44,borderRadius:12,background:"rgba(245,146,46,0.15)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,flexShrink:0 }}>
                        {r.type.split(" ")[0]}
                      </div>
                      <div style={{ flex:1,minWidth:0 }}>
                        <div style={{ display:"flex",alignItems:"center",gap:8,flexWrap:"wrap" }}>
                          <p style={{ margin:0,fontSize:15,fontWeight:700,color:"rgba(255,255,255,0.9)" }}>{r.name}</p>
                          {r.bookable && <span style={{ fontSize:11,background:"rgba(91,139,245,0.2)",color:"#5B8BF5",padding:"2px 8px",borderRadius:20,fontWeight:700 }}>Bookable</span>}
                        </div>
                        <p style={{ margin:"3px 0",fontSize:13,color:"rgba(255,255,255,0.5)" }}>{r.type.split(" ").slice(1).join(" ")} · {r.location}</p>
                        <p style={{ margin:"4px 0 0",fontSize:13,color:"rgba(255,255,255,0.65)",lineHeight:1.4 }}>{r.desc}</p>
                        <div style={{ display:"flex",alignItems:"center",gap:6,marginTop:8,background:"rgba(255,200,50,0.08)",borderRadius:8,padding:"6px 10px" }}>
                          <span style={{ fontSize:12 }}>💡</span>
                          <p style={{ margin:0,fontSize:12,color:"rgba(255,200,50,0.8)",lineHeight:1.3 }}>{r.tip}</p>
                        </div>
                      </div>
                      <button onClick={()=>{ setSheetPrefill({ name:r.name, type: r.type.includes("Buffet")?"restaurant":r.type.includes("Fast")?"fastfood":r.type.includes("Café")?"drinks":r.type.includes("Dessert")?"dessert":"restaurant", notes:r.tip }); setSheet("dining"); }} style={{ ...GLASS_LIGHT,border:GLASS_LIGHT.border,borderRadius:10,padding:"6px 12px",color:"#F5922E",fontSize:12,fontWeight:700,cursor:"pointer",flexShrink:0 }}>
                        + Plan
                      </button>
                    </div>
                  </div>
                ))}

                {/* Snacks */}
                <p style={{ margin:"20px 0 10px",fontSize:11,fontWeight:600,color:"rgba(255,255,255,0.35)",textTransform:"uppercase",letterSpacing:1.5 }}>🍿 Snacks & Treats</p>
                <div style={{ ...GLASS_MID,borderRadius:16,padding:"4px 0",marginBottom:14 }}>
                  {pd.snacks.map((s,i)=>(
                    <div key={i} style={{ display:"flex",alignItems:"center",gap:12,padding:"12px 16px",borderBottom:i<pd.snacks.length-1?"1px solid rgba(255,255,255,0.06)":"none" }}>
                      <span style={{ fontSize:24,width:36,textAlign:"center" }}>{s.emoji}</span>
                      <div>
                        <p style={{ margin:0,fontSize:14,fontWeight:600,color:"rgba(255,255,255,0.85)" }}>{s.name}</p>
                        <p style={{ margin:"2px 0 0",fontSize:12,color:"rgba(255,255,255,0.4)" }}>{s.desc}</p>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Tips */}
                <p style={{ margin:"8px 0 10px",fontSize:11,fontWeight:600,color:"rgba(255,255,255,0.35)",textTransform:"uppercase",letterSpacing:1.5 }}>💡 Dining Tips</p>
                <div style={{ ...GLASS_MID,borderRadius:16,padding:"4px 0",marginBottom:14 }}>
                  {pd.tips.map((t,i)=>(
                    <div key={i} style={{ display:"flex",gap:10,padding:"12px 16px",borderBottom:i<pd.tips.length-1?"1px solid rgba(255,255,255,0.06)":"none" }}>
                      <span style={{ fontSize:14,flexShrink:0 }}>💡</span>
                      <p style={{ margin:0,fontSize:13,color:"rgba(255,255,255,0.55)",lineHeight:1.5 }}>{t}</p>
                    </div>
                  ))}
                </div>
              </>
            );
          })()}
        </>}

        {section==="budget"&&<>
          <div style={{ ...GLASS_MID, borderRadius:18, padding:20, marginBottom:14 }}>
            <p style={{ margin:"0 0 4px",fontSize:13,fontWeight:700,color:"#8E8E93",textTransform:"uppercase",letterSpacing:0.4 }}>Total Budget</p>
            <div style={{ display:"flex",alignItems:"center",gap:4 }}>
              <span style={{ fontSize:28,color:"#C7C7CC",fontWeight:300 }}>£</span>
              <input type="number" value={budget.total} onChange={e=>mutBudget(b=>({...b,total:e.target.value}))} placeholder="0.00" style={{ background:"transparent",border:"none",fontSize:36,fontWeight:900,color:"#fff",flex:1,outline:"none",background:"transparent" }} />
            </div>
            {budget.total&&<>
              <div style={{ height:6,background:"#3A3A3C",borderRadius:3,margin:"14px 0 12px" }}>
                <div style={{ height:"100%",borderRadius:3,transition:"width 0.4s",background:budgetLeft>=0?"linear-gradient(90deg,#27AE60,#6BCB77)":"#E8445A",width:`${Math.min((totalSpent/(parseFloat(budget.total)||1))*100,100)}%` }} />
              </div>
              <div style={{ display:"flex",justifyContent:"space-between" }}>
                <div><p style={{ margin:0,fontSize:12,color:"#8E8E93" }}>Spent</p><p style={{ margin:0,fontSize:20,fontWeight:900,color:"#E8445A" }}>£{totalSpent.toFixed(2)}</p></div>
                <div style={{ textAlign:"right" }}><p style={{ margin:0,fontSize:12,color:"#8E8E93" }}>Remaining</p><p style={{ margin:0,fontSize:20,fontWeight:900,color:budgetLeft>=0?"#27AE60":"#E8445A" }}>£{Math.abs(budgetLeft).toFixed(2)}{budgetLeft<0?" over":""}</p></div>
              </div>
            </>}
          </div>
          <SectionHeader title="Expenses" onAdd={()=>setSheet("budget")} />
          {budget.items.length===0&&<EmptyState icon="💰" text="Track your spending as you go" />}
          {budget.items.map(item=>(
            <div key={item.id} style={{ ...GLASS_MID, borderRadius:14, padding:"14px 16px", marginBottom:8, display:"flex", gap:12, alignItems:"center" }}>
              <span style={{ fontSize:22 }}>{item.emoji||"📌"}</span>
              <div style={{ flex:1 }}><p style={{ margin:0,fontSize:15,fontWeight:700,color:"#fff" }}>{item.label||"Expense"}</p></div>
              <span style={{ fontSize:17,fontWeight:800,color:"#1C1C1E" }}>£{parseFloat(item.amount||0).toFixed(2)}</span>
              <button onClick={()=>mutBudget(b=>({...b,items:b.items.filter(i=>i.id!==item.id)}))} style={{ background:"none",border:"none",color:"#C7C7CC",fontSize:20,cursor:"pointer" }}>×</button>
            </div>
          ))}
        </>}

        {section==="packing"&&<PackingSection pdata={pdata} mutatePark={mutatePark} />}

        {section==="travel"&&<TravelSection park={park} />}

        {section==="booking"&&<BookingSection park={park} pdata={pdata} mutatePark={mutatePark} />}

        {section==="visitinfo"&&<VisitInfoSection park={park} />}

        {section==="summary"&&<SummarySection park={park} pdata={pdata} liveQueues={liveQueues} getLiveWait={getLiveWait} />}

        {section==="notes"&&<>
          <div style={{ ...GLASS_MID, borderRadius:18, padding:18, marginBottom:14 }}>
            <textarea value={notes} onChange={e=>setNotes(e.target.value)} placeholder={`Your memories from ${park.name}...\n\nCapture highlights, tips for next time 🌟`} style={{ width:"100%",minHeight:220,border:"none",outline:"none",fontSize:16,lineHeight:1.75,color:"#fff",background:"transparent",fontFamily:"inherit",resize:"vertical",boxSizing:"border-box" }} />
          </div>
          <div style={{ ...GLASS_MID, borderRadius:18, padding:"14px 16px" }}>
            <p style={{ margin:"0 0 10px",fontSize:13,fontWeight:700,color:"#8E8E93",textTransform:"uppercase",letterSpacing:0.4 }}>💡 Park Tips</p>
            {["Arrive 30 min before opening to beat queues","Use the park app for live wait times","Peak queues: 11am–3pm. Ride early or late","Book dining in advance for popular restaurants","Lockers near big rides save bag-dragging hassle"].map((tip,i,a)=>(
              <div key={i} style={{ display:"flex",gap:10,padding:"8px 0",borderBottom:i<a.length-1?"1px solid #F2F2F7":"none" }}>
                <span>💡</span><p style={{ margin:0,fontSize:14,color:"#8E8E93",lineHeight:1.5 }}>{tip}</p>
              </div>
            ))}
          </div>
        </>}
      </div>

      {sheet&&(
        <AddSheet type={sheet} prefill={sheetPrefill} onClose={()=>{ setSheet(null); setSheetPrefill(null); }} onSave={item=>{
          if (sheet==="ride")   mutRides(rs=>[...rs,item]);
          if (sheet==="itin")   mutItin(is=>[...is,item]);
          if (sheet==="dining") mutDining(ds=>[...ds,item]);
          if (sheet==="budget") mutBudget(b=>({...b,items:[...b.items,item]}));
          setSheet(null);
        }} />
      )}
    </div>
  );
}

// ─── Add sheet ────────────────────────────────────────────────────────────────
function AddSheet({ type, prefill, onClose, onSave }) {
  const [form, setForm] = useState(
    type==="ride"   ? { name:"",wait:0,status:"open",star:false,done:false,thrill:"🟡",height:"",fastPass:false } :
    type==="itin"   ? { time:"10:00",activity:"",type:"ride",duration:30,notes:"" } :
    type==="dining" ? { name: prefill?.name||"", time:"", type: prefill?.type||"restaurant", cost:"", notes: prefill?.notes||"", booked:false } :
                      { label:"",amount:"",emoji:"📌",note:"" }
  );
  const labels = { ride:"Add Ride",itin:"Add to Schedule",dining:"Add Dining Stop",budget:"Add Expense" };
  const canSave = type==="ride"?form.name.trim().length>0:type==="itin"?form.activity.trim().length>0:type==="dining"?form.name.trim().length>0:form.label.trim().length>0&&parseFloat(form.amount)>0;

  return (
    <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.35)",zIndex:50,display:"flex",alignItems:"flex-end",justifyContent:"center" }} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{ ...GLASS_HEAVY, borderRadius:"22px 22px 0 0", padding:"0 20px 40px", width:"100%", maxWidth:430, maxHeight:"90vh", overflowY:"auto" }}>
        <div style={{ width:36,height:4,background:"#C7C7CC",borderRadius:2,margin:"10px auto 20px" }} />
        <h2 style={{ margin:"0 0 20px",fontSize:20,fontWeight:800,color:"#fff" }}>{labels[type]}</h2>
        {type==="ride"&&<>
          <SheetLabel>Ride Name</SheetLabel>
          <input autoFocus value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} placeholder="e.g. Nemesis" style={sheetInput} />
          <SheetLabel>Thrill Level</SheetLabel>
          <div style={{ display:"flex",gap:8,marginBottom:12 }}>
            {[["🔴","Extreme"],["🟠","Thrilling"],["🟡","Moderate"],["🟢","Family"]].map(([emoji,label])=>(
              <button key={emoji} onClick={()=>setForm(f=>({...f,thrill:emoji}))} style={{ flex:1,background:form.thrill===emoji?"rgba(245,146,46,0.2)":"#3A3A3C",border:"none",borderRadius:10,padding:"8px 6px",cursor:"pointer",fontSize:12,fontWeight:700,color:form.thrill===emoji?"#F5922E":"#8E8E93",outline:form.thrill===emoji?"2px solid #F5922E":"none" }}>{emoji}<br/>{label}</button>
            ))}
          </div>
          <SheetLabel>Height Restriction</SheetLabel>
          <input value={form.height} onChange={e=>setForm(f=>({...f,height:e.target.value}))} placeholder="e.g. 140cm or —" style={sheetInput} />
          <button onClick={()=>setForm(f=>({...f,fastPass:!f.fastPass}))} style={{ background:form.fastPass?"rgba(91,139,245,0.2)":"#2C2C2E",border:form.fastPass?"1px solid rgba(91,139,245,0.4)":"none",borderRadius:12,padding:"12px 16px",width:"100%",textAlign:"left",fontSize:15,fontWeight:700,cursor:"pointer",marginBottom:8,color:form.fastPass?"#5B8BF5":"rgba(255,255,255,0.5)" }}>
            {form.fastPass?"⚡ FastPass purchased":"⚡ Add FastPass"}
          </button>
          <button onClick={()=>setForm(f=>({...f,star:!f.star}))} style={{ background:form.star?"rgba(245,205,56,0.15)":"#2C2C2E",border:"none",borderRadius:12,padding:"12px 16px",width:"100%",textAlign:"left",fontSize:15,fontWeight:700,cursor:"pointer",marginBottom:8,color:form.star?"#FFD93D":"#fff" }}>
            {form.star?"⭐ On wishlist":"☆ Add to wishlist"}
          </button>
        </>}
        {type==="itin"&&<>
          <SheetLabel>Time</SheetLabel>
          <input type="time" value={form.time} onChange={e=>setForm(f=>({...f,time:e.target.value}))} style={{ ...sheetInput,colorScheme:"light" }} />
          <SheetLabel>Activity</SheetLabel>
          <input autoFocus value={form.activity} onChange={e=>setForm(f=>({...f,activity:e.target.value}))} placeholder="What are you doing?" style={sheetInput} />
          <SheetLabel>Type</SheetLabel>
          <select value={form.type} onChange={e=>setForm(f=>({...f,type:e.target.value}))} style={sheetSelect}>
            {Object.entries(ITEM_TYPES).map(([k,v])=><option key={k} value={k}>{v.icon} {k.charAt(0).toUpperCase()+k.slice(1)}</option>)}
          </select>
          <SheetLabel>Duration (mins)</SheetLabel>
          <input type="number" value={form.duration} onChange={e=>setForm(f=>({...f,duration:e.target.value}))} style={sheetInput} />
          <SheetLabel>Notes (optional)</SheetLabel>
          <input value={form.notes} onChange={e=>setForm(f=>({...f,notes:e.target.value}))} placeholder="Any extra details..." style={sheetInput} />
        </>}
        {type==="dining"&&<>
          <SheetLabel>Name</SheetLabel>
          <input autoFocus value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} placeholder="Restaurant or food stall" style={sheetInput} />
          <SheetLabel>Type</SheetLabel>
          <select value={form.type} onChange={e=>setForm(f=>({...f,type:e.target.value}))} style={sheetSelect}>
            <option value="restaurant">🍽 Restaurant</option>
            <option value="fastfood">🍟 Fast Food</option>
            <option value="snack">🍦 Snack</option>
            <option value="drinks">🥤 Drinks</option>
            <option value="dessert">🍰 Dessert</option>
          </select>
          <SheetLabel>Time</SheetLabel>
          <input type="time" value={form.time} onChange={e=>setForm(f=>({...f,time:e.target.value}))} style={{ ...sheetInput,colorScheme:"light" }} />
          <SheetLabel>Estimated Cost (£)</SheetLabel>
          <input type="number" value={form.cost} onChange={e=>setForm(f=>({...f,cost:e.target.value}))} placeholder="0.00" style={sheetInput} />
          <SheetLabel>Notes / Allergies</SheetLabel>
          <input value={form.notes} onChange={e=>setForm(f=>({...f,notes:e.target.value}))} placeholder="Dietary needs, preferences..." style={sheetInput} />
          <button onClick={()=>setForm(f=>({...f,booked:!f.booked}))} style={{ background:form.booked?"rgba(39,174,96,0.15)":"#2C2C2E",border:"none",borderRadius:12,padding:"12px 16px",width:"100%",textAlign:"left",fontSize:15,fontWeight:700,cursor:"pointer",marginBottom:8,color:form.booked?"#27AE60":"#fff" }}>
            {form.booked?"✅ Booked":"Mark as booked?"}
          </button>
        </>}
        {type==="budget"&&<>
          <SheetLabel>Description</SheetLabel>
          <input autoFocus value={form.label} onChange={e=>setForm(f=>({...f,label:e.target.value}))} placeholder="What did you spend on?" style={sheetInput} />
          <SheetLabel>Amount (£)</SheetLabel>
          <input type="number" value={form.amount} onChange={e=>setForm(f=>({...f,amount:e.target.value}))} placeholder="0.00" style={sheetInput} />
          <SheetLabel>Category</SheetLabel>
          <div style={{ display:"flex",gap:8,flexWrap:"wrap",marginBottom:12 }}>
            {[["📌","Other"],["🎢","Ride"],["🍔","Food"],["🛍","Shop"],["📸","Photo"],["🎟","Ticket"]].map(([emoji,label])=>(
              <button key={emoji} onClick={()=>setForm(f=>({...f,emoji}))} style={{ background:form.emoji===emoji?"rgba(245,146,46,0.2)":"#2C2C2E",border:"none",borderRadius:10,padding:"8px 12px",cursor:"pointer",fontSize:13,fontWeight:600,color:form.emoji===emoji?"#F5922E":"#8E8E93",outline:form.emoji===emoji?"2px solid #F5922E":"none" }}>{emoji} {label}</button>
            ))}
          </div>
        </>}
        <button onClick={()=>canSave&&onSave({...form,id:uid()})} disabled={!canSave} style={{ width:"100%",background:canSave?"#F5922E":"#48484A",border:"none",borderRadius:14,padding:15,color:"#fff",fontSize:17,fontWeight:800,cursor:canSave?"pointer":"default",marginTop:4 }}>Save</button>
      </div>
    </div>
  );
}

// ─── Micro components ─────────────────────────────────────────────────────────
function StatPill({ emoji, label, bad }) {
  return (
    <div style={{ ...GLASS_LIGHT, borderRadius:20, padding:"5px 12px", display:"flex", gap:5, alignItems:"center" }}>
      <span style={{ fontSize:13 }}>{emoji}</span>
      <span style={{ fontSize:13,fontWeight:700,color:bad?"#FFD93D":"#fff" }}>{label}</span>
    </div>
  );
}
function SmallStat({ icon, label }) {
  return (
    <div style={{ display:"flex",alignItems:"center",gap:5 }}>
      <span style={{ fontSize:14 }}>{icon}</span>
      <span style={{ fontSize:13,color:"#8E8E93",fontWeight:600 }}>{label}</span>
    </div>
  );
}
function SectionHeader({ title, onAdd }) {
  return (
    <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12 }}>
      <p style={{ margin:0,fontSize:11,fontWeight:600,color:"rgba(255,255,255,0.35)",textTransform:"uppercase",letterSpacing:1.5 }}>{title}</p>
      <button onClick={onAdd} style={{ background:"#F5922E",border:"none",borderRadius:10,padding:"7px 16px",color:"#fff",fontSize:14,fontWeight:700,cursor:"pointer" }}>＋ Add</button>
    </div>
  );
}
function EmptyState({ icon, text }) {
  return (
    <div style={{ textAlign:"center",padding:"40px 20px" }}>
      <div style={{ fontSize:42,marginBottom:10 }}>{icon}</div>
      <p style={{ margin:0,fontSize:15,color:"#48484A",fontWeight:500 }}>{text}</p>
    </div>
  );
}
function SheetLabel({ children }) {
  return <p style={{ margin:"0 0 6px",fontSize:13,fontWeight:700,color:"#8E8E93",textTransform:"uppercase",letterSpacing:0.4 }}>{children}</p>;
}



// ─── Packing section ──────────────────────────────────────────────────────────
const PACKING_CAT_ICONS = { Essentials:"🔑", Clothing:"👕", Health:"💊", "Food & Drink":"🍎", Kids:"🧒", Other:"📦" };

function PackingSection({ pdata, mutatePark }) {
  const packing = pdata.packing || DEFAULT_PACKING.map(i=>({...i}));
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCat,  setNewCat]  = useState("Essentials");

  function toggle(id) {
    mutatePark(d => ({
      ...d,
      packing: (d.packing||DEFAULT_PACKING.map(i=>({...i}))).map(i => i.id===id ? {...i, checked:!i.checked} : i)
    }));
  }

  function addItem() {
    if (!newName.trim()) return;
    mutatePark(d => ({
      ...d,
      packing: [...(d.packing||DEFAULT_PACKING.map(i=>({...i}))), { id:uid(), category:newCat, name:newName.trim(), checked:false }]
    }));
    setNewName("");
    setShowAdd(false);
  }

  function removeItem(id) {
    mutatePark(d => ({ ...d, packing: (d.packing||[]).filter(i=>i.id!==id) }));
  }

  function resetAll() {
    mutatePark(d => ({ ...d, packing: DEFAULT_PACKING.map(i=>({...i})) }));
  }

  const categories = [...new Set(packing.map(i=>i.category))];
  const doneCount  = packing.filter(i=>i.checked).length;
  const pct        = packing.length ? Math.round((doneCount/packing.length)*100) : 0;

  return (
    <div>
      {/* Progress bar */}
      <div style={{ ...GLASS_MID, borderRadius:18, padding:"16px", marginBottom:12 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
          <p style={{ margin:0, fontSize:16, fontWeight:700, color:"#fff" }}>{doneCount}/{packing.length} packed</p>
          <span style={{ fontSize:22, fontWeight:900, color: pct===100?"#27AE60":"#00B4DB" }}>{pct}%</span>
        </div>
        <div style={{ height:8, background:"#3A3A3C", borderRadius:4 }}>
          <div style={{ height:"100%", borderRadius:4, transition:"width 0.4s", background: pct===100?"#27AE60":"linear-gradient(90deg,#00B4DB,#0083B0)", width:`${pct}%` }} />
        </div>
        {pct===100 && <p style={{ margin:"10px 0 0", fontSize:14, color:"#27AE60", fontWeight:700, textAlign:"center" }}>🎉 All packed! Ready to go!</p>}
      </div>

      {/* Add item */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
        <p style={{ margin:0, fontSize:13, fontWeight:700, color:"#8E8E93", textTransform:"uppercase", letterSpacing:0.5 }}>Checklist</p>
        <div style={{ display:"flex", gap:8 }}>
          <button onClick={resetAll} style={{ background:"#3A3A3C", border:"none", borderRadius:10, padding:"6px 12px", color:"#8E8E93", fontSize:13, fontWeight:600, cursor:"pointer" }}>Reset</button>
          <button onClick={()=>setShowAdd(s=>!s)} style={{ background:"#F5922E", border:"none", borderRadius:10, padding:"6px 14px", color:"#fff", fontSize:13, fontWeight:700, cursor:"pointer" }}>+ Add</button>
        </div>
      </div>

      {showAdd && (
        <div style={{ background:"#2C2C2E", borderRadius:14, padding:"14px", marginBottom:12 }}>
          <select value={newCat} onChange={e=>setNewCat(e.target.value)}
            style={{ width:"100%", background:"#3A3A3C", border:"none", borderRadius:10, padding:"10px 12px", fontSize:14, color:"#fff", marginBottom:8, fontFamily:"inherit" }}>
            {["Essentials","Clothing","Health","Food & Drink","Kids","Other"].map(c=><option key={c}>{c}</option>)}
          </select>
          <div style={{ display:"flex", gap:8 }}>
            <input value={newName} onChange={e=>setNewName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addItem()}
              placeholder="Item name" autoFocus
              style={{ flex:1, background:"#3A3A3C", border:"none", borderRadius:10, padding:"10px 12px", fontSize:14, color:"#fff", fontFamily:"inherit", outline:"none" }} />
            <button onClick={addItem} disabled={!newName.trim()}
              style={{ background:newName.trim()?"#F5922E":"#3A3A3C", border:"none", borderRadius:10, padding:"10px 16px", color:"#fff", fontSize:14, fontWeight:700, cursor:"pointer" }}>Add</button>
          </div>
        </div>
      )}

      {/* Items by category */}
      {categories.map(cat => {
        const items = packing.filter(i=>i.category===cat);
        return (
          <div key={cat} style={{ ...GLASS_MID, borderRadius:16, padding:"14px 16px", marginBottom:10 }}>
            <p style={{ margin:"0 0 10px", fontSize:13, fontWeight:700, color:"#8E8E93", textTransform:"uppercase", letterSpacing:0.4 }}>
              {PACKING_CAT_ICONS[cat]||"📦"} {cat}
            </p>
            {items.map(item => (
              <div key={item.id} style={{ display:"flex", alignItems:"center", gap:12, padding:"9px 0", borderBottom:"1px solid rgba(255,255,255,0.06)" }}>
                <button onClick={()=>toggle(item.id)} style={{
                  width:24, height:24, borderRadius:7, flexShrink:0, border:`2px solid ${item.checked?"#27AE60":"#48484A"}`,
                  background:item.checked?"#27AE60":"transparent", cursor:"pointer",
                  display:"flex", alignItems:"center", justifyContent:"center", color:"#fff", fontSize:13, fontWeight:900
                }}>{item.checked?"✓":""}</button>
                <span style={{ flex:1, fontSize:15, fontWeight:500, color:item.checked?"#48484A":"#fff", textDecoration:item.checked?"line-through":"none" }}>{item.name}</span>
                <button onClick={()=>removeItem(item.id)} style={{ background:"none", border:"none", color:"#3A3A3C", fontSize:18, cursor:"pointer", padding:0, lineHeight:1 }}>×</button>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

// ─── Guests modal ─────────────────────────────────────────────────────────────
const GUEST_EMOJIS = ["😀","😎","🤩","🥳","👦","👧","👨","👩","🧑","👴","👵","🧒","🎉","🦄","🐶","🐱","🦊","🐼"];

function GuestsModal({ guests, onSave, onClose }) {
  const [list, setList] = useState(guests.map(g => ({...g})));
  const [newName, setNewName] = useState("");
  const [newEmoji, setNewEmoji] = useState("😀");
  const [showShareSheet, setShowShareSheet] = useState(false);

  function addGuest() {
    if (!newName.trim()) return;
    setList(prev => [...prev, { id: uid(), name: newName.trim(), emoji: newEmoji }]);
    setNewName("");
  }

  const shareText = `You're invited to join my theme park visit! 🎢\n\nDownload ParkDay to see the plan, rides and itinerary.`;

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.6)", zIndex:60, display:"flex", alignItems:"flex-end", justifyContent:"center" }} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{ ...GLASS_HEAVY, borderRadius:"22px 22px 0 0", padding:"0 0 44px", width:"100%", maxWidth:430, maxHeight:"85vh", overflowY:"auto" }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"16px 20px 12px" }}>
          <button onClick={onClose} style={{ background:"#2C2C2E", border:"none", borderRadius:10, padding:"7px 14px", color:"#fff", fontSize:14, fontWeight:600, cursor:"pointer" }}>Cancel</button>
          <p style={{ margin:0, fontSize:16, fontWeight:800, color:"#fff" }}>👥 Guests</p>
          <button onClick={() => onSave(list)} style={{ background:"#F5922E", border:"none", borderRadius:10, padding:"7px 14px", color:"#fff", fontSize:14, fontWeight:700, cursor:"pointer" }}>Save</button>
        </div>
        <div style={{ height:1, background:"#3A3A3C", marginBottom:16 }} />

        <div style={{ padding:"0 16px" }}>
          {/* Add guest */}
          <p style={{ margin:"0 0 8px", fontSize:13, fontWeight:700, color:"#8E8E93", textTransform:"uppercase", letterSpacing:0.4 }}>Add a Guest</p>
          <div style={{ display:"flex", gap:8, marginBottom:8 }}>
            <select value={newEmoji} onChange={e=>setNewEmoji(e.target.value)}
              style={{ background:"#2C2C2E", border:"none", borderRadius:10, padding:"10px", fontSize:20, cursor:"pointer", color:"#fff" }}>
              {GUEST_EMOJIS.map(e => <option key={e} value={e}>{e}</option>)}
            </select>
            <input value={newName} onChange={e=>setNewName(e.target.value)}
              onKeyDown={e=>e.key==="Enter"&&addGuest()}
              placeholder="Guest name" style={{ flex:1, background:"#2C2C2E", border:"none", borderRadius:10, padding:"10px 14px", fontSize:15, color:"#fff", fontFamily:"inherit", outline:"none" }} />
            <button onClick={addGuest} disabled={!newName.trim()}
              style={{ background:newName.trim()?"#F5922E":"#3A3A3C", border:"none", borderRadius:10, padding:"10px 16px", color:"#fff", fontSize:15, fontWeight:700, cursor:"pointer" }}>Add</button>
          </div>

          {/* Guest list */}
          {list.length > 0 && <>
            <p style={{ margin:"16px 0 8px", fontSize:13, fontWeight:700, color:"#8E8E93", textTransform:"uppercase", letterSpacing:0.4 }}>Your Group</p>
            {list.map(g => (
              <div key={g.id} style={{ background:"#2C2C2E", borderRadius:12, padding:"12px 14px", marginBottom:8, display:"flex", alignItems:"center", gap:12 }}>
                <span style={{ fontSize:24 }}>{g.emoji}</span>
                <span style={{ flex:1, fontSize:16, fontWeight:600, color:"#fff" }}>{g.name}</span>
                <button onClick={()=>setList(prev=>prev.filter(x=>x.id!==g.id))}
                  style={{ background:"none", border:"none", color:"#48484A", fontSize:20, cursor:"pointer" }}>×</button>
              </div>
            ))}
          </>}

          {/* Share trip */}
          <div style={{ background:"#2C2C2E", borderRadius:16, padding:"16px", marginTop:16 }}>
            <p style={{ margin:"0 0 4px", fontSize:15, fontWeight:700, color:"#fff" }}>📤 Share Trip</p>
            <p style={{ margin:"0 0 12px", fontSize:13, color:"#8E8E93" }}>Invite others to view your park plan</p>
            <button
              onClick={() => {
                if (navigator.share) {
                  navigator.share({ title:"Join my park visit! 🎢", text: shareText });
                } else {
                  navigator.clipboard?.writeText(shareText);
                  setShowShareSheet(true);
                }
              }}
              style={{ width:"100%", background:"#F5922E", border:"none", borderRadius:12, padding:"13px", color:"#fff", fontSize:15, fontWeight:700, cursor:"pointer" }}>
              Share Trip Invite
            </button>
            {showShareSheet && (
              <div style={{ marginTop:10, background:"#3A3A3C", borderRadius:10, padding:"10px 14px" }}>
                <p style={{ margin:0, fontSize:13, color:"#27AE60" }}>✓ Copied to clipboard!</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}




// ─── Booking section ──────────────────────────────────────────────────────────
const MERLIN_PARKS = ["Alton Towers","Thorpe Park","Chessington World of Adventures"];

function BookingSection({ park, pdata, mutatePark }) {
  const travel   = getParkTravel(park.name);
  const booking  = pdata.booking || {};
  const isMerlin = MERLIN_PARKS.includes(park.name);

  function set(key, val) {
    mutatePark(d => ({ ...d, booking: { ...(d.booking||{}), [key]: val } }));
  }

  function BookingRow({ icon, label, desc, url, bookedKey, linkLabel }) {
    const isBooked = booking[bookedKey];
    return (
      <div style={{ ...GLASS_MID, borderRadius:16, padding:"16px", marginBottom:10 }}>
        <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom: url ? 12 : 0 }}>
          <div style={{ width:46, height:46, borderRadius:13, background: isBooked ? "rgba(39,174,96,0.2)" : "rgba(255,255,255,0.07)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:22, flexShrink:0, transition:"background 0.2s" }}>
            {isBooked ? "✓" : icon}
          </div>
          <div style={{ flex:1 }}>
            <p style={{ margin:0, fontSize:15, fontWeight:700, color:"#fff" }}>{label}</p>
            <p style={{ margin:"2px 0 0", fontSize:12, color:"rgba(255,255,255,0.4)" }}>{desc}</p>
          </div>
          <button onClick={()=>set(bookedKey, !isBooked)} style={{ background: isBooked ? "rgba(39,174,96,0.2)" : "rgba(255,255,255,0.08)", border: isBooked ? "1px solid rgba(39,174,96,0.4)" : "1px solid rgba(255,255,255,0.1)", borderRadius:10, padding:"6px 14px", color: isBooked ? "#27AE60" : "rgba(255,255,255,0.6)", fontSize:13, fontWeight:700, cursor:"pointer", transition:"all 0.2s" }}>
            {isBooked ? "✓ Done" : "Mark done"}
          </button>
        </div>
        {url && !isBooked && (
          <button onClick={()=>{ window.open(url,"_blank"); }} style={{ width:"100%", background:"linear-gradient(135deg,#F5922E,#FF6B6B)", border:"none", borderRadius:12, padding:"12px", color:"#fff", fontSize:14, fontWeight:800, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:6 }}>
            {linkLabel} →
          </button>
        )}
        {isBooked && (
          <div style={{ background:"rgba(39,174,96,0.1)", borderRadius:10, padding:"8px 12px", display:"flex", gap:6, alignItems:"center" }}>
            <span>✓</span>
            <p style={{ margin:0, fontSize:12, color:"#27AE60", fontWeight:600 }}>Booked — you're all set for this one</p>
          </div>
        )}
      </div>
    );
  }

  // Overall progress
  const items = [
    { key:"ticketsBooked" },
    isMerlin ? { key:"merlinPreBooked" } : null,
    travel?.parkingBookUrl ? { key:"parkingBooked" } : null,
    travel?.fastPassUrl ? { key:"fastPassBooked" } : null,
  ].filter(Boolean);
  const doneCount = items.filter(i => booking[i.key]).length;

  return (
    <div>
      {/* Progress overview */}
      <div style={{ ...GLASS_HEAVY, borderRadius:20, padding:"18px", marginBottom:16 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
          <p style={{ margin:0, fontSize:16, fontWeight:800, color:"#fff" }}>Pre-visit checklist</p>
          <span style={{ fontSize:14, fontWeight:900, color: doneCount===items.length ? "#27AE60" : "#F5922E" }}>{doneCount}/{items.length}</span>
        </div>
        <div style={{ height:5, background:"rgba(255,255,255,0.08)", borderRadius:3, marginBottom:10 }}>
          <div style={{ height:"100%", borderRadius:3, background: doneCount===items.length ? "#27AE60" : "linear-gradient(90deg,#F5922E,#FF6B6B)", width:`${items.length ? (doneCount/items.length)*100 : 0}%`, transition:"width 0.4s" }} />
        </div>
        {doneCount === items.length && (
          <p style={{ margin:0, fontSize:13, color:"#27AE60", fontWeight:700, textAlign:"center" }}>🎉 All booked — ready to go!</p>
        )}
      </div>

      {/* Tickets */}
      <p style={{ margin:"0 0 8px", fontSize:11, fontWeight:600, color:"rgba(255,255,255,0.35)", textTransform:"uppercase", letterSpacing:1.5 }}>🎟 Tickets</p>
      <BookingRow
        icon="🎟"
        label="Park Tickets"
        desc="Pre-booking online is always cheaper than the gate"
        url={travel?.ticketUrl}
        linkLabel="Book Tickets"
        bookedKey="ticketsBooked"
      />

      {/* Merlin Annual Pass pre-booking */}
      {isMerlin && (
        <>
          <div style={{ ...GLASS_MID, borderRadius:16, padding:"14px 16px", marginBottom:10, display:"flex", alignItems:"center", gap:12 }}>
            <div style={{ width:46, height:46, borderRadius:13, background:"rgba(91,139,245,0.15)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:22, flexShrink:0 }}>🪪</div>
            <div style={{ flex:1 }}>
              <p style={{ margin:0, fontSize:15, fontWeight:700, color:"#fff" }}>Merlin Annual Pass</p>
              <p style={{ margin:"2px 0 0", fontSize:12, color:"rgba(255,255,255,0.4)" }}>Passholders must pre-book their visit slot</p>
            </div>
            <button onClick={()=>set("merlinPassHolder", !booking.merlinPassHolder)} style={{ background: booking.merlinPassHolder ? "rgba(91,139,245,0.25)" : "rgba(255,255,255,0.08)", border: booking.merlinPassHolder ? "1px solid rgba(91,139,245,0.4)" : "1px solid rgba(255,255,255,0.1)", borderRadius:10, padding:"6px 12px", color: booking.merlinPassHolder ? "#5B8BF5" : "rgba(255,255,255,0.5)", fontSize:13, fontWeight:700, cursor:"pointer" }}>
              {booking.merlinPassHolder ? "✓ I have one" : "I have one"}
            </button>
          </div>
          {booking.merlinPassHolder && (
            <BookingRow
              icon="📅"
              label="Pre-book Visit Slot"
              desc="Required for Annual Pass holders — book your date on the Merlin hub"
              url="https://www.merlinannualpass.co.uk/book"
              linkLabel="Pre-book on Merlin Hub"
              bookedKey="merlinPreBooked"
            />
          )}
        </>
      )}

      {/* Parking */}
      {travel?.parkingBookUrl && (
        <>
          <p style={{ margin:"16px 0 8px", fontSize:11, fontWeight:600, color:"rgba(255,255,255,0.35)", textTransform:"uppercase", letterSpacing:1.5 }}>🅿️ Parking</p>
          <BookingRow
            icon="🅿️"
            label="Pre-book Parking"
            desc={`Standard: ${travel.parking.standard} · Express: ${travel.parking.express}`}
            url={travel.parkingBookUrl}
            linkLabel="Pre-book Parking"
            bookedKey="parkingBooked"
          />
        </>
      )}
      {!travel?.parkingBookUrl && (
        <div style={{ ...GLASS_MID, borderRadius:16, padding:"14px 16px", marginBottom:10, display:"flex", gap:10 }}>
          <span style={{ fontSize:20 }}>🅿️</span>
          <div>
            <p style={{ margin:0, fontSize:14, fontWeight:700, color:"#fff" }}>Parking</p>
            <p style={{ margin:"2px 0 0", fontSize:13, color:"rgba(255,255,255,0.45)" }}>{travel?.parking?.standard || "Free parking included"}</p>
          </div>
        </div>
      )}

      {/* FastPass */}
      {travel?.fastPassUrl && (
        <>
          <p style={{ margin:"16px 0 8px", fontSize:11, fontWeight:600, color:"rgba(255,255,255,0.35)", textTransform:"uppercase", letterSpacing:1.5 }}>⚡ Queue Skip</p>
          <BookingRow
            icon="⚡"
            label={travel.fastPassName}
            desc={travel.fastPassNote}
            url={travel.fastPassUrl}
            linkLabel={`Book ${travel.fastPassName}`}
            bookedKey="fastPassBooked"
          />
        </>
      )}
      {!travel?.fastPassUrl && (
        <div style={{ ...GLASS_MID, borderRadius:16, padding:"14px 16px", marginBottom:10, display:"flex", gap:10, alignItems:"flex-start" }}>
          <span style={{ fontSize:20 }}>⚡</span>
          <div>
            <p style={{ margin:0, fontSize:14, fontWeight:700, color:"#fff" }}>Queue Skip</p>
            <p style={{ margin:"2px 0 0", fontSize:13, color:"rgba(255,255,255,0.45)" }}>{travel?.fastPassNote || "No fast pass available at this park"}</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Visit Info section ───────────────────────────────────────────────────────
function VisitInfoSection({ park }) {
  const travel = getParkTravel(park.name);
  const score  = getCrowdScore(park.date);
  const crowd  = getCrowdLabel(score);

  return (
    <div>
      {/* Opening times */}
      <p style={{ margin:"0 0 8px", fontSize:11, fontWeight:600, color:"rgba(255,255,255,0.35)", textTransform:"uppercase", letterSpacing:1.5 }}>🕘 Opening Times</p>
      <div style={{ ...GLASS_MID, borderRadius:16, padding:"16px", marginBottom:14 }}>
        <div style={{ display:"flex", gap:10 }}>
          <div style={{ flex:1, background:"rgba(255,255,255,0.06)", borderRadius:10, padding:"10px 12px", textAlign:"center" }}>
            <p style={{ margin:0, fontSize:11, color:"rgba(255,255,255,0.35)", textTransform:"uppercase", letterSpacing:0.5 }}>Opens</p>
            <p style={{ margin:"4px 0 0", fontSize:22, fontWeight:900, color:"#27AE60" }}>{park.openTime||"—"}</p>
          </div>
          <div style={{ flex:1, background:"rgba(255,255,255,0.06)", borderRadius:10, padding:"10px 12px", textAlign:"center" }}>
            <p style={{ margin:0, fontSize:11, color:"rgba(255,255,255,0.35)", textTransform:"uppercase", letterSpacing:0.5 }}>Closes</p>
            <p style={{ margin:"4px 0 0", fontSize:22, fontWeight:900, color:"#E8445A" }}>{park.closeTime||"—"}</p>
          </div>
          <div style={{ flex:1, background:"rgba(255,255,255,0.06)", borderRadius:10, padding:"10px 12px", textAlign:"center" }}>
            <p style={{ margin:0, fontSize:11, color:"rgba(255,255,255,0.35)", textTransform:"uppercase", letterSpacing:0.5 }}>Status</p>
            <p style={{ margin:"4px 0 0", fontSize:14, fontWeight:900, color: isParkOpen(park.openTime,park.closeTime) ? "#27AE60" : "#E8445A" }}>
              {isParkOpen(park.openTime,park.closeTime) ? "Open ✓" : "Closed"}
            </p>
          </div>
        </div>
        {travel?.arrivalTip && (
          <div style={{ marginTop:12, background:"rgba(0,180,219,0.1)", borderRadius:10, padding:"8px 12px", display:"flex", gap:6 }}>
            <span style={{ fontSize:13 }}>⏰</span>
            <p style={{ margin:0, fontSize:12, color:"rgba(0,180,219,0.8)", lineHeight:1.4 }}>{travel.arrivalTip}</p>
          </div>
        )}
      </div>

      {/* Crowd forecast */}
      <p style={{ margin:"0 0 8px", fontSize:11, fontWeight:600, color:"rgba(255,255,255,0.35)", textTransform:"uppercase", letterSpacing:1.5 }}>📊 Crowd Forecast</p>
      {crowd ? (
        <div style={{ ...GLASS_MID, borderRadius:16, padding:"16px", marginBottom:14 }}>
          <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:12 }}>
            <span style={{ fontSize:36 }}>{crowd.emoji}</span>
            <div style={{ flex:1 }}>
              <p style={{ margin:0, fontSize:20, fontWeight:900, color:crowd.color }}>{crowd.label}</p>
              <p style={{ margin:"2px 0 0", fontSize:13, color:"rgba(255,255,255,0.45)" }}>{fmtDate(park.date)}</p>
            </div>
            <div style={{ position:"relative", width:52, height:52 }}>
              <svg width="52" height="52" style={{ transform:"rotate(-90deg)" }}>
                <circle cx="26" cy="26" r="20" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="5" />
                <circle cx="26" cy="26" r="20" fill="none" stroke={crowd.color} strokeWidth="5"
                  strokeDasharray={`${score * 1.257} 125.7`} strokeLinecap="round" />
              </svg>
              <span style={{ position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:900, color:crowd.color }}>{score}</span>
            </div>
          </div>
          <div style={{ height:5, background:"rgba(255,255,255,0.08)", borderRadius:3, marginBottom:10 }}>
            <div style={{ height:"100%", borderRadius:3, background:crowd.color, width:`${score}%`, transition:"width 0.5s" }} />
          </div>
          <div style={{ background:"rgba(255,255,255,0.06)", borderRadius:10, padding:"8px 12px", display:"flex", gap:6 }}>
            <span style={{ fontSize:13 }}>💡</span>
            <p style={{ margin:0, fontSize:12, color:"rgba(255,255,255,0.55)", lineHeight:1.4 }}>{crowd.tip}</p>
          </div>
          {/* Best/worst times */}
          <div style={{ marginTop:12, display:"flex", gap:8 }}>
            <div style={{ flex:1, background:"rgba(39,174,96,0.1)", borderRadius:10, padding:"8px 10px" }}>
              <p style={{ margin:"0 0 2px", fontSize:10, color:"rgba(39,174,96,0.7)", textTransform:"uppercase", letterSpacing:0.5 }}>Best time to arrive</p>
              <p style={{ margin:0, fontSize:13, fontWeight:700, color:"#27AE60" }}>At opening ({park.openTime})</p>
            </div>
            <div style={{ flex:1, background:"rgba(232,68,90,0.1)", borderRadius:10, padding:"8px 10px" }}>
              <p style={{ margin:"0 0 2px", fontSize:10, color:"rgba(232,68,90,0.7)", textTransform:"uppercase", letterSpacing:0.5 }}>Busiest time</p>
              <p style={{ margin:0, fontSize:13, fontWeight:700, color:"#E8445A" }}>12:00–14:00</p>
            </div>
          </div>
        </div>
      ) : (
        <div style={{ ...GLASS_MID, borderRadius:16, padding:"18px", marginBottom:14, textAlign:"center" }}>
          <p style={{ margin:0, fontSize:15, color:"rgba(255,255,255,0.4)" }}>Set a visit date to see your crowd forecast</p>
        </div>
      )}

      {/* Address & postcode quick ref */}
      {travel && (
        <>
          <p style={{ margin:"0 0 8px", fontSize:11, fontWeight:600, color:"rgba(255,255,255,0.35)", textTransform:"uppercase", letterSpacing:1.5 }}>📍 Quick Reference</p>
          <div style={{ ...GLASS_MID, borderRadius:16, padding:"14px 16px", marginBottom:14 }}>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8 }}>
              <p style={{ margin:0, fontSize:15, fontWeight:700, color:"#fff" }}>{travel.postcode}</p>
              <button onClick={()=>navigator.clipboard?.writeText(travel.postcode)} style={{ ...GLASS_LIGHT, border:GLASS_LIGHT.border, borderRadius:8, padding:"5px 12px", color:"rgba(255,255,255,0.7)", fontSize:12, fontWeight:700, cursor:"pointer" }}>Copy</button>
            </div>
            <p style={{ margin:0, fontSize:12, color:"rgba(255,255,255,0.4)" }}>{travel.address}</p>
            {travel.ulez && (
              <div style={{ marginTop:10, background:"rgba(232,68,90,0.15)", borderRadius:10, padding:"7px 12px", display:"flex", gap:6 }}>
                <span>⚠️</span>
                <p style={{ margin:0, fontSize:12, color:"#E8445A", fontWeight:600 }}>ULEZ zone — check your vehicle at tfl.gov.uk/ulez</p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Travel section ───────────────────────────────────────────────────────────
function TravelSection({ park }) {
  const travel = getParkTravel(park.name);

  function openMaps(type) {
    const t = getParkTravel(park.name);
    if (!t) return;
    if (type === "apple") {
      window.open(`http://maps.apple.com/?q=${encodeURIComponent(t.appleMapsQuery)}`, "_blank");
    } else {
      window.open(`https://www.google.com/maps/search/?api=1&query=${t.mapsQuery}`, "_blank");
    }
  }

  if (!travel) {
    return (
      <div style={{ ...GLASS_MID, borderRadius:18, padding:"24px 20px", textAlign:"center" }}>
        <p style={{ margin:0, fontSize:15, color:"rgba(255,255,255,0.4)" }}>No travel info available for this park yet</p>
      </div>
    );
  }

  return (
    <div>
      {/* Get Directions buttons */}
      <div style={{ ...GLASS_HEAVY, borderRadius:20, padding:"18px", marginBottom:14 }}>
        <p style={{ margin:"0 0 4px", fontSize:11, fontWeight:600, color:"rgba(255,255,255,0.35)", textTransform:"uppercase", letterSpacing:1.5 }}>📍 Destination</p>
        <p style={{ margin:"0 0 14px", fontSize:14, color:"rgba(255,255,255,0.6)", lineHeight:1.4 }}>{travel.address}</p>
        <div style={{ display:"flex", gap:10 }}>
          <button onClick={()=>openMaps("apple")} style={{ flex:1, background:"linear-gradient(135deg,rgba(0,122,255,0.3),rgba(0,122,255,0.15))", border:"1px solid rgba(0,122,255,0.4)", borderRadius:14, padding:"12px 10px", cursor:"pointer", textAlign:"center" }}>
            <p style={{ margin:0, fontSize:18 }}>🗺️</p>
            <p style={{ margin:"4px 0 0", fontSize:13, fontWeight:700, color:"#5B8BF5" }}>Apple Maps</p>
          </button>
          <button onClick={()=>openMaps("google")} style={{ flex:1, background:"linear-gradient(135deg,rgba(52,168,83,0.3),rgba(52,168,83,0.15))", border:"1px solid rgba(52,168,83,0.4)", borderRadius:14, padding:"12px 10px", cursor:"pointer", textAlign:"center" }}>
            <p style={{ margin:0, fontSize:18 }}>📍</p>
            <p style={{ margin:"4px 0 0", fontSize:13, fontWeight:700, color:"#34A853" }}>Google Maps</p>
          </button>
          <button onClick={()=>{ if(navigator.clipboard) navigator.clipboard.writeText(travel.postcode); }} style={{ flex:1, ...GLASS_MID, border:GLASS_MID.border, borderRadius:14, padding:"12px 10px", cursor:"pointer", textAlign:"center" }}>
            <p style={{ margin:0, fontSize:18 }}>📋</p>
            <p style={{ margin:"4px 0 0", fontSize:13, fontWeight:700, color:"rgba(255,255,255,0.7)" }}>{travel.postcode}</p>
          </button>
        </div>
        {travel.ulez && (
          <div style={{ marginTop:12, background:"rgba(232,68,90,0.15)", borderRadius:10, padding:"8px 12px", display:"flex", gap:8, alignItems:"center" }}>
            <span style={{ fontSize:16 }}>⚠️</span>
            <p style={{ margin:0, fontSize:13, color:"#E8445A", fontWeight:600 }}>This park is within the ULEZ zone — check your vehicle at tfl.gov.uk/ulez</p>
          </div>
        )}
      </div>



      {/* By car */}
      <p style={{ margin:"0 0 8px", fontSize:11, fontWeight:600, color:"rgba(255,255,255,0.35)", textTransform:"uppercase", letterSpacing:1.5 }}>🚗 By Car</p>
      <div style={{ ...GLASS_MID, borderRadius:16, padding:"14px 16px", marginBottom:14 }}>
        <p style={{ margin:"0 0 8px", fontSize:14, color:"rgba(255,255,255,0.7)", lineHeight:1.5 }}>{travel.byRoad.detail}</p>
        {travel.byRoad.warning && (
          <div style={{ background:"rgba(245,146,46,0.12)", borderRadius:10, padding:"8px 12px", display:"flex", gap:8, alignItems:"flex-start" }}>
            <span style={{ fontSize:14, flexShrink:0 }}>💡</span>
            <p style={{ margin:0, fontSize:12, color:"rgba(245,146,46,0.8)", lineHeight:1.4 }}>{travel.byRoad.warning}</p>
          </div>
        )}
        {/* Parking */}
        <div style={{ marginTop:12, borderTop:"1px solid rgba(255,255,255,0.06)", paddingTop:12 }}>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8 }}>
            <p style={{ margin:0, fontSize:12, fontWeight:700, color:"rgba(255,255,255,0.4)", textTransform:"uppercase", letterSpacing:0.8 }}>Parking</p>
            {travel.parkingBookUrl ? (
              <button onClick={()=>window.open(travel.parkingBookUrl,"_blank")} style={{ background:"linear-gradient(135deg,#F5922E,#FF6B6B)", border:"none", borderRadius:10, padding:"5px 12px", color:"#fff", fontSize:12, fontWeight:700, cursor:"pointer", display:"flex", alignItems:"center", gap:5 }}>
                🅿️ Pre-book & Save
              </button>
            ) : (
              <span style={{ fontSize:12, color:"#27AE60", fontWeight:700 }}>✓ Free parking</span>
            )}
          </div>
          <div style={{ display:"flex", gap:10, marginBottom:8 }}>
            <div style={{ flex:1, background:"rgba(255,255,255,0.06)", borderRadius:10, padding:"8px 10px" }}>
              <p style={{ margin:"0 0 2px", fontSize:10, color:"rgba(255,255,255,0.3)", textTransform:"uppercase", letterSpacing:0.5 }}>Standard</p>
              <p style={{ margin:0, fontSize:13, fontWeight:700, color:"rgba(255,255,255,0.8)" }}>{travel.parking.standard}</p>
            </div>
            <div style={{ flex:1, background:"rgba(255,255,255,0.06)", borderRadius:10, padding:"8px 10px" }}>
              <p style={{ margin:"0 0 2px", fontSize:10, color:"rgba(255,255,255,0.3)", textTransform:"uppercase", letterSpacing:0.5 }}>Express</p>
              <p style={{ margin:0, fontSize:13, fontWeight:700, color:"rgba(255,255,255,0.8)" }}>{travel.parking.express}</p>
            </div>
          </div>
          {travel.parkingBookUrl && (
            <div style={{ background:"rgba(245,146,46,0.1)", borderRadius:10, padding:"8px 12px", marginBottom:8, display:"flex", gap:6, alignItems:"center" }}>
              <span style={{ fontSize:13 }}>💰</span>
              <p style={{ margin:0, fontSize:12, color:"rgba(245,146,46,0.8)", lineHeight:1.4 }}>Pre-booking online is cheaper than paying on the day — tap "Pre-book & Save" above</p>
            </div>
          )}
          <div style={{ background:"rgba(0,180,219,0.1)", borderRadius:10, padding:"7px 10px", display:"flex", gap:6 }}>
            <span style={{ fontSize:12 }}>💡</span>
            <p style={{ margin:0, fontSize:12, color:"rgba(0,180,219,0.8)", lineHeight:1.4 }}>{travel.parking.tip}</p>
          </div>
        </div>
      </div>

      {/* By train */}
      <p style={{ margin:"0 0 8px", fontSize:11, fontWeight:600, color:"rgba(255,255,255,0.35)", textTransform:"uppercase", letterSpacing:1.5 }}>🚆 By Train</p>
      <div style={{ ...GLASS_MID, borderRadius:16, padding:"14px 16px", marginBottom:14 }}>
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:10 }}>
          <div style={{ background:"rgba(91,139,245,0.2)", borderRadius:10, padding:"6px 12px" }}>
            <p style={{ margin:0, fontSize:13, fontWeight:800, color:"#5B8BF5" }}>🚉 {travel.byTrain.station}</p>
          </div>
          <p style={{ margin:0, fontSize:12, color:"rgba(255,255,255,0.35)" }}>Nearest station</p>
        </div>
        <p style={{ margin:"0 0 12px", fontSize:13, color:"rgba(255,255,255,0.6)", lineHeight:1.5 }}>{travel.byTrain.detail}</p>
        <button onClick={()=>window.open(travel.byTrain.trainLink,"_blank")} style={{ width:"100%", background:"rgba(91,139,245,0.15)", border:"1px solid rgba(91,139,245,0.3)", borderRadius:12, padding:"11px", color:"#5B8BF5", fontSize:14, fontWeight:700, cursor:"pointer" }}>
          🎫 Check Train Times →
        </button>
      </div>

      {/* By bus/other */}
      <p style={{ margin:"0 0 8px", fontSize:11, fontWeight:600, color:"rgba(255,255,255,0.35)", textTransform:"uppercase", letterSpacing:1.5 }}>🚌 Bus & Other</p>
      <div style={{ ...GLASS_MID, borderRadius:16, padding:"14px 16px", marginBottom:14 }}>
        <p style={{ margin:0, fontSize:13, color:"rgba(255,255,255,0.6)", lineHeight:1.5 }}>{travel.byBus.detail}</p>
      </div>
    </div>
  );
}

// ─── Summary section ──────────────────────────────────────────────────────────
function SummarySection({ park, pdata, liveQueues, getLiveWait }) {
  const rides     = pdata.rides     || [];
  const itinerary = pdata.itinerary || [];
  const dining    = pdata.dining    || [];
  const budget    = pdata.budget    || { total:"", items:[] };
  const packing   = pdata.packing   || [];
  const notes     = pdata.notes     || "";

  const doneRides   = rides.filter(r=>r.done).length;
  const starRides   = rides.filter(r=>r.star);
  const totalSpent  = budget.items.reduce((s,i)=>s+(parseFloat(i.amount)||0),0);
  const budgetLeft  = (parseFloat(budget.total)||0)-totalSpent;
  const packDone    = packing.filter(i=>i.checked).length;
  const sortedItin  = [...itinerary].sort((a,b)=>a.time.localeCompare(b.time));
  const readyToGo   = packDone === packing.length && packing.length > 0;

  const daysUntil = park?.date ? Math.ceil((new Date(park.date) - new Date()) / 86400000) : null;

  return (
    <div>
      {/* Hero summary card */}
      <div style={{ ...GLASS_HEAVY, borderRadius:22, padding:"20px", marginBottom:16, position:"relative", overflow:"hidden" }}>
        <div style={{ position:"absolute", top:-20, right:-20, width:80, height:80, borderRadius:"50%", background:"rgba(39,174,96,0.15)" }} />
        <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:16 }}>
          <span style={{ fontSize:36 }}>{park.emoji||"🏰"}</span>
          <div>
            <h2 style={{ margin:0, fontSize:20, fontWeight:900, color:"#fff" }}>{park.name}</h2>
            {park.date && <p style={{ margin:"2px 0 0", fontSize:13, color:"rgba(255,255,255,0.5)" }}>{fmtDate(park.date)}{daysUntil!==null && daysUntil>=0 ? ` · ${daysUntil===0?"Today! 🎉":`${daysUntil} day${daysUntil!==1?"s":""} to go`}` : ""}</p>}
          </div>
          {readyToGo && (
            <div style={{ marginLeft:"auto", background:"rgba(39,174,96,0.2)", borderRadius:12, padding:"6px 12px" }}>
              <p style={{ margin:0, fontSize:12, fontWeight:700, color:"#27AE60" }}>✓ Ready!</p>
            </div>
          )}
        </div>
        {/* Stats row */}
        <div style={{ display:"flex", gap:8 }}>
          {[
            { label:"Rides", value:rides.length, color:"#5B8BF5" },
            { label:"Dining", value:dining.length, color:"#F5922E" },
            { label:"Packed", value:`${packDone}/${packing.length}`, color: readyToGo?"#27AE60":"#F5922E" },
            budget.total ? { label:"Budget", value:`£${parseFloat(budget.total).toFixed(0)}`, color:"#E8445A" } : null,
          ].filter(Boolean).map((s,i) => (
            <div key={i} style={{ flex:1, background:"rgba(255,255,255,0.07)", borderRadius:12, padding:"10px 8px", textAlign:"center" }}>
              <p style={{ margin:0, fontSize:18, fontWeight:900, color:s.color }}>{s.value}</p>
              <p style={{ margin:"2px 0 0", fontSize:10, color:"rgba(255,255,255,0.4)", textTransform:"uppercase", letterSpacing:0.8 }}>{s.label}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Crowd estimate */}
      {park.date && (() => {
        const score = getCrowdScore(park.date);
        const crowd = getCrowdLabel(score);
        if (!crowd) return null;
        return (
          <div style={{ ...GLASS_MID, borderRadius:16, padding:"14px 16px", marginBottom:14, display:"flex", alignItems:"center", gap:12 }}>
            <span style={{ fontSize:28 }}>{crowd.emoji}</span>
            <div style={{ flex:1 }}>
              <p style={{ margin:0, fontSize:15, fontWeight:700, color:crowd.color }}>{crowd.label} day</p>
              <p style={{ margin:"2px 0 0", fontSize:12, color:"rgba(255,255,255,0.4)" }}>{crowd.tip}</p>
            </div>
            <div style={{ height:40, width:40, borderRadius:"50%", background:`conic-gradient(${crowd.color} ${score*3.6}deg, rgba(255,255,255,0.08) 0deg)`, display:"flex", alignItems:"center", justifyContent:"center" }}>
              <div style={{ width:28, height:28, borderRadius:"50%", background:"#0d0d12", display:"flex", alignItems:"center", justifyContent:"center" }}>
                <span style={{ fontSize:10, fontWeight:900, color:crowd.color }}>{score}</span>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Must-do rides */}
      {starRides.length > 0 && (
        <div style={{ marginBottom:14 }}>
          <p style={{ margin:"0 0 10px", fontSize:11, fontWeight:600, color:"rgba(255,255,255,0.35)", textTransform:"uppercase", letterSpacing:1.5 }}>⭐ Must-Do Rides</p>
          <div style={{ ...GLASS_MID, borderRadius:16, padding:"4px 0" }}>
            {starRides.map((r,i) => {
              const live = getLiveWait ? getLiveWait(r) : null;
              return (
                <div key={r.id} style={{ display:"flex", alignItems:"center", gap:12, padding:"12px 16px", borderBottom:i<starRides.length-1?"1px solid rgba(255,255,255,0.06)":"none" }}>
                  <span style={{ fontSize:20 }}>🎢</span>
                  <span style={{ flex:1, fontSize:14, fontWeight:600, color: r.done?"rgba(255,255,255,0.3)":"rgba(255,255,255,0.85)", textDecoration:r.done?"line-through":"none" }}>{r.name}</span>
                  {live && <span style={{ fontSize:12, fontWeight:700, color:live.wait<=15?"#27AE60":live.wait<=40?"#F5922E":"#E8445A" }}>{live.status==="closed"?"Closed":`${live.wait}m`}</span>}
                  {r.done && <span style={{ fontSize:11, background:"rgba(39,174,96,0.15)", color:"#27AE60", padding:"2px 8px", borderRadius:20, fontWeight:700 }}>Done</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Full schedule */}
      {sortedItin.length > 0 && (
        <div style={{ marginBottom:14 }}>
          <p style={{ margin:"0 0 10px", fontSize:11, fontWeight:600, color:"rgba(255,255,255,0.35)", textTransform:"uppercase", letterSpacing:1.5 }}>📅 Your Schedule</p>
          {sortedItin.map((item,idx,arr) => {
            const t = ITEM_TYPES[item.type]||ITEM_TYPES.other;
            return (
              <div key={item.id} style={{ display:"flex", gap:12, marginBottom:4 }}>
                <div style={{ display:"flex", flexDirection:"column", alignItems:"center", paddingTop:12, width:28 }}>
                  <div style={{ width:8, height:8, borderRadius:"50%", background:t.color, flexShrink:0 }} />
                  {idx<arr.length-1 && <div style={{ width:2, flex:1, background:"rgba(255,255,255,0.08)", margin:"3px 0", minHeight:20 }} />}
                </div>
                <div style={{ flex:1, ...GLASS_MID, borderRadius:12, padding:"10px 14px", marginBottom:4 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                    <span style={{ fontSize:11, fontWeight:700, color:t.color }}>{item.time}</span>
                    <span style={{ fontSize:16 }}>{t.icon}</span>
                    <span style={{ fontSize:14, fontWeight:600, color:"rgba(255,255,255,0.85)", flex:1 }}>{item.activity||"—"}</span>
                    {item.duration > 0 && <span style={{ fontSize:11, color:"rgba(255,255,255,0.3)" }}>{item.duration}m</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Dining summary */}
      {dining.length > 0 && (
        <div style={{ marginBottom:14 }}>
          <p style={{ margin:"0 0 10px", fontSize:11, fontWeight:600, color:"rgba(255,255,255,0.35)", textTransform:"uppercase", letterSpacing:1.5 }}>🍽 Dining Plan</p>
          <div style={{ ...GLASS_MID, borderRadius:16, padding:"4px 0" }}>
            {dining.map((d,i) => (
              <div key={d.id} style={{ display:"flex", alignItems:"center", gap:12, padding:"12px 16px", borderBottom:i<dining.length-1?"1px solid rgba(255,255,255,0.06)":"none" }}>
                <span style={{ fontSize:20 }}>{d.type==="snack"?"🍦":d.type==="drinks"?"🥤":d.type==="dessert"?"🍰":d.type==="fastfood"?"🍟":"🍽"}</span>
                <div style={{ flex:1 }}>
                  <p style={{ margin:0, fontSize:14, fontWeight:600, color:"rgba(255,255,255,0.85)" }}>{d.name||"Unnamed"}</p>
                  <p style={{ margin:0, fontSize:12, color:"rgba(255,255,255,0.35)" }}>{d.time||"Time TBC"}{d.cost?` · £${d.cost}`:""}</p>
                </div>
                {d.booked && <span style={{ fontSize:11, background:"rgba(39,174,96,0.15)", color:"#27AE60", padding:"2px 8px", borderRadius:20, fontWeight:700 }}>Booked</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Budget summary */}
      {budget.total && (
        <div style={{ marginBottom:14 }}>
          <p style={{ margin:"0 0 10px", fontSize:11, fontWeight:600, color:"rgba(255,255,255,0.35)", textTransform:"uppercase", letterSpacing:1.5 }}>💰 Budget</p>
          <div style={{ ...GLASS_MID, borderRadius:16, padding:"16px" }}>
            <div style={{ display:"flex", justifyContent:"space-between", marginBottom:10 }}>
              <span style={{ fontSize:14, color:"rgba(255,255,255,0.5)" }}>Total budget</span>
              <span style={{ fontSize:14, fontWeight:700, color:"#fff" }}>£{parseFloat(budget.total).toFixed(2)}</span>
            </div>
            {budget.items.map((item,i) => (
              <div key={item.id} style={{ display:"flex", justifyContent:"space-between", padding:"6px 0", borderTop:"1px solid rgba(255,255,255,0.06)" }}>
                <span style={{ fontSize:13, color:"rgba(255,255,255,0.5)" }}>{item.emoji||"📌"} {item.label||"Expense"}</span>
                <span style={{ fontSize:13, fontWeight:600, color:"rgba(255,255,255,0.7)" }}>£{parseFloat(item.amount||0).toFixed(2)}</span>
              </div>
            ))}
            <div style={{ borderTop:"1px solid rgba(255,255,255,0.1)", marginTop:8, paddingTop:10, display:"flex", justifyContent:"space-between" }}>
              <span style={{ fontSize:14, fontWeight:700, color:"rgba(255,255,255,0.6)" }}>Remaining</span>
              <span style={{ fontSize:16, fontWeight:900, color: budgetLeft>=0?"#27AE60":"#E8445A" }}>£{Math.abs(budgetLeft).toFixed(2)}{budgetLeft<0?" over":""}</span>
            </div>
          </div>
        </div>
      )}

      {/* Packing summary */}
      {packing.length > 0 && (
        <div style={{ marginBottom:14 }}>
          <p style={{ margin:"0 0 10px", fontSize:11, fontWeight:600, color:"rgba(255,255,255,0.35)", textTransform:"uppercase", letterSpacing:1.5 }}>🎒 Packing — {packDone}/{packing.length}</p>
          <div style={{ ...GLASS_MID, borderRadius:16, padding:"12px 16px" }}>
            <div style={{ height:5, background:"rgba(255,255,255,0.08)", borderRadius:3, marginBottom:12 }}>
              <div style={{ height:"100%", borderRadius:3, background:readyToGo?"#27AE60":"linear-gradient(90deg,#00B4DB,#0083B0)", width:`${packing.length?Math.round((packDone/packing.length)*100):0}%`, transition:"width 0.4s" }} />
            </div>
            <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
              {packing.map(item => (
                <span key={item.id} style={{ fontSize:12, padding:"4px 10px", borderRadius:20, background:item.checked?"rgba(39,174,96,0.15)":"rgba(255,255,255,0.07)", color:item.checked?"#27AE60":"rgba(255,255,255,0.4)", textDecoration:item.checked?"none":"none", fontWeight:item.checked?600:400 }}>
                  {item.checked?"✓ ":""}{item.name}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Notes */}
      {notes.trim() && (
        <div style={{ marginBottom:14 }}>
          <p style={{ margin:"0 0 10px", fontSize:11, fontWeight:600, color:"rgba(255,255,255,0.35)", textTransform:"uppercase", letterSpacing:1.5 }}>📓 Notes</p>
          <div style={{ ...GLASS_MID, borderRadius:16, padding:"14px 16px" }}>
            <p style={{ margin:0, fontSize:14, color:"rgba(255,255,255,0.6)", lineHeight:1.7, whiteSpace:"pre-wrap" }}>{notes}</p>
          </div>
        </div>
      )}

      {/* Empty state */}
      {rides.length===0 && itinerary.length===0 && dining.length===0 && (
        <div style={{ textAlign:"center", padding:"30px 20px" }}>
          <p style={{ margin:"0 0 6px", fontSize:16, fontWeight:700, color:"rgba(255,255,255,0.4)" }}>Nothing planned yet</p>
          <p style={{ margin:0, fontSize:13, color:"rgba(255,255,255,0.25)" }}>Add rides, build your schedule and plan your dining — it'll all appear here</p>
        </div>
      )}
    </div>
  );
}

const backBtn    = { background:"rgba(255,255,255,0.2)",border:"none",borderRadius:20,padding:"6px 14px",color:"#fff",fontSize:14,fontWeight:700,cursor:"pointer",marginBottom:18,display:"inline-block" };
const darkBtn    = { ...GLASS_LIGHT, border:"none",borderRadius:20,padding:"7px 14px",color:"#fff",fontSize:14,fontWeight:700,cursor:"pointer" };
const createH2   = { margin:"0 0 4px",fontSize:24,fontWeight:900,color:"#1C1C1E" };
const createSub  = { margin:"0 0 20px",fontSize:16,color:"#8E8E93" };
const createLabel= { margin:"0 0 6px",fontSize:13,fontWeight:700,color:"#8E8E93",textTransform:"uppercase",letterSpacing:0.4 };
const createInput= { width:"100%",minWidth:0,background:"#fff",border:"none",borderRadius:14,padding:"15px 16px",fontSize:17,color:"#1C1C1E",boxSizing:"border-box",outline:"none",marginBottom:12,fontFamily:"inherit",boxShadow:"0 1px 3px rgba(0,0,0,0.07)",display:"block" };
const sheetInput = { width:"100%",background:"#2C2C2E",border:"none",borderRadius:12,padding:"13px 14px",fontSize:16,color:"#fff",boxSizing:"border-box",marginBottom:12,outline:"none",fontFamily:"inherit" };
const sheetSelect= { width:"100%",background:"#2C2C2E",border:"none",borderRadius:12,padding:"13px 14px",fontSize:16,color:"#fff",boxSizing:"border-box",marginBottom:12,fontFamily:"inherit",cursor:"pointer" };
