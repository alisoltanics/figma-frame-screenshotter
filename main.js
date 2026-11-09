'use strict';

const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  session,
  shell
} = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');

const FIGMA_PARTITION = 'persist:figma';
const FIGMA_LOGIN_URL = 'https://www.figma.com/login';
const CANVAS_SETTLE_MS = 5_000;
const ZOOM_SETTLE_MS = 2_000;
const PANEL_SETTLE_MS = 600;
const RENDER_IDLE_MAX_MS = 10_000;
const RENDER_SETTLE_MS = 2_500;
const STABILITY_INTERVAL_MS = 800;
const STABILITY_MAX_MS = 8_000;
const BETWEEN_ITEMS_MS = 2_000;
const PAGE_POLL_MS = 500;
const CAPTURE_WIDTH = 1600;
const CAPTURE_HEIGHT = 1000;
const CAPTURE_VIEWPORT = {
  width: CAPTURE_WIDTH,
  height: CAPTURE_HEIGHT,
  deviceScaleFactor: 1,
  mobile: false
};

// Figma's "Copy as PNG" exports the exact node at 2x. The high-quality mode
// uses Figma's export panel at 4x instead. Long nodes are split into readable
// tiles so no part of a tall frame is lost.
const QUALITY_PRESETS = {
  normal: {
    maxWidth: 3200,
    tileHeight: 3000,
    overlap: 200,
    exportScale: null,
    unitTimeout: 120_000,
    timeoutMessage: 'This item timed out after 2 minutes.'
  },
  high: {
    maxWidth: 0,
    tileHeight: 6000,
    overlap: 200,
    exportScale: '4x',
    unitTimeout: 300_000,
    timeoutMessage: 'This item timed out after 5 minutes.'
  }
};

const EXPORT_PANEL_SELECTOR = '[data-testid="fullscreen-export-panel"]';
const EXPORT_ADD_SELECTOR = '[aria-label="Add export settings"]';
const EXPORT_SCALE_SELECTOR =
  'input[aria-label="Export constraints for content scale or width/height dimensions"]';
const EXPORT_PANEL_TIMEOUT_MS = 8_000;
const EXPORT_DOWNLOAD_TIMEOUT_MS = 240_000;

const CLIPBOARD_POLL_MS = 250;
const CLIPBOARD_MAX_MS = 12_000;
const CLIPBOARD_RETRY_MS = 3_000;
const PAGE_SELECT_SETTLE_MS = 900;
const UI_TOGGLE_MODIFIER = process.platform === 'darwin' ? 'meta' : 'control';
const APP_ICON = path.join(__dirname, 'assets', 'icon.png');

const SAME_SITE_VALUES = { 0: 'no_restriction', 1: 'lax', 2: 'strict' };

const FIREFOX_COOKIE_SCRIPT = `
import glob, json, os, shutil, sqlite3, tempfile, time

ROOTS = [
    os.path.join(os.path.expanduser("~"), ".mozilla", "firefox"),
    os.path.join(os.path.expanduser("~"), "snap", "firefox", "common", ".mozilla", "firefox"),
    os.path.join(os.path.expanduser("~"), ".var", "app", "org.mozilla.firefox", ".mozilla", "firefox"),
]

def profiles():
    found = []
    seen = set()
    for root in ROOTS:
        for pattern in ("*", "*/*"):
            for item in glob.glob(os.path.join(root, pattern)):
                if item in seen or not os.path.isdir(item):
                    continue
                seen.add(item)
                db = os.path.join(item, "cookies.sqlite")
                if os.path.isfile(db):
                    found.append((os.path.getmtime(db), item))
    found.sort(reverse=True)
    return [item for _mtime, item in found]

def read_profile(profile):
    tmp = tempfile.mkdtemp(prefix="figma-ff-")
    try:
        for suffix in ("", "-wal", "-shm"):
            src = os.path.join(profile, "cookies.sqlite" + suffix)
            if os.path.isfile(src):
                shutil.copy2(src, os.path.join(tmp, "cookies.sqlite" + suffix))
        con = sqlite3.connect(os.path.join(tmp, "cookies.sqlite"))
        con.row_factory = sqlite3.Row
        cols = {row[1] for row in con.execute("PRAGMA table_info(moz_cookies)")}
        if not {"host", "name", "value"}.issubset(cols):
            return []
        wanted = ["host", "name", "value", "path", "expiry", "isSecure", "isHttpOnly", "sameSite"]
        select = ", ".join(col for col in wanted if col in cols)
        rows = con.execute(
            "SELECT " + select + " FROM moz_cookies "
            "WHERE (host = 'figma.com' OR host LIKE '%.figma.com') AND value <> ''"
        ).fetchall()
        con.close()
        now = int(time.time() * 1000)
        cookies = []
        for row in rows:
            item = dict(row)
            expiry = item.get("expiry") or 0
            if expiry and expiry < now:
                continue
            cookies.append({
                "host": item.get("host") or "",
                "name": item.get("name") or "",
                "value": item.get("value") or "",
                "path": item.get("path") or "/",
                "expiry": expiry,
                "isSecure": bool(item.get("isSecure")),
                "isHttpOnly": bool(item.get("isHttpOnly")),
                "sameSite": item.get("sameSite") or 0,
            })
        return cookies
    except Exception:
        return []
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

best = []
for profile in profiles():
    cookies = read_profile(profile)
    if len(cookies) > len(best):
        best = cookies
    if len(best) >= 8:
        break

print(json.dumps({"cookies": best}, ensure_ascii=False))
`;

const PAGE_STATE_SCRIPT = `
(() => {
  const bodyText = ((document.body && document.body.innerText) || '').slice(0, 100000).toLowerCase();
  const pathName = (location.pathname || '').toLowerCase();
  const firstPathPart = pathName.split('/').filter(Boolean)[0] || '';
  const loginPath = ['login', 'signup', 'sign-up', 'auth'].includes(firstPathPart);
  const loginText = [
    'log in to figma',
    'login to figma',
    'sign in to figma',
    'enter your email',
    'continue with google',
    'sign up with google',
    'forgot password'
  ].some((phrase) => bodyText.includes(phrase));
  const deniedText = [
    "you don't have access",
    'you don’t have access',
    'you do not have access',
    'request access',
    'you need permission',
    "you don't have permission",
    'you do not have permission',
    'access denied',
    'permission denied',
    'this file is not available',
    'this file is unavailable',
    'this file is private',
    'you need access',
    'file not found'
  ].some((phrase) => bodyText.includes(phrase));

  const hasCanvas = Boolean(document.querySelector('canvas'));

  return {
    hasCanvas,
    // A loaded file always has a canvas. Figma's UI also contains words like
    // "request access" in menus and tooltips, so text alone is not a reliable
    // access-denied signal when the editor is already rendered.
    login: !hasCanvas && (loginPath || loginText),
    denied: !hasCanvas && deniedText
  };
})()
`;

const PAGE_IDLE_SCRIPT = `
(() => ({
  ready: document.readyState === 'complete',
  imagesReady: Array.from(document.images).every((image) => image.complete)
}))()
`;

let mainWindow = null;
let loginWindow = null;
let batchRunning = false;
let projectGenerating = false;
let stopRequested = false;
let activeStop = null;
let logSink = null;

class ItemError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ItemError';
  }
}

class StopError extends Error {
  constructor() {
    super('Stopped.');
    this.name = 'StopError';
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendEvent(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('figma:event', payload);
  }
}

function log(message, level = 'info') {
  sendEvent({ type: 'log', level, message });
  if (logSink) {
    try {
      logSink(String(message), level);
    } catch {
      // A broken log sink must not interrupt a capture.
    }
  }
}

function setLogSink(handler) {
  logSink = typeof handler === 'function' ? handler : null;
}

function requestStop() {
  stopRequested = true;
  if (activeStop) activeStop();
}

async function getFigmaSessionStatus() {
  try {
    const ses = session.fromPartition(FIGMA_PARTITION);
    const urls = ['https://www.figma.com/files', 'https://figma.com/'];

    for (const url of urls) {
      const cookies = await ses.cookies.get({ url });
      const loggedIn = cookies.some(
        (cookie) =>
          cookie.value &&
          (cookie.name === 'figma.session' ||
            cookie.name === 'figma.authn' ||
            cookie.name === '__Host-figma.authn')
      );
      if (loggedIn) return { loggedIn: true };
    }

    return { loggedIn: false };
  } catch {
    return { loggedIn: false, error: 'session-check-failed' };
  }
}

async function notifySessionStatus() {
  const status = await getFigmaSessionStatus();
  sendEvent({ type: 'session', loggedIn: status.loggedIn });
  return status;
}

function readFirefoxCookies() {
  return new Promise((resolve) => {
    execFile(
      'python3',
      ['-c', FIREFOX_COOKIE_SCRIPT],
      { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve({ ok: false, error: 'Could not read the Firefox session.' });
          return;
        }

        let parsed;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          resolve({ ok: false, error: 'Could not read the Firefox session.' });
          return;
        }

        const cookies = Array.isArray(parsed && parsed.cookies) ? parsed.cookies : [];
        if (!cookies.length) {
          resolve({
            ok: false,
            error: 'No Figma session found in Firefox. Sign in to Figma in Firefox first.'
          });
          return;
        }

        resolve({ ok: true, cookies });
      }
    );
  });
}

async function applyFirefoxCookies(cookies) {
  const ses = session.fromPartition(FIGMA_PARTITION);
  let imported = 0;
  let failed = 0;

  for (const cookie of cookies) {
    const host = typeof cookie.host === 'string' ? cookie.host.replace(/^\./, '') : '';
    const name = typeof cookie.name === 'string' ? cookie.name : '';
    const value = typeof cookie.value === 'string' ? cookie.value : '';

    if (!host || !(host === 'figma.com' || host.endsWith('.figma.com')) || !name || !value) {
      failed += 1;
      continue;
    }

    const cookiePath =
      typeof cookie.path === 'string' && cookie.path.startsWith('/') ? cookie.path : '/';

    const details = {
      url: 'https://' + host + cookiePath,
      name,
      value,
      path: cookiePath,
      secure: Boolean(cookie.isSecure),
      httpOnly: Boolean(cookie.isHttpOnly)
    };

    if (typeof cookie.host === 'string' && cookie.host.startsWith('.')) {
      details.domain = host;
    }

    if (Number.isFinite(cookie.expiry) && cookie.expiry > 0) {
      details.expirationDate = Math.floor(cookie.expiry / 1000);
    }

    const sameSite = SAME_SITE_VALUES[cookie.sameSite];
    if (sameSite) details.sameSite = sameSite;

    try {
      await ses.cookies.set(details);
      imported += 1;
    } catch {
      failed += 1;
    }
  }

  await ses.cookies.flushStore().catch(() => {});
  return { imported, failed };
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 840,
    minWidth: 760,
    minHeight: 620,
    title: 'Figma Frame Screenshotter',
    icon: APP_ICON,
    backgroundColor: '#0b1020',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile('index.html');
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function openFigmaLogin() {
  if (loginWindow && !loginWindow.isDestroyed()) {
    if (loginWindow.isMinimized()) loginWindow.restore();
    loginWindow.show();
    loginWindow.focus();
    return;
  }

  loginWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    title: 'Sign in to Figma',
    icon: APP_ICON,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      partition: FIGMA_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  loginWindow.on('closed', () => {
    loginWindow = null;
    notifySessionStatus().catch(() => {});
  });

  const refreshLoginState = () => {
    notifySessionStatus().catch(() => {});
  };

  loginWindow.webContents.on('did-finish-load', refreshLoginState);
  loginWindow.webContents.on('did-navigate', refreshLoginState);

  loginWindow.loadURL(FIGMA_LOGIN_URL).catch(() => {
    // The window itself shows Chromium's load error; no sensitive details are logged.
  });
}

function normalizeItem(raw, index) {
  const entry = raw && typeof raw === 'object' ? raw : {};
  const folder = typeof entry.folder === 'string' ? entry.folder.trim() : '';
  const name = typeof entry.name === 'string' ? entry.name.trim() : '';
  const nodeId = typeof entry.nodeId === 'string' ? entry.nodeId.trim() : '';
  const url = typeof entry.url === 'string' ? entry.url.trim() : '';

  let reason = '';
  if (!url) {
    reason = 'The URL is empty';
  } else if (!folder || !name) {
    reason = 'The folder or name is empty';
  } else {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        reason = 'The URL is not valid';
      }
    } catch {
      reason = 'The URL is not valid';
    }
  }

  return {
    index,
    folder,
    name,
    nodeId,
    rawNodeId: entry.nodeId,
    url,
    valid: !reason,
    reason
  };
}

function itemLabel(item, index) {
  const name = item.name || `Item ${index + 1}`;
  return item.folder ? `${item.folder}/${name}` : name;
}

function parseNodeIds(item) {
  const ids = [];

  const add = (value) => {
    if (typeof value !== 'string') return;
    for (const part of value.split(/[,\s]+/)) {
      const id = part.trim();
      if (id && !ids.includes(id)) ids.push(id);
    }
  };

  if (Array.isArray(item.rawNodeId)) {
    for (const value of item.rawNodeId) add(value);
  } else {
    add(item.nodeId);
  }

  try {
    const parsed = new URL(item.url);
    for (const value of parsed.searchParams.getAll('node-id')) add(value);
  } catch {
    // The URL was validated earlier; a parse failure simply means no IDs.
  }

  return ids;
}

function urlForNode(item, nodeId) {
  if (!nodeId) return item.url;

  try {
    const parsed = new URL(item.url);
    parsed.searchParams.delete('node-id');
    parsed.searchParams.set('node-id', nodeId);
    return parsed.toString();
  } catch {
    return item.url;
  }
}

function outputPathFor(root, item, suffix = '') {
  const base = path.resolve(root);
  let target;

  try {
    target = path.resolve(base, item.folder, `${item.name}${suffix}.png`);
  } catch {
    throw new ItemError('The output path is not valid.');
  }

  const relative = path.relative(base, target);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new ItemError('The output path is not valid.');
  }

  return target;
}

function safeErrorMessage(error) {
  if (error instanceof ItemError) return error.message;

  if (error && typeof error.code === 'string') {
    if (error.code === 'ENOSPC') return 'There is not enough disk space.';
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      return 'The app is not allowed to write to the output folder.';
    }
    return `System error (${error.code})`;
  }

  return 'An unexpected error occurred.';
}

async function readPageState(webContents) {
  try {
    return await webContents.executeJavaScript(PAGE_STATE_SCRIPT, true);
  } catch {
    return null;
  }
}

function assertAccessible(state) {
  if (!state) return;

  if (state.denied) {
    throw new ItemError('You do not have access to this file.');
  }

  if (state.login) {
    throw new ItemError('Figma login required — use the “Sign in to Figma” button first.');
  }
}

async function waitForCanvas(webContents, getLoadFailure, isCancelled) {
  while (!isCancelled()) {
    const failureCode = getLoadFailure();
    if (failureCode) {
      throw new ItemError(`The page failed to load (code ${failureCode}).`);
    }

    const state = await readPageState(webContents);
    if (state) {
      if (state.denied) {
        throw new ItemError('You do not have access to this file.');
      }
      if (state.login) {
        throw new ItemError('Figma login required — use the “Sign in to Figma” button first.');
      }
      if (state.hasCanvas) return;
    }

    await wait(PAGE_POLL_MS);
  }

  throw new ItemError('This item timed out after 60 seconds.');
}

function sendShortcut(webContents, keyCode, modifiers) {
  webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
}

async function waitForPageIdle(webContents, isCancelled, maxWaitMs) {
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    if (isCancelled()) return;

    if (!webContents.isLoading()) {
      const state = await webContents
        .executeJavaScript(PAGE_IDLE_SCRIPT, true)
        .catch(() => null);

      if (state && state.ready && state.imagesReady) return;
    }

    await wait(PAGE_POLL_MS);
  }
}

async function capturePng(webContents) {
  if (webContents.debugger.isAttached()) {
    const shot = await webContents.debugger.sendCommand('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT, scale: 1 }
    });

    if (!shot || typeof shot.data !== 'string' || !shot.data) return null;
    return Buffer.from(shot.data, 'base64');
  }

  const image = await webContents.capturePage();
  return image.isEmpty() ? null : image.toPNG();
}

async function captureStablePng(webContents, isCancelled) {
  await wait(RENDER_SETTLE_MS);
  if (isCancelled()) return null;

  let previous = await capturePng(webContents);
  if (!previous) return null;

  const deadline = Date.now() + STABILITY_MAX_MS;

  while (!isCancelled() && Date.now() < deadline) {
    await wait(STABILITY_INTERVAL_MS);
    if (isCancelled()) break;

    const current = await capturePng(webContents);
    if (!current) return previous;

    // Figma paints canvas tiles asynchronously after zooming. Keep sampling
    // until two consecutive frames match, so the saved image is not partial.
    if (current.equals(previous)) return current;
    previous = current;
  }

  return previous;
}

function clipboardSnapshot() {
  return {
    text: clipboard.readText(),
    html: clipboard.readHTML(),
    rtf: clipboard.readRTF(),
    image: clipboard.readImage()
  };
}

function restoreClipboard(snapshot) {
  if (!snapshot) return;

  const data = {};
  if (snapshot.text) data.text = snapshot.text;
  if (snapshot.html) data.html = snapshot.html;
  if (snapshot.rtf) data.rtf = snapshot.rtf;
  if (snapshot.image && !snapshot.image.isEmpty()) data.image = snapshot.image;

  clipboard.clear();
  if (Object.keys(data).length) clipboard.write(data);
}

async function copySelectionAsPng(webContents, isCancelled) {
  clipboard.clear();

  const deadline = Date.now() + CLIPBOARD_MAX_MS;
  let nextAttempt = 0;

  while (!isCancelled() && Date.now() < deadline) {
    if (Date.now() >= nextAttempt) {
      sendShortcut(webContents, 'c', [UI_TOGGLE_MODIFIER, 'shift']);
      nextAttempt = Date.now() + CLIPBOARD_RETRY_MS;
    }

    await wait(CLIPBOARD_POLL_MS);
    if (isCancelled()) return null;

    try {
      const image = clipboard.readImage();
      if (!image.isEmpty()) return image;
    } catch {
      // Ignore malformed clipboard payloads and keep waiting for Figma.
    }
  }

  return null;
}

async function openNodeForCapture(win, item, nodeId, isCancelled) {
  const webContents = win.webContents;
  let loadFailure = null;

  const onFailLoad = (_event, errorCode, _description, _url, isMainFrame) => {
    if (isMainFrame && errorCode !== -3) {
      loadFailure = loadFailure || errorCode;
    }
  };

  webContents.on('did-fail-load', onFailLoad);

  try {
    try {
      await win.loadURL(urlForNode(item, nodeId));
    } catch (error) {
      if (!error || error.code !== 'ERR_ABORTED') {
        loadFailure = loadFailure || (error && error.code) || 'ERR_FAILED';
      }
    }

    if (isCancelled()) return null;
    await waitForCanvas(webContents, () => loadFailure, isCancelled);

    await waitForPageIdle(webContents, isCancelled, RENDER_IDLE_MAX_MS);
    await wait(CANVAS_SETTLE_MS);
    if (isCancelled()) return null;

    assertAccessible(await readPageState(webContents));
    webContents.focus();

    // A link without a node id opens a whole page. Select everything on the
    // canvas so "Copy as PNG" exports every frame that lives on that page.
    if (!nodeId) {
      sendShortcut(webContents, 'a', [UI_TOGGLE_MODIFIER]);
      await wait(PAGE_SELECT_SETTLE_MS);
    }

    return webContents;
  } finally {
    try {
      webContents.removeListener('did-fail-load', onFailLoad);
    } catch {
      // The window may already be gone after a stop request.
    }
  }
}

async function runInPage(webContents, script) {
  try {
    return await webContents.executeJavaScript(script, true);
  } catch {
    return null;
  }
}

async function waitForPageScript(webContents, script, isCancelled, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (isCancelled()) return null;

    const value = await runInPage(webContents, script);
    if (value) return value;

    await wait(250);
  }

  return null;
}

function exportPanelScript(body) {
  return `(() => {
    const panel = document.querySelector(${JSON.stringify(EXPORT_PANEL_SELECTOR)});
    ${body}
  })()`;
}

function scaleInputScript(body) {
  return exportPanelScript(`
    const input = panel && panel.querySelector(${JSON.stringify(EXPORT_SCALE_SELECTOR)});
    if (!input) return null;
    ${body}
  `);
}

let downloadSlot = null;
let downloadHandlerReady = false;

function ensureDownloadHandler() {
  if (downloadHandlerReady) return;
  downloadHandlerReady = true;

  session.fromPartition(FIGMA_PARTITION).on('will-download', (_event, item) => {
    const slot = downloadSlot;
    if (!slot) return;

    downloadSlot = null;
    try {
      item.setSavePath(slot.savePath);
    } catch {
      // The done handler below still reports a failed state.
    }
    item.once('done', (_doneEvent, state) => slot.finish(state));
  });
}

function waitForDownload(savePath, timeoutMs, isCancelled) {
  let cancel = () => {};

  const promise = new Promise((resolve) => {
    let settled = false;

    const finish = (state) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poller);
      if (downloadSlot && downloadSlot.savePath === savePath) downloadSlot = null;
      resolve(state);
    };

    cancel = () => finish('aborted');

    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    const poller = setInterval(() => {
      if (isCancelled && isCancelled()) finish('aborted');
    }, 400);

    downloadSlot = { savePath, finish };
  });

  return { promise, cancel };
}

async function removeAddedExportSettings(webContents, beforeCount) {
  if (!webContents || webContents.isDestroyed()) return;

  await runInPage(
    webContents,
    exportPanelScript(`
      const buttons = Array.from(panel.querySelectorAll('button[aria-label="Remove"]'));
      const extra = buttons.length - ${Number(beforeCount) || 0};
      let removed = 0;

      for (let i = 0; i < extra; i += 1) {
        const button = buttons[buttons.length - 1 - i];
        if (!button) break;
        button.click();
        removed += 1;
      }

      return removed;
    `)
  );
}

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 66_000);

  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }

  return -1;
}

function extractPngsFromZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) return [];

  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) return [];

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];

  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) break;

    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    entries.push({ name, method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  const pngs = [];

  for (const entry of entries) {
    if (!/\.png$/i.test(entry.name)) continue;
    if (entry.localOffset + 30 > buffer.length) continue;
    if (buffer.readUInt32LE(entry.localOffset) !== 0x04034b50) continue;

    const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
    const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
    const start = entry.localOffset + 30 + nameLength + extraLength;
    const end = start + entry.compressedSize;

    if (start >= buffer.length || end > buffer.length) continue;

    const data = buffer.subarray(start, end);
    let png = null;

    if (entry.method === 0) {
      png = Buffer.from(data);
    } else if (entry.method === 8) {
      try {
        png = zlib.inflateRawSync(data);
      } catch {
        png = null;
      }
    }

    if (png && png.length) {
      pngs.push({ name: entry.name.replace(/\.png$/i, ''), buffer: png });
    }
  }

  return pngs;
}

// Exports the current selection through Figma's export panel at the given
// scale. A single selected node yields one PNG; a multi-selection (for example
// a whole page) yields one PNG per node. Figma delivers the result as a ZIP.
async function exportNodePngs(win, isCancelled, scaleValue) {
  const webContents = win.webContents;
  const addScript = `Boolean(document.querySelector(${JSON.stringify(EXPORT_ADD_SELECTOR)}))`;
  const normalizedScale = String(scaleValue || '2x').trim().toLowerCase();

  let ready = await waitForPageScript(
    webContents,
    addScript,
    isCancelled,
    EXPORT_PANEL_TIMEOUT_MS
  );

  if (!ready) {
    sendShortcut(webContents, 'e', [UI_TOGGLE_MODIFIER, 'shift']);
    ready = await waitForPageScript(
      webContents,
      addScript,
      isCancelled,
      EXPORT_PANEL_TIMEOUT_MS / 2
    );
  }

  if (!ready || isCancelled()) return null;

  const beforeRemove =
    Number(
      await runInPage(
        webContents,
        exportPanelScript(
          `return panel ? panel.querySelectorAll('button[aria-label="Remove"]').length : 0;`
        )
      )
    ) || 0;

  try {
    const added = await runInPage(
      webContents,
      `(() => {
        const button = document.querySelector(${JSON.stringify(EXPORT_ADD_SELECTOR)});
        if (!button) return false;
        button.click();
        return true;
      })()`
    );

    if (!added) return null;

    const scaleReady = await waitForPageScript(
      webContents,
      scaleInputScript('input.focus(); input.select(); return true;'),
      isCancelled,
      EXPORT_PANEL_TIMEOUT_MS
    );

    if (!scaleReady) return null;

    let scale = null;

    for (let attempt = 0; attempt < 2 && !isCancelled(); attempt += 1) {
      await wait(150);

      for (const keyCode of normalizedScale) {
        webContents.sendInputEvent({ type: 'char', keyCode });
      }

      sendShortcut(webContents, 'Return', []);
      await wait(2_000);

      scale = await runInPage(webContents, scaleInputScript('return input.value;'));

      if (typeof scale === 'string' && scale.trim().toLowerCase() === normalizedScale) break;

      await runInPage(
        webContents,
        scaleInputScript('input.focus(); input.select(); return true;')
      );
    }

    if (typeof scale !== 'string' || scale.trim().toLowerCase() !== normalizedScale) {
      return null;
    }

    const tempDir = await fs.mkdtemp(path.join(app.getPath('temp'), 'figma-export-'));
    const zipPath = path.join(tempDir, 'export.zip');

    try {
      ensureDownloadHandler();
      const waiter = waitForDownload(zipPath, EXPORT_DOWNLOAD_TIMEOUT_MS, isCancelled);

      const clicked = await runInPage(
        webContents,
        exportPanelScript(`
          if (!panel) return 'no-panel';

          const button = Array.from(panel.querySelectorAll('button')).find((candidate) =>
            /^Export\\s/.test((candidate.innerText || '').trim())
          );

          if (!button) return 'no-button';
          button.click();
          return 'clicked';
        `)
      );

      if (clicked !== 'clicked') {
        waiter.cancel();
        return null;
      }

      const state = await waiter.promise;
      if (state !== 'completed') return null;

      const pngs = extractPngsFromZip(await fs.readFile(zipPath));
      return pngs.length ? pngs : null;
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  } finally {
    await removeAddedExportSettings(webContents, beforeRemove);
  }
}

async function captureUnitImages(win, item, nodeId, isCancelled, preset, onFallback) {
  const webContents = await openNodeForCapture(win, item, nodeId, isCancelled);
  if (!webContents) return [];

  // Page-level links have no node to select, and some links point at a page
  // id directly. Selecting everything on the page lets the export panel
  // capture each top-level frame separately.
  const exportScale = preset.exportScale;
  const hasAdd = await waitForPageScript(
    webContents,
    `Boolean(document.querySelector(${JSON.stringify(EXPORT_ADD_SELECTOR)}))`,
    isCancelled,
    2_500
  );

  // Normal quality with a real selected frame uses the faster clipboard
  // shortcut. If nothing is selected, this link points at a page (or the whole
  // file), so select every top-level frame and export them instead of taking a
  // single low-quality viewport screenshot.
  if (!exportScale && hasAdd) {
    const copied = await copySelectionAsPng(webContents, isCancelled);
    return copied ? [{ image: copied, label: '' }] : [];
  }

  if (!hasAdd) {
    sendShortcut(webContents, 'a', [UI_TOGGLE_MODIFIER]);
    await wait(PAGE_SELECT_SETTLE_MS);
  }

  const exported = await exportNodePngs(win, isCancelled, exportScale || '2x');
  if (isCancelled()) return [];

  if (exported) {
    const images = [];

    for (const entry of exported) {
      const image = nativeImage.createFromBuffer(entry.buffer);
      if (!image.isEmpty()) images.push({ image, label: entry.name });
    }

    if (images.length) return images;
  }

  if (typeof onFallback === 'function') onFallback();

  // Reload so the export panel state cannot interfere with the clipboard
  // shortcut used as the fallback.
  const reopened = await openNodeForCapture(win, item, nodeId, isCancelled);
  if (!reopened) return [];

  const copied = await copySelectionAsPng(reopened, isCancelled);
  return copied ? [{ image: copied, label: '' }] : [];
}

async function captureViewportPng(win, isCancelled) {
  const webContents = win.webContents;
  let debuggerAttached = false;

  // Fallback for the rare case where Figma does not put a PNG on the
  // clipboard. The window must be visible for capturePage to paint.
  win.show();
  win.focus();
  webContents.focus();
  await wait(400);

  try {
    try {
      if (!webContents.debugger.isAttached()) {
        webContents.debugger.attach('1.3');
      }
      debuggerAttached = true;
      await webContents.debugger.sendCommand(
        'Emulation.setDeviceMetricsOverride',
        CAPTURE_VIEWPORT
      );
    } catch {
      debuggerAttached = false;
    }

    await waitForPageIdle(webContents, isCancelled, RENDER_IDLE_MAX_MS);

    sendShortcut(webContents, '2', ['shift']);
    await wait(ZOOM_SETTLE_MS);
    await waitForPageIdle(webContents, isCancelled, RENDER_IDLE_MAX_MS);

    sendShortcut(webContents, '\\', [UI_TOGGLE_MODIFIER]);
    await wait(PANEL_SETTLE_MS);

    sendShortcut(webContents, '2', ['shift']);
    return await captureStablePng(webContents, isCancelled);
  } finally {
    if (debuggerAttached && webContents.debugger.isAttached()) {
      try {
        webContents.debugger.detach();
      } catch {
        // Detach failures are harmless when the window is being torn down.
      }
    }

    if (!win.isDestroyed()) win.hide();
  }
}

function tileImage(image, preset = QUALITY_PRESETS.normal) {
  let working = image;
  const size = working.getSize();

  if (preset.maxWidth > 0 && size.width > preset.maxWidth) {
    const height = Math.max(1, Math.round(size.height * (preset.maxWidth / size.width)));
    working = working.resize({ width: preset.maxWidth, height, quality: 'best' });
  }

  const width = working.getSize().width;
  const height = working.getSize().height;

  if (height <= preset.tileHeight) return [working];

  // Split into evenly sized tiles instead of 2000px slices plus a tiny
  // leftover. Neighbouring tiles keep an overlap so no content is lost at a
  // cut.
  const count = Math.ceil(height / preset.tileHeight);
  const baseHeight = Math.ceil(height / count);
  const tileHeight = Math.min(preset.tileHeight, baseHeight + preset.overlap);

  if (count <= 1 || tileHeight >= height) return [working];

  const maxY = height - tileHeight;
  const tiles = [];

  for (let i = 0; i < count; i += 1) {
    const y = Math.round((maxY * i) / (count - 1));
    tiles.push(working.crop({ x: 0, y, width, height: tileHeight }));
  }

  return tiles;
}

async function captureItem(item, outputRoot, quality = 'normal') {
  const preset = QUALITY_PRESETS[quality] || QUALITY_PRESETS.normal;
  const nodeIds = parseNodeIds(item);
  const units = nodeIds.length ? nodeIds : [null];

  let win = null;
  let timer = null;
  let cancelled = false;
  let rejectStop = null;

  if (stopRequested) throw new StopError();

  const stopPromise = new Promise((_resolve, reject) => {
    rejectStop = reject;
  });

  const requestStop = () => {
    if (cancelled) return;
    cancelled = true;
    rejectStop(new StopError());
  };

  activeStop = requestStop;
  if (stopRequested) requestStop();

  const images = [];

  try {
    // A hidden window keeps the desktop calm while the batch runs; Copy as
    // PNG still works without showing Figma.
    win = new BrowserWindow({
      width: 1400,
      height: 900,
      show: false,
      title: `Figma — ${itemLabel(item, item.index)}`,
      icon: APP_ICON,
      backgroundColor: '#ffffff',
      autoHideMenuBar: true,
      webPreferences: {
        partition: FIGMA_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false
      }
    });

    win.setMenuBarVisibility(false);

    for (let unitIndex = 0; unitIndex < units.length; unitIndex += 1) {
      if (cancelled || stopRequested) throw new StopError();

      const nodeId = units[unitIndex];

      if (units.length > 1) {
        log(
          `${itemLabel(item, item.index)}: image ${unitIndex + 1} of ${units.length}`,
          'info'
        );
      }

      const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          cancelled = true;
          reject(new ItemError(preset.timeoutMessage));
        }, preset.unitTimeout);
      });

      let unitImages = [];

      try {
        unitImages = await Promise.race([
          captureUnitImages(win, item, nodeId, () => cancelled, preset, () => {
            log(
              `${itemLabel(item, item.index)}: high quality was unavailable; used normal quality instead.`,
              'info'
            );
          }),
          timeout,
          stopPromise
        ]);
      } finally {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      }

      if (cancelled) throw new StopError();

      if (Array.isArray(unitImages) && unitImages.length) {
        for (const entry of unitImages) {
          const tiles = tileImage(entry.image, preset);

          tiles.forEach((tile, tileIndex) => {
            const label = entry.label
              ? tiles.length > 1
                ? `${entry.label} (${tileIndex + 1}/${tiles.length})`
                : entry.label
              : '';
            images.push({ buffer: tile.toPNG(), label });
          });
        }
      } else {
        // Neither export nor clipboard capture worked; fall back to the
        // 1600x1000 viewport screenshot.
        const fallbackTimeout = new Promise((_resolve, reject) => {
          timer = setTimeout(() => {
            cancelled = true;
            reject(new ItemError(preset.timeoutMessage));
          }, preset.unitTimeout);
        });

        try {
          const png = await Promise.race([
            captureViewportPng(win, () => cancelled),
            fallbackTimeout,
            stopPromise
          ]);

          if (png) images.push({ buffer: png, label: '' });
        } finally {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
        }
      }
    }
  } finally {
    if (activeStop === requestStop) activeStop = null;
    if (timer) clearTimeout(timer);
    if (win && !win.isDestroyed()) win.destroy();
  }

  if (!images.length) {
    throw new ItemError('No image was captured.');
  }

  const digits = Math.max(2, String(images.length).length);
  const files = [];

  for (let i = 0; i < images.length; i += 1) {
    const suffix = images.length > 1 ? `-${String(i + 1).padStart(digits, '0')}` : '';
    const target = outputPathFor(outputRoot, item, suffix);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, images[i].buffer);
    files.push({ path: target, label: images[i].label });
  }

  return { count: images.length, files };
}

