// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FilePalettePlugin from '../src/main';
import * as ObsidianMock from './__mocks__/obsidian';
import {
	AbstractInputSuggest,
	Notice,
	Platform,
	Setting,
	SuggestModal,
	TAbstractFile,
	TFile,
	TFolder,
} from './__mocks__/obsidian';
import type { App } from 'obsidian';

function addFolder(parent: TFolder, name: string): TFolder {
	const path = parent.path ? `${parent.path}/${name}` : name;
	const folder = new TFolder(name, path);
	folder.parent = parent;
	parent.children.push(folder);
	return folder;
}

function addFile(parent: TFolder, name: string): TFile {
	const path = parent.path ? `${parent.path}/${name}` : name;
	const file = new TFile(name, path);
	parent.children.push(file);
	return file;
}

describe('file palette picker', () => {
	let root: TFolder;
	let currentFolder: TFolder;
	let nestedFolder: TFolder;
	let rootFile: TFile;
	let app: App;
	let workspace: {
		getActiveFile: () => { parent: TFolder; path: string };
		getLeaf: (newLeaf?: 'tab' | 'split' | 'window' | boolean) => { openFile: ReturnType<typeof vi.fn> };
		getLeavesOfType: () => { view: { revealInFolder: ReturnType<typeof vi.fn> } }[];
	};
	let openedFiles: TFile[];
	let revealedItems: TAbstractFile[];
	let shownPaths: string[];
	let openedDefaultAppPaths: string[];
	let generateMarkdownLink: ReturnType<typeof vi.fn>;
	let metadataByFile: Map<TFile, { frontmatter: Record<string, unknown> }>;
	let plugin: FilePalettePlugin & {
		commands: { id: string; callback: () => void }[];
		settingTabs: {
			getSettingDefinitions: () => { name?: string; control?: { key: string }; render?: (setting: Setting, group: never) => (() => void) | void }[];
			setControlValue: (key: string, value: unknown) => Promise<void>;
		}[];
		data: unknown;
	};

	beforeEach(async () => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		SuggestModal.instances.length = 0;
		AbstractInputSuggest.instances.length = 0;
		Setting.instances.length = 0;
		Notice.messages.length = 0;
		Platform.isMobile = false;
		Platform.isMacOS = false;
		root = new TFolder('', '');
		currentFolder = addFolder(root, 'current');
		rootFile = addFile(root, 'Root note.md');
		nestedFolder = addFolder(currentFolder, 'Nested');
		addFile(nestedFolder, 'Needle note.md');

		openedFiles = [];
		revealedItems = [];
		shownPaths = [];
		openedDefaultAppPaths = [];
		const openFile = vi.fn((file: TFile) => {
			openedFiles.push(file);
			return Promise.resolve();
		});
		const getLeaf = vi.fn((_newLeaf?: 'tab' | 'split' | 'window' | boolean) => ({ openFile }));
		const revealInFolder = vi.fn((file: TAbstractFile) => {
			revealedItems.push(file);
		});
		generateMarkdownLink = vi.fn((file: TFile, _sourcePath: string) => `[[${file.basename}]]`);
		metadataByFile = new Map();
		workspace = {
			getActiveFile: () => ({ parent: currentFolder, path: 'current/source.md' }),
			getLeaf,
			getLeavesOfType: () => [{ view: { revealInFolder } }],
		};
		app = {
			vault: {
				getRoot: () => root,
				getMarkdownFiles: () => [...metadataByFile.keys()],
			},
			showInFolder: (path: string) => {
				shownPaths.push(path);
			},
			openWithDefaultApp: (path: string) => {
				openedDefaultAppPaths.push(path);
			},
			workspace,
			metadataCache: {
				getFileCache: (file: TFile) => metadataByFile.get(file) ?? null,
			},
			fileManager: { generateMarkdownLink },
		} as unknown as App;
		plugin = new FilePalettePlugin(app, {} as never) as typeof plugin;
		await plugin.onload();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function runCommand(id: string): void {
		const command = plugin.commands.find((item) => item.id === id);
		if (!command) throw new Error(`Expected command "${id}" to be registered`);
		command.callback();
	}

	function highlightEntry(file: TAbstractFile, query = ''): SuggestModal<any> {
		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1);
		if (!modal) throw new Error('Expected the picker modal to open');

		const entry = modal.getSuggestions(query).find((suggestion) => suggestion.file === file);
		if (!entry) throw new Error(`Expected "${file.path}" to be suggested`);
		const element = document.createElement('div');
		element.addClass('suggestion-item');
		element.addClass('is-selected');
		modal.renderSuggestion(entry, element);
		modal.resultContainerEl.appendChild(element);
		return modal;
	}

	it('shows the command header, path, and concise footer hints', () => {
		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1);
		expect(modal).toBeDefined();

		const header = modal?.modalEl.querySelector('.fp-header');
		const title = modal?.modalEl.querySelector('.fp-title');
		const path = modal?.modalEl.querySelector('.fp-path');
		expect(title?.textContent).toBe('File palette');
		expect(title?.hasAttribute('hidden')).toBe(false);
		expect(path?.textContent).toBe('/current');
		expect(path?.getAttribute('title')).toBe('/current');
		expect(header?.nextElementSibling).toBe(modal?.inputEl.parentElement);
		expect(modal?.modalEl.classList.contains('file-palette-modal')).toBe(true);
		expect(Array.from(modal?.modalEl.querySelectorAll('.fp-footer-actions .fp-hint') ?? [], (hint) => [
			hint.querySelector('.fp-hint-command')?.textContent,
			hint.querySelector('.fp-hint-purpose')?.textContent,
		])).toEqual([
			['Tab', 'Complete'],
			['~', 'Root'],
			[':', 'Reveal'],
			['?', 'Explorer'],
			['*', 'App'],
			['Ctrl+Shift+L', 'Link'],
		]);
		expect(Array.from(modal?.modalEl.querySelectorAll('.fp-footer-openers .fp-hint') ?? [], (hint) => [
			hint.querySelector('.fp-hint-command')?.textContent,
			hint.querySelector('.fp-hint-purpose')?.textContent,
		])).toEqual([
			['Enter', 'Open'],
			['Ctrl+Shift+↵', 'New tab'],
			['Ctrl+Alt+↵', 'Group'],
			['Ctrl+Alt+Shift+↵', 'Window'],
		]);
	});

	it('uses Apple modifier-key symbols in the macOS footer', () => {
		Platform.isMacOS = true;
		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1);

		expect(Array.from(modal?.modalEl.querySelectorAll('.fp-footer-actions .fp-hint') ?? [], (hint) => [
			hint.querySelector('.fp-hint-command')?.textContent,
			hint.querySelector('.fp-hint-purpose')?.textContent,
		])).toContainEqual(['⌘⇧L', 'Link']);
		expect(Array.from(modal?.modalEl.querySelectorAll('.fp-footer-openers .fp-hint') ?? [], (hint) => [
			hint.querySelector('.fp-hint-command')?.textContent,
			hint.querySelector('.fp-hint-purpose')?.textContent,
		])).toEqual([['Enter', 'Open'], ['⌘⇧↵', 'New tab'], ['⌘⌥↵', 'Group'], ['⌘⌥⇧↵', 'Window']]);
		expect(modal?.modalEl.querySelector('.fp-footer-openers .fp-hint-command[title]')?.getAttribute('title'))
			.toBe('⌘⇧Return');
	});

	it('allows the command title to be hidden from plugin settings without hiding the path', async () => {
		const settingTab = plugin.settingTabs[0];
		const definition = settingTab.getSettingDefinitions().find(({ name }) => name === 'Show command title');
		expect(definition?.control?.key).toBe('showCommandTitle');
		expect(settingTab.getSettingDefinitions().find(({ name }) => name === 'Show matching properties')?.control?.key)
			.toBe('showPropertyMatches');
		await settingTab.setControlValue('showCommandTitle', false);
		expect(plugin.settings.showCommandTitle).toBe(false);
		expect(plugin.data).toEqual({
			showCommandTitle: false,
			searchProperties: ['title'],
			showPropertyMatches: false,
		});

		const reloadedPlugin = new FilePalettePlugin(app, {} as never) as typeof plugin;
		reloadedPlugin.data = plugin.data;
		await reloadedPlugin.onload();
		expect(reloadedPlugin.settings.showCommandTitle).toBe(false);
		reloadedPlugin.commands.find(({ id }) => id === 'open-palette')?.callback();
		const modal = SuggestModal.instances.at(-1);
		expect(modal?.modalEl.querySelector('.fp-title')?.hasAttribute('hidden')).toBe(true);
		expect(modal?.modalEl.querySelector('.fp-path')?.textContent).toBe('/current');
	});

	it('searches configured string-valued properties and ranks files matching both name and property higher', () => {
		const matchingBoth = addFile(currentFolder, 'query-name.md');
		const matchingName = addFile(currentFolder, 'query-name-only.md');
		const matchingProperty = addFile(currentFolder, 'unrelated.md');
		const nonStringProperty = addFile(currentFolder, 'also-unrelated.md');
		metadataByFile.set(matchingBoth, { frontmatter: { title: 'query title' } });
		metadataByFile.set(matchingProperty, { frontmatter: { title: 'query title' } });
		metadataByFile.set(nonStringProperty, { frontmatter: { title: ['query title'] } });
		vi.spyOn(ObsidianMock, 'prepareFuzzySearch').mockReturnValue((value) => {
			if (value === 'query-name.md') return { score: 1, matches: [] };
			if (value === 'query-name-only.md') return { score: 10, matches: [] };
			if (value === 'query title') return { score: 4, matches: [] };
			return null;
		});

		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1);
		const suggestions = modal?.getSuggestions('query');

		expect(suggestions?.map(({ file }) => file)).toEqual([matchingBoth, matchingName, matchingProperty]);
	});

	it('saves a configurable property list and completes string-valued property names', async () => {
		const settingTab = plugin.settingTabs[0];
		const file = addFile(currentFolder, 'property-source.md');
		metadataByFile.set(file, {
			frontmatter: {
				title: 'A title',
				category: 'literaturenote',
				tags: ['one', 'two'],
			},
		});
		const definition = settingTab.getSettingDefinitions().find(({ name }) => name === 'Search properties');
		if (!definition?.render) throw new Error('Expected a custom property setting renderer');
		const setting = new Setting(document.createElement('div'));
		definition.render(setting, {} as never);
		expect(setting?.text?.value).toBe('title');
		await setting?.text?.change('title, cat');
		setting?.text?.inputEl.setSelectionRange(setting.text.value.length, setting.text.value.length);
		const propertySuggest = AbstractInputSuggest.instances.at(-1);
		expect(propertySuggest?.suggestions()).toContain('category');
		expect(propertySuggest?.suggestions()).not.toContain('tags');
		propertySuggest?.select('category');
		expect(setting?.text?.inputEl.value).toBe('title, category, ');
		expect(plugin.settings.searchProperties).toEqual(['title', 'category']);

		const categoryMatch = addFile(currentFolder, 'category-match.md');
		metadataByFile.set(categoryMatch, { frontmatter: { category: 'distinctive phrase' } });
		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1);
		expect(modal?.getSuggestions('distinctive').some(({ file }) => file === categoryMatch)).toBe(true);
	});

	it('shows matching property values beneath filenames with fuzzy-match highlighting', async () => {
		const matchingFile = addFile(currentFolder, 'Unrelated.md');
		metadataByFile.set(matchingFile, { frontmatter: { title: 'A unique title' } });
		await plugin.settingTabs[0].setControlValue('showPropertyMatches', true);
		vi.spyOn(ObsidianMock, 'prepareFuzzySearch').mockReturnValue((value) => {
			if (value === 'A unique title') return { score: 8, matches: [[2, 8]] };
			return null;
		});
		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1);
		const entry = modal?.getSuggestions('unique').find(({ file }) => file === matchingFile);
		if (!modal || !entry) throw new Error('Expected the property-matching file suggestion');
		const element = document.createElement('div');
		modal.renderSuggestion(entry, element);

		expect(element.querySelector('.file-palette-suggestion-property-name')?.textContent).toBe('title:');
		expect(element.querySelector('.file-palette-suggestion-property-value')?.textContent).toBe('A unique title');
		expect(Array.from(element.querySelectorAll('.suggestion-highlight'), (highlight) => highlight.textContent))
			.toEqual(['unique']);
	});

	it('does not show property details when disabled or when a file has no configured string property', async () => {
		const fileWithoutProperty = addFile(currentFolder, 'query-only.md');
		const fileWithProperty = addFile(currentFolder, 'query-property.md');
		metadataByFile.set(fileWithProperty, { frontmatter: { title: 'A query title' } });
		runCommand('open-palette');
		let modal = SuggestModal.instances.at(-1);
		if (!modal) throw new Error('Expected the file picker');
		let entry = modal.getSuggestions('query').find(({ file }) => file === fileWithProperty);
		if (!entry) throw new Error('Expected a file match');
		let element = document.createElement('div');
		modal.renderSuggestion(entry, element);
		expect(element.querySelector('.file-palette-suggestion-properties')).toBeNull();

		await plugin.settingTabs[0].setControlValue('showPropertyMatches', true);
		runCommand('open-palette');
		modal = SuggestModal.instances.at(-1);
		if (!modal) throw new Error('Expected the file picker');
		entry = modal.getSuggestions('query').find(({ file }) => file === fileWithoutProperty);
		if (!entry) throw new Error('Expected a filename match');
		element = document.createElement('div');
		modal.renderSuggestion(entry, element);
		expect(element.querySelector('.file-palette-suggestion-properties')).toBeNull();
	});

	it('matches orderless search terms across filename and properties', async () => {
		await plugin.settingTabs[0].setControlValue('showPropertyMatches', true);
		const settingTab = plugin.settingTabs[0];
		const definition = settingTab.getSettingDefinitions().find(({ name }) => name === 'Search properties');
		const setting = new Setting(document.createElement('div'));
		definition?.render?.(setting, {} as never);
		await setting?.text?.change('title, fake-property');

		const steadyLinks = addFile(currentFolder, 'Steady Links Plugin.md');
		metadataByFile.set(steadyLinks, {
			frontmatter: {
				title: 'steady title',
				'fake-property': 'steady but fake',
			},
		});

		const filePalette = addFile(currentFolder, 'File Palette Plugin.md');
		metadataByFile.set(filePalette, {
			frontmatter: {
				title: 'steady title',
				'fake-property': 'fake but steady',
			},
		});

		const otherPlugin = addFile(currentFolder, 'My Plugin Ideas for Obsidian and Others.md');
		metadataByFile.set(otherPlugin, {
			frontmatter: {
				title: 'A fake title',
			},
		});

		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1);
		if (!modal) throw new Error('Expected modal');

		const forwardSuggestions = modal.getSuggestions('fake steady');
		const forwardFiles = forwardSuggestions.map(({ file }) => file);
		expect(forwardFiles).toContain(steadyLinks);
		expect(forwardFiles).toContain(filePalette);
		expect(forwardFiles).not.toContain(otherPlugin);

		const reverseSuggestions = modal.getSuggestions('steady fake');
		const reverseFiles = reverseSuggestions.map(({ file }) => file);
		expect(reverseFiles).toContain(steadyLinks);
		expect(reverseFiles).toContain(filePalette);
		expect(reverseFiles).not.toContain(otherPlugin);
	});

	it('merges highlight ranges when multiple search terms hit the same property in any order', async () => {
		await plugin.settingTabs[0].setControlValue('showPropertyMatches', true);
		const settingTab = plugin.settingTabs[0];
		const definition = settingTab.getSettingDefinitions().find(({ name }) => name === 'Search properties');
		const setting = new Setting(document.createElement('div'));
		definition?.render?.(setting, {} as never);
		await setting?.text?.change('title, fake-property');

		const steadyLinks = addFile(currentFolder, 'Steady Links Plugin.md');
		metadataByFile.set(steadyLinks, {
			frontmatter: {
				'fake-property': 'steady but fake',
			},
		});

		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1);
		if (!modal) throw new Error('Expected modal');

		const entry = modal.getSuggestions('fake steady').find(({ file }) => file === steadyLinks);
		if (!entry) throw new Error('Expected steadyLinks suggestion');
		const element = document.createElement('div');
		modal.renderSuggestion(entry, element);

		const highlights = Array.from(element.querySelectorAll('.suggestion-highlight'), (el) => el.textContent);
		expect(highlights).toEqual(['steady', 'fake']);
	});

	it('uses the vault root for tilde queries and updates the displayed path', () => {
		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1);
		if (!modal) throw new Error('Expected the picker modal to open');

		modal.inputEl.value = '~';
		modal.inputEl.dispatchEvent(new Event('input', { bubbles: true }));

		expect(modal.modalEl.querySelector('.file-palette-current-path')?.textContent).toBe('/');
		expect(modal.getSuggestions('~').some((entry) => entry.file === rootFile)).toBe(true);
	});

	it('keeps path segments in order and truncates ancestors before the current folder', () => {
		const spacedFolder = addFolder(currentFolder, 'Folder with spaces & [special]');
		currentFolder = addFolder(spacedFolder, 'Deepest');
		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1);
		const path = modal?.modalEl.querySelector<HTMLElement>('.fp-path');
		if (!modal || !path) throw new Error('Expected the picker path header');

		expect(path.textContent).toBe('/current/Folder with spaces & [special]/Deepest');
		expect(path.getAttribute('title')).toBe('/current/Folder with spaces & [special]/Deepest');
		expect(Array.from(path.querySelectorAll('.fp-path-parent'), (segment) => segment.textContent))
			.toEqual(['current', 'Folder with spaces & [special]']);
		expect(path.querySelector('.fp-path-current')?.textContent).toBe('Deepest');

		Object.defineProperty(path, 'clientWidth', { configurable: true, value: 80 });
		Object.defineProperty(path, 'scrollWidth', {
			configurable: true,
			get: () => {
				const visibleSegments = path.querySelectorAll('.fp-path-segment:not(.fp-path-hidden)').length;
				return visibleSegments === 3 ? 200 : visibleSegments === 2 ? 120 : 40;
			},
		});
		modal.inputEl.dispatchEvent(new Event('input', { bubbles: true }));

		expect(path.querySelector('.fp-path-ellipsis')?.textContent).toBe('…');
		expect(Array.from(path.querySelectorAll('.fp-path-segment:not(.fp-path-hidden)'), (segment) => segment.textContent))
			.toEqual(['Deepest']);
		expect(path.querySelectorAll('.fp-path-segment.fp-path-hidden')).toHaveLength(2);
		expect(path.getAttribute('title')).toBe('/current/Folder with spaces & [special]/Deepest');
	});

	it('treats a slash query as the vault root and displays a single root slash', () => {
		root.path = '/';
		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1);
		if (!modal) throw new Error('Expected the picker modal to open');

		modal.inputEl.value = '/';
		modal.inputEl.dispatchEvent(new Event('input', { bubbles: true }));

		expect(modal.modalEl.querySelector('.file-palette-current-path')?.textContent).toBe('/');
		expect(modal.getSuggestions('/').some((entry) => entry.file === rootFile)).toBe(true);
	});

	it('resolves slash-separated folder queries relative to the starting folder', () => {
		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1);
		expect(modal?.getSuggestions('Nested/Needle').map((entry) => entry.file?.name)).toEqual(['Needle note.md']);
	});

	it('passes fuzzy matches through and orders them by Obsidian match score', () => {
		const lowerRanked = addFile(currentFolder, 'lower-ranked');
		const higherRanked = addFile(currentFolder, 'higher-ranked');
		const fuzzySearch = vi.spyOn(ObsidianMock, 'prepareFuzzySearch').mockReturnValue((name) => {
			if (name === lowerRanked.name) return { score: 1 };
			if (name === higherRanked.name) return { score: 10 };
			return null;
		});

		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1);
		const suggestions = modal?.getSuggestions('rank');

		expect(fuzzySearch).toHaveBeenCalledWith('rank');
		expect(suggestions?.map((entry) => entry.file)).toEqual([higherRanked, lowerRanked]);
	});

	it('marks parent and file suggestions for compact row styling', () => {
		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1);
		if (!modal) throw new Error('Expected the picker modal to open');

		for (const entry of modal.getSuggestions('')) {
			const element = document.createElement('div');
			modal.renderSuggestion(entry, element);
			expect(element.classList.contains('file-palette-suggestion')).toBe(true);
		}
	});

	it('keeps suggestion rows vertically compact', () => {
		const stylesheet = readFileSync(resolve(process.cwd(), 'styles.css'), 'utf8');
		const rowStyles = stylesheet.match(/\.file-palette-suggestion\s*\{([^}]+)\}/)?.[1];
		expect(rowStyles).toContain('padding-block: var(--size-4-1)');
	});

	it('styles path truncation and lets compact footer hints wrap instead of scrolling', () => {
		const stylesheet = readFileSync(resolve(process.cwd(), 'styles.css'), 'utf8');
		const titleStyles = stylesheet.match(/\.fp-title\s*\{([^}]+)\}/)?.[1];
		const pathStyles = stylesheet.match(/\.fp-path\s*\{([^}]+)\}/)?.[1];
		const hiddenPathStyles = stylesheet.match(/\.fp-path-hidden\s*\{([^}]+)\}/)?.[1];
		const ellipsisStyles = stylesheet.match(/\.fp-path-ellipsis\s*\{([^}]+)\}/)?.[1];
		const footerStyles = stylesheet.match(
			/\.fp-footer-shortcuts,\s*\.fp-footer-actions,\s*\.fp-footer-openers\s*\{([^}]+)\}/,
		)?.[1];
		const hintStyles = stylesheet.match(/\.fp-hint\s*\{([^}]+)\}/)?.[1];

		expect(titleStyles).toContain('color: var(--text-accent)');
		expect(titleStyles).toContain('font-size: var(--font-ui-small)');
		expect(pathStyles).toContain('font-size: var(--font-ui-small)');
		expect(pathStyles).toContain('overflow: hidden');
		expect(hiddenPathStyles).toContain('display: none');
		expect(ellipsisStyles).toContain('color: var(--text-faint)');
		expect(footerStyles).toContain('flex-wrap: wrap');
		expect(hintStyles).toContain('overflow-wrap: anywhere');
		expect(stylesheet).not.toContain('overflow-x: auto');
	});

	it('removes the path display when the modal closes', () => {
		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1);
		if (!modal) throw new Error('Expected the picker modal to open');
		const path = modal.modalEl.querySelector('.file-palette-current-path');

		modal.close();

		expect(path?.isConnected).toBe(false);
	});


	it('copies the highlighted file link in the vault-configured format with Ctrl+Shift+L', async () => {
		const clipboardWrite = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal('navigator', { clipboard: { writeText: clipboardWrite } });
		generateMarkdownLink.mockReturnValue('[Root note](Root%20note.md)');
		const modal = highlightEntry(rootFile, '~/Root');
		const event = new KeyboardEvent('keydown', {
			key: 'L',
			ctrlKey: true,
			shiftKey: true,
			bubbles: true,
			cancelable: true,
		});

		modal.inputEl.dispatchEvent(event);
		await vi.waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith('[Root note](Root%20note.md)'));

		expect(event.defaultPrevented).toBe(true);
		expect(generateMarkdownLink).toHaveBeenCalledWith(rootFile, 'current/source.md');
		expect(Notice.messages).toEqual(['Link copied to clipboard.']);
		expect(modal.modalEl.querySelector('.fp-path')).not.toBeNull();
	});

	it('does not consume L while the user is typing a search', () => {
		const modal = highlightEntry(rootFile, '~/Root');
		const event = new KeyboardEvent('keydown', { key: 'l', bubbles: true, cancelable: true });

		modal.inputEl.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(false);
		expect(generateMarkdownLink).not.toHaveBeenCalled();
	});

	it('reports clipboard failures when copying a highlighted link', async () => {
		vi.stubGlobal('navigator', {
			clipboard: { writeText: vi.fn().mockRejectedValue(new Error('Permission denied')) },
		});
		const modal = highlightEntry(rootFile, '~/Root');
		modal.inputEl.dispatchEvent(new KeyboardEvent('keydown', {
			key: 'l',
			metaKey: true,
			shiftKey: true,
			bubbles: true,
			cancelable: true,
		}));

		await vi.waitFor(() => expect(Notice.messages).toEqual(['Could not copy link: Permission denied']));
	});

	it('does not copy links for folders', async () => {
		const clipboardWrite = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal('navigator', { clipboard: { writeText: clipboardWrite } });
		const modal = highlightEntry(nestedFolder);
		modal.inputEl.dispatchEvent(new KeyboardEvent('keydown', {
			key: 'l',
			ctrlKey: true,
			shiftKey: true,
			bubbles: true,
			cancelable: true,
		}));

		await vi.waitFor(() => expect(Notice.messages).toEqual(['Select a file to copy its link.']));
		expect(clipboardWrite).not.toHaveBeenCalled();
	});

	it.each([
		{ label: 'Ctrl+Shift+Enter', options: { ctrlKey: true, shiftKey: true }, destination: 'tab' },
		{ label: 'Meta+Shift+Enter', options: { metaKey: true, shiftKey: true }, destination: 'tab' },
		{ label: 'Ctrl+Alt+Enter', options: { ctrlKey: true, altKey: true }, destination: 'split' },
		{ label: 'Meta+Alt+Enter', options: { metaKey: true, altKey: true }, destination: 'split' },
		{ label: 'Ctrl+Alt+Shift+Enter', options: { ctrlKey: true, altKey: true, shiftKey: true }, destination: 'window' },
		{ label: 'Meta+Alt+Shift+Enter', options: { metaKey: true, altKey: true, shiftKey: true }, destination: 'window' },
	] as const)('opens the highlighted file in a $destination with $label', ({ options, destination }) => {
		const modal = highlightEntry(rootFile, '~/Root');
		const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options });

		modal.inputEl.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(true);
		expect(workspace.getLeaf).toHaveBeenCalledWith(destination);
		expect(openedFiles).toEqual([rootFile]);
		expect(modal.modalEl.querySelector('.file-palette-current-path')).toBeNull();
	});

	it('leaves modified Enter on a highlighted folder to the modal folder-navigation behavior', () => {
		const modal = highlightEntry(nestedFolder);
		const event = new KeyboardEvent('keydown', {
			key: 'Enter',
			ctrlKey: true,
			shiftKey: true,
			bubbles: true,
			cancelable: true,
		});

		modal.inputEl.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(false);
		expect(workspace.getLeaf).not.toHaveBeenCalled();
	});

	it('completes the highlighted folder suggestion with a trailing slash on Tab', () => {
		const modal = highlightEntry(nestedFolder, 'Nes');
		modal.inputEl.value = 'Nes';
		const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
		modal.inputEl.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(true);
		expect(modal.inputEl.value).toBe('Nested/');
		expect(modal.modalEl.querySelector('.fp-path')?.textContent).toBe('/current/Nested');
	});

	it('completes the highlighted file suggestion basename on Tab and preserves path prefixes', () => {
		const modal = highlightEntry(rootFile, '~/Root');
		modal.inputEl.value = '~/Root';
		const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
		modal.inputEl.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(true);
		expect(modal.inputEl.value).toBe('~/Root note');
	});

	it('completes the parent entry on Tab', () => {
		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1);
		if (!modal) throw new Error('Expected modal');
		const entry = modal.getSuggestions('').find((suggestion) => suggestion.isParent);
		if (!entry) throw new Error('Expected parent entry');
		const element = document.createElement('div');
		element.addClass('suggestion-item');
		element.addClass('is-selected');
		modal.renderSuggestion(entry, element);
		modal.resultContainerEl.appendChild(element);

		modal.inputEl.value = '';
		const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
		modal.inputEl.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(true);
		expect(modal.inputEl.value).toBe('../');
	});

	it('hides the new-window shortcut and reports it unavailable on mobile', () => {
		Platform.isMobile = true;
		const modal = highlightEntry(rootFile, '~/Root');

		expect(modal.modalEl.querySelector('.fp-footer-openers')?.textContent).not.toContain('Window');
		modal.inputEl.dispatchEvent(
			new KeyboardEvent('keydown', {
				key: 'Enter',
				ctrlKey: true,
				altKey: true,
				shiftKey: true,
				bubbles: true,
				cancelable: true,
			}),
		);

		expect(Notice.messages).toEqual(['Opening a file in a new window is not available on mobile.']);
		expect(workspace.getLeaf).not.toHaveBeenCalled();
	});


	it('reveals the highlighted file in the Obsidian file navigator with the colon operator', () => {
		const modal = highlightEntry(rootFile, '~/Root');
		const event = new KeyboardEvent('keydown', { key: ':', bubbles: true, cancelable: true });

		modal.inputEl.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(true);
		expect(revealedItems).toEqual([rootFile]);
		expect(modal.modalEl.querySelector('.file-palette-current-path')).toBeNull();
	});

	it('reveals a highlighted folder in the Obsidian file navigator', () => {
		const modal = highlightEntry(nestedFolder);

		modal.inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: ':', bubbles: true, cancelable: true }));

		expect(revealedItems).toEqual([nestedFolder]);
	});

	it('shows the highlighted item in System File Explorer with the question-mark operator', () => {
		const modal = highlightEntry(rootFile, '~/Root');

		modal.inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true }));

		expect(shownPaths).toEqual([rootFile.path]);
		expect(modal.modalEl.querySelector('.file-palette-current-path')).toBeNull();
	});

	it('shows a highlighted folder in System File Explorer', () => {
		highlightEntry(nestedFolder).inputEl.dispatchEvent(
			new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true }),
		);

		expect(shownPaths).toEqual([nestedFolder.path]);
	});

	it('opens the highlighted file with the system default app using the asterisk operator', () => {
		const modal = highlightEntry(rootFile, '~/Root');

		modal.inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: '*', bubbles: true, cancelable: true }));

		expect(openedDefaultAppPaths).toEqual([rootFile.path]);
		expect(modal.modalEl.querySelector('.file-palette-current-path')).toBeNull();
	});

	it('opens a highlighted folder with the system default app', () => {
		const modal = highlightEntry(nestedFolder);

		modal.inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: '*', bubbles: true, cancelable: true }));

		expect(openedDefaultAppPaths).toEqual([nestedFolder.path]);
	});

	it('reports when opening with the system default app is unavailable', () => {
		const modal = highlightEntry(rootFile, '~/Root');
		(app as App & { openWithDefaultApp?: (path: string) => void | Promise<void> }).openWithDefaultApp = undefined;

		modal.inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: '*', bubbles: true, cancelable: true }));

		expect(Notice.messages).toEqual(['Opening items with the system default app is not available on this device.']);
		expect(modal.modalEl.querySelector('.file-palette-current-path')).not.toBeNull();
	});

	it('reports when opening with the system default app fails', async () => {
		const modal = highlightEntry(rootFile, '~/Root');
		(app as App & { openWithDefaultApp?: (path: string) => void | Promise<void> }).openWithDefaultApp = vi.fn(
			() => Promise.reject(new Error('Permission denied')),
		);

		modal.inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: '*', bubbles: true, cancelable: true }));
		await vi.waitFor(() => expect(Notice.messages).toEqual([
			'Could not open item with the system default app: Permission denied',
		]));

		expect(modal.modalEl.querySelector('.file-palette-current-path')).toBeNull();
	});

	it('reveals the parent folder when the parent suggestion is highlighted with the colon operator', () => {
		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1);
		if (!modal) throw new Error('Expected the picker modal to open');
		const parentEntry = modal.getSuggestions('').find((suggestion) => suggestion.isParent);
		if (!parentEntry) throw new Error('Expected the parent-folder suggestion');
		modal.resultContainerEl.empty();
		const element = document.createElement('div');
		element.addClass('suggestion-item');
		element.addClass('is-selected');
		modal.renderSuggestion(parentEntry, element);
		modal.resultContainerEl.appendChild(element);

		modal.inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: ':', bubbles: true, cancelable: true }));

		expect(revealedItems).toEqual([root]);
	});

	it('shows the parent folder in System File Explorer when highlighted with the question-mark operator', () => {
		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1);
		if (!modal) throw new Error('Expected the picker modal to open');
		const parentEntry = modal.getSuggestions('').find((suggestion) => suggestion.isParent);
		if (!parentEntry) throw new Error('Expected the parent-folder suggestion');
		modal.resultContainerEl.empty();
		const element = document.createElement('div');
		element.addClass('suggestion-item');
		element.addClass('is-selected');
		modal.renderSuggestion(parentEntry, element);
		modal.resultContainerEl.appendChild(element);

		modal.inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true }));

		expect(shownPaths).toEqual([root.path]);
	});
});
