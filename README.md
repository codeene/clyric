# Now Playing — Spotify OBS Overlay

A real-time Spotify now-playing overlay for OBS with synced lyrics, customizable fonts, and a live config UI.

![overlay preview](https://i.imgur.com/placeholder.png)

---

## Features

- **Now playing** — album art, title, artist, album
- **Synced lyrics** — real-time karaoke-style display via lrclib
- **Font picker** — 10 Google Fonts built in
- **Live config** — tweak everything without restarting
- **Auto token refresh** — stays authenticated in the background

---

## Requirements

- [Node.js](https://nodejs.org/) v18 or newer
- A free [Spotify Developer](https://developer.spotify.com/) account

---

## Setup

### 1. Get the app

```bash
git clone https://github.com/yourusername/now-playing.git
cd now-playing
npm install
```

### 2. Create a Spotify app

1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
2. Click **Create app**
3. Fill in any name and description
4. Under **Redirect URIs**, add: `http://localhost:8888/callback`
5. Check **Web API** and click **Save**
6. Copy your **Client ID** and **Client Secret**

### 3. Start the server

```bash
node server.js
```

Your browser will open automatically. Enter your Client ID and Client Secret in the setup page, then authorize with Spotify.

### 4. Add to OBS

1. In OBS, add a **Browser Source**
2. Set the URL to: `http://localhost:8888/overlay`
3. Set width/height to match your canvas (e.g. 1920×1080)
4. Check **Shutdown source when not visible**

### 5. Customize

Open `http://localhost:8888/config` to adjust fonts, colors, layout, lyrics, and more. Changes apply live.

---

## How it works

```
node server.js
    │
    ├── /setup       → enter Spotify credentials (first run only)
    ├── /login       → Spotify OAuth redirect
    ├── /callback    → receives auth code, stores token
    ├── /overlay     → OBS browser source URL
    ├── /config      → live customization UI
    ├── /now-playing → polling endpoint (every 2s)
    └── /lyrics      → fetches synced lyrics from lrclib.net
```

Credentials are saved to `credentials.json` on your machine. This file is gitignored and never shared.

---

## Lyrics

Lyrics are fetched from [lrclib.net](https://lrclib.net) — a free, open lyrics database. Synced (timestamped) lyrics are used when available, falling back to plain lyrics if not.

---

## License

MIT