async function executeBatch(items, outputRoot, summary, quality) {
  const total = items.length;
  let completed = 0;

  const emitProgress = () => {
    sendEvent({ type: 'progress', completed, total });
  };

  emitProgress();

  for (let index = 0; index < items.length; index += 1) {
    if (stopRequested) return true;

    const item = items[index];
    const label = itemLabel(item, index);

    if (!item.valid) {
      const message = `Skipped: ${item.reason}`;
      log(`${label}: ${message}`, 'error');
      sendEvent({ type: 'item', index, status: 'error', error: item.reason });
      summary.failedItems.push({ folder: item.folder, name: item.name, reason: item.reason });
      completed += 1;
      emitProgress();
      continue;
    }

    sendEvent({ type: 'item', index, status: 'working', error: '' });
    log(`${label}: started`, 'info');

    let stoppedHere = false;

    try {
      const result = await captureItem(item, outputRoot, quality);
      summary.success += 1;
      summary.savedItems.push({
        folder: item.folder,
        name: item.name,
        files: result.files
      });
      sendEvent({ type: 'item', index, status: 'success', error: '' });

      if (result.count > 1) {
        log(`${label}: success — ${result.count} images in ${item.folder}`, 'success');
      } else {
        log(`${label}: success — ${item.folder}/${item.name}.png`, 'success');
      }
    } catch (error) {
      if (error instanceof StopError) {
        sendEvent({ type: 'item', index, status: 'waiting', error: '' });
        log(`${label}: stopped.`, 'info');
        stoppedHere = true;
      } else {
        const reason = safeErrorMessage(error);
        summary.failedItems.push({ folder: item.folder, name: item.name, reason });
        sendEvent({ type: 'item', index, status: 'error', error: reason });
        log(`${label}: ${reason}`, 'error');
      }
    } finally {
      if (!stoppedHere) {
        completed += 1;
        emitProgress();
      }
    }

    if (stoppedHere) return true;

    if (index < items.length - 1) {
      await wait(BETWEEN_ITEMS_MS);
    }
  }

  return false;
}

function safePathPart(value, fallback = 'item') {
  let text = String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim();

  text = text.replace(/[\\/:*?"<>|]+/g, '-');
  text = text.replace(/\s+/g, ' ').trim();
  text = text.replace(/^[.\s]+|[.\s]+$/g, '');

  if (!text) text = fallback;
  return text.slice(0, 120);
}

function cleanPageName(value, fallback) {
  const stripped = String(value || '').replace(/^[^\p{L}\p{N}]+/u, '');
  return safePathPart(stripped, fallback);
}

async function waitForEditorReady(webContents, isStopped, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (isStopped()) throw new StopError();

    const state = await readPageState(webContents);
    if (state) {
      if (state.denied) throw new ItemError('No access to this Figma file.');
      if (state.login) throw new ItemError('Not signed in to Figma.');
      if (state.hasCanvas) {
        await waitForPageIdle(webContents, isStopped, RENDER_IDLE_MAX_MS);
        await wait(CANVAS_SETTLE_MS);
        return;
      }
    }

    await wait(PAGE_POLL_MS);
  }

  throw new ItemError('Timed out while loading the Figma file.');
}

async function readProjectPages(webContents) {
  const pages = await runInPage(
    webContents,
    `(() => {
      return Array.from(document.querySelectorAll('[data-testid="PagesRowWrapper"]')).map((element) => {
        const nameElement = element.querySelector('span');
        return {
          id: element.getAttribute('data-page-row-id') || '',
          name: nameElement ? (nameElement.innerText || '').trim() : ''
        };
      }).filter((page) => /^\\d+:\\d+$/.test(page.id));
    })()`
  );

  return Array.isArray(pages) ? pages : [];
}

async function readTopLevelLayers(webContents, isStopped) {
  const collected = new Map();

  const gatherScript = `(() => {
    const rows = [];

    for (const element of document.querySelectorAll('[data-testid$="-layers-panel-row"]')) {
      const content = element.closest('[data-testid="tree-grid-row-content"]');
      if (!content) continue;

      const indent = content.firstElementChild;
      const width = indent ? parseFloat(indent.style.width || '0') : 0;
      if (width > 0) continue;

      const testId = element.getAttribute('data-testid') || '';
      const match = testId.match(/^(\\d+:\\d+)-layers-panel-row$/);
      if (!match) continue;

      const name = (element.innerText || '').trim();
      if (!name) continue;

      rows.push({ id: match[1], name });
    }

    return rows;
  })()`;

  const scrollScript = `(() => {
    const row = document.querySelector('[data-testid="tree-grid-row-content"]');
    if (!row) return { scrolled: false };

    let node = row.parentElement;

    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      const scrollable =
        (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
        node.scrollHeight > node.clientHeight + 10;

      if (scrollable) {
        const before = node.scrollTop;
        node.scrollTop = Math.min(
          node.scrollHeight,
          node.scrollTop + Math.max(200, node.clientHeight - 80)
        );
        return { scrolled: node.scrollTop !== before };
      }

      node = node.parentElement;
    }

    return { scrolled: false };
  })()`;

  for (let pass = 0; pass < 80; pass += 1) {
    if (isStopped()) throw new StopError();

    const rows = await runInPage(webContents, gatherScript);
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (!collected.has(row.id)) collected.set(row.id, row.name);
      }
    }

    const scroll = await runInPage(webContents, scrollScript);
    if (!scroll || !scroll.scrolled) break;

    await wait(350);
  }

  return Array.from(collected.entries()).map(([id, name]) => ({ id, name }));
}

