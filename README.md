# Figma Frame Screenshotter

A small Electron app that captures Figma frames as PNG files. It reads a
`links.json` file, captures every item, splits very tall frames into several
tiles, and reports exactly which files were saved where.

## Install and run

```bash
npm install
npm start
```

To add the app to your Ubuntu application list with an icon and install the
`figma-shot` command into `~/.local/bin`:

```bash
./install.sh
```

The app has a single runtime dependency: `electron`. There is no build step.

## Signing in

Click **Sign in to Figma** and sign in manually in the window that opens. The
status badge in the header updates automatically.

If you are already signed in to Figma in Firefox, click **Use Firefox session**
to import the `figma.com` cookies. The session is stored in the persistent
`persist:figma` partition. Tokens, cookies, and passwords are never logged or
written to disk by the app.

## Capture a batch

1. Choose a `links.json` file.
2. Choose an output folder, or keep the default.
3. Pick a quality mode.
4. Click **Start**. Click **Stop** at any time to stop promptly; files that were
   not fully captured are not written.

### Capture a node directly

Paste a Figma frame or page link into **Capture a node directly** and click
**Capture node**. No `links.json` file is needed. A frame link captures that
frame; a page link captures every top-level frame on the page. Direct captures
are saved under the `captures/` subfolder.

### Output folder

The default output folder is `~/Pictures/Figma Screenshots` (the Pictures
folder reported by the operating system). If no output folder has been chosen,
captures are saved there. Use **Choose output folder** to pick another folder
and **Use default** to switch back.

### Quality modes

| Mode | How it captures | Result |
| --- | --- | --- |
| **Normal (2x)** | Figma's *Copy as PNG* | 2x pixel density, fast |
| **High (4x)** | Figma's *Export* panel at **4x** | 4x pixel density, sharper and larger |

High quality downloads the export as a ZIP file, extracts every PNG, and then
tiles long frames locally. Temporary ZIPs are deleted immediately after
extraction. If the high-quality export is not available for an item, the app
logs it and falls back to normal quality.

A link can point at:

- **A frame** — `...?node-id=1-2` captures that frame.
- **Several nodes** — `node-id=1-2%2C3-4` or a `nodeId` with commas captures
  every listed node.
- **A page** — a page id or a link with no `node-id` selects all top-level
  frames on that page and captures each one separately.

## Output layout

```text
<output folder>/
  <folder>/
    <name>.png
    <name>-01.png
    <name>-02.png
    ...
```

- `folder` and `name` come from each `links.json` entry.
- A single captured image is saved as `<name>.png`.
- Multiple images (several nodes, or a long frame split into tiles) use
  `<name>-01.png`, `<name>-02.png`, and so on.
- Long frames are split into overlapping tiles so no content is lost at the
  cut. Tiles are numbered in reading order.

When a run finishes, the **Summary** panel shows:

- how many items succeeded or failed, with the reason for each failure,
- the full output folder path with a **Copy path** button,
- a **Saved files** report grouping every written file by its links entry.

## links.json

The file is a JSON array. Each entry has `folder`, `name`, `nodeId`, and `url`:

```json
[
  {
    "folder": "landing",
    "name": "desktop",
    "nodeId": "1-2",
    "url": "https://www.figma.com/design/AbCdEf123456/Example-Project?node-id=1-2"
  },
  {
    "folder": "landing",
    "name": "mobile",
    "nodeId": "",
    "url": "https://www.figma.com/design/AbCdEf123456/Example-Project"
  }
]
```

- `folder` is the output subfolder.
- `name` is the file name (without `.png`).
- `nodeId` is optional when the URL already contains `node-id`.
- Entries without a `nodeId` and without a `node-id` in the URL capture every
  top-level frame on the page.

Click **Sample JSON** in the app to see this structure at any time. **Save JSON**
writes the currently loaded entries back to a file.

## Generate links.json from a project

Enter a Figma project or file link in the **Generate links.json from a Figma
project** section, for example:

```text
https://www.figma.com/design/AbCdEf123456/Example-Project
```

Click **Generate links.json**. The app reads every page and every top-level
frame in the file, builds one entry per frame, saves the JSON file where you
choose, and loads the generated entries into the app so you can start a capture
immediately.

Notes:

- The Figma file must be openable with your current session.
- The Pages and Layers panels must be available; the app uses them to enumerate
  pages and frames.
- Page names are cleaned for use as folder names (leading symbols are removed).
  Empty page names fall back to `Page 1`, `Page 2`, and so on.
- Duplicate names get a numeric suffix so no file is overwritten.

## Command-line interface

`figma-shot` runs the same capture pipeline without opening the UI, which makes
it easy to call from scripts and AI agents.

```bash
# From a git checkout (after npm install)
./bin/figma-shot capture --url "https://www.figma.com/design/AbCdEf123456/Example-Project?node-id=1-2" \
  --out ./screenshots --quality normal

# The installed desktop app exposes the same commands
figma-frame-screenshotter capture --links ./links.json --out ./screenshots --quality high
```

On Windows use `bin\figma-shot.cmd`. In a git checkout you can also run
`npm run cli -- <command>`.

### Commands

