```javascript
const { app, BrowserWindow, ipcMain, shell, session, dialog } = require('electron');
const path = require('path');
const http = require('http');
const { StreamDomainService } = require('./utils/streamService.js');
const {
  IPC_STREAM_CHANNELS,
  IPC_DOWNLOAD_CHANNELS,
  IPC_CACHE_CHANNELS,
  IPC_SETTINGS_CHANNELS,
  IPC_WINDOW_CHANNELS
} = require('./src/ipc/stream-ipc-channels.d.ts');

const BROWSER_HEADERS = { 'User-Agent': 'Mozilla/5.0' };

// Enable GPU acceleration for smoother rendering
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

let mainWindow;
let downloadIdCounter = 0;
let cacheIdCounter = 0;
let localMediaPort = 0;
const activeDownloads = new Map(); // downloadId -> { stream, writer, paused, filePath, received, total }
const activeCaches = new Map();    // cacheId -> { url, title, filePath, received, total }
const MIME_TYPES = {
  '.ts':  'video/mp2t',
  '.mp4': 'video/mp4',
  '.m4s': 'video/mp4',
  '.webm':'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.m3u8':'application/vnd.apple.mpegurl',
  '.txt': 'text/plain'
};

// Initialize StreamDomainService
const streamService = new StreamDomainService();

// Tiny local HTTP server to serve downloaded media files with proper MIME types
function startLocalMediaServer() {
  const downloadsDir = path.join(app.getPath('downloads'), 'Void Streamer');
  const server = http.createServer((req, res) => {
    const filePath = path.join(downloadsDir, decodeURIComponent(req.url.slice(1)));
    // Security: only serve files inside the downloads directory
    if (!filePath.startsWith(downloadsDir + path.sep) && filePath !== downloadsDir) {
      res.writeHead(403); res.end('Forbidden');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const stat = require('fs').statSync(filePath, { throwIfNoEntry: false });
    if (!stat) {
      res.writeHead(404); res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*'
    });
    const stream = require('fs').createReadStream(filePath);
    stream.pipe(res);
    stream.on('error', () => { res.writeHead(500); res.end('Error'); });
  });
  server.listen(0, '127.0.0.1', () => {
    localMediaPort = server.address().port;
    console.log('Local media server on port', localMediaPort);
  });
  return server;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    icon: path.join(__dirname, 'icon.png'),
    titleBarStyle: 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    show: false,
    autoHideMenuBar: true
  });

  // Built-in Ad Blocker
  const AD_BLOCK_LIST = [
    '*://*.doubleclick.net/*',
    '*://*.googlesyndication.com/*',
    '*://*.google-analytics.com/*',
    '*://*.analytics.google.com/*',
    '*://*.popads.net/*',
    '*://*.popcash.net/*',
    '*://*.adsterra.com/*',
    '*://*.onclickads.net/*',
    '*://*.exoclick.com/*',
    '*://*.juicyads.com/*',
    '*://*.propellerads.com/*',
    '*://*.onclicktop.com/*',
    '*://*.ad-maven.com/*',
    '*://*.coinad.com/*',
    '*://*.a-ads.com/*',
    '*://*/*.js?*popunder*',
    '*://*/*popunder*.js*',
    '*://*/*adsterra*',
    '*://*/*exoclick*',
    '*://*.adservice.google.com/*',
    '*://*.adnxs.com/*',
    '*://*.rubiconproject.com/*',
    '*://*.pubmatic.com/*',
    '*://*.openx.net/*',
    '*://*.criteo.com/*',
    '*://*.taboola.com/*',
    '*://*.outbrain.com/*',
    '*://*.amazon-adsystem.com/*',
    '*://*.facebook.com/tr/*',
    '*://*.scorecardresearch.com/*',
    '*://*.quantserve.com/*'
  ];

  session.defaultSession.webRequest.onBeforeRequest({ urls: AD_BLOCK_LIST }, (details, callback) => {
    // Silently cancel all matching ad network requests
    callback({ cancel: true });
  });

  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.on('console-message', (event, level, message) => {
    console.log(`[Renderer ${level}] ${message}`);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// IPC Handlers for Stream Operations
function registerStreamIpcHandlers() {
  // STREAM_SEARCH - Search for streams
  ipcMain.handle(IPC_STREAM_CHANNELS.STREAM_SEARCH, async (_event, query, options = {}) => {
    try {
      const results = await streamService.searchStreams(query, options);
      return { success: true, data: results };
    } catch (error) {
      console.error('[IPC] STREAM_SEARCH error:', error);
      return { success: false, error: error.message || 'Search failed', code: error.code || 'SEARCH_ERROR' };
    }
  });

  // STREAM_GET_URL - Get playable stream URL
  ipcMain.handle(IPC_STREAM_CHANNELS.STREAM_GET_URL, async (_event, sourceId, streamId, quality) => {
    try {
      const streamUrl = await streamService.getStreamUrl(sourceId, streamId, quality);
      return { success: true, data: { url: streamUrl } };
    } catch (error) {
      console.error('[IPC] STREAM_GET_URL error:', error);
      return { success: false, error: error.message || 'Failed to get stream URL', code: error.code || 'GET_URL_ERROR' };
    }
  });

  // STREAM_VALIDATE_SOURCE - Validate a source
  ipcMain.handle(IPC_STREAM_CHANNELS.STREAM_VALIDATE_SOURCE, async (_event, sourceId) => {
    try {
      const isValid = await streamService.validateSource(sourceId);
      return { success: true, data: { sourceId, valid: isValid } };
    } catch (error) {
      console.error('[IPC] STREAM_VALIDATE_SOURCE error:', error);
      return { success: false, error: error.message || '