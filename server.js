// ── Spotify Now Playing Overlay Server ───────────────────────────
// First run: auto-generates HTTPS certs + installs CA to user cert store (no admin required).
// Subsequent runs: just start and go.

const express      = require('express');
const https        = require('https');
const http         = require('http');
const fs           = require('fs');
const path         = require('path');
const forge        = require('node-forge');
const { execSync } = require('child_process');
const os           = require('os');

const PORT         = 8888;
const OBS_PORT     = 8889;
const DOMAIN       = 'localhost';
const REDIRECT_URI = `http://127.0.0.1:${OBS_PORT}/callback`;
const SCOPES       = 'user-read-currently-playing user-read-playback-state';

// When bundled with pkg, __dirname is read-only (inside the snapshot).
// Writable files go in %APPDATA%\NowPlaying so they don't clutter the exe folder.
const isPkg    = typeof process.pkg !== 'undefined';
const DATA_DIR = isPkg
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'NowPlaying')
  : __dirname;

// Ensure the data directory exists
fs.mkdirSync(DATA_DIR, { recursive: true });

const SETTINGS_FILE    = path.join(DATA_DIR, 'settings.json');
const CREDENTIALS_FILE = path.join(DATA_DIR, 'credentials.json');
const TOKEN_FILE       = path.join(DATA_DIR, 'token.json');
const CA_FILE          = path.join(DATA_DIR, 'ca.crt');
const CERT_FILE        = path.join(DATA_DIR, 'cert.pem');
const KEY_FILE         = path.join(DATA_DIR, 'key.pem');

// ── Load credentials ──────────────────────────────────────────────
function loadCredentials() {
  try {
    if (fs.existsSync(CREDENTIALS_FILE))
      return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
  } catch {}
  return null;
}

let creds         = loadCredentials();
let CLIENT_ID     = creds?.clientId     || '';
let CLIENT_SECRET = creds?.clientSecret || '';

const DEFAULT_SETTINGS = {
  albumArt:    { enabled: true,  size: 120, borderRadius: 12 },
  title:       { enabled: true,  fontSize: 22, color: '#ffffff' },
  artist:      { enabled: true,  fontSize: 15, color: '#b3b3b3' },
  album:       { enabled: false, fontSize: 13, color: '#888888' },
  progressBar: { enabled: true,  color: '#1db954', showTimeRemaining: false },
  controls:    { enabled: true,  color: '#ffffff', size: 22 },
  lyrics:      { enabled: true,  fontSize: 15, activeColor: '#ffffff', inactiveColor: '#555555', linesAbove: 2, linesBelow: 2, textAlign: 'left' },
  layout:      'horizontal',
  background:  { color: 'rgba(10,10,15,0.85)', blur: 12 },
  card:        { borderRadius: 16, maxWidth: 720 },
  animation:   'slide',
  font:        'Default',
  animations: {
    albumArtStyle: 'normal',   // normal | vinyl | float | glow | reflection | kenburns
    songChange:    'slide',    // fade | slide | flip | blur | glitch
    background:    'none',     // none | gradient | bokeh | grain
    progressStyle: 'normal',   // normal | shimmer | glow | gradient
    lyricsEffect:  'normal',   // normal | wave
    ambientColor:  false,
    autoColor:     false,      // auto-tint title/artist/progress from album art
    bpmPulse:      false,      // pulse card to beat (uses Spotify audio features)
    borderGlow:    false,      // animated ambient glow border around card
    confetti:      false,      // confetti burst on song change
  },
  position: {
    preset: 'top-left',        // top-left | top-center | top-right | center-left | center | center-right | bottom-left | bottom-center | bottom-right | custom
    x: 16,
    y: 16,
  },
  cardStyle:  'frosted',       // frosted | ghost | outlined | solid
  textEffect: 'none',          // none | shadow | glow | outline
  eq:      { enabled: false, style: 'classic', placement: 'beside' },
  marquee: { enabled: false },
  idle:    { style: 'pulse' }, // hidden | pulse | notes | wave | disc
};

