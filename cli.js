'use strict';

// The CLI runs inside Electron (main process) so it can reuse the same capture
// pipeline as the desktop app:
//
//   electron cli.js capture --url <figma-url> --out <dir>
//
// stdout is reserved for a single JSON object; progress and diagnostics go to
// stderr.

process.env.FIGMA_SHOT_CLI = '1';

const { app } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

const core = require('./main.js');
const pkg = require('./package.json');

// Running `electron cli.js` makes Electron name the app "Electron", which
// would use ~/.config/Electron instead of the desktop app's profile. Align the
// name and user-data folder with the desktop app before Electron reads them.
if (app.getName() === 'Electron') {
  app.setName(pkg.name);
  app.setPath('userData', path.join(app.getPath('appData'), pkg.name));
}

const SAMPLE_LINKS = [
  {
    folder: 'landing',
    name: 'desktop',
    nodeId: '1-2',
    url: 'https://www.figma.com/design/AbCdEf123456/Example-Project?node-id=1-2'
  },
  {
    folder: 'landing',
    name: 'mobile',
    nodeId: '',
    url: 'https://www.figma.com/design/AbCdEf123456/Example-Project'
  }
];

const HELP = `Figma Frame Screenshotter CLI ${pkg.version}

Usage:
  figma-shot capture --url <figma-url> --out <dir> [options]
  figma-shot capture --links <links.json> --out <dir> [options]
  figma-shot generate --project <figma-url> --out <file.json> [options]
  figma-shot session
  figma-shot import-firefox
  figma-shot sample

Capture options:
  --url <url>             Figma frame/page URL. Repeat for several URLs.
  --links <file>          Read items from a links.json file.
  --out <dir>             Output folder (default: Pictures/Figma Screenshots).
  --quality <mode>        normal (2x, default) or high (4x).
  --folder <name>         Output subfolder for --url items (default: captures).
  --name <name>           File name for a single --url item.
  --timeout <seconds>     Stop the run after this many seconds.
  --import-firefox        Import the Firefox Figma session if not signed in.

Generate options:
  --project <url>         Figma project/file URL.
  --out <file.json>       Where to write the generated links file (required).
  --include-items         Include the generated items in the JSON output.

General options:
  --user-data-dir <dir>   Electron profile to use (same profile as the app by default).
  --pretty                Pretty-print JSON output.
  --verbose               Print progress and log lines to stderr.
  --quiet                 Suppress non-error stderr output.
  -h, --help              Show this help.
  -V, --version           Show the version.

Examples:
  figma-shot capture --url "https://www.figma.com/design/KEY/File?node-id=1-2" \\
    --out ./screenshots --quality high

  figma-shot capture --links ./links.json --out ./screenshots --quality normal

  figma-shot generate --project "https://www.figma.com/design/KEY/File" \\
    --out ./links.json
`;

class CliError extends Error {
  constructor(message, code = 'ERROR') {
    super(message);
    this.name = 'CliError';
    this.code = code;
  }
}

function defaultOptions() {
  return {
    command: '',
    urls: [],
    links: '',
    project: '',
    out: '',
    quality: 'normal',
    folder: '',
    name: '',
    timeout: 0,
    userDataDir: '',
    importFirefox: false,
    includeItems: false,
    pretty: false,
    verbose: false,
    quiet: false
  };
}