| Command | Purpose |
| --- | --- |
| `capture` | Capture frames or pages from `--url` or `--links`. |
| `generate` | Read a Figma project/file and write a `links.json` file. |
| `skill` | Install the AI agent skill, or print it. |
| `session` | Report whether a Figma session is available. |
| `import-firefox` | Import the Firefox Figma session. |
| `sample` | Print a sample `links.json` array. |

### Capture

```bash
figma-shot capture --url <figma-url> --out <dir> [options]
figma-shot capture --links <links.json> --out <dir> [options]
```

| Option | Meaning |
| --- | --- |
| `--url <url>` | Figma frame or page URL. Repeat the flag for several URLs. |
| `--links <file>` | Read entries from a `links.json` file. |
| `--out <dir>` | Output folder (default: `~/Pictures/Figma Screenshots`). |
| `--quality <mode>` | `normal` (2x, default) or `high` (4x). |
| `--folder <name>` | Output subfolder for `--url` entries (default `captures`). |
| `--name <name>` | File name for a single `--url` entry. |
| `--timeout <seconds>` | Stop the run after this many seconds. |
| `--import-firefox` | Import the Firefox session if no session is found. |

### Generate

```bash
figma-shot generate --project "https://www.figma.com/design/AbCdEf123456/Example-Project" \
  --out ./links.json
```

| Option | Meaning |
| --- | --- |
| `--project <url>` | Figma project or file URL (required). |
| `--out <file.json>` | Where to write the file (required). |
| `--include-items` | Include the generated entries in the JSON result. |
| `--timeout <seconds>` | Stop after this many seconds. |

### AI agent skill

The repository ships an [agent skill](.claude/skills/figma-shot/SKILL.md) that
teaches AI tools to use `figma-shot` for screenshots. Claude Code and OpenCode
discover it automatically when working in this repository.

To make it available in every project, install it into the global skill folders:

```bash
figma-shot skill --install                 # Claude Code, OpenCode, and .agents
figma-shot skill --install --target claude # only one agent
figma-shot skill --local                   # install into the current project
figma-shot skill --print                   # print the Markdown
```

The skill checks `figma-shot session`, runs `figma-shot capture` with a
timeout, reads the JSON result, and reports the saved paths. It also instructs
the agent never to log or save Figma tokens, cookies, or passwords.

### General options

- `--user-data-dir <dir>` uses a different Electron profile, so the CLI can use
  a separate Figma session. In a git checkout you can also set
  `FIGMA_SHOT_USER_DATA_DIR`.
- `--pretty` pretty-prints the JSON result.
- `--verbose` sends progress and log lines to stderr.
- `--quiet` suppresses non-error stderr output.
- `-h`, `--help` prints usage; `-V`, `--version` prints the version.

### Output and exit codes

`stdout` contains exactly one JSON object per run, so a caller can parse it
directly. Progress, warnings, and errors are written to `stderr`.

```json
{
  "ok": true,
  "command": "capture",
  "quality": "normal",
  "outputDir": "/home/user/screenshots",
  "success": 1,
  "failed": 0,
  "stopped": false,
  "timedOut": false,
  "files": ["/home/user/screenshots/landing/desktop.png"]
}
```

| Exit code | Meaning |
| --- | --- |
| `0` | The command finished successfully. |
| `1` | A capture failed, the run was stopped, or authentication is required. |
| `2` | Invalid command-line usage. |

A stopped or timed-out run never writes partially captured images. Use
`--timeout` for unattended runs instead of relying on an external kill.

Authentication uses the same persistent `persist:figma` partition as the
desktop app. Sign in through the app, run `figma-shot import-firefox`, or pass
`--import-firefox` to `capture`/`generate`.

## Builds and releases

The app can be packaged for Linux, Windows, and macOS with
[electron-builder](https://www.electron.build/):

```bash
npm run dist:linux   # AppImage + .deb
npm run dist:win     # NSIS installer (.exe)
npm run dist:mac     # .dmg + .zip (universal)
```

Artifacts are written to `dist/`.

Native builds for all three platforms are produced by the
`.github/workflows/release.yml` GitHub Actions workflow. Push a tag to start a
release:

```bash
git tag v1.0.0
git push origin v1.0.0
```

The workflow builds on Ubuntu, Windows, and macOS runners and attaches the
installers to the GitHub Release. You can also start it manually from the
Actions tab to build the installers without publishing a release.

The released builds are currently **unsigned**. Windows may show a SmartScreen
warning and macOS may require opening the app from the context menu; code
signing and notarization require platform certificates configured as repository
secrets.

## Files

- `main.js` — Electron main process: capture, quality modes, export/ZIP
  handling, tiling, JSON generation, and IPC.
- `cli.js` — the non-interactive command-line interface.
- `bin/figma-shot` / `bin/figma-shot.cmd` — CLI launchers for Linux/macOS and
  Windows.
- `preload.js` — the small secure bridge exposed to the UI.
- `index.html` — the interface (HTML/CSS/JS, no framework).
- `.claude/skills/figma-shot/SKILL.md` — the AI agent skill installed by
  `figma-shot skill --install`.
- `install.sh` / `launch.sh` — optional desktop integration helpers.