// ── Certificate generation (pure JS, no elevation needed) ─────────
function generateCerts() {
  console.log('Generating local HTTPS certificates (one-time, ~15 seconds)…');

  // CA
  const caKeys = forge.pki.rsa.generateKeyPair(2048);
  const caCert = forge.pki.createCertificate();
  caCert.publicKey = caKeys.publicKey;
  caCert.serialNumber = '01';
  caCert.validity.notBefore = new Date();
  caCert.validity.notAfter  = new Date();
  caCert.validity.notAfter.setFullYear(caCert.validity.notBefore.getFullYear() + 10);
  const caAttrs = [
    { name: 'commonName',       value: 'NowPlaying Local CA' },
    { name: 'organizationName', value: 'NowPlaying Overlay'  },
  ];
  caCert.setSubject(caAttrs);
  caCert.setIssuer(caAttrs);
  caCert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  caCert.sign(caKeys.privateKey, forge.md.sha256.create());

  // Server cert signed by our CA
  const srvKeys = forge.pki.rsa.generateKeyPair(2048);
  const srvCert = forge.pki.createCertificate();
  srvCert.publicKey = srvKeys.publicKey;
  srvCert.serialNumber = '02';
  srvCert.validity.notBefore = new Date();
  srvCert.validity.notAfter  = new Date();
  srvCert.validity.notAfter.setFullYear(srvCert.validity.notBefore.getFullYear() + 3);
  const srvAttrs = [{ name: 'commonName', value: DOMAIN }];
  srvCert.setSubject(srvAttrs);
  srvCert.setIssuer(caAttrs);
  srvCert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    {
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1'   },
      ],
    },
  ]);
  srvCert.sign(caKeys.privateKey, forge.md.sha256.create());

  fs.writeFileSync(CA_FILE,   forge.pki.certificateToPem(caCert));
  fs.writeFileSync(CERT_FILE, forge.pki.certificateToPem(srvCert));
  fs.writeFileSync(KEY_FILE,  forge.pki.privateKeyToPem(srvKeys.privateKey));
  console.log('Certificates generated ✓');
}

// ── First-run setup (no admin required) ──────────────────────────
async function firstRunSetup() {
  const certsReady = fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE) && fs.existsSync(CA_FILE);
  if (certsReady) return;

  generateCerts();

  // Install CA to the current user's cert store — no admin/UAC needed.
  // Windows will show a standard "Do you want to install this certificate?" dialog.
  console.log('\nInstalling certificate to user store (a Windows confirmation dialog will appear)…');
  try {
    execSync(
      `certutil -addstore -user Root "${CA_FILE.replace(/\//g, '\\')}"`,
      { stdio: 'inherit' }
    );
    console.log('Certificate installed ✓\n');
  } catch (err) {
    console.error('Certificate install failed:', err.message);
  }
}

// ── Express app ───────────────────────────────────────────────────
const app = express();
app.use(express.json());

function loadToken() {
  try {
    if (fs.existsSync(TOKEN_FILE))
      return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch {}
  return null;
}

function saveToken(data) {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2));
  } catch {}
}

let tokenData = loadToken();
const lyricsCache = new Map();

function corsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
}

