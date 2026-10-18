# File Palette

[![Build](https://github.com/notuntoward/obsidian-file-palette/actions/workflows/build.yml/badge.svg)](https://github.com/notuntoward/obsidian-file-palette/actions/workflows/build.yml)
[![CodeQL](https://github.com/notuntoward/obsidian-file-palette/actions/workflows/codeql.yml/badge.svg)](https://github.com/notuntoward/obsidian-file-palette/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://github.com/notuntoward/obsidian-file-palette/actions/workflows/scorecard.yml/badge.svg)](https://github.com/notuntoward/obsidian-file-palette/actions/workflows/scorecard.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/notuntoward/obsidian-file-palette/badge)](https://securityscorecards.dev/viewer/?uri=github.com/notuntoward/obsidian-file-palette)

A fast file and folder picker for Obsidian.

This plugin provides a lightweight palette-style UI for jumping to files,
and browsing folders through two searchable commands.

## Features

- Search files and folders by name
- Open entries directly from a palette-like modal
- Navigate folders and slash-separated paths
- Jump to a file inferred from the current editor selection or cursor
- Keep the interaction lightweight and keyboard-friendly
- Built on the Obsidian plugin template with linting, type-checking, and tests

## Development

```bash
npm install
npm run dev
```

## Commands

- `Open file palette`: always opens the picker in the current note's folder
  (or the vault root when no note is active), without trying to infer anything
  from the editor.
- `Find file (guessing)`: first inspects the active editor for selected text,
  the word under the cursor, or a wiki link such as `[[filename]]`. If that
  text resolves to a real file, the plugin opens it immediately. Otherwise, it
  opens the picker with the guessed text prefilled as the initial query.

In other words, `Open file palette` is a manual browse command, while `Find file
(guessing)` is an intent-aware shortcut that tries to jump directly to a file
before falling back to the same picker.

The picker fuzzy-matches the current folder's children. Select a folder to
browse into it, select `.. (parent folder)` or press Backspace on an empty
search to go up, and enter slash-separated paths to navigate through folders.
The current folder path stays displayed at the top of the palette, below the
accent-colored `File palette` title. The title can be hidden with the
`Show command title` setting; the path remains visible. Long paths retain their
deepest folders and show the full path on hover. Start a query with `/` or `~`
to switch to the vault root. Use Up/Down to highlight a suggestion and Enter to
open a file or browse into a folder. Footer hints wrap to fit the modal and
show `⌘`/`⇧`/`⌥` on macOS or `Ctrl`/`Shift`/`Alt` on Windows and Linux. To act
on the highlighted file or folder, type `:` to reveal it in Obsidian's file
navigator or `?` to show it in the system file explorer. Type `*` to open it
with the system default app. Press `Ctrl+Shift+L` (Windows/Linux) or
`Cmd+Shift+L` (macOS) to copy an Obsidian link to a highlighted file, using
the vault's configured link format. The system file
explorer and default app actions depend on platform support. These operator
characters cannot appear in filenames on Windows. The picker includes every
file type; Markdown extensions are omitted from names, while other file
extensions appear as right-aligned hints.

For a highlighted file, use the Obsidian tab shortcuts: `Ctrl+Shift+Enter` on
Windows/Linux or `Cmd+Shift+Enter` on macOS to open in a new tab;
`Ctrl+Alt+Enter` or `Cmd+Option+Enter` to open in a new tab group; and add
`Shift` to that last shortcut to open in a new window (desktop only). These
modifier shortcuts do not change folder selection: folders continue to open in
the picker.

## Build and test

```bash
npm run build
npm run test:run
```
