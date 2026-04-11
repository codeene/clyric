// ── Spotify Now Playing Overlay Server ───────────────────────────
// Usage:
//   1. npm install
//   2. node server.js
//   3. Follow the setup page to enter your Spotify credentials
//   4. Add http://localhost:8888/overlay as an OBS browser source
//   5. Customize at http://localhost:8888/config

const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 8888;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPES = "user-read-currently-playing user-read-playback-state";
const SETTINGS_FILE     = path.join(__dirname, "settings.json");
const CREDENTIALS_FILE  = path.join(__dirname, "credentials.json");

// ── Load credentials ─────────────────────────────────────────
function loadCredentials() {
  try {
    if (fs.existsSync(CREDENTIALS_FILE)) {
      return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf8"));
    }
  } catch {}
  return null;
}

let creds = loadCredentials();
let CLIENT_ID     = creds?.clientId     || "";
let CLIENT_SECRET = creds?.clientSecret || "";

const DEFAULT_SETTINGS = {
  albumArt:    { enabled: true,  size: 120, borderRadius: 12 },
  title:       { enabled: true,  fontSize: 22, color: "#ffffff" },
  artist:      { enabled: true,  fontSize: 15, color: "#b3b3b3" },
  album:       { enabled: false, fontSize: 13, color: "#888888" },
  progressBar: { enabled: true,  color: "#1db954" },
  lyrics:      { enabled: true,  fontSize: 15, activeColor: "#ffffff", inactiveColor: "#555555", linesAbove: 2, linesBelow: 2 },
  layout:      "horizontal",
  background:  { color: "rgba(10,10,15,0.85)", blur: 12 },
  animation:   "slide",
  font:        "Default",
};

const app = express();
app.use(express.json());

let tokenData = null;
const lyricsCache = new Map(); // key: "title||artist" → parsed lines

// ── Helpers ─────────────────────────────────────────────────────
function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
}

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) };
    }
  } catch {}
  return { ...DEFAULT_SETTINGS };
}

function parseLRC(lrc) {
  const lines = [];
  for (const line of lrc.split("\n")) {
    const match = line.match(/^\[(\d+):(\d+\.\d+)\](.*)/);
    if (match) {
      const time = parseInt(match[1]) * 60 + parseFloat(match[2]);
      const text = match[3].trim();
      if (text) lines.push({ time, text });
    }
  }
  return lines;
}

async function ensureFreshToken() {
  if (!tokenData) return null;
  if (Date.now() > tokenData.expires_at - 5 * 60 * 1000) {
    try {
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokenData.refresh_token,
      });
      const authHeader = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
      const response = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${authHeader}`,
        },
        body: body.toString(),
      });
      const data = await response.json();
      if (data.access_token) {
        tokenData.access_token = data.access_token;
        tokenData.expires_at = Date.now() + data.expires_in * 1000;
        if (data.refresh_token) tokenData.refresh_token = data.refresh_token;
        console.log("🔄 Token refreshed automatically.");
      }
    } catch (err) {
      console.error("Refresh error:", err);
    }
  }
  return tokenData.access_token;
}

// ── Setup ────────────────────────────────────────────────────────
app.get("/setup", (req, res) => {
  res.sendFile(path.join(__dirname, "setup.html"));
});

app.post("/setup", express.json(), (req, res) => {
  const { clientId, clientSecret } = req.body || {};
  if (!clientId || !clientSecret) {
    return res.json({ ok: false, error: "Missing clientId or clientSecret." });
  }
  try {
    fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify({ clientId, clientSecret }, null, 2));
    CLIENT_ID     = clientId;
    CLIENT_SECRET = clientSecret;
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ── Auth flow ────────────────────────────────────────────────────
app.get("/login", (req, res) => {
  if (!CLIENT_ID || !CLIENT_SECRET) return res.redirect("/setup");
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    show_dialog: "true",
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

app.get("/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.send("Error: no code received.");
  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
    });
    const authHeader = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
    const response = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${authHeader}`,
      },
      body: body.toString(),
    });
    const data = await response.json();
    if (data.access_token) {
      tokenData = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + data.expires_in * 1000,
      };
      console.log("\n✅ Authenticated! Token ready.");
      res.send(`
        <html><body style="background:#0a0a0f;color:#f0ece4;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:16px;">
          <h1 style="color:#1db954;">✅ Connected to Spotify!</h1>
          <p>Your overlay is ready.</p>
          <p><a href="http://localhost:${PORT}/config" style="color:#1db954;">Open Config →</a></p>
        </body></html>
      `);
    } else {
      res.send("Error getting token: " + JSON.stringify(data));
    }
  } catch (err) {
    res.send("Error: " + err.message);
  }
});

