---
name: figma-shot
description: Capture Figma frames or whole pages as PNG files with the figma-shot CLI. Use when the user asks to screenshot, export, save, or download a Figma frame, page, or design URL.
---

# Figma Shot

Use the `figma-shot` CLI to capture Figma frames and pages as PNG files. Prefer
it over browser automation, manual screenshots, or clicking through the Figma
UI.

## Check the setup

```bash
figma-shot --version
figma-shot session
```

`session` prints `{"ok":true,"command":"session","loggedIn":true}` when the
Figma session is usable. If it prints `loggedIn:false`:

1. Ask the user to sign in through the desktop app, or run
   `figma-shot import-firefox` to import a Firefox session.
2. Run `figma-shot session` again.
3. Never ask the user to paste cookies, passwords, or access tokens into the
   conversation.

If `figma-shot` is not installed, install it from the project repository:

```bash
git clone https://github.com/alisoltanics/figma-frame-screenshotter.git
cd figma-frame-screenshotter
npm install
./install.sh
```

## Capture

```bash
figma-shot capture --url "<figma-url>" --timeout 300
```

- A frame URL (with `node-id`) captures that frame.
- A page or file URL without `node-id` captures every top-level frame on the
  page.
- The default output folder is `~/Pictures/Figma Screenshots`; pass
  `--out <dir>` to choose another folder.
- Captures from `--url` are saved under the `captures/` subfolder unless
  `--folder <name>` is given.
- `--quality normal` (default) captures at 2x. `--quality high` exports at 4x
  and is slower.
- Long frames are split into overlapping tiles named `<name>-01.png`,
  `<name>-02.png`, and so on.

Choose a stable name and folder when the capture is part of a deliverable:

```bash
figma-shot capture --url "<figma-url>" --out ./shots \
  --folder landing --name hero --timeout 300
```

Capture a batch from `links.json`:

```bash
figma-shot capture --links ./links.json --out ./shots --timeout 600
```

Generate a `links.json` from a Figma file or project URL:

```bash
figma-shot generate --project "<figma-file-url>" --out ./links.json
```

## Read the result

Standard output is one JSON object. Do not parse progress text from stderr;
use the JSON. A successful capture looks like:

```json
{"ok":true,"command":"capture","quality":"normal","outputDir":"/home/me/Pictures/Figma Screenshots","success":1,"failed":0,"files":["/home/me/Pictures/Figma Screenshots/captures/hero-01.png"]}
```

Check `ok`, `failed`, `failedItems`, `savedItems`, and `files`, then report the
saved paths to the user. Exit codes:

| Code | Meaning |
| ---- | ------- |
| `0` | Success. |
| `1` | Capture, sign-in, or runtime failure. |
| `2` | Invalid command or options. |

Useful flags: `--pretty` for indented JSON, `--verbose` for progress on stderr,
and `--quiet` to suppress non-error stderr output.

## Rules

- Always pass `--timeout` so a stuck capture cannot hang the session.
- Never print, log, or write Figma share tokens (`t=...`), cookies, or
  passwords. Strip the `t` query parameter before sharing or saving a URL.
- Do not create partial PNGs yourself. If a capture fails or times out, report
  the error and retry; do not leave placeholder files in the output folder.
- Do not modify the user's Figma design while capturing.