function buildProjectEntries(baseUrl, pages) {
  const entries = [];
  const usedFolders = new Map();

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex];
    const baseFolder = cleanPageName(page.name, `Page ${pageIndex + 1}`);
    const folderKey = baseFolder.toLowerCase();
    const folderCount = usedFolders.get(folderKey) || 0;
    usedFolders.set(folderKey, folderCount + 1);

    const folder = folderCount ? `${baseFolder}-${folderCount + 1}` : baseFolder;
    const usedNames = new Map();

    for (let frameIndex = 0; frameIndex < page.frames.length; frameIndex += 1) {
      const frame = page.frames[frameIndex];
      const baseName = safePathPart(frame.name, `Frame ${frameIndex + 1}`);
      const nameKey = baseName.toLowerCase();
      const nameCount = usedNames.get(nameKey) || 0;
      usedNames.set(nameKey, nameCount + 1);

      const name = nameCount ? `${baseName}-${nameCount + 1}` : baseName;
      const nodeId = frame.id.replace(':', '-');
      const frameUrl = new URL(baseUrl);
      frameUrl.searchParams.set('node-id', nodeId);

      entries.push({
        folder,
        name,
        nodeId,
        url: frameUrl.toString()
      });
    }
  }

  return entries;
}

async function selectProjectPage(webContents, pageId, isStopped) {
  const query = JSON.stringify(
    `[data-testid="PagesRowWrapper"][data-page-row-id="${pageId}"]`
  );

  const clicked = await runInPage(
    webContents,
    `(() => {
      const element = document.querySelector(${query});
      if (!element) return false;
      element.scrollIntoView({ block: 'nearest' });
      const button = element.querySelector('button') || element;
      button.click();
      return true;
    })()`
  );

  if (!clicked) {
    throw new ItemError('Could not select a page in the Pages panel.');
  }

  const selectedScript = `(() => {
    const element = document.querySelector(${query});
    if (!element) return false;
    const row = element.closest('[role="row"]');
    return row ? row.getAttribute('aria-selected') === 'true' : false;
  })()`;

  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (isStopped()) throw new StopError();
    if (await runInPage(webContents, selectedScript)) break;
    await wait(300);
  }

  await wait(1_500);
}

