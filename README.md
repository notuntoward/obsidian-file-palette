# File Palette

A fast file and folder picker for Obsidian.

This plugin provides a lightweight palette-style UI for jumping to files,
and browsing folders through two searchable commands.

## Features

- Search files and folders by name
- Open entries directly from a palette-like modal
- Navigate folders and slash-separated paths
- Jump to a file inferred from the current editor selection or cursor
- Keep the interaction lightweight and keyboard-friendly

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

The picker fuzzy-matches the current folder's children. Enter slash-separated
paths to browse folders; prefix a query with `/` or `~` to search from the vault
root. The current folder path stays above the search input, below the
`File palette` title. The title can be hidden with the `Show command title`
setting; the path remains visible. Long paths retain their deepest folders and
show the full path on hover.

**Picker shortcuts**

| Key | Action |
| --- | --- |
| Up / Down | Highlight a suggestion |
| Enter | Open a file or browse into a folder |
| Backspace (empty search) or select `..` | Go to the parent folder |
| `:` | Reveal the highlighted file or folder in Obsidian's file navigator |
| `?` | Show it in the system file explorer |
| `*` | Open it with the system default app |
| Ctrl+Shift+L (Windows/Linux); Cmd+Shift+L (macOS) | Copy a highlighted file's link in the vault's configured format |

System file explorer and default-app actions depend on platform support. The
operator characters `:`, `?`, and `*` cannot appear in Windows filenames. The
picker includes every file type: Markdown extensions are omitted from names,
while other extensions appear as right-aligned hints.

**Open highlighted files**

| Shortcut (Windows/Linux; macOS) | Action |
| --- | --- |
| Ctrl+Shift+Enter; Cmd+Shift+Enter | Open in a new tab |
| Ctrl+Alt+Enter; Cmd+Option+Enter | Open in a new tab group |
| Ctrl+Alt+Shift+Enter; Cmd+Option+Shift+Enter | Open in a new window (desktop only) |

These modifier shortcuts do not change folder selection; folders continue to
open in the picker. Footer hints use `Ctrl`/`Shift`/`Alt` on Windows and Linux,
and `⌘`/`⇧`/`⌥` on macOS.