function loadSettings(profile = 1) {
  const file = path.join(DATA_DIR, `settings-${profile}.json`);
  try {
    if (fs.existsSync(file))
      return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    // Migrate legacy settings.json → settings-1.json on first upgrade
    if (profile === 1 && fs.existsSync(SETTINGS_FILE))
      return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch {}
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(profile, data) {
  fs.writeFileSync(path.join(DATA_DIR, `settings-${profile}.json`), JSON.stringify(data, null, 2));
}

function parseLRC(lrc) {
  const lines = [];
  for (const line of lrc.split('\n')) {
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
        grant_type:    'refresh_token',
        refresh_token: tokenData.refresh_token,
      });
      const authHeader = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
      const response = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${authHeader}`,
        },
        body: body.toString(),
      });
      const data = await response.json();
      if (data.access_token) {
        tokenData.access_token = data.access_token;
        tokenData.expires_at   = Date.now() + data.expires_in * 1000;
        if (data.refresh_token) tokenData.refresh_token = data.refresh_token;
        saveToken(tokenData);
        console.log('🔄 Token refreshed.');
      }
    } catch (err) {
      console.error('Refresh error:', err);
    }
  }
  return tokenData.access_token;
}

// ── Routes ────────────────────────────────────────────────────────
app.get('/setup',  (req, res) => res.sendFile(path.join(__dirname, 'setup.html')));

app.post('/setup', (req, res) => {
  const { clientId, clientSecret } = req.body || {};
  if (!clientId || !clientSecret)
    return res.json({ ok: false, error: 'Missing clientId or clientSecret.' });
  try {
    fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify({ clientId, clientSecret }, null, 2));
    CLIENT_ID     = clientId;
    CLIENT_SECRET = clientSecret;
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.get('/login', (req, res) => {
  if (!CLIENT_ID || !CLIENT_SECRET) return res.redirect('/setup');
  const params = new URLSearchParams({
    client_id:     CLIENT_ID,
    response_type: 'code',
    redirect_uri:  REDIRECT_URI,
    scope:         SCOPES,
    show_dialog:   'true',
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

app.get('/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.send('Error: no code received.');
  try {
    const body = new URLSearchParams({
      grant_type:   'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    });
    const authHeader = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${authHeader}`,
      },
      body: body.toString(),
    });
    const data = await response.json();
    if (data.access_token) {
      tokenData = {
        access_token:  data.access_token,
        refresh_token: data.refresh_token,
        expires_at:    Date.now() + data.expires_in * 1000,
      };
      saveToken(tokenData);
      console.log('\n✅ Authenticated! Token ready.');
      res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Now Playing — Connected!</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:#0c0c10;color:#f0eef8;font-family:'Inter',-apple-system,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;-webkit-font-smoothing:antialiased}
.card{width:100%;max-width:480px;background:#131318;border:1px solid rgba(255,255,255,0.08);border-radius:20px;padding:40px}
.logo{display:flex;align-items:center;gap:10px;margin-bottom:32px}
.logo-icon{width:36px;height:36px;background:#1db954;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;box-shadow:0 0 20px rgba(29,185,84,0.4)}
.logo-text{font-size:18px;font-weight:700;letter-spacing:-0.3px}
.logo-sub{font-size:12px;color:rgba(255,255,255,0.4);margin-top:1px}
.badge{display:inline-flex;align-items:center;gap:6px;background:rgba(29,185,84,0.12);border:1px solid rgba(29,185,84,0.3);border-radius:20px;padding:6px 14px;font-size:13px;font-weight:600;color:#1db954;margin-bottom:20px}
h1{font-size:22px;font-weight:700;letter-spacing:-0.4px;margin-bottom:8px}
.subtitle{font-size:14px;color:rgba(255,255,255,0.5);line-height:1.6;margin-bottom:28px}
.obs-box{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:18px;margin-bottom:28px}
.obs-box h3{font-size:13px;font-weight:600;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:14px}
.url-row{display:flex;align-items:center;gap:8px;margin-bottom:14px}
.url-chip{flex:1;background:#0c0c10;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:10px 12px;font-family:monospace;font-size:13px;color:#1db954;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.copy-btn{padding:9px 14px;background:rgba(29,185,84,0.15);border:1px solid rgba(29,185,84,0.3);border-radius:8px;color:#1db954;font-size:12px;font-weight:600;font-family:'Inter',sans-serif;cursor:pointer;white-space:nowrap;transition:background 0.15s}
.copy-btn:hover{background:rgba(29,185,84,0.25)}
.steps{display:flex;flex-direction:column;gap:9px}
.step{display:flex;align-items:flex-start;gap:10px;font-size:13px;color:rgba(255,255,255,0.65);line-height:1.5}
.step-num{width:20px;height:20px;border-radius:50%;background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.4);font-size:11px;font-weight:600;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px}
.btn{width:100%;padding:14px;background:#1db954;border:none;border-radius:10px;color:#000;font-size:14px;font-weight:700;font-family:'Inter',sans-serif;cursor:pointer;transition:background 0.15s,transform 0.1s;letter-spacing:-0.1px}
.btn:hover{background:#1ed760}.btn:active{transform:scale(0.98)}
.btn-ghost{width:100%;padding:14px;background:transparent;border:1px solid rgba(255,255,255,0.12);border-radius:10px;color:rgba(255,255,255,0.6);font-size:14px;font-weight:600;font-family:'Inter',sans-serif;cursor:pointer;transition:border-color 0.15s,color 0.15s;margin-top:10px;text-decoration:none;display:block;text-align:center}
.btn-ghost:hover{border-color:rgba(255,255,255,0.25);color:#fff}
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    <div class="logo-icon">♫</div>
    <div><div class="logo-text">Now Playing</div><div class="logo-sub">OBS Spotify Overlay</div></div>
  </div>

  <div class="badge">✅ Connected to Spotify</div>
  <h1>Last step — add to OBS</h1>
  <p class="subtitle">You have <strong style="color:#fff">3 independent profiles</strong> — each gets its own Browser Source URL. Add as many as you need and configure each one separately from the Config page.</p>

  <div class="obs-box">
    <h3>OBS Browser Source URLs</h3>
    <div class="url-row">
      <div class="url-chip">http://127.0.0.1:${OBS_PORT}/overlay/1</div>
      <button class="copy-btn" onclick="copyUrl(this,'http://127.0.0.1:${OBS_PORT}/overlay/1')">Copy</button>
    </div>
    <div class="url-row" style="margin-top:6px">
      <div class="url-chip">http://127.0.0.1:${OBS_PORT}/overlay/2</div>
      <button class="copy-btn" onclick="copyUrl(this,'http://127.0.0.1:${OBS_PORT}/overlay/2')">Copy</button>
    </div>
    <div class="url-row" style="margin-top:6px">
      <div class="url-chip">http://127.0.0.1:${OBS_PORT}/overlay/3</div>
      <button class="copy-btn" onclick="copyUrl(this,'http://127.0.0.1:${OBS_PORT}/overlay/3')">Copy</button>
    </div>
    <div class="steps" style="margin-top:14px">
      <div class="step"><div class="step-num">1</div><span>In OBS, click <strong style="color:#fff">+</strong> under Sources and choose <strong style="color:#fff">Browser</strong>.</span></div>
      <div class="step"><div class="step-num">2</div><span>Paste one of the URLs above. Set width/height to fit your layout (e.g. 500×150).</span></div>
      <div class="step"><div class="step-num">3</div><span>Use <strong style="color:#fff">Config</strong> to customise each profile independently — switch profiles with the selector at the top of the panel.</span></div>
    </div>
  </div>

  <a href="https://${DOMAIN}:${PORT}/config" class="btn">Open Config to customise →</a>
  <span style="display:block;text-align:center;font-size:12px;color:rgba(255,255,255,0.3);margin-top:14px">Now Playing is running in your system tray</span>
</div>
<script>
function copyUrl(btn, url){
  navigator.clipboard.writeText(url).then(()=>{
    btn.textContent='Copied!';
    setTimeout(()=>btn.textContent='Copy',2000);
  });
}
</script>
</body>
</html>`);
    } else {
      res.send('Error getting token: ' + JSON.stringify(data));
    }
  } catch (err) {
    res.send('Error: ' + err.message);
  }
});

app.get('/token', async (req, res) => {
  corsHeaders(res);
  const token = await ensureFreshToken();
  if (!token) return res.json({ error: 'Not authenticated.' });
  res.json({ access_token: token });
});

app.get('/now-playing', async (req, res) => {
  corsHeaders(res);
  const token = await ensureFreshToken();
  if (!token) return res.json({ is_playing: false, error: 'Not authenticated.' });
  try {
    const response = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status === 204 || response.status === 404)
      return res.json({ is_playing: false });
    const data = await response.json();
    if (!data || !data.item) return res.json({ is_playing: false });
    const track = data.item;
    res.json({
      is_playing:    data.is_playing,
      track_id:      track.id,
      title:         track.name,
      artist:        track.artists.map(a => a.name).join(', '),
      album:         track.album.name,
      album_art_url: track.album.images[0]?.url ?? null,
      duration_ms:   track.duration_ms,
      progress_ms:   data.progress_ms,
    });
  } catch (err) {
    console.error('Now-playing error:', err);
    res.json({ is_playing: false });
  }
});

app.get('/audio-features', async (req, res) => {
  corsHeaders(res);
  const { track_id } = req.query;
  if (!track_id) return res.json({ tempo: null });
  const token = await ensureFreshToken();
  if (!token) return res.json({ tempo: null });
  try {
    const r = await fetch(`https://api.spotify.com/v1/audio-features/${track_id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return res.json({ tempo: null });
    const data = await r.json();
    res.json({ tempo: data.tempo ?? null });
  } catch {
    res.json({ tempo: null });
  }
});

app.get('/lyrics', async (req, res) => {
  corsHeaders(res);
  const { title, artist, album, duration } = req.query;
  if (!title || !artist) return res.json({ synced: false, lines: [] });

  const cacheKey = `${title}||${artist}`;
  if (lyricsCache.has(cacheKey)) return res.json(lyricsCache.get(cacheKey));

  try {
    const params = new URLSearchParams({
      track_name:  title,
      artist_name: artist,
      ...(album    ? { album_name: album } : {}),
      ...(duration ? { duration: Math.round(Number(duration) / 1000) } : {}),
    });
    const response = await fetch(`https://lrclib.net/api/get?${params}`, {
      headers: { 'User-Agent': 'SpotifyOBSOverlay/1.0' },
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
      result = { synced: false, lines: data.plainLyrics.split('\n').filter(Boolean).map(text => ({ time: null, text })) };
    } else {
      result = { synced: false, lines: [] };
    }
    if (lyricsCache.size >= 50) lyricsCache.delete(lyricsCache.keys().next().value);
    lyricsCache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error('Lyrics error:', err);
    res.json({ synced: false, lines: [] });
  }
});

app.get('/settings', (req, res) => {
  corsHeaders(res);
  const profile = Math.min(3, Math.max(1, parseInt(req.query.profile) || 1));
  res.json(loadSettings(profile));
});

app.post('/settings', (req, res) => {
  corsHeaders(res);
  const profile = Math.min(3, Math.max(1, parseInt(req.query.profile) || 1));
  try {
    const merged = { ...loadSettings(profile), ...req.body };
    saveSettings(profile, merged);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get(['/overlay', '/overlay/:profile'], (req, res) => res.sendFile(path.join(__dirname, 'overlay.html')));
app.get('/config',  (req, res) => res.sendFile(path.join(__dirname, 'config.html')));

// ── System tray (Windows) ─────────────────────────────────────────
function startTray() {
  if (process.platform !== 'win32') return;
  const { spawn } = require('child_process');

  // PowerShell script: draws a ♫ music note icon in Spotify green and
  // creates a NotifyIcon with a right-click context menu.
  const ps = String.raw`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Draw 16x16 icon: dark background + green music note
$bmp   = New-Object System.Drawing.Bitmap(16,16)
$g     = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::FromArgb(18,18,24))
$brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(29,185,84))
$font  = New-Object System.Drawing.Font('Segoe UI Symbol',9,[System.Drawing.FontStyle]::Regular,[System.Drawing.GraphicsUnit]::Pixel)
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
$g.DrawString([char]0x266B,$font,$brush,-1,0)
$g.Dispose()
$icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
$bmp.Dispose()

$tray           = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon      = $icon
$tray.Text      = 'Now Playing Overlay'
$tray.Visible   = $true

# Balloon on startup
$tray.ShowBalloonTip(3000,'Now Playing','Overlay is running. Right-click for options.',[System.Windows.Forms.ToolTipIcon]::None)

# Context menu
$menu   = New-Object System.Windows.Forms.ContextMenuStrip
$mConfig = New-Object System.Windows.Forms.ToolStripMenuItem('Open Config')
$mConfig.Add_Click({ Start-Process 'CONFIGURL' })
$mSetup  = New-Object System.Windows.Forms.ToolStripMenuItem('Open Setup')
$mSetup.Add_Click({  Start-Process 'SETUPURL'  })
$mSep    = New-Object System.Windows.Forms.ToolStripSeparator
$mQuit   = New-Object System.Windows.Forms.ToolStripMenuItem('Quit Now Playing')
$mQuit.Add_Click({
  $tray.Visible = $false
  $tray.Dispose()
  [System.Windows.Forms.Application]::Exit()
})
$menu.Items.AddRange(($mConfig,$mSetup,$mSep,$mQuit))
$tray.ContextMenuStrip = $menu
$tray.add_DoubleClick({ Start-Process 'CONFIGURL' })

# When server exits (stdin closes), clean up tray
$null = [System.Threading.Tasks.Task]::Run([Action]{
  [System.Console]::In.ReadToEnd() | Out-Null
  $tray.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})

[System.Windows.Forms.Application]::Run()
`.replace(/CONFIGURL/g, `https://${DOMAIN}:${PORT}/config`)
  .replace(/SETUPURL/g,  `https://${DOMAIN}:${PORT}/setup`);

  const tmpScript = path.join(os.tmpdir(), 'nowplaying-tray.ps1');
  fs.writeFileSync(tmpScript, ps, 'utf8');

  const trayProc = spawn('powershell', [
    '-ExecutionPolicy', 'Bypass',
    '-WindowStyle',     'Hidden',
    '-NonInteractive',
    '-File', tmpScript,
  ], { stdio: ['pipe', 'ignore', 'ignore'] });

  // Tray closed by user → shut down server
  trayProc.on('exit', () => process.exit(0));

  // Server exiting → signal tray to close
  const cleanup = () => {
    try { trayProc.stdin.end(); } catch {}
    try { fs.unlinkSync(tmpScript); } catch {}
  };
  process.on('exit',   cleanup);
  process.on('SIGINT',  () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

// Hide the console window when running as a packaged exe
function hideConsole() {
  if (!isPkg || process.platform !== 'win32') return;
  try {
    execSync(
      'powershell -NoProfile -Command "' +
      '$src=\'using System;using System.Runtime.InteropServices;' +
      'public class W{' +
      '[DllImport(\\"kernel32.dll\\")]public static extern IntPtr GetConsoleWindow();' +
      '[DllImport(\\"user32.dll\\")]public static extern bool ShowWindow(IntPtr h,int n);}\';" +' +
      '"Add-Type -TypeDefinition $src;[W]::ShowWindow([W]::GetConsoleWindow(),0)"',
      { stdio: 'ignore', timeout: 5000 }
    );
  } catch {}
}

// ── Boot ──────────────────────────────────────────────────────────
firstRunSetup().then(() => {
  const sslOptions = {
    key:  fs.readFileSync(KEY_FILE),
    cert: fs.readFileSync(CERT_FILE),
  };

  // HTTPS server — Spotify auth, setup, config
  const httpsServer = https.createServer(sslOptions, app);
  // HTTP server — OBS browser source (CEF doesn't trust local certs)
  const httpServer  = http.createServer(app);

  httpsServer.listen(PORT, () => {
    httpServer.listen(OBS_PORT, () => {
      console.log(`\n🎵 Spotify Overlay`);
      console.log(`   Setup  : https://${DOMAIN}:${PORT}/setup`);
      console.log(`   Config : https://${DOMAIN}:${PORT}/config`);
      console.log(`   OBS URLs: http://127.0.0.1:${OBS_PORT}/overlay/1  (Profile 1)`);
      console.log(`             http://127.0.0.1:${OBS_PORT}/overlay/2  (Profile 2)`);
      console.log(`             http://127.0.0.1:${OBS_PORT}/overlay/3  (Profile 3)\n`);

      startTray();
      hideConsole();

      const startUrl = (CLIENT_ID && CLIENT_SECRET)
        ? `https://${DOMAIN}:${PORT}/login`
        : `https://${DOMAIN}:${PORT}/setup`;
      try {
        const open   = require('open');
        const opener = open.default || open;
        opener(startUrl);
      } catch {
        console.log(`   Open ${startUrl} in your browser.\n`);
      }
    });
  });
}).catch(err => {
  console.error('Startup failed:', err);
  process.exit(1);
});
