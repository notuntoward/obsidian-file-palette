# File Palette

A fast file and folder picker for jumping to files and browsing folders.

> [!IMPORTANT]
> **Notice (External File Access)**: On desktop, this plugin can access and browse files and folders outside your Obsidian vault when the **Browse outside vault** setting is enabled (the default). This is required to support Obsidian 1.14.2+'s native external note editing capabilities—allowing you to navigate, search, open, and link notes located anywhere on your computer (such as in your home directory or external repositories) from the palette.
>
> If you prefer to restrict File Palette strictly to your vault, you can toggle off **Browse outside vault** in settings at any time. In addition, creating files outside the vault via Shift+Enter is disabled by default and requires explicitly enabling **Allow creating files outside vault**.

> [!NOTE]
> **Release Note / Breaking Change**: In v0.2.0, `~` navigates to the user's OS home directory (desktop only) instead of the vault root. To jump directly to the vault root, use `^`. Inside the vault, a leading `/` also navigates to the vault root; outside the vault, `/` navigates to the OS root directory.

## Command

- `Open file palette`: opens the picker in the current note's folder
  (or the vault root when no note is active).

## Keys

| Key | Action |
| --- | --- |
| Up / Down | Highlight a suggestion |
| Enter | Open in current tab or browse into a folder |
| Shift+Enter | Create a new file in the current folder using the search query |
| Ctrl+Shift+Enter; Cmd+Shift+Enter | Open in a new tab |
| Ctrl+Alt+Enter; Cmd+Option+Enter | Open in a new tab group |
| Ctrl+Alt+Shift+Enter; Cmd+Option+Shift+Enter | Open in a new window (desktop only) |
| Tab | Complete the highlighted file name, folder (`/`), or parent (`../`) |
| Backspace (empty search) or select `..` | Go to the parent folder |
| `:` | Reveal the highlighted file or folder (including `..`) in Obsidian's file navigation sidebar |
| `?` | Show the highlighted file or folder (including `..`) in your system file explorer (Finder or Windows Explorer) |
| `*` | Open the highlighted file or folder with your system default app |
| Ctrl+Shift+L (Windows/Linux); Cmd+Shift+L (macOS) | Copy a link to the highlighted file or folder |
| `^` | Return immediately to the vault root |
| `~` | Go to the user's OS home directory (desktop only) |
| `/` | Go to the vault root (inside vault) or OS filesystem root (outside vault) |


## External Files & Folders

Obsidian 1.14.2+ on desktop allows opening notes stored outside the vault. When editing an external note, File Palette automatically tracks reality:

- **Location tracks reality**: The palette opens in the active file's real OS folder and shows the OS path (e.g. `C:/Users/scott/repos/docs`).
- **Indicator marks the exception**: Inside the vault, paths stay vault-relative (`/Finance/`) with a `vault` icon. Outside the vault, a `home` icon appears when browsing at or under your home directory, and a `hard-drive` indicator appears elsewhere. Disabled footer shortcuts are dimmed.
- **Quick return**: Typing `^` at any point returns straight to the vault root. Typing `~` jumps to your OS home directory.
- **Navigation**: Selecting `..` or pressing Backspace in an empty search navigates up the folder hierarchy up to the drive root.

### Outside-the-Vault Capabilities

| Key | Inside Vault | Outside Vault |
| --- | --- | --- |
| Enter on file | Opens file in active leaf | Opens file using Obsidian's external file mechanism (falls back to default app) |
| Shift+Enter (create) | Creates note in vault | Disabled by default (shows notice; toggleable in settings) |
| Ctrl+Shift+L (link) | Copies link in vault-configured format (files only) | Copies absolute file:/// Markdown link matching Obsidian Ctrl+drag (files and folders) |
| `:` (sidebar) | Reveals item in file navigation sidebar | Disabled (the sidebar only displays vault files) |
| `?` (explorer) | Shows in system file explorer | Shows in system file explorer |
| `*` (app) | Opens in system default app | Opens in system default app |
| Tab, Backspace, `..` | Navigate and complete | Navigate and complete |
| `^` | Jumps to vault root | Jumps to vault root |
| `~` | Jumps to OS home directory | Jumps to OS home directory |
| `/` | Jumps to vault root | Jumps to OS filesystem root |


## Settings

- **Show command title**: Toggle showing the "File palette" heading above the current folder path in the picker modal (defaults to enabled). When disabled, the folder path remains visible.
- **Search properties**: Comma-separated frontmatter properties to search alongside file names (defaults to `title`). Offers autocomplete suggestions for properties found in your vault, indicating unsupported properties. Only string and string list values are searched.
- **Show matching properties**: Toggle displaying configured frontmatter property values underneath each matching file name in the suggestion list (defaults to disabled). When enabled, matched text across all search terms is highlighted.
- **Browse outside vault**: Allow the palette to open in and navigate to folders outside the vault. When off, the palette stays inside the vault as before (defaults to enabled).
- **Allow creating files outside vault**: Let Shift+Enter create files while browsing outside the vault on desktop (defaults to disabled).
