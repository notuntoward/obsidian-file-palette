# File Palette

A fast file and folder picker for Obsidian.

This plugin provides a lightweight palette-style UI for jumping to files,
and browsing folders through two searchable commands.

## Features

- Search files and folders by name, and files by configured string-valued properties
- Orderless multi-word search matching across filenames and properties
- Fast Tab completion for folders, parent paths, and filenames
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

## Searching and Navigation

The picker fuzzy-matches items in the active folder:

- **Orderless multi-token search**: Enter multiple space-separated words (such as `fake steady`). All words must match, but they can appear in any order and across different fields—one word can match the filename while another matches a frontmatter property. Within each word, fuzzy matching still applies.
- **Cross-field ranking**: Files matching search terms in both the filename and frontmatter properties are ranked above matches from only one source.
- **Folder navigation**: Enter slash-separated paths to browse into subfolders (e.g. `folder/subfolder/query`). Prefix a query with `/` or `~` to search from the vault root.
- **Tab completion**: Press `Tab` on any highlighted suggestion to complete it into the search input. Completing a folder automatically appends a trailing `/`, instantly transitioning the picker into that folder and listing its contents. Completing `..` inserts `../` to navigate upward, and completing a file fills its basename while preserving any folder prefix.
- **Parent navigation**: Type `..` or press Backspace on an empty search to navigate to the parent folder.
- **Persistent path**: The current folder path stays above the search input. Long paths retain their deepest folders and show the full path on hover.

## Settings

- **Show command title**: Toggle showing the "File palette" heading above the current folder path in the picker modal (defaults to enabled). When disabled, the folder path remains visible.
- **Search properties**: Comma-separated frontmatter properties to search alongside file names (defaults to `title`). Offers autocomplete suggestions for string-valued properties found in your vault. Only string-valued properties are searched.
- **Show matching properties**: Toggle displaying configured frontmatter property values underneath each matching file name in the suggestion list (defaults to disabled). When enabled, matched text across all search terms is highlighted.

## Shortcuts

**Picker shortcuts**

| Key | Action |
| --- | --- |
| Up / Down | Highlight a suggestion |
| Enter | Open a file or browse into a folder |
| Tab | Complete the highlighted file name, folder (`/`), or parent (`../`) |
| Backspace (empty search) or select `..` | Go to the parent folder |
| `:` | Reveal the highlighted file or folder in Obsidian's file navigator |
| `?` | Show it in the system file explorer |
| `*` | Open it with the system default app |
| Ctrl+Shift+L (Windows/Linux); Cmd+Shift+L (macOS) | Copy a highlighted file's link in the vault's configured format |

**Open highlighted files**

| Shortcut (Windows/Linux; macOS) | Action |
| --- | --- |
| Ctrl+Shift+Enter; Cmd+Shift+Enter | Open in a new tab |
| Ctrl+Alt+Enter; Cmd+Option+Enter | Open in a new tab group |
| Ctrl+Alt+Shift+Enter; Cmd+Option+Shift+Enter | Open in a new window (desktop only) |

These modifier shortcuts do not change folder selection; folders continue to
open in the picker. Footer hints use concise action labels (`Complete`, `Root`,
`Reveal`, `Explorer`, `App`, `Link`, `Open`, `New tab`, `Group`, `Window`) with
`Ctrl`/`Shift`/`Alt` on Windows and Linux, and `⌘`/`⇧`/`⌥` on macOS.
