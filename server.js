// ── Spotify Now Playing Overlay Server ───────────────────────────
// First run: auto-generates HTTPS certs + hosts entry (one UAC prompt).
// Subsequent runs: just start and go.

const express      = require('express');
const https        = require('https');
const fs           = require('fs');
const path         = require('path');
const forge        = require('node-forge');
const { execSync } = require('child_process');
const os           = require('os');

const PORT         = 8888;
const DOMAIN       = 'musicplayer.test';
const REDIRECT_URI = `https://${DOMAIN}:${PORT}/callback`;
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
const CA_FILE          = path.join(DATA_DIR, 'ca.crt');
const CERT_FILE        = path.join(DATA_DIR, 'cert.pem');
const KEY_FILE         = path.join(DATA_DIR, 'key.pem');
const HOSTS_FILE       = 'C:\\Windows\\System32\\drivers\\etc\\hosts';

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
  progressBar: { enabled: true,  color: '#1db954' },
  lyrics:      { enabled: true,  fontSize: 15, activeColor: '#ffffff', inactiveColor: '#555555', linesAbove: 2, linesBelow: 2 },
  layout:      'horizontal',
  background:  { color: 'rgba(10,10,15,0.85)', blur: 12 },
  animation:   'slide',
  font:        'Default',
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
        { type: 2, value: DOMAIN      },
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

// ── First-run setup (elevation only if hosts/CA not yet configured) ─
async function firstRunSetup() {
  const certsReady = fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE) && fs.existsSync(CA_FILE);
  const hostsOk    = fs.existsSync(HOSTS_FILE) &&
                     fs.readFileSync(HOSTS_FILE, 'utf8').includes(DOMAIN);

  if (certsReady && hostsOk) return;

  // Generate certs first (no elevation needed)
  if (!certsReady) generateCerts();

  if (!hostsOk) {
    // One UAC prompt to install CA + add hosts entry
    const psLines = [
      `certutil -addstore -f Root "${CA_FILE.replace(/\//g, '\\')}"`,
      `$h = 'C:\\Windows\\System32\\drivers\\etc\\hosts'`,
      `$e = '127.0.0.1 ${DOMAIN}'`,
      'if (-not (Select-String -Path $h -Pattern ([regex]::Escape($e)) -Quiet)) { Add-Content $h ("`n" + $e) }',
    ].join('; ');

    const tmpScript = path.join(os.tmpdir(), 'nowplaying-setup.ps1');
    fs.writeFileSync(tmpScript, psLines, 'utf8');

    console.log('\nRequesting administrator access to install certificate and update hosts file…');
    execSync(
      `powershell -Command "Start-Process powershell -ArgumentList '-ExecutionPolicy Bypass -File \\"${tmpScript}\\"' -Verb RunAs -Wait"`,
      { stdio: 'inherit' }
    );

    try { fs.unlinkSync(tmpScript); } catch {}
    console.log('System setup complete ✓\n');
  }
}

// ── Express app ───────────────────────────────────────────────────
const app = express();
app.use(express.json());

let tokenData    = null;
const lyricsCache = new Map();

function corsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
}

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE))
      return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch {}
  return { ...DEFAULT_SETTINGS };
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
      console.log('\n✅ Authenticated! Token ready.');
      res.send(`
        <html><body style="background:#0a0a0f;color:#f0ece4;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:16px;">
          <h1 style="color:#1db954;">✅ Connected to Spotify!</h1>
          <p>Your overlay is ready.</p>
          <p><a href="https://${DOMAIN}:${PORT}/config" style="color:#1db954;">Open Config →</a></p>
        </body></html>
      `);
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
  res.json(loadSettings());
});

app.post('/settings', (req, res) => {
  corsHeaders(res);
  try {
    const merged = { ...loadSettings(), ...req.body };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/overlay', (req, res) => res.sendFile(path.join(__dirname, 'overlay.html')));
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
  const server = https.createServer(sslOptions, app);

  server.listen(PORT, () => {
    console.log(`\n🎵 Spotify Overlay — https://${DOMAIN}:${PORT}`);
    console.log(`   Setup  : https://${DOMAIN}:${PORT}/setup`);
    console.log(`   Overlay: https://${DOMAIN}:${PORT}/overlay  ← OBS browser source`);
    console.log(`   Config : https://${DOMAIN}:${PORT}/config\n`);

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
}).catch(err => {
  console.error('Startup failed:', err);
  process.exit(1);
});
