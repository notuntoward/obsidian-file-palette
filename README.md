# File Palette

A fast file and folder picker for Obsidian.

This plugin provides a lightweight palette-style UI for jumping to files
and browsing folders.

## Features

- Search files and folders by name, and files by configured string-valued properties
- Orderless multi-word search matching across filenames and properties
- Fast Tab completion for folders, parent paths, and filenames
- Open entries directly from a palette-like modal
- Navigate folders and slash-separated paths
- Keep the interaction lightweight and keyboard-friendly

## Commands

- `Open file palette`: opens the picker in the current note's folder
  (or the vault root when no note is active).

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
| `:` | Reveal the highlighted file or folder (including `..`) in Obsidian's file navigation sidebar |
| `?` | Show the highlighted file or folder (including `..`) in your system file explorer (Finder or Windows Explorer) |
| `*` | Open the highlighted file or folder with your system default app |
| Ctrl+Shift+L (Windows/Linux); Cmd+Shift+L (macOS) | Copy a highlighted file's link in the vault's configured format |

**Open highlighted files**

| Shortcut (Windows/Linux; macOS) | Action |
| --- | --- |
| Enter | Open in current tab|
| Ctrl+Shift+Enter; Cmd+Shift+Enter | Open in a new tab |
| Ctrl+Alt+Enter; Cmd+Option+Enter | Open in a new tab group |
| Ctrl+Alt+Shift+Enter; Cmd+Option+Shift+Enter | Open in a new window (desktop only) |

