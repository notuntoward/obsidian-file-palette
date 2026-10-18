# File Palette

A fast file and folder picker for jumping to files and browsing folders.

## Command

- `Open file palette`: opens the picker in the current note's folder
  (or the vault root when no note is active).

## Keys

| Key | Action |
| --- | --- |
| Up / Down | Highlight a suggestion |
| Enter | Open in current tab or browse into a folder|
| Ctrl+Shift+Enter; Cmd+Shift+Enter | Open in a new tab |
| Ctrl+Alt+Enter; Cmd+Option+Enter | Open in a new tab group |
| Ctrl+Alt+Shift+Enter; Cmd+Option+Shift+Enter | Open in a new window (desktop only) |
| Tab | Complete the highlighted file name, folder (`/`), or parent (`../`) |
| Backspace (empty search) or select `..` | Go to the parent folder |
| `:` | Reveal the highlighted file or folder (including `..`) in Obsidian's file navigation sidebar |
| `?` | Show the highlighted file or folder (including `..`) in your system file explorer (Finder or Windows Explorer) |
| `*` | Open the highlighted file or folder with your system default app |
| Ctrl+Shift+L (Windows/Linux); Cmd+Shift+L (macOS) | Copy a highlighted file's link in the vault's configured format |


## Settings

- **Show command title**: Toggle showing the "File palette" heading above the current folder path in the picker modal (defaults to enabled). When disabled, the folder path remains visible.
- **Search properties**: Comma-separated frontmatter properties to search alongside file names (defaults to `title`). Offers autocomplete suggestions for string-valued properties found in your vault. Only string-valued properties are searched.
- **Show matching properties**: Toggle displaying configured frontmatter property values underneath each matching file name in the suggestion list (defaults to disabled). When enabled, matched text across all search terms is highlighted.