function camelCase(key) {
  return key.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function takeValue(argv, index, inlineValue, flag) {
  if (inlineValue !== undefined) return { value: inlineValue, next: index };

  const next = argv[index + 1];
  if (next === undefined) {
    throw new CliError(`Missing value for ${flag}.`, 'USAGE');
  }

  return { value: next, next: index + 1 };
}

function parseArgv(argv) {
  const options = defaultOptions();
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--') {
      positional.push(...argv.slice(index + 1));
      break;
    }

    if (argument === '-h' || argument === '--help') {
      options.help = true;
      continue;
    }

    if (argument === '-V' || argument === '--version') {
      options.version = true;
      continue;
    }

    if (argument === '-q') {
      options.quiet = true;
      continue;
    }

    if (argument === '-v') {
      options.verbose = true;
      continue;
    }

    if (!argument.startsWith('--')) {
      positional.push(argument);
      continue;
    }

    const equals = argument.indexOf('=');
    const rawKey = equals >= 0 ? argument.slice(2, equals) : argument.slice(2);
    const inlineValue = equals >= 0 ? argument.slice(equals + 1) : undefined;
    const key = camelCase(rawKey);

    switch (key) {
      case 'url': {
        const taken = takeValue(argv, index, inlineValue, `--${rawKey}`);
        options.urls.push(taken.value);
        index = taken.next;
        break;
      }

      case 'links':
      case 'project':
      case 'out':
      case 'quality':
      case 'folder':
      case 'name':
      case 'userDataDir':
      case 'timeout': {
        const taken = takeValue(argv, index, inlineValue, `--${rawKey}`);
        if (key === 'timeout') {
          const seconds = Number(taken.value);
          if (!Number.isFinite(seconds) || seconds <= 0) {
            throw new CliError('--timeout must be a positive number of seconds.', 'USAGE');
          }
          options.timeout = seconds;
        } else {
          options[key] = taken.value;
        }
        index = taken.next;
        break;
      }

      case 'importFirefox':
        options.importFirefox = true;
        break;

      case 'includeItems':
        options.includeItems = true;
        break;

      case 'pretty':
        options.pretty = true;
        break;

      case 'verbose':
        options.verbose = true;
        break;

      case 'quiet':
        options.quiet = true;
        break;

      default:
        throw new CliError(`Unknown option: --${rawKey}`, 'USAGE');
    }
  }

  options.command = positional.shift() || 'help';
  options.positional = positional;

  if (options.positional.length) {
    throw new CliError(
      `Unexpected argument(s): ${options.positional.join(' ')}`,
      'USAGE'
    );
  }

  if (options.quality !== 'normal' && options.quality !== 'high') {
    throw new CliError('--quality must be "normal" or "high".', 'USAGE');
  }

  return options;
}

function emit(payload, pretty = false) {
  return new Promise((resolve) => {
    const text = JSON.stringify(payload, null, pretty ? 2 : 0) + '\n';
    process.stdout.write(text, resolve);
  });
}

function stderr(message) {
  process.stderr.write(String(message) + '\n');
}

// Electron may put Chromium flags (for example --no-sandbox) before the app
// path, so process.argv.slice(2) is not reliable. Find our own script and use
// everything after it as CLI arguments.
function getCliArgs() {
  const argv = process.argv;
  const ownIndex = argv.findIndex((argument) => {
    try {
      return path.resolve(argument) === path.resolve(__filename);
    } catch {
      return false;
    }
  });

  if (ownIndex >= 0) return argv.slice(ownIndex + 1);

  // When main.js forwards to the CLI, the app path (for example ".") sits in
  // argv instead of cli.js.
  const appTargets = new Set([
    __dirname,
    path.join(__dirname, 'main.js'),
    path.join(__dirname, 'package.json')
  ]);

  const appIndex = argv.findIndex((argument, index) => {
    if (index === 0) return false;

    try {
      return appTargets.has(path.resolve(process.cwd(), argument));
    } catch {
      return false;
    }
  });

  if (appIndex >= 0) return argv.slice(appIndex + 1);
  return argv.slice(process.defaultApp ? 2 : 1);
}

function resolvePath(value) {
  return path.resolve(process.cwd(), String(value));
}

function safeName(value, fallback) {
  return core.safePathPart(value, fallback);
}

function nameFromUrl(url, index) {
  try {
    const parsed = new URL(url);
    const nodeId = parsed.searchParams.get('node-id');

    if (nodeId) {
      const first = nodeId.split(',')[0].replace(/:/g, '-');
      return safeName(`frame-${first}`, `frame-${index + 1}`);
    }

    const segments = parsed.pathname.split('/').filter(Boolean);
    const tail = segments[segments.length - 1];
    return safeName(tail ? `page-${tail}` : 'page', 'page');
  } catch {
    return `capture-${index + 1}`;
  }
}

function buildUrlItems(options) {
  if (options.name && options.urls.length > 1) {
    throw new CliError('--name can only be used with a single --url.', 'USAGE');
  }

  const folder = safeName(options.folder || 'captures', 'captures');
  const usedNames = new Map();

  return options.urls.map((url, index) => {
    let name = safeName(options.name || nameFromUrl(url, index), `capture-${index + 1}`);
    const key = name.toLowerCase();
    const count = usedNames.get(key) || 0;
    usedNames.set(key, count + 1);

    if (count) name = `${name}-${count + 1}`;

    return core.normalizeItem({ folder, name, nodeId: '', url }, index);
  });
}