async function generateProjectLinks(projectUrl, isStopped = () => false) {
  let parsed;

  try {
    parsed = new URL(projectUrl);
  } catch {
    throw new ItemError('Enter a valid Figma project link.');
  }

  if (!/(^|\.)figma\.com$/i.test(parsed.hostname)) {
    throw new ItemError('Only figma.com links are supported.');
  }

  const keyMatch = parsed.pathname.match(/^\/(?:design|file)\/([A-Za-z0-9]+)/);
  if (!keyMatch) {
    throw new ItemError('This link does not point to a Figma design file.');
  }

  const baseUrl = `${parsed.origin}${parsed.pathname}`;
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      partition: FIGMA_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });

  win.setMenuBarVisibility(false);

  try {
    await win.loadURL(projectUrl).catch(() => {});
    await waitForEditorReady(win.webContents, isStopped, 60_000);

    const pages = await readProjectPages(win.webContents);
    if (!pages.length) {
      throw new ItemError('No pages were found. Open the file and make the Pages panel visible.');
    }

    log(`Found ${pages.length} page(s). Reading frames…`, 'info');

    const collected = [];

    for (let index = 0; index < pages.length; index += 1) {
      const page = pages[index];
      const pageName = cleanPageName(page.name, `Page ${index + 1}`);

      log(`Reading page ${index + 1}/${pages.length}: ${pageName}`, 'info');

      await selectProjectPage(win.webContents, page.id, isStopped);

      const frames = await readTopLevelLayers(win.webContents, isStopped);
      collected.push({ name: page.name, frames });
    }

    return {
      baseUrl,
      key: keyMatch[1],
      pages: collected,
      items: buildProjectEntries(baseUrl, collected)
    };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

function registerIpcHandlers() {
  ipcMain.handle('figma:login', () => {
    openFigmaLogin();
    return { ok: true };
  });

  ipcMain.handle('figma:session', () => getFigmaSessionStatus());

  ipcMain.handle('figma:import-firefox', async () => {
    const result = await readFirefoxCookies();
    if (!result.ok) return result;

    const applied = await applyFirefoxCookies(result.cookies);
    if (applied.imported === 0) {
      return { ok: false, error: 'No valid Figma cookies were found in the Firefox session.' };
    }

    const status = await getFigmaSessionStatus();
    return {
      ok: true,
      imported: applied.imported,
      failed: applied.failed,
      loggedIn: status.loggedIn
    };
  });

  ipcMain.handle('links:choose', async () => {
    const options = {
      title: 'Choose links.json',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    };

    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);

    if (result.canceled || !result.filePaths.length) return { canceled: true };

    try {
      const text = await fs.readFile(result.filePaths[0], 'utf8');
      const data = JSON.parse(text.replace(/^\uFEFF/, ''));
      if (!Array.isArray(data)) {
        return { error: 'links.json must contain a JSON array.' };
      }

      return {
        path: result.filePaths[0],
        items: data.map((entry, index) => normalizeItem(entry, index))
      };
    } catch {
      return { error: 'The selected file could not be read or is not valid JSON.' };
    }
  });

  ipcMain.handle('links:generate', async (_event, projectUrl) => {
    if (batchRunning || projectGenerating) {
      return { ok: false, error: 'Another task is already running.' };
    }

    projectGenerating = true;

    try {
      const result = await generateProjectLinks(String(projectUrl || '').trim());

      if (!result.items.length) {
        return { ok: false, error: 'No frames were found in this project.' };
      }

      const fileSlug = safePathPart(path.basename(new URL(result.baseUrl).pathname), 'figma');
      const options = {
        title: 'Save generated links.json',
        defaultPath: path.join(app.getPath('documents'), `${fileSlug}-links.json`),
        filters: [{ name: 'JSON', extensions: ['json'] }]
      };

      const save = mainWindow
        ? await dialog.showSaveDialog(mainWindow, options)
        : await dialog.showSaveDialog(options);

      if (save.canceled || !save.filePath) {
        return {
          ok: true,
          canceled: true,
          items: result.items.map((entry, index) => normalizeItem(entry, index)),
          pages: result.pages.length
        };
      }

      await fs.writeFile(save.filePath, JSON.stringify(result.items, null, 2) + '\n', 'utf8');
      log(`Saved ${result.items.length} frame link(s) to ${save.filePath}`, 'success');

      return {
        ok: true,
        path: save.filePath,
        items: result.items.map((entry, index) => normalizeItem(entry, index)),
        pages: result.pages.length,
        count: result.items.length
      };
    } catch (error) {
      return { ok: false, error: safeErrorMessage(error) };
    } finally {
      projectGenerating = false;
    }
  });

  ipcMain.handle('links:save', async (_event, payload) => {
    if (!payload || !Array.isArray(payload.items) || !payload.items.length) {
      return { ok: false, error: 'There are no links to save.' };
    }

    const options = {
      title: 'Save links.json',
      defaultPath: path.join(app.getPath('documents'), 'links.json'),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    };

    const save = mainWindow
      ? await dialog.showSaveDialog(mainWindow, options)
      : await dialog.showSaveDialog(options);

    if (save.canceled || !save.filePath) return { canceled: true };

    try {
      await fs.writeFile(save.filePath, JSON.stringify(payload.items, null, 2) + '\n', 'utf8');
      return { ok: true, path: save.filePath };
    } catch {
      return { ok: false, error: 'Could not write the JSON file.' };
    }
  });

  ipcMain.handle('clipboard:write', (_event, text) => {
    if (typeof text !== 'string' || !text) return { ok: false };
    clipboard.writeText(text);
    return { ok: true };
  });

  ipcMain.handle('output:choose', async () => {
    const options = {
      title: 'Choose output folder',
      properties: ['openDirectory', 'createDirectory']
    };

    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);

    if (result.canceled || !result.filePaths.length) return { canceled: true };
    return { path: result.filePaths[0] };
  });

  ipcMain.handle('capture:start', async (_event, payload) => {
    if (batchRunning || projectGenerating) {
      return { ok: false, error: 'Another task is already running.' };
    }

    if (!payload || !Array.isArray(payload.items) || payload.items.length === 0) {
      return { ok: false, error: 'links.json has no items to process.' };
    }

    if (typeof payload.outputDir !== 'string' || !path.isAbsolute(payload.outputDir)) {
      return { ok: false, error: 'Choose an output folder first.' };
    }

    try {
      const stat = await fs.stat(payload.outputDir);
      if (!stat.isDirectory()) {
        return { ok: false, error: 'The selected path is not a folder.' };
      }
    } catch {
      return { ok: false, error: 'The output folder is not available.' };
    }

    const items = payload.items.map((entry, index) => normalizeItem(entry, index));
    const quality = payload.quality === 'high' ? 'high' : 'normal';
    batchRunning = true;
    stopRequested = false;
    activeStop = null;

    ensureDownloadHandler();

    // Copy as PNG uses the system clipboard. Put the user's clipboard back
    // when the batch finishes, including after a stop request.
    const savedClipboard = clipboardSnapshot();

    setImmediate(async () => {
      const summary = { success: 0, failedItems: [], savedItems: [], stopped: false };

      try {
        log(
          quality === 'high'
            ? 'Output quality: High (4x).'
            : 'Output quality: Normal (2x).',
          'info'
        );
        summary.stopped = await executeBatch(items, payload.outputDir, summary, quality);
      } catch {
        log('The batch stopped unexpectedly.', 'error');
      } finally {
        batchRunning = false;
        stopRequested = false;
        activeStop = null;
        restoreClipboard(savedClipboard);
      }

      if (summary.stopped) {
        log('Run stopped at your request.', 'info');
      }

      sendEvent({
        type: 'summary',
        success: summary.success,
        failed: summary.failedItems.length,
        failedItems: summary.failedItems,
        savedItems: summary.savedItems,
        outputDir: payload.outputDir,
        stopped: summary.stopped
      });
    });

    return { ok: true };
  });

  ipcMain.handle('capture:stop', () => {
    if (!batchRunning) {
      return { ok: false, error: 'No batch is running.' };
    }

    requestStop();
    return { ok: true };
  });

  ipcMain.handle('output:open', async (_event, directory) => {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
      return { ok: false, error: 'Choose an output folder first.' };
    }

    const result = await shell.openPath(directory);
    return result ? { ok: false, error: 'Could not open the output folder.' } : { ok: true };
  });
}

module.exports = {
  QUALITY_PRESETS,
  normalizeItem,
  parseNodeIds,
  captureItem,
  executeBatch,
  generateProjectLinks,
  getFigmaSessionStatus,
  readFirefoxCookies,
  applyFirefoxCookies,
  ensureDownloadHandler,
  safePathPart,
  safeErrorMessage,
  setLogSink,
  requestStop
};

const CLI_COMMANDS = new Set([
  'capture',
  'generate',
  'session',
  'import-firefox',
  'sample',
  'help',
  'version'
]);

function hasCliArguments(argv) {
  return argv
    .slice(1)
    .some(
      (argument) =>
        argument === '-h' ||
        argument === '--help' ||
        argument === '-V' ||
        argument === '--version' ||
        CLI_COMMANDS.has(argument)
    );
}

// Electron does not set require.main to the app entry point, so detect it by
// looking for our own path in process.argv (dev) or the packaged app flag.
function isElectronAppEntry(argv) {
  if (app.isPackaged) return true;

  const targets = new Set([
    __filename,
    __dirname,
    path.join(__dirname, 'main.js'),
    path.join(__dirname, 'package.json')
  ]);

  return argv.some((argument, index) => {
    if (index === 0) return false;

    try {
      return targets.has(path.resolve(process.cwd(), argument));
    } catch {
      return false;
    }
  });
}

function startGui() {
  app.whenReady().then(() => {
    registerIpcHandlers();
    createMainWindow();

    app.on('activate', () => {
      if (!mainWindow) createMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

if (process.env.FIGMA_SHOT_CLI !== '1' && isElectronAppEntry(process.argv)) {
  if (hasCliArguments(process.argv)) {
    require('./cli.js');
  } else {
    startGui();
  }
}

