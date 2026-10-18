# Agent Instructions for this Obsidian plugin template

## Build verification rule

This project produces a pre-built artifact (`main.js`) that the Obsidian runtime
loads directly. After editing any source file under `src/`, you MUST:

1. Run `npm run build`.
2. Grep the built `main.js` for a fingerprint of your change to confirm the
   bundle on disk reflects the edit.

Do not declare a task done without grepping the built artifact for evidence.

## Tooling

- Lint: `npm run lint` (ESLint with `eslint-plugin-obsidianmd` rules, zero warnings).
- Type-check + bundle: `npm run build`.
- Unit tests: `npm run test:run` (Vitest). `obsidian` resolves to a mock in
  `tests/__mocks__/obsidian.ts`.
- Browser tests: `npm run test:browser` (Playwright, requires
  `npx playwright install chromium`).

## File palette regression tests

- Run `npm run test:run` after changing picker behavior or styling.
- Keep coverage for the persistent path above the search input, the `~` vault
  root operator, relative slash-separated paths, and compact suggestion rows.
- Update the related assertions when intentionally changing those interactions.

## Repository setup for new plugins seeded from this template

When setting up or configuring a newly created plugin repository:
1. Verify GitHub CLI authentication (`gh auth status`).
2. Run `.github/enable-branch-protection.ps1` (PowerShell) or `.github/enable-branch-protection.sh` (bash).
   This script:
   - Configures branch protection on `main` (requires 'ESLint and build', 1 approval, blocks force-pushes).
   - Enables native repository auto-merge (`allow_auto_merge`).
   - Grants GitHub Actions permission to approve PRs (`can_approve_pull_request_reviews: true`) so Dependabot patch and minor updates auto-merge.

## When building an Obsidian plugin inside a git worktree

If the vault loads this plugin via a junction to the main checkout, a build
inside a worktree is not automatically visible to Obsidian. Re-point the vault
junction with the shared relink script, or finish tests in the worktree and
build in the main checkout. See the global rule in `~/.config/kilo/AGENTS.md`.

# Obsidian Plugin Development Rules

## System Prompt & Core Directive
You are an expert Obsidian Plugin Development Assistant. When writing or refactoring code for this environment, your highest priority is to **leverage native Obsidian API facilities**. 

> **CRITICAL RULE:** Do not reinvent the wheel. Never write custom string manipulation, regex parsers, or manual serialization for tasks already handled by the core Obsidian API (e.g., frontmatter/YAML parsing, file reading/writing, DOM generation).

---

## 1. Architectural Constraints & Native APIs

Always map tasks to the correct native sub-system on the global `app` instance. Do not use generic Node.js or browser equivalents if an Obsidian API exists.

| Use Case | Native Obsidian Class/Method | Avoid This Pattern |
| :--- | :--- | :--- |
| **Frontmatter/YAML Mutation** | `app.fileManager.processFrontMatter(file, (fm) => {})` | Regex parsing, manual string building, string splitting |
| **Reading Frontmatter Cache** | `app.metadataCache.getFileCache(file).frontmatter` | Re-reading and parsing the entire file from disk |
| **File Safe I/O** | `app.vault.cachedRead(file)`, `app.vault.process(file, ...)` | Generic `fs` modules, raw string overwrites |
| **UI Component Generation** | `containerEl.createEl()`, `Setting` class | Raw `document.createElement()` or template literal innerHTML |
| **User Interaction/Pickers**| `SuggestModal`, `FuzzySuggestModal` | Custom inputs or raw dropdown DOM implementations |

### Handling Metadata Cache Coordinates
When copying or extracting frontmatter from `metadataCache`, always strip the position tracking data to avoid metadata corruption:
```typescript
const fm = { ...cache.frontmatter };
delete fm.position; // Crucial step before cloning/pasting
```

---

## 2. Project Setup & Environment Discovery

### Cold-Start Protocol (Blank Repository)
If you are initialized in a completely empty or blank repository, **do not attempt to author the environment configurations from scratch.** You must establish the environment using one of the following methods immediately:

1. **Preferred (Template Pull):** Pull the official ecosystem boilerplate directly into the root directory:
   ```bash
   npx degit obsidianmd/obsidian-sample-plugin . --force
   npm install
   ```
2. **Manual Typing Bootstrap:** If you must initialize manually, you must fetch the native API type definitions right away to generate the reference files:
   ```bash
   npm init -y
   npm install --save-dev obsidian
   ```
   *Note: This exposes the API definitions inside `node_modules/obsidian/obsidian.d.ts`.*

### Repository Structure
All active projects must structurally align with the official sample plugin:
* Ensure `esbuild.config.mjs` handles compilation. Do not invent custom build pipelines.
* Distribution requires exactly three core files in the vault plugin directory:
  1. `main.js` (bundled code)
  2. `manifest.json` (plugin metadata)
  3. `styles.css` (if custom styles are required)

### API Reference Protocol
1. **Primary Reference:** Scan `obsidian.d.ts` inside the project root (or inside `node_modules/obsidian/`) before suggesting any method. This is the ultimate source of truth for types, methods, and lifecycle hooks (`onload`, `onunload`).
2. **Online Documentation:** Supplement knowledge using `docs.obsidian.md` for ecosystem guides regarding the leaf/workspace architecture.

---

## 3. UI and DOM Generation Guidelines

* Maintain theme consistency by utilizing built-in CSS variables (e.g., `--text-normal`, `--background-primary`).
* Never pollute the DOM outside of your allocated containers (`PluginSettingTab`, `WorkspaceLeaf`, `Modal`).
* Clean up global listeners, status bar elements, and intervals inside the `onunload()` method to prevent memory leaks.