async function readLinksItems(filePath) {
  const absolute = resolvePath(filePath);
  let text;

  try {
    text = await fs.readFile(absolute, 'utf8');
  } catch {
    throw new CliError(`Could not read links file: ${absolute}`, 'LINKS_READ_FAILED');
  }

  let data;

  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new CliError('The links file is not valid JSON.', 'LINKS_INVALID');
  }

  if (!Array.isArray(data)) {
    throw new CliError('The links file must contain a JSON array.', 'LINKS_INVALID');
  }

  return data.map((entry, index) => core.normalizeItem(entry, index));
}

async function ensureSignedIn(options) {
  let status = await core.getFigmaSessionStatus();

  if (status.loggedIn) return { loggedIn: true };

  if (options.importFirefox) {
    const result = await core.readFirefoxCookies();

    if (result.ok && Array.isArray(result.cookies) && result.cookies.length) {
      const applied = await core.applyFirefoxCookies(result.cookies);
      status = await core.getFigmaSessionStatus();

      if (status.loggedIn) {
        return { loggedIn: true, imported: applied.imported };
      }
    }
  }

  throw new CliError(
    'Not signed in to Figma. Sign in with the desktop app, or run "figma-shot import-firefox" first.',
    'AUTH_REQUIRED'
  );
}

async function runCapture(options, state) {
  if (options.links && options.urls.length) {
    throw new CliError('Use either --links or --url, not both.', 'USAGE');
  }

  if (!options.links && !options.urls.length) {
    throw new CliError('capture requires --url or --links.', 'USAGE');
  }

  const items = options.links
    ? await readLinksItems(options.links)
    : buildUrlItems(options);

  if (!items.length) {
    throw new CliError('There are no items to capture.', 'NO_ITEMS');
  }

  const outputDir = options.out
    ? resolvePath(options.out)
    : core.getDefaultOutputDir();

  try {
    const stat = await fs.stat(outputDir);
    if (!stat.isDirectory()) {
      throw new CliError(`Output path is not a folder: ${outputDir}`, 'OUTPUT_INVALID');
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    await fs.mkdir(outputDir, { recursive: true });
  }

  const auth = await ensureSignedIn(options);

  core.ensureDownloadHandler();

  const summary = {
    success: 0,
    failedItems: [],
    savedItems: [],
    stopped: false
  };

  let timedOut = false;
  let timer = null;

  if (options.timeout > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      if (!options.quiet) stderr(`Timeout reached (${options.timeout}s); stopping…`);
      core.requestStop();
    }, options.timeout * 1000);
    timer.unref();
  }

  try {
    summary.stopped = await core.executeBatch(items, outputDir, summary, options.quality);
  } finally {
    if (timer) clearTimeout(timer);
  }

  const files = summary.savedItems.flatMap((item) =>
    (item.files || []).map((file) => file.path)
  );

  return {
    ok: !summary.stopped && summary.failedItems.length === 0,
    command: 'capture',
    quality: options.quality,
    outputDir,
    importedCookies: auth.imported || 0,
    success: summary.success,
    failed: summary.failedItems.length,
    stopped: summary.stopped,
    timedOut,
    failedItems: summary.failedItems,
    savedItems: summary.savedItems,
    files
  };
}

