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
4. Under **Redirect URIs**, add: `https://musicplayer.test:8888/callback`
5. Check **Web API** and click **Save**
6. Copy your **Client ID** and **Client Secret**

### 3. Run

Double-click `NowPlaying.exe`.

- **First launch only:** a UAC prompt will appear to install a local HTTPS certificate and add a hosts entry — this is a one-time setup, it never happens again.
- Your browser opens automatically to the setup page.
- Enter your **Client ID** and **Client Secret**, then log in to Spotify.

### 4. Add to OBS

1. In OBS, add a **Browser Source**
2. Set the URL to: `https://musicplayer.test:8888/overlay`
3. Set width/height to match your canvas (e.g. 1920×1080)
4. Check **Shutdown source when not visible**

### 5. Customize

Right-click the tray icon → **Open Config**, or go to `https://musicplayer.test:8888/config`. Changes apply live.

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
    ├── First run: generates HTTPS cert, installs CA, adds hosts entry
    │
    ├── /setup       → enter Spotify credentials (first run only)
    ├── /login       → Spotify OAuth redirect
    ├── /callback    → receives auth code, stores token
    ├── /overlay     → OBS browser source URL
    ├── /config      → live customization UI
    ├── /now-playing → polling endpoint
    └── /lyrics      → fetches synced lyrics from lrclib.net
```

Credentials are saved to `credentials.json` next to the exe. Never shared.

---

## Lyrics

Lyrics are fetched from [lrclib.net](https://lrclib.net) — a free, open lyrics database. Synced (timestamped) lyrics are used when available, falling back to plain lyrics if not.

---

## License

MIT