// ── Token (legacy) ───────────────────────────────────────────────
app.get("/token", async (req, res) => {
  corsHeaders(res);
  const token = await ensureFreshToken();
  if (!token) return res.json({ error: "Not authenticated." });
  res.json({ access_token: token });
});

// ── Now Playing ──────────────────────────────────────────────────
app.get("/now-playing", async (req, res) => {
  corsHeaders(res);
  const token = await ensureFreshToken();
  if (!token) return res.json({ is_playing: false, error: "Not authenticated." });

  try {
    const response = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.status === 204 || response.status === 404) {
      return res.json({ is_playing: false });
    }

    const data = await response.json();
    if (!data || !data.item) return res.json({ is_playing: false });

    const track = data.item;
    res.json({
      is_playing: data.is_playing,
      track_id: track.id,
      title: track.name,
      artist: track.artists.map((a) => a.name).join(", "),
      album: track.album.name,
      album_art_url: track.album.images[0]?.url ?? null,
      duration_ms: track.duration_ms,
      progress_ms: data.progress_ms,
    });
  } catch (err) {
    console.error("Now-playing error:", err);
    res.json({ is_playing: false });
  }
});

// ── Lyrics ───────────────────────────────────────────────────────
app.get("/lyrics", async (req, res) => {
  corsHeaders(res);
  const { title, artist, album, duration } = req.query;
  if (!title || !artist) return res.json({ synced: false, lines: [] });

  const cacheKey = `${title}||${artist}`;
  if (lyricsCache.has(cacheKey)) {
    return res.json(lyricsCache.get(cacheKey));
  }

  try {
    const params = new URLSearchParams({
      track_name: title,
      artist_name: artist,
      ...(album ? { album_name: album } : {}),
      ...(duration ? { duration: Math.round(Number(duration) / 1000) } : {}),
    });

    const response = await fetch(`https://lrclib.net/api/get?${params}`, {
      headers: { "User-Agent": "SpotifyOBSOverlay/1.0" },
    });

    if (!response.ok) {
      const result = { synced: false, lines: [] };
      lyricsCache.set(cacheKey, result);
      return res.json(result);
    }

    const data = await response.json();
    let result;

    if (data.syncedLyrics) {
      result = { synced: true, lines: parseLRC(data.syncedLyrics) };
    } else if (data.plainLyrics) {
      const lines = data.plainLyrics.split("\n").filter(Boolean).map((text) => ({ time: null, text }));
      result = { synced: false, lines };
    } else {
      result = { synced: false, lines: [] };
    }

    // Keep cache bounded
    if (lyricsCache.size >= 50) {
      lyricsCache.delete(lyricsCache.keys().next().value);
    }
    lyricsCache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error("Lyrics error:", err);
    res.json({ synced: false, lines: [] });
  }
});

// ── Settings ─────────────────────────────────────────────────────
app.get("/settings", (req, res) => {
  corsHeaders(res);
  res.json(loadSettings());
});

app.post("/settings", (req, res) => {
  corsHeaders(res);
  try {
    const merged = { ...loadSettings(), ...req.body };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Overlay & Config pages ───────────────────────────────────────
app.get("/overlay", (req, res) => {
  res.sendFile(path.join(__dirname, "overlay.html"));
});

app.get("/config", (req, res) => {
  res.sendFile(path.join(__dirname, "config.html"));
});

// ── Start ────────────────────────────────────────────────────────
const server = http.createServer(app);

server.listen(PORT, () => {
  console.log(`\n🎵 Spotify Overlay Server — port ${PORT}`);
  console.log(`   Redirect URI in use: ${REDIRECT_URI}`);
  console.log(`   http://localhost:${PORT}/login   → Authenticate with Spotify`);
  console.log(`   http://localhost:${PORT}/overlay → OBS browser source URL`);
  console.log(`   http://localhost:${PORT}/config  → Customization UI\n`);
  const startUrl = (CLIENT_ID && CLIENT_SECRET)
    ? `http://localhost:${PORT}/login`
    : `http://localhost:${PORT}/setup`;
  try {
    const open = require("open");
    const opener = open.default || open;
    opener(startUrl);
  } catch {
    console.log(`   Open ${startUrl} in your browser.\n`);
  }
});