async function runGenerate(options) {
  if (!options.project) {
    throw new CliError('generate requires --project <figma-url>.', 'USAGE');
  }

  if (!options.out) {
    throw new CliError('generate requires --out <file.json>.', 'USAGE');
  }

  const auth = await ensureSignedIn(options);

  let outPath = resolvePath(options.out);

  try {
    const stat = await fs.stat(outPath);
    if (stat.isDirectory()) outPath = path.join(outPath, 'links.json');
  } catch {
    // The file does not exist yet; use the path as given.
  }

  if (!outPath.toLowerCase().endsWith('.json')) {
    outPath += '.json';
  }

  let timedOut = false;
  let timer = null;

  if (options.timeout > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      cliStopRequested = true;
      if (!options.quiet) stderr(`Timeout reached (${options.timeout}s); stopping…`);
    }, options.timeout * 1000);
    timer.unref();
  }

  let result;

  try {
    result = await core.generateProjectLinks(
      options.project,
      () => cliStopRequested
    );
  } catch (error) {
    if (error && error.name === 'StopError') {
      return {
        ok: false,
        command: 'generate',
        project: options.project,
        stopped: true,
        timedOut,
        error: 'Stopped before the links file was written.'
      };
    }

    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(result.items, null, 2) + '\n', 'utf8');

  return {
    ok: true,
    command: 'generate',
    project: options.project,
    pages: result.pages.length,
    count: result.items.length,
    out: outPath,
    stopped: false,
    timedOut: false,
    importedCookies: auth.imported || 0,
    ...(options.includeItems ? { items: result.items } : {})
  };
}

async function runImportFirefox(options) {
  const result = await core.readFirefoxCookies();

  if (!result.ok) {
    throw new CliError(result.error || 'Could not read the Firefox session.', 'IMPORT_FAILED');
  }

  const applied = await core.applyFirefoxCookies(result.cookies);
  const status = await core.getFigmaSessionStatus();

  return {
    ok: status.loggedIn,
    command: 'import-firefox',
    imported: applied.imported,
    failed: applied.failed,
    loggedIn: status.loggedIn,
    ...(status.loggedIn
      ? {}
      : { error: 'The imported cookies did not produce a valid Figma session.' })
  };
}

async function run(options, state) {
  if (options.version || options.command === 'version') {
    await emit({ ok: true, name: pkg.name, version: pkg.version }, options.pretty);
    return 0;
  }

  if (options.help || options.command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }

  if (options.verbose && !options.quiet) {
    core.setLogSink((message, level) => stderr(`[${level}] ${message}`));
  }

  switch (options.command) {
    case 'capture': {
      const result = await runCapture(options, state);
      await emit(result, options.pretty);
      return result.ok ? 0 : 1;
    }

    case 'generate': {
      const result = await runGenerate(options);
      await emit(result, options.pretty);
      return result.ok ? 0 : 1;
    }

    case 'session': {
      const status = await core.getFigmaSessionStatus();
      await emit(
        {
          ok: true,
          command: 'session',
          loggedIn: Boolean(status.loggedIn),
          ...(status.error ? { error: status.error } : {})
        },
        options.pretty
      );
      return status.loggedIn ? 0 : 1;
    }

    case 'import-firefox': {
      const result = await runImportFirefox(options);
      await emit(result, options.pretty);
      return result.ok ? 0 : 1;
    }

    case 'sample': {
      await emit({ ok: true, command: 'sample', links: SAMPLE_LINKS }, options.pretty);
      return 0;
    }

    default:
      throw new CliError(`Unknown command: ${options.command}`, 'USAGE');
  }
}

let options = null;
let interrupted = false;
let cliStopRequested = false;

try {
  options = parseArgv(getCliArgs());

  if (options.userDataDir) {
    app.setPath('userData', resolvePath(options.userDataDir));
  }
} catch (error) {
  const payload = {
    ok: false,
    command: 'help',
    error: error.message,
    code: error.code || 'USAGE'
  };
  process.stdout.write(JSON.stringify(payload) + '\n', () => {
    process.exit(2);
  });
}

if (options) {
  // The CLI creates and destroys hidden BrowserWindows. Without a listener,
  // Electron would quit as soon as the last window closes, before the result
  // can be printed.
  app.on('window-all-closed', () => {});

  process.on('SIGINT', () => {
    if (interrupted) {
      process.exit(130);
    }

    interrupted = true;
    cliStopRequested = true;
    if (!options.quiet) stderr('Interrupt received; stopping…');
    core.requestStop();
  });

  app
    .whenReady()
    .then(async () => {
      const code = await run(options, { interrupted: () => interrupted });
      app.exit(code);
    })
    .catch(async (error) => {
      const payload = {
        ok: false,
        command: options.command,
        error: error.message || String(error),
        code: error.code || 'ERROR'
      };
      await emit(payload, options.pretty);
      app.exit(error.code === 'USAGE' ? 2 : 1);
    });
}
