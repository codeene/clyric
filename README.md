# Now Playing — Spotify OBS Overlay

A real-time Spotify now-playing overlay for OBS with synced lyrics, customizable fonts, and a live config UI.

---

## Features

- **Now playing** — album art, title, artist, album
- **Synced lyrics** — real-time karaoke-style display via lrclib
- **Font picker** — 10 Google Fonts built in
- **Live config** — tweak everything without restarting
- **Auto token refresh** — stays authenticated in the background
- **System tray** — runs quietly in the background, won't get closed by accident

---

## Installation (Windows)

### 1. Download

Grab `NowPlaying.exe` from the [Releases](../../releases) page.

### 2. Create a Spotify app

1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
2. Click **Create app**
3. Fill in any name and description
4. Under **Redirect URIs**, add: `https://localhost:8888/callback`
5. Check **Web API** and click **Save**
6. Copy your **Client ID** and **Client Secret**

### 3. Run

Double-click `NowPlaying.exe`.

- **First launch only:** a standard Windows dialog will appear asking you to confirm installing a local HTTPS certificate — this is a one-time setup, it never happens again. No admin rights required.
- Your browser opens automatically to the setup page.
- Enter your **Client ID** and **Client Secret**, then log in to Spotify.

### 4. Add to OBS

1. In OBS, add a **Browser Source**
2. Set the URL to: `http://localhost:8889/overlay`
3. Set width/height to fit your layout (e.g. 500×150 for horizontal, 200×400 for vertical)
4. Check **Shutdown source when not visible**

### 5. Customize

Right-click the tray icon → **Open Config**, or go to `https://localhost:8888/config`. Changes apply live.

> The OBS browser source uses `http://localhost:8889/overlay` (plain HTTP) because OBS's built-in browser does not trust locally-generated HTTPS certificates.

---

## Running from source

Requires [Node.js](https://nodejs.org/) v18+.

```bash
git clone https://github.com/codeene/clyric.git
cd clyric
npm install
node server.js
```

To build the exe yourself:

```bash
npm run build
# outputs dist/NowPlaying.exe
```

---

## How it works

```
NowPlaying.exe
    │
    ├── First run: generates HTTPS cert, installs CA to user cert store (no admin)
    │
    ├── https://localhost:8888  (Spotify auth + config)
    │     ├── /setup       → enter Spotify credentials (first run only)
    │     ├── /login       → Spotify OAuth redirect
    │     ├── /callback    → receives auth code, stores token
    │     └── /config      → live customization UI
    │
    └── http://localhost:8889  (OBS browser source)
          ├── /overlay     → OBS browser source URL
          ├── /now-playing → polling endpoint
          └── /lyrics      → fetches synced lyrics from lrclib.net
```

Credentials and settings are saved to `%APPDATA%\NowPlaying` on your machine. Never shared.

---

## Lyrics

Lyrics are fetched from [lrclib.net](https://lrclib.net) — a free, open lyrics database. Synced (timestamped) lyrics are used when available, falling back to plain lyrics if not.

---

## License

MIT
