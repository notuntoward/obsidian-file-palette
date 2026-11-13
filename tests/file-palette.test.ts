// @vitest-environment jsdom

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ScriptTarget, transpileModule } from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FilePalettePlugin, {
	alignFuzzyRanges,
	classifyLiteral,
	compareWordMatches,
	generateExternalMarkdownLink,
	getParentPath,
	getSystemRootLocation,
	makeLocation,
	MatchQuality,
	norm,
	resolveHome,
	splitLocationPath,
	tokenize,
	vaultBase,
	VaultPathSuggestModal,
} from '../src/main';
import * as ObsidianMock from './__mocks__/obsidian';
import {
	AbstractInputSuggest,
	FileSystemAdapter,
	Modal,
	Notice,
	Platform,
	Setting,
	SuggestModal,
	TAbstractFile,
	TExternalFile,
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
		on?: ReturnType<typeof vi.fn>;
		trigger?: (event: string, ...args: unknown[]) => void;
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
		VaultPathSuggestModal.closeActiveModal();
		SuggestModal.instances.length = 0;
		Modal.instances.length = 0;
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
		const eventListeners = new Map<string, ((...args: unknown[]) => unknown)[]>();
		workspace = {
			getActiveFile: () => ({ parent: currentFolder, path: 'current/source.md' }),
			getLeaf,
			getLeavesOfType: () => [{ view: { revealInFolder } }],
			on: vi.fn((event: string, callback: (...args: unknown[]) => unknown) => {
				const listeners = eventListeners.get(event) ?? [];
				listeners.push(callback);
				eventListeners.set(event, listeners);
				return { id: event };
			}),
			trigger: (event: string, ...args: unknown[]) => {
				for (const listener of eventListeners.get(event) ?? []) {
					listener(...args);
				}
			},
		};
		function getAbstractFileByPath(targetPath: string): TAbstractFile | null {
			const normalized = targetPath
				.replace(/\\/g, '/')
				.replace(/\/+/g, '/')
				.replace(/^\/+/, '')
				.replace(/\/+$/, '');
			if (!normalized) return root;
			const segments = normalized.split('/').filter(Boolean);
			let current: TAbstractFile = root;
			for (const segment of segments) {
				if (!(current instanceof TFolder)) return null;
				const child: TAbstractFile | undefined = current.children.find((c) => c.name === segment);
				if (!child) return null;
				current = child;
			}
			return current;
		}

		const vaultCreate = vi.fn(async (path: string, _data: string) => {
			const normalized = path
				.replace(/\\/g, '/')
				.replace(/\/+/g, '/')
				.replace(/^\/+/, '')
				.replace(/\/+$/, '');
			const slash = normalized.lastIndexOf('/');
			const parentPath = slash >= 0 ? normalized.slice(0, slash) : '';
			const name = slash >= 0 ? normalized.slice(slash + 1) : normalized;
			const parent = parentPath ? getAbstractFileByPath(parentPath) : root;
			if (!(parent instanceof TFolder)) {
				throw new Error(`Parent folder "${parentPath}" not found`);
			}
			return addFile(parent, name);
		});

		app = {
			vault: {
				getRoot: () => root,
				getMarkdownFiles: () => [...metadataByFile.keys()],
				getAbstractFileByPath,
				create: vaultCreate,
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
		VaultPathSuggestModal.closeActiveModal();
		delete (document as unknown as { activeElement?: unknown }).activeElement;
		vi.unstubAllGlobals();
	});

	
	function findSettingDefinition(name: string): any {
		const settingTab = plugin.settingTabs[0];
		for (const def of settingTab.getSettingDefinitions()) {
			if ('name' in def && (def as any).name === name) return def;
			if ('items' in def && Array.isArray((def as any).items)) {
				const match = (def as any).items.find((item: any) => item.name === name);
				if (match) return match;
			}
		}
		return undefined;
	}

	function propertyPickerInput(setting: Setting): HTMLInputElement {
		const input = setting.controlEl.querySelector<HTMLInputElement>('.commons-property-picker-input');
		if (!input) throw new Error('Expected the property picker input');
		return input;
	}

	async function addSearchProperty(setting: Setting, property: string): Promise<void> {
		const input = propertyPickerInput(setting);
		input.value = property;
		const suggester = AbstractInputSuggest.instances.at(-1);
		const option = suggester?.suggestions().find((item: any) => item.value === property);
		if (!suggester || !option) throw new Error(`Expected a picker option for "${property}"`);
		const selection = suggester.selectSuggestion(option, new KeyboardEvent('keydown'));
		if (option.kind === 'create') {
			const modal = Modal.instances.at(-1);
			const addButton = modal?.contentEl.querySelector('button.mod-cta') as HTMLButtonElement | null;
			if (!addButton) throw new Error(`Expected confirmation for new property "${property}"`);
			addButton.click();
		}
		await selection;
	}

	async function setSearchProperties(setting: Setting, properties: string[]): Promise<void> {
		const selected = setting.controlEl.querySelectorAll<HTMLButtonElement>('.commons-property-picker-remove');
		for (const button of Array.from(selected)) button.click();
		for (const property of properties) await addSearchProperty(setting, property);
	}
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
			hint.querySelector('.fp-hint-key')?.textContent,
			hint.querySelector('.fp-hint-action')?.textContent,
		])).toEqual([
			['Tab', 'Complete'],
			['~', 'Home'],
			['^', 'Vault'],
			[':', 'Reveal'],
			['?', 'Explorer'],
			['*', 'App'],
			['Ctrl+Shift+L', 'Link'],
			['F2', 'Rename'],
		]);
		expect(Array.from(modal?.modalEl.querySelectorAll('.fp-footer-openers .fp-hint') ?? [], (hint) => [			hint.querySelector('.fp-hint-key')?.textContent,
			hint.querySelector('.fp-hint-action')?.textContent,
		])).toEqual([
			['↵', 'Open'],
			['Shift+↵', 'Create'],
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
			hint.querySelector('.fp-hint-key')?.textContent,
			hint.querySelector('.fp-hint-action')?.textContent,
		])).toContainEqual(['⌘⇧L', 'Link']);
		expect(Array.from(modal?.modalEl.querySelectorAll('.fp-footer-openers .fp-hint') ?? [], (hint) => [
			hint.querySelector('.fp-hint-key')?.textContent,
			hint.querySelector('.fp-hint-action')?.textContent,
		])).toEqual([['↵', 'Open'], ['⇧↵', 'Create'], ['⌘⇧↵', 'New tab'], ['⌘⌥↵', 'Group'], ['⌘⌥⇧↵', 'Window']]);
		expect(modal?.modalEl.querySelector('.fp-footer-openers .fp-hint-key[title]')?.getAttribute('title'))
			.toBe('Return');
		expect(modal?.modalEl.querySelectorAll('.fp-footer-actions .fp-hint-line')).toHaveLength(1);
		expect(modal?.modalEl.querySelectorAll('.fp-footer-openers .fp-hint-line')).toHaveLength(1);
	});

	it('keeps a large suggestion list unchanged when scrolled to the bottom', async () => {
		for (let index = 0; index < 1100; index++) {
			addFile(currentFolder, `Bulk ${String(index).padStart(4, '0')}.md`);
		}
		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1);
		if (!modal) throw new Error('Expected modal');

		const suggestions = modal.getSuggestions('');
		const render = (entry: unknown) => {
			const element = document.createElement('div');
			element.addClass('suggestion-item');
			modal.renderSuggestion(entry, element);
			modal.resultContainerEl.appendChild(element);
		};
		for (const entry of suggestions) render(entry);
		const addSuggestion = vi.fn(render);
		(modal as unknown as { chooser: unknown }).chooser = {
			selectedItem: 0,
			values: suggestions,
			setSelectedItem: vi.fn(),
			addSuggestion,
		};

		const scroller = modal.resultContainerEl;
		Object.defineProperty(scroller, 'clientHeight', { value: 200, configurable: true });
		Object.defineProperty(scroller, 'scrollHeight', { value: 1000, configurable: true });
		scroller.scrollTop = 800;
		const initialCount = scroller.querySelectorAll('.suggestion-item').length;
		scroller.dispatchEvent(new Event('scroll'));
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(scroller.querySelectorAll('.suggestion-item')).toHaveLength(initialCount);
		expect(addSuggestion).not.toHaveBeenCalled();
		expect(initialCount).toBe(1102);
	});

	it('moves PageDown by the visible row count instead of the selected row height', () => {
		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1);
		if (!modal) throw new Error('Expected modal');
		const { chooser } = installPagingList(modal, 30, 100, 800);
		modal.inputEl.focus();

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true }));
		expect(chooser.selectedItem).toBe(8);

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true }));
		expect(chooser.selectedItem).toBe(16);

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true, cancelable: true }));
		expect(chooser.selectedItem).toBe(8);

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
		expect(chooser.selectedItem).toBe(29);

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
		expect(chooser.selectedItem).toBe(0);
	});

	it('pages using cumulative variable-height row positions', () => {
		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1);
		if (!modal) throw new Error('Expected modal');
		const heights = Array.from({ length: 40 }, (_, index) => index % 3 === 0 ? 45 : 25);
		const { chooser } = installPagingList(modal, 40, 25, 120, heights);
		chooser.setSelectedItem(0);
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true }));
		expect(chooser.selectedItem).toBe(3);
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true }));
		expect(chooser.selectedItem).toBe(6);
	});

	it('selects the true last suggestion immediately on End in a large folder', () => {
		for (let index = 0; index < 1100; index++) {
			addFile(currentFolder, `Bulk ${String(index).padStart(4, '0')}.md`);
		}
		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1);
		if (!modal) throw new Error('Expected modal');
		const suggestions = modal.getSuggestions('');
		const { chooser, elements } = installPagingList(modal, suggestions.length, 20, 160);
		suggestions.forEach((entry, index) => modal.renderSuggestion(entry, elements[index]));
		modal.inputEl.focus();

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
		expect(chooser.selectedItem).toBe(1101);
		expect(elements[chooser.selectedItem]?.textContent).toBe('Nested/');

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
		expect(chooser.selectedItem).toBe(0);
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true }));
		expect(chooser.selectedItem).toBe(8);
	});

	it('handles large-list paging in the modal owner window', () => {
		for (let index = 0; index < 1001; index++) {
			addFile(currentFolder, `Bulk ${String(index).padStart(4, '0')}.md`);
		}
		const popoutDocument = document.implementation.createHTMLDocument('popout');
		const popoutWindow = new EventTarget();
		Object.defineProperty(popoutDocument, 'defaultView', { value: popoutWindow, configurable: true });
		vi.stubGlobal('activeDocument', popoutDocument);
		vi.stubGlobal('activeWindow', popoutWindow);
		const instance = new VaultPathSuggestModal(app, currentFolder as never);
		popoutDocument.body.appendChild(instance.containerEl);
		instance.open();
		const modal = SuggestModal.instances.at(-1);
		if (!modal) throw new Error('Expected modal');
		expect(modal.scope.tabFocusContainerEl).toBe(instance.containerEl);
		expect(modal.scope.tabFocusContainerEl?.ownerDocument).toBe(popoutDocument);
		const suggestions = modal.getSuggestions('');
		const { chooser } = installPagingList(modal, suggestions.length, 20, 160);

		popoutWindow.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
		expect(chooser.selectedItem).toBe(1002);
		expect(suggestions[chooser.selectedItem]?.file).toBe(nestedFolder);
		popoutWindow.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
		expect(chooser.selectedItem).toBe(0);
		popoutWindow.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true }));
		expect(chooser.selectedItem).toBe(8);
	});

	it('keeps paging free of bare window globals and incremental-loading hooks', () => {
		const source = readFileSync(resolve('src/main.ts'), 'utf8');
		const code = transpileModule(source, { compilerOptions: { removeComments: true, target: ScriptTarget.ESNext } }).outputText;
		expect(/\b(?:pendingSuggestions|takeSuggestionBatch|appendPendingSuggestions|appendAllPendingSuggestions|revealPendingSuggestionsNearEnd|onResultsScroll)\b/.test(code)).toBe(false);
		expect(/(?<![\w$.])(?:document|window|navigator)\s*(?:\?\.|\.)\s*(?:activeElement|querySelector(?:All)?|body|addEventListener|removeEventListener|setTimeout|clearTimeout|setInterval|clearInterval|requestAnimationFrame|cancelAnimationFrame|getSelection|clipboard)\b/.test(code)).toBe(false);
	});

	it('retains the native modal focus container through close and reopen', () => {
		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1);
		if (!modal) throw new Error('Expected modal');
		const scope = modal.scope;
		const nativeScope = scope.parent;
		const outside = document.createElement('button');
		expect(scope.tabFocusContainerEl).toBe(modal.containerEl);
		expect(nativeScope?.tabFocusContainerEl).toBe(modal.containerEl);
		expect(scope.tabFocusContainerEl?.contains(modal.inputEl)).toBe(true);
		expect(scope.tabFocusContainerEl?.contains(outside)).toBe(false);
		modal.close();
		expect(scope.tabFocusContainerEl).toBe(modal.containerEl);
		expect(nativeScope?.tabFocusContainerEl).toBe(modal.containerEl);
		modal.open();
		expect(modal.scope).toBe(scope);
		expect(scope.tabFocusContainerEl).toBe(modal.containerEl);
		expect(nativeScope?.tabFocusContainerEl).toBe(modal.containerEl);
	});

	it('owns paging before the native parent scope', () => {
		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1);
		if (!modal) throw new Error('Expected modal');
		const { chooser } = installPagingList(modal, 60, 100, 800);
		const native = modal.scope.parent?.registrations.find((entry) => entry.key === 'PageDown');
		if (!native) throw new Error('Expected native PageDown');
		const handler = vi.fn(native.func);
		native.func = handler;
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', cancelable: true }));
		expect(chooser.selectedItem).toBe(8);
		expect(handler).not.toHaveBeenCalled();
		modal.close();
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', cancelable: true }));
		expect(chooser.selectedItem).toBe(8);
	});

	function installPagingList(modal: SuggestModal<any>, count: number, rowHeight: number, viewport: number, heights = Array<number>(count).fill(rowHeight)) {
		const tops = heights.map((_, index) => heights.slice(0, index).reduce((sum, height) => sum + height, 0));
		const scroller = modal.resultContainerEl;
		const ownerDocument = modal.modalEl.ownerDocument;
		scroller.replaceChildren();
		Object.defineProperty(ownerDocument, 'activeElement', {
			configurable: true,
			get: () => modal.inputEl,
		});
		Object.defineProperty(scroller, 'clientHeight', { value: viewport, configurable: true });
		scroller.getBoundingClientRect = () => ({ top: 0, bottom: viewport, height: viewport }) as DOMRect;
		const elements: HTMLElement[] = [];
		const sync = () => {
			scroller.querySelectorAll<HTMLElement>('.suggestion-item').forEach((element, index) => {
				const top = tops[index] - scroller.scrollTop;
				const height = heights[index];
				element.getBoundingClientRect = () =>
					({ top, bottom: top + height, height }) as DOMRect;
			});
		};
		for (let index = 0; index < count; index++) {
			const element = ownerDocument.createElement('div');
			element.addClass('suggestion-item');
			scroller.appendChild(element);
			Object.defineProperty(element, 'offsetHeight', { value: heights[index], configurable: true });
			elements.push(element);
		}
		const chooser = {
			selectedItem: 0,
			values: Array.from({ length: count }, (_, item) => ({ item })),
			setSelectedItem(index: number) {
				chooser.selectedItem = index;
				elements.forEach((element, itemIndex) =>
					element.classList.toggle('is-selected', itemIndex === index),
				);
				scroller.scrollTop = Math.max(0, tops[index] + heights[index] - viewport);
				sync();
			},
		};
		(modal as unknown as { chooser: unknown }).chooser = chooser;
		chooser.setSelectedItem(0);
		sync();
		return { chooser, elements, sync };
	}

	it('organizes settings into unheaded general, Search, and Outside the vault groups with safe defaults', () => {
		const settingTab = plugin.settingTabs[0];
		const defs = settingTab.getSettingDefinitions();
		expect(defs).toHaveLength(3);

		// Top: no heading (general)
		expect(defs[0]).toMatchObject({
			name: 'Show command title',
			control: { key: 'showCommandTitle', defaultValue: true },
		});

		// Group: Search
		expect(defs[1]).toMatchObject({
			type: 'group',
			heading: 'Search',
		});
		const searchGroup = defs[1] as any;
		expect(searchGroup.items?.map((item: any) => item.name)).toEqual([
			'Search properties',
			'Show matching properties',
		]);

		// Group: Outside the vault
		expect(defs[2]).toMatchObject({
			type: 'group',
			heading: 'Outside the vault',
		});
		const outsideGroup = defs[2] as any;
		expect(outsideGroup.items?.map((item: any) => item.name)).toEqual([
			'Browse outside vault',
			'Allow creating files outside vault',
		]);

		// Both outside vault defaults are off
		const browseDef = outsideGroup.items[0];
		const createDef = outsideGroup.items[1];
		expect(browseDef.control.defaultValue).toBe(false);
		expect(createDef.control.defaultValue).toBe(false);
		expect(plugin.settings.browseOutsideVault).toBe(false);
		expect(plugin.settings.allowCreateOutsideVault).toBe(false);

		// Allow creating files outside vault is disabled when browseOutsideVault is false
		const isDisabled = typeof createDef.control.disabled === 'function'
			? createDef.control.disabled()
			: createDef.control.disabled;
		expect(isDisabled).toBe(true);
	});

	it('allows the command title to be hidden from plugin settings without hiding the path', async () => {
		const settingTab = plugin.settingTabs[0];
		const definition = findSettingDefinition('Show command title');
		expect(definition?.control?.key).toBe('showCommandTitle');
		expect(findSettingDefinition('Show matching properties')?.control?.key)
			.toBe('showPropertyMatches');
		await settingTab.setControlValue('showCommandTitle', false);
		expect(plugin.settings.showCommandTitle).toBe(false);
		expect(plugin.data).toEqual({
			showCommandTitle: false,
			searchProperties: ['title'],
			showPropertyMatches: false,
			browseOutsideVault: false,
			allowCreateOutsideVault: false,
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

	it('searches configured string-valued properties and ranks files by match quality', () => {
		const matchingName = addFile(currentFolder, 'query-name-only.md');
		const matchingBoth = addFile(currentFolder, 'query-name.md');
		const matchingProperty = addFile(currentFolder, 'unrelated.md');
		const matchingStringList = addFile(currentFolder, 'string-list.md');
		const nonStringProperty = addFile(currentFolder, 'also-unrelated.md');
		metadataByFile.set(matchingBoth, { frontmatter: { title: 'query title' } });
		metadataByFile.set(matchingProperty, { frontmatter: { title: 'query title' } });
		metadataByFile.set(matchingStringList, { frontmatter: { title: ['query title'] } });
		metadataByFile.set(nonStringProperty, { frontmatter: { title: 12345 } });
		vi.spyOn(ObsidianMock, 'prepareFuzzySearch').mockReturnValue((value) => {
			if (value === 'query-name') return { score: 1, matches: [] };
			if (value === 'query-name-only') return { score: 10, matches: [] };
			if (value === 'query title') return { score: 4, matches: [] };
			return null;
		});

		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1);
		const suggestions = modal?.getSuggestions('query');

		expect(suggestions?.map(({ file }) => file)).toEqual([matchingName, matchingBoth, matchingStringList, matchingProperty]);
	});

	it('saves a configurable property list and completes string-valued and string-list property names', async () => {
		const settingTab = plugin.settingTabs[0];
		const file = addFile(currentFolder, 'property-source.md');
		metadataByFile.set(file, {
			frontmatter: {
				title: 'A title',
				category: 'literaturenote',
				tags: ['one', 'two'],
				rating: 5,
			},
		});
		const definition = findSettingDefinition('Search properties');
		if (!definition?.render) throw new Error('Expected the property picker renderer');
		const setting = new Setting(document.createElement('div'));
		definition.render(setting, {} as never);
		expect(setting.controlEl.querySelector('[aria-label="Remove title"]')).not.toBeNull();
		const titleChip = setting.controlEl.querySelector('.commons-property-picker-chip')!;
		expect(titleChip.classList.contains('is-plain')).toBe(true);
		expect(titleChip.querySelector('[aria-label="Text"]')).not.toBeNull();
		expect(setting.controlEl.querySelector('.commons-property-row')?.getAttribute('tabindex')).toBe('0');
		expect(setting.settingEl.classList.contains('commons-property-list-setting')).toBe(true);
		expect(setting.controlEl.querySelector<HTMLElement>('.commons-property-picker')?.dataset.appearance).toBe('property');
		expect(setting.controlEl.querySelector<HTMLElement>('.commons-property-picker')?.dataset.selectedLayout).toBe('rows');
		const propertySuggest = AbstractInputSuggest.instances.at(-1);
		const suggestions = propertySuggest?.suggestions('').map((item: any) => item.value);
		expect(suggestions).toEqual(expect.arrayContaining(['category', 'tags']));
		expect(suggestions).not.toContain('rating');

		await addSearchProperty(setting, 'tags');
		expect(plugin.settings.searchProperties).toEqual(['title', 'tags']);
		expect(setting.controlEl.querySelector('[aria-label="Remove tags"]')).not.toBeNull();

		await addSearchProperty(setting, 'future-property');
		expect(plugin.settings.searchProperties).toEqual(['title', 'tags', 'future-property']);
		expect(Notice.messages).toEqual([]);

		const categoryMatch = addFile(currentFolder, 'category-match.md');
		metadataByFile.set(categoryMatch, { frontmatter: { tags: ['distinctive phrase', 'other'] } });
		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1);
		expect(modal?.getSuggestions('distinctive').some(({ file }) => file === categoryMatch)).toBe(true);
	});

	it.each([
		{ name: 'ActionLab26beePolarisSkyNav.md', query: 'lab', highlights: ['Lab'], showProperties: false },
		{ name: 'ActionLab26beePolarisSkyNav.md', query: 'lab', highlights: ['Lab'], showProperties: true },
		{ name: 'Lab report.txt', query: 'lab', highlights: ['Lab'], showProperties: false },
		{ name: 'Lab report.md', query: 'report lab', highlights: ['Lab', 'report'], showProperties: false },
		{ name: 'Laboratory.md', query: 'lab labo', highlights: ['Labo'], showProperties: false },
		{ name: 'Lab report.md', query: 'lab', highlights: ['Lab'], showProperties: true, title: 'lab' },
		{ name: 'Lab report.md', query: 'lab unique', highlights: ['Lab'], showProperties: true, title: 'unique' },
		{ name: 'Unrelated.md', query: 'lab', highlights: [], showProperties: true, title: 'lab' },
		{ name: 'Lab report.md', query: '', highlights: [], showProperties: true },
		{ name: 'Lab report.md', query: '^/current/lab', highlights: ['Lab'], showProperties: false },
	])('highlights filename matches for $name with "$query" (properties: $showProperties)', async ({
		name, query, highlights, showProperties, title,
	}) => {
		const file = addFile(currentFolder, name);
		if (title) metadataByFile.set(file, { frontmatter: { title } });
		await plugin.settingTabs[0].setControlValue('showPropertyMatches', showProperties);
		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1);
		const entry = modal?.getSuggestions(query).find(({ file: result }) => result === file);
		if (!modal || !entry) throw new Error('Expected the filename-matching suggestion');
		const element = document.createElement('div');
		modal.renderSuggestion(entry, element);

		const nameEl = element.querySelector('.file-palette-suggestion-name');
		expect(nameEl?.textContent).toBe(file.basename);
		expect(Array.from(nameEl!.querySelectorAll('.suggestion-highlight'), (el) => el.textContent))
			.toEqual(highlights);
		expect(element.getAttribute('data-path')).toBe(file.path);
		expect(element.querySelector('.file-palette-suggestion-extension')?.textContent ?? '')
			.toBe(file.extension === 'md' ? '' : file.extension.toUpperCase());
		if (showProperties && title) {
			expect(element.querySelector('.file-palette-suggestion-property-value .suggestion-highlight')?.textContent)
				.toBe(title);
		}
	});

	it('highlights fuzzy filename ranges instead of requiring a literal substring', () => {
		const file = addFile(currentFolder, 'LongAmberBranch.md');
		vi.spyOn(ObsidianMock, 'prepareFuzzySearch').mockReturnValue((value) =>
			value === file.basename ? { score: 8, matches: [[0, 1], [4, 5], [9, 10]] } : null,
		);
		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1);
		const entry = modal?.getSuggestions('lab').find(({ file: result }) => result === file);
		if (!modal || !entry) throw new Error('Expected a fuzzy filename match');
		const element = document.createElement('div');
		modal.renderSuggestion(entry, element);
		expect(element.querySelector('.file-palette-suggestion-name')?.textContent).toBe(file.basename);
		expect(Array.from(element.querySelectorAll('.suggestion-highlight'), (el) => el.textContent))
			.toEqual(['L', 'A', 'B']);
	});

	it('highlights folder names without changing the trailing slash', () => {
		const folder = addFolder(currentFolder, 'Lab notes');
		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1);
		const entry = modal?.getSuggestions('lab').find(({ file }) => file === folder);
		if (!modal || !entry) throw new Error('Expected a folder match');
		const element = document.createElement('div');
		modal.renderSuggestion(entry, element);
		expect(element.querySelector('.file-palette-suggestion-name')?.textContent).toBe('Lab notes/');
		expect(element.querySelector('.suggestion-highlight')?.textContent).toBe('Lab');
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

	it('shows matching string property lists formatted as comma-separated values with highlights', async () => {
		const matchingFile = addFile(currentFolder, 'TagsFile.md');
		metadataByFile.set(matchingFile, { frontmatter: { tags: ['apple pie', 'banana bread'] } });
		await plugin.settingTabs[0].setControlValue('showPropertyMatches', true);
		const settingTab = plugin.settingTabs[0];
		const definition = findSettingDefinition('Search properties');
		const setting = new Setting(document.createElement('div'));
		definition?.render?.(setting, {} as never);
		await setSearchProperties(setting, ['title', 'tags']);

		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1);
		const entry = modal?.getSuggestions('banana').find(({ file }) => file === matchingFile);
		if (!modal || !entry) throw new Error('Expected the tags-matching file suggestion');
		const element = document.createElement('div');
		modal.renderSuggestion(entry, element);

		expect(element.querySelector('.file-palette-suggestion-property-name')?.textContent).toBe('tags:');
		expect(element.querySelector('.file-palette-suggestion-property-value')?.textContent).toBe('apple pie, banana bread');
		expect(Array.from(element.querySelectorAll('.suggestion-highlight'), (highlight) => highlight.textContent))
			.toEqual(['banana']);
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
		const definition = findSettingDefinition('Search properties');
		const setting = new Setting(document.createElement('div'));
		definition?.render?.(setting, {} as never);
		await setSearchProperties(setting, ['title', 'fake-property']);

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
		const definition = findSettingDefinition('Search properties');
		const setting = new Setting(document.createElement('div'));
		definition?.render?.(setting, {} as never);
		await setSearchProperties(setting, ['title', 'fake-property']);

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

		const highlights = Array.from(element.querySelectorAll('.file-palette-suggestion-properties .suggestion-highlight'), (el) => el.textContent);
		expect(highlights).toEqual(['steady', 'fake']);
		expect(element.querySelector('.file-palette-suggestion-name .suggestion-highlight')?.textContent).toBe('Steady');
	});

	it('previews the vault root for caret queries without clearing the input', () => {
		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1) as VaultPathSuggestModal | undefined;
		if (!modal) throw new Error('Expected the picker modal to open');
		const locationBeforeTyping = modal.currentLocation.absPath;

		modal.inputEl.value = '^';
		modal.inputEl.dispatchEvent(new Event('input', { bubbles: true }));

		expect(modal.modalEl.querySelector('.file-palette-current-path')?.textContent).toBe('/');
		expect(modal.inputEl.value).toBe('^/');
		expect(modal.currentLocation.absPath).toBe(locationBeforeTyping);
		expect((modal.getSuggestions('^') as any).some((entry: any) => entry.file === rootFile)).toBe(true);
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
				return visibleSegments === 3 ? 200 : 40;
			},
		});
		modal.inputEl.dispatchEvent(new Event('input', { bubbles: true }));

		expect(path.querySelector('.fp-path-ellipsis')?.textContent).toBe('…');
		expect(Array.from(path.querySelectorAll('.fp-path-segment:not(.fp-path-hidden)'), (segment) => segment.textContent))
			.toEqual(['Folder with spaces & [special]', 'Deepest']);
		expect(path.querySelectorAll('.fp-path-segment.fp-path-hidden')).toHaveLength(1);
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
		const modal = highlightEntry(rootFile, '^/Root');
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
		await vi.waitFor(() => expect(Notice.messages).toEqual(['Link copied to clipboard.']));
		expect(modal.modalEl.querySelector('.fp-path')).not.toBeNull();
	});

	it('does not consume L while the user is typing a search', () => {
		const modal = highlightEntry(rootFile, '^/Root');
		const event = new KeyboardEvent('keydown', { key: 'l', bubbles: true, cancelable: true });

		modal.inputEl.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(false);
		expect(generateMarkdownLink).not.toHaveBeenCalled();
	});

	it('reports clipboard failures when copying a highlighted link', async () => {
		vi.stubGlobal('navigator', {
			clipboard: { writeText: vi.fn().mockRejectedValue(new Error('Permission denied')) },
		});
		const modal = highlightEntry(rootFile, '^/Root');
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
		const modal = highlightEntry(rootFile, '^/Root');
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

	it('creates a new markdown file in the current folder on Shift+Enter', async () => {
		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1);
		if (!modal) throw new Error('Expected modal to open');

		modal.inputEl.value = 'Brand new note';
		const event = new KeyboardEvent('keydown', {
			key: 'Enter',
			shiftKey: true,
			bubbles: true,
			cancelable: true,
		});

		modal.inputEl.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(true);
		expect(app.vault.create).toHaveBeenCalledWith('current/Brand new note.md', '');
		await vi.waitFor(() => {
			expect(openedFiles.some((f) => f.path === 'current/Brand new note.md')).toBe(true);
		});
		expect(modal.modalEl.querySelector('.file-palette-current-path')).toBeNull();
	});

	it('preserves an explicit file extension on Shift+Enter', async () => {
		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1);
		if (!modal) throw new Error('Expected modal to open');

		modal.inputEl.value = 'diagram.canvas';
		const event = new KeyboardEvent('keydown', {
			key: 'Enter',
			shiftKey: true,
			bubbles: true,
			cancelable: true,
		});

		modal.inputEl.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(true);
		expect(app.vault.create).toHaveBeenCalledWith('current/diagram.canvas', '');
		await vi.waitFor(() => {
			expect(openedFiles.some((f) => f.path === 'current/diagram.canvas')).toBe(true);
		});
	});

	it('creates a note in a subfolder or root path when specified in the query on Shift+Enter', async () => {
		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1);
		if (!modal) throw new Error('Expected modal to open');

		modal.inputEl.value = 'Nested/Child note';
		const event = new KeyboardEvent('keydown', {
			key: 'Enter',
			shiftKey: true,
			bubbles: true,
			cancelable: true,
		});

		modal.inputEl.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(true);
		expect(app.vault.create).toHaveBeenCalledWith('current/Nested/Child note.md', '');
		await vi.waitFor(() => {
			expect(openedFiles.some((f) => f.path === 'current/Nested/Child note.md')).toBe(true);
		});
	});

	it('shows a notice and refuses to create a file when input name is empty on Shift+Enter', () => {
		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1);
		if (!modal) throw new Error('Expected modal to open');

		modal.inputEl.value = '   ';
		const event = new KeyboardEvent('keydown', {
			key: 'Enter',
			shiftKey: true,
			bubbles: true,
			cancelable: true,
		});

		modal.inputEl.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(true);
		expect(app.vault.create).not.toHaveBeenCalled();
		expect(Notice.messages).toContain('Enter a file name to create a note.');
	});

	it('shows a notice and refuses to create a file with invalid characters on Shift+Enter', () => {
		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1);
		if (!modal) throw new Error('Expected modal to open');

		modal.inputEl.value = 'illegal:name?*';
		const event = new KeyboardEvent('keydown', {
			key: 'Enter',
			shiftKey: true,
			bubbles: true,
			cancelable: true,
		});

		modal.inputEl.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(true);
		expect(app.vault.create).not.toHaveBeenCalled();
		expect(Notice.messages).toContain('File name contains invalid characters.');
	});

	it('opens existing note and displays a notice if the file already exists on Shift+Enter', async () => {
		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1);
		if (!modal) throw new Error('Expected modal to open');

		modal.inputEl.value = '^/Root note';
		const event = new KeyboardEvent('keydown', {
			key: 'Enter',
			shiftKey: true,
			bubbles: true,
			cancelable: true,
		});

		modal.inputEl.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(true);
		expect(app.vault.create).not.toHaveBeenCalled();
		expect(Notice.messages).toContain('"Root note" already exists — opening file.');
		await vi.waitFor(() => {
			expect(openedFiles).toContain(rootFile);
		});
	});

	it('shows a notice and refuses to create when a folder with the same name exists', () => {
		addFolder(currentFolder, 'FolderNote.md');
		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1);
		if (!modal) throw new Error('Expected modal to open');

		modal.inputEl.value = 'FolderNote.md';
		const event = new KeyboardEvent('keydown', {
			key: 'Enter',
			shiftKey: true,
			bubbles: true,
			cancelable: true,
		});

		modal.inputEl.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(true);
		expect(app.vault.create).not.toHaveBeenCalled();
		expect(Notice.messages).toContain('A folder named "FolderNote.md" already exists.');
	});

	it('shows a notice when the specified parent folder does not exist', () => {
		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1);
		if (!modal) throw new Error('Expected modal to open');

		modal.inputEl.value = 'NonexistentFolder/NewNote';
		const event = new KeyboardEvent('keydown', {
			key: 'Enter',
			shiftKey: true,
			bubbles: true,
			cancelable: true,
		});

		modal.inputEl.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(true);
		expect(app.vault.create).not.toHaveBeenCalled();
		expect(Notice.messages).toContain('The specified folder does not exist.');
	});

	it('catches and reports creation error if vault.create fails', async () => {
		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1);
		if (!modal) throw new Error('Expected modal to open');

		vi.mocked(app.vault.create).mockRejectedValueOnce(new Error('Permission denied'));

		modal.inputEl.value = 'Failed note';
		const event = new KeyboardEvent('keydown', {
			key: 'Enter',
			shiftKey: true,
			bubbles: true,
			cancelable: true,
		});

		modal.inputEl.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(true);
		await vi.waitFor(() => {
			expect(Notice.messages).toContain('Could not create file: Permission denied');
		});
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
		const modal = highlightEntry(rootFile, '^/Root');
		modal.inputEl.value = '^/Root';
		const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
		modal.inputEl.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(true);
		expect(modal.inputEl.value).toBe('^/Root note');
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
		const modal = highlightEntry(rootFile, '^/Root');

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
		const modal = highlightEntry(rootFile, '^/Root');
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
		const modal = highlightEntry(rootFile, '^/Root');

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
		const modal = highlightEntry(rootFile, '^/Root');

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
		const modal = highlightEntry(rootFile, '^/Root');
		(app as App & { openWithDefaultApp?: (path: string) => void | Promise<void> }).openWithDefaultApp = undefined;

		modal.inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: '*', bubbles: true, cancelable: true }));

		expect(Notice.messages).toEqual(['Opening items with the system default app is not available on this device.']);
		expect(modal.modalEl.querySelector('.file-palette-current-path')).not.toBeNull();
	});

	it('reports when opening with the system default app fails', async () => {
		const modal = highlightEntry(rootFile, '^/Root');
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

	describe('search ranking and tokenization', () => {
		it('tokenizes Hong20energyForecastingReview into word and digit tokens', () => {
			expect(tokenize('Hong20energyForecastingReview')).toEqual(['hong', '20', 'energy', 'forecasting', 'review']);
		});

		it('tokenizes PDFExtractionNotes preserving acronym and word boundaries', () => {
			expect(tokenize('PDFExtractionNotes')).toEqual(['pdf', 'extraction', 'notes']);
		});

		it('tokenizes kebab-case and snake_case in wind-power_notes', () => {
			expect(tokenize('wind-power_notes')).toEqual(['wind', 'power', 'notes']);
		});

		it('classifies forecasting against energyForecastingReview as WholeWord', () => {
			const tokens = tokenize('energyForecastingReview');
			expect(classifyLiteral('energyForecastingReview', tokens, 'forecasting')).toBe(MatchQuality.WholeWord);
		});

		it('classifies power against wind-power_notes as WholeWord', () => {
			const tokens = tokenize('wind-power_notes');
			expect(classifyLiteral('wind-power_notes', tokens, 'power')).toBe(MatchQuality.WholeWord);
		});

		it('classifies pin against Pinson as WordPrefix', () => {
			const tokens = tokenize('Pinson');
			expect(classifyLiteral('Pinson', tokens, 'pin')).toBe(MatchQuality.WordPrefix);
		});

		it('classifies inso against Pinson as Substring', () => {
			const tokens = tokenize('Pinson');
			expect(classifyLiteral('Pinson', tokens, 'inso')).toBe(MatchQuality.Substring);
		});

		it('evaluates queries differing only in case to the same quality', () => {
			const tokens = tokenize('Pinson');
			expect(classifyLiteral('Pinson', tokens, 'PINSON')).toBe(MatchQuality.WholeWord);
			expect(classifyLiteral('Pinson', tokens, 'pinson')).toBe(MatchQuality.WholeWord);
			expect(classifyLiteral('Pinson', tokens, 'PIN')).toBe(MatchQuality.WordPrefix);
			expect(classifyLiteral('Pinson', tokens, 'pin')).toBe(MatchQuality.WordPrefix);
		});

		it('ranks filename match first when whole-word match quality is equal', () => {
			const filenameMatch = { quality: MatchQuality.WholeWord, isFilename: true, fuzzyScore: 0 };
			const propertyMatch = { quality: MatchQuality.WholeWord, isFilename: false, fuzzyScore: 0 };
			expect(compareWordMatches(filenameMatch, propertyMatch)).toBeGreaterThan(0);
		});

		it('ranks property file first when filename has prefix and property has whole word', () => {
			const filenamePrefix = { quality: MatchQuality.WordPrefix, isFilename: true, fuzzyScore: 0 };
			const propertyWholeWord = { quality: MatchQuality.WholeWord, isFilename: false, fuzzyScore: 0 };
			expect(compareWordMatches(propertyWholeWord, filenamePrefix)).toBeGreaterThan(0);
		});

		it('ranks property file first when property has whole word and filename has scattered fuzzy match', () => {
			const filenameFuzzy = { quality: MatchQuality.Fuzzy, isFilename: true, fuzzyScore: 10 };
			const propertyWholeWord = { quality: MatchQuality.WholeWord, isFilename: false, fuzzyScore: 0 };
			expect(compareWordMatches(propertyWholeWord, filenameFuzzy)).toBeGreaterThan(0);
		});

		it('ranks whole word in authors above weak fuzzy hits in filename and title', async () => {
			const settingTab = plugin.settingTabs[0];
			const definition = findSettingDefinition('Search properties');
			const setting = new Setting(document.createElement('div'));
			definition?.render?.(setting, {} as never);
			await setSearchProperties(setting, ['title', 'authors']);

			const fragmented = addFile(currentFolder, 'DePinto23partisanEconLens.md');
			metadataByFile.set(fragmented, {
				frontmatter: {
					title: 'CBS News poll analysis looks at how Americans rate the economy throughout...',
					authors: 'De Pinto, Jennifer',
				},
			});

			const authorsMatch = addFile(currentFolder, 'Hong20energyForecastingReview.md');
			metadataByFile.set(authorsMatch, {
				frontmatter: {
					title: 'Energy forecasting: A review and outlook',
					authors: ['Hong, Tao', 'Pinson, Pierre', 'Wang, Yi'],
				},
			});

			vi.spyOn(ObsidianMock, 'prepareFuzzySearch').mockReturnValue((value) => {
				if (value === 'DePinto23partisanEconLens') return { score: 1, matches: [[2, 3], [4, 6], [14, 15], [19, 21]] };
				if (value.startsWith('CBS News')) return { score: 1, matches: [[9, 10], [20, 21], [44, 46], [58, 60]] };
				if (value === 'Pinson, Pierre') return { score: 10, matches: [[0, 6]] };
				return null;
			});

			runCommand('open-palette');
			const modal = SuggestModal.instances.at(-1);
			const suggestions = modal?.getSuggestions('pinson');

			expect(suggestions?.map(({ file }) => file)).toEqual([authorsMatch, fragmented]);
		});

		it('includes files when different query words match different properties', async () => {
			const settingTab = plugin.settingTabs[0];
			const definition = findSettingDefinition('Search properties');
			const setting = new Setting(document.createElement('div'));
			definition?.render?.(setting, {} as never);
			await setSearchProperties(setting, ['title', 'authors']);

			const multiMatch = addFile(currentFolder, 'unrelated-filename.md');
			metadataByFile.set(multiMatch, {
				frontmatter: {
					title: 'Energy forecasting: A review',
					authors: ['Pinson, Pierre'],
				},
			});

			runCommand('open-palette');
			const modal = SuggestModal.instances.at(-1);
			const suggestions = modal?.getSuggestions('pinson forecasting');

			expect(suggestions?.map(({ file }) => file)).toContain(multiMatch);
		});

		it('excludes files when one query word is absent everywhere', async () => {
			const settingTab = plugin.settingTabs[0];
			const definition = findSettingDefinition('Search properties');
			const setting = new Setting(document.createElement('div'));
			definition?.render?.(setting, {} as never);
			await setSearchProperties(setting, ['title', 'authors']);

			const partialMatch = addFile(currentFolder, 'unrelated-filename.md');
			metadataByFile.set(partialMatch, {
				frontmatter: {
					title: 'Energy forecasting: A review',
					authors: ['Pinson, Pierre'],
				},
			});

			runCommand('open-palette');
			const modal = SuggestModal.instances.at(-1);
			const suggestions = modal?.getSuggestions('pinson absentword');

			expect(suggestions?.map(({ file }) => file)).not.toContain(partialMatch);
		});

		it('excludes matches that only span across two list items', async () => {
			const settingTab = plugin.settingTabs[0];
			const definition = findSettingDefinition('Search properties');
			const setting = new Setting(document.createElement('div'));
			definition?.render?.(setting, {} as never);
			await setSearchProperties(setting, ['authors']);

			const file = addFile(currentFolder, 'spanning-test.md');
			metadataByFile.set(file, {
				frontmatter: {
					authors: ['Alice Pin', 'Son Smith'],
				},
			});

			// Mock fuzzy matcher so 'pinson' would only match if the text were joined as "Alice Pin, Son Smith"
			vi.spyOn(ObsidianMock, 'prepareFuzzySearch').mockReturnValue((text) => {
				if (text === 'Alice Pin, Son Smith') return { score: 10, matches: [] };
				return null;
			});

			runCommand('open-palette');
			const modal = SuggestModal.instances.at(-1);
			const suggestions = modal?.getSuggestions('pinson');

			expect(suggestions?.map(({ file }) => file)).not.toContain(file);
		});

		it('orders files with identical match quality alphabetically by path', () => {
			const fileB = addFile(currentFolder, 'file-beta.md');
			const fileA = addFile(currentFolder, 'file-alpha.md');

			runCommand('open-palette');
			const modal = SuggestModal.instances.at(-1);
			const suggestions = modal?.getSuggestions('file');

			expect(suggestions?.map(({ file }) => file)).toEqual([fileA, fileB]);
		});

		it('preserves unfiltered behavior and parent entry on empty query', () => {
			const note = addFile(currentFolder, 'Current note.md');
			runCommand('open-palette');
			const modal = SuggestModal.instances.at(-1);
			const suggestions = modal?.getSuggestions('');

			expect(suggestions?.[0]?.isParent).toBe(true);
			expect(suggestions?.slice(1).map(({ file }) => file)).toContain(note);
		});

		it('aligns highlight ranges with the displayed text for camel-case and list items', async () => {
			await plugin.settingTabs[0].setControlValue('showPropertyMatches', true);
			const settingTab = plugin.settingTabs[0];
			const definition = findSettingDefinition('Search properties');
			const setting = new Setting(document.createElement('div'));
			definition?.render?.(setting, {} as never);
			await setSearchProperties(setting, ['authors']);

			const file = addFile(currentFolder, 'Hong20energyForecastingReview.md');
			metadataByFile.set(file, {
				frontmatter: {
					authors: ['Hong, Tao', 'Pinson, Pierre'],
				},
			});

			runCommand('open-palette');
			const modal = SuggestModal.instances.at(-1);
			const entry = modal?.getSuggestions('pinson').find((s) => s.file === file);
			if (!modal || !entry) throw new Error('Expected suggestion');
			const element = document.createElement('div');
			modal.renderSuggestion(entry, element);

			expect(element.querySelector('.file-palette-suggestion-property-value')?.textContent).toBe('Hong, Tao, Pinson, Pierre');
			expect(Array.from(element.querySelectorAll('.suggestion-highlight'), (el) => el.textContent)).toEqual(['Pinson']);
		});
	});

	it('ensures only one file palette is open across windows, closing the old one when a new one is opened', () => {
		// Open palette in Window 1
		runCommand('open-palette');
		const modal1 = VaultPathSuggestModal.getActiveModal();
		expect(modal1).not.toBeNull();
		expect(modal1?.modalEl.querySelector('.fp-header')).not.toBeNull();

		// Simulate user moving to Window 2 and opening the file palette
		runCommand('open-palette');
		const modal2 = VaultPathSuggestModal.getActiveModal();
		expect(modal2).not.toBeNull();
		expect(modal2).not.toBe(modal1);

		// Old modal in Window 1 is closed
		expect(modal1?.modalEl.querySelector('.fp-header')).toBeNull();
		// New modal in Window 2 is open
		expect(modal2?.modalEl.querySelector('.fp-header')).not.toBeNull();
		expect(VaultPathSuggestModal.getActiveModal()).toBe(modal2);
	});

	it('cleans up active modal reference when the modal is closed', () => {
		runCommand('open-palette');
		const modal = VaultPathSuggestModal.getActiveModal();
		expect(modal).not.toBeNull();

		modal?.close();
		expect(VaultPathSuggestModal.getActiveModal()).toBeNull();
	});

	it('closes the active modal when plugin is unloaded', () => {
		runCommand('open-palette');
		const modal = VaultPathSuggestModal.getActiveModal();
		expect(modal).not.toBeNull();

		plugin.onunload();
		expect(modal?.modalEl.querySelector('.fp-header')).toBeNull();
		expect(VaultPathSuggestModal.getActiveModal()).toBeNull();
	});

	it('cleans up active modal if the window containing it is closed', () => {
		runCommand('open-palette');
		const modal = VaultPathSuggestModal.getActiveModal();
		expect(modal).not.toBeNull();

		const popoutWindow = { document: modal?.modalEl.ownerDocument } as Window;
		const workspaceWindow = { win: popoutWindow, doc: modal?.modalEl.ownerDocument } as never;

		workspace.trigger?.('window-close', workspaceWindow, popoutWindow);
		expect(VaultPathSuggestModal.getActiveModal()).toBeNull();
	});

	it('returns every suggestion for empty and matching queries in a folder with over 1000 files', async () => {
		const largeFolder = addFolder(root, 'large-folder');
		for (let i = 0; i < 1100; i++) {
			addFile(largeFolder, `bulk-file-${String(i).padStart(4, '0')}.md`);
		}

		const modal = new VaultPathSuggestModal(app, largeFolder as never);
		expect(modal.limit).toBe(0);
		const emptySuggestions = await Promise.resolve(modal.getSuggestions(''));
		expect(emptySuggestions).toHaveLength(1101);
		expect(emptySuggestions[0]?.isParent).toBe(true);
		expect(emptySuggestions.at(-1)?.file?.name).toBe('bulk-file-1099.md');

		const searchSuggestions = await Promise.resolve(modal.getSuggestions('bulk'));
		expect(searchSuggestions).toHaveLength(1100);
		expect(searchSuggestions.at(-1)?.file?.name).toBe('bulk-file-1099.md');
	});

	it('does not read metadata cache on empty query when showPropertyMatches is disabled', async () => {
		const getFileCacheSpy = vi.spyOn(app.metadataCache, 'getFileCache');
		const modal = new VaultPathSuggestModal(app, currentFolder as never, true, ['title'], false);
		const suggestions = await Promise.resolve(modal.getSuggestions(''));
		expect(suggestions.length).toBeGreaterThan(0);
		expect(getFileCacheSpy).not.toHaveBeenCalled();
	});

	it('navigates to and stays in the resolved folder on Enter when query is a completed folder path like /lit/lit_notes/', async () => {
		const litFolder = addFolder(root, 'lit');
		const litNotesFolder = addFolder(litFolder, 'lit_notes');
		addFile(litNotesFolder, 'SampleNote.md');

		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1) as unknown as VaultPathSuggestModal;
		expect(modal).not.toBeNull();

		modal.inputEl.value = '/lit/lit_notes/';
		modal.inputEl.dispatchEvent(new Event('input', { bubbles: true }));

		// Highlight parent entry (or whatever is at index 0)
		const parentEntry = (await Promise.resolve(modal.getSuggestions('/lit/lit_notes/')))[0];
		const element = document.createElement('div');
		element.addClass('suggestion-item');
		element.addClass('is-selected');
		modal.renderSuggestion(parentEntry, element);
		modal.resultContainerEl.appendChild(element);

		// Press Enter via onChooseSuggestion (as Obsidian SuggestModal invokes on Enter)
		modal.onChooseSuggestion(parentEntry, new KeyboardEvent('keydown', { key: 'Enter' }));

		await vi.waitFor(() => {
			const latestModal = SuggestModal.instances.at(-1) as unknown as VaultPathSuggestModal;
			expect(latestModal).not.toBe(modal);
			expect(latestModal.currentLocation.vaultRelPath).toBe('/lit/lit_notes');
		});
	});

	it('navigates to target folder when choosing parent suggestion on traversed path query like lit_sources/', async () => {
		const litFolder = addFolder(root, 'lit');
		const litSourcesFolder = addFolder(litFolder, 'lit_sources');
		addFile(litSourcesFolder, 'SourceDoc.md');

		const modal = new VaultPathSuggestModal(app, litFolder as never);
		modal.inputEl.value = 'lit_sources/';
		modal.inputEl.dispatchEvent(new Event('input', { bubbles: true }));

		const suggestions = await Promise.resolve(modal.getSuggestions('lit_sources/'));
		const parentEntry = suggestions.find((s) => s.isParent);
		if (!parentEntry) throw new Error('Expected parent entry');

		modal.onChooseSuggestion(parentEntry);

		await vi.waitFor(() => {
			const latestModal = SuggestModal.instances.at(-1) as unknown as VaultPathSuggestModal;
			expect(latestModal).not.toBe(modal);
			expect(latestModal.currentLocation.vaultRelPath).toBe('/lit/lit_sources');
		});
	});

	it('resolves parent folder when clicking parent entry with mouse or when query is empty', async () => {
		const litFolder = addFolder(root, 'lit');
		const litNotesFolder = addFolder(litFolder, 'lit_notes');

		// Case A: modal opened in /lit/lit_notes with empty query
		const modalInSubfolder = new VaultPathSuggestModal(app, litNotesFolder as never);
		const parentEntryA = (await Promise.resolve(modalInSubfolder.getSuggestions(''))).find((s) => s.isParent);
		if (!parentEntryA) throw new Error('Expected parent entry');

		modalInSubfolder.onChooseSuggestion(parentEntryA);

		await vi.waitFor(() => {
			const latestModal = SuggestModal.instances.at(-1) as unknown as VaultPathSuggestModal;
			expect(latestModal).not.toBe(modalInSubfolder);
			expect(latestModal.currentLocation.vaultRelPath).toBe('/lit');
		});

		// Case B: modal in root with query /lit/lit_notes/, user explicitly clicks .. with mouse
		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1) as unknown as VaultPathSuggestModal;
		modal.inputEl.value = '/lit/lit_notes/';
		modal.inputEl.dispatchEvent(new Event('input', { bubbles: true }));

		const parentEntryB = (await Promise.resolve(modal.getSuggestions('/lit/lit_notes/'))).find((s) => s.isParent);
		if (!parentEntryB) throw new Error('Expected parent entry');

		modal.onChooseSuggestion(parentEntryB, new MouseEvent('click'));

		await vi.waitFor(() => {
			const latestModal = SuggestModal.instances.at(-1) as unknown as VaultPathSuggestModal;
			expect(latestModal).not.toBe(modal);
			expect(latestModal.currentLocation.vaultRelPath).toBe('/lit');
		});
	});
});

describe('alignFuzzyRanges', () => {
	it('moves a stray first letter onto the word start', () => {
		// "Yes, America is super polarized": matcher took p from "super" and "olariz" from "polarized".
		const text = 'Yes, America is super polarized.';
		const p = text.indexOf('super') + 2;
		const o = text.indexOf('polarized') + 1;
		expect(alignFuzzyRanges(text, [[p, p + 1], [o, o + 6]], 'polarization')).toEqual([[o - 1, o + 6]]);
	});

	it('leaves already aligned and unrelated ranges alone', () => {
		expect(alignFuzzyRanges('polarized', [[0, 7]], 'polarization')).toEqual([[0, 7]]);
		expect(alignFuzzyRanges('Policy Feasibility', [[0, 3], [8, 9]], 'polarization')).toEqual([[0, 3], [8, 9]]);
	});
});

describe('makeLocation and getParentPath', () => {
	const createMockApp = (vaultBasePath: string | null): App => {
		const adapter = vaultBasePath ? new FileSystemAdapter(vaultBasePath) : undefined;
		return {
			vault: {
				adapter,
				getRoot: () => new TFolder('', ''),
			},
		} as unknown as App;
	};

	it('handles Windows case-insensitive match', () => {
		Platform.isWin = true;
		const app = createMockApp('C:/Vault');
		const loc = makeLocation(app, 'c:/vault/docs/note.md');
		expect(loc.inVault).toBe(true);
		expect(loc.vaultRelPath).toBe('/docs/note.md');
		expect(loc.absPath).toBe('c:/vault/docs/note.md');
	});

	it('handles case-sensitive match on non-Windows', () => {
		Platform.isWin = false;
		const app = createMockApp('C:/Vault');
		const locMismatch = makeLocation(app, 'c:/vault/docs/note.md');
		expect(locMismatch.inVault).toBe(false);
		expect(locMismatch.vaultRelPath).toBeNull();

		const locMatch = makeLocation(app, 'C:/Vault/docs/note.md');
		expect(locMatch.inVault).toBe(true);
		expect(locMatch.vaultRelPath).toBe('/docs/note.md');
		Platform.isWin = true;
	});

	it('identifies sibling folders with a shared prefix as outside the vault', () => {
		Platform.isWin = true;
		const app = createMockApp('C:/Vault');
		const locSibling = makeLocation(app, 'C:/Vault2/notes');
		expect(locSibling.inVault).toBe(false);
		expect(locSibling.vaultRelPath).toBeNull();

		const locExactSibling = makeLocation(app, 'C:/Vault2');
		expect(locExactSibling.inVault).toBe(false);
		expect(locExactSibling.vaultRelPath).toBeNull();
	});

	it('handles trailing slashes on vault root and subfolders', () => {
		Platform.isWin = true;
		const app = createMockApp('C:/Vault');
		const locRootSlash = makeLocation(app, 'C:/Vault/');
		expect(locRootSlash.inVault).toBe(true);
		expect(locRootSlash.vaultRelPath).toBe('/');
		expect(locRootSlash.absPath).toBe('C:/Vault');

		const locSubSlash = makeLocation(app, 'C:/Vault/subfolder/');
		expect(locSubSlash.inVault).toBe(true);
		expect(locSubSlash.vaultRelPath).toBe('/subfolder');
		expect(locSubSlash.absPath).toBe('C:/Vault/subfolder');
	});

	it('handles the vault root itself', () => {
		Platform.isWin = true;
		const app = createMockApp('C:/Vault');
		const locRoot = makeLocation(app, 'C:/Vault');
		expect(locRoot.inVault).toBe(true);
		expect(locRoot.vaultRelPath).toBe('/');
		expect(locRoot.absPath).toBe('C:/Vault');
	});

	it('falls back to in-vault when vaultBase is null', () => {
		const app = createMockApp(null);
		const loc = makeLocation(app, '/Finance');
		expect(loc.inVault).toBe(true);
		expect(loc.vaultRelPath).toBe('/Finance');
	});

	it('stops at drive root on Windows and does not navigate up', () => {
		expect(getParentPath('C:')).toBe('C:');
		expect(getParentPath('C:/')).toBe('C:');
		expect(getParentPath('D:')).toBe('D:');
	});

	it('navigates up subpaths correctly', () => {
		expect(getParentPath('C:/Users/scott')).toBe('C:/Users');
		expect(getParentPath('C:/Users')).toBe('C:');
		expect(getParentPath('/home/user/docs')).toBe('/home/user');
		expect(getParentPath('/home/user')).toBe('/home');
		expect(getParentPath('/home')).toBe('/');
		expect(getParentPath('/')).toBe('/');
	});
});

describe('external file and folder palette behavior', () => {
	let tempDir: string;
	let app: App;
	let plugin: FilePalettePlugin & {
		commands: { id: string; callback: () => void }[];
		settingTabs: {
			getSettingDefinitions: () => { name?: string; control?: { key: string } }[];
			getControlValue: (key: string) => unknown;
			setControlValue: (key: string, value: unknown) => Promise<void>;
		}[];
	};
	let root: TFolder;
	let shownPaths: string[];
	let openedDefaultAppPaths: string[];
	let openedFiles: unknown[];

	beforeEach(async () => {
		vi.restoreAllMocks();
		SuggestModal.instances.length = 0;
		Notice.messages.length = 0;
		shownPaths = [];
		openedDefaultAppPaths = [];
		openedFiles = [];
		Platform.isDesktopApp = true;
		Platform.isWin = true;
		Platform.isMobile = false;

		tempDir = mkdtempSync(join(tmpdir(), 'palette-ext-'));
		writeFileSync(join(tempDir, 'outside-doc.md'), '# External Note\n');
		writeFileSync(join(tempDir, 'readme.txt'), 'Hello outside world\n');

		root = new TFolder('', '');
		app = {
			vault: {
				adapter: new FileSystemAdapter('C:/ObsidianVault'),
				getRoot: () => root,
				getAbstractFileByPath: () => null,
				getFileByPath: (path: string) => {
					if (path.startsWith('file:')) {
						const real = path.slice(5);
						return new TExternalFile('outside-doc.md', path, real);
					}
					return null;
				},
				create: vi.fn(),
			},
			workspace: {
				getActiveFile: () => new TExternalFile('outside-doc.md', 'outside-doc.md', join(tempDir, 'outside-doc.md')),
				getLeaf: () => ({
					openFile: vi.fn((file: unknown) => {
						openedFiles.push(file);
						return Promise.resolve();
					}),
				}),
				getLeavesOfType: () => [],
			},
			showInFolder: (path: string) => {
				shownPaths.push(path);
			},
			openWithDefaultApp: (path: string) => {
				openedDefaultAppPaths.push(path);
			},
			metadataCache: {
				getFileCache: () => null,
			},
			fileManager: {
				generateMarkdownLink: vi.fn(),
			},
		} as unknown as App;

		plugin = new FilePalettePlugin(app, {} as never) as typeof plugin;
		await plugin.onload();
		plugin.settings.browseOutsideVault = true;
	});

	afterEach(() => {
		VaultPathSuggestModal.closeActiveModal();
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	});

	it('opens in the external folder with .palette-external class and hard-drive indicator', async () => {
		plugin.commands.find(({ id }) => id === 'open-palette')?.callback();
		const modal = SuggestModal.instances.at(-1);
		if (!modal) throw new Error('Expected modal to open');

		expect(modal.modalEl.classList.contains('palette-external')).toBe(true);
		const indicator = modal.modalEl.querySelector('.fp-external-indicator');
		const isUnderHome = norm(tempDir).toLowerCase().startsWith(norm(tmpdir()).toLowerCase() + '/');
		expect(indicator?.getAttribute('data-icon')).toBe(isUnderHome ? 'home' : 'hard-drive');
		expect(indicator?.classList.contains('is-external')).toBe(true);

		const pathEl = modal.modalEl.querySelector('.fp-path');
		expect(pathEl?.classList.contains('file-palette-outside')).toBe(true);
		const expectedDisplay = tempDir.replace(/\\/g, '/');
		expect(pathEl?.getAttribute('title')).toBe(expectedDisplay);
	});

	it('keeps navigation inside the vault when outside-vault browsing is disabled', async () => {
		plugin.settings.browseOutsideVault = false;
		plugin.commands.find(({ id }) => id === 'open-palette')?.callback();
		const modal = SuggestModal.instances.at(-1) as VaultPathSuggestModal | undefined;
		if (!modal) throw new Error('Expected modal to open');

		expect(modal.currentLocation.inVault).toBe(true);
		expect(modal.currentLocation.absPath).toBe('C:/ObsidianVault');

		modal.inputEl.value = '~';
		modal.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
		expect(modal.currentLocation.inVault).toBe(true);
		expect(modal.currentLocation.absPath).toBe('C:/ObsidianVault');
		expect(Notice.messages).toContain(
			'Blocked by the “Browse outside vault” setting. Change it in File Palette settings.',
		);
		expect(Notice.durations.at(-1)).toBe(8000);
		expect(
			Array.from(modal.modalEl.querySelectorAll('.fp-hint.is-disabled .fp-hint-key')).map((el) => el.textContent),
		).toContain('~');

		expect(await Promise.resolve(modal.getSuggestions('../'))).toEqual([]);
		expect(await Promise.resolve(modal.getSuggestions(tempDir))).toEqual([]);
	});

	it('shows the browse-setting notice for parent navigation attempts at the vault root', async () => {
		plugin.settings.browseOutsideVault = false;
		plugin.commands.find(({ id }) => id === 'open-palette')?.callback();
		const modal = SuggestModal.instances.at(-1) as VaultPathSuggestModal | undefined;
		if (!modal) throw new Error('Expected modal to open');

		const parentSuggestion = (await Promise.resolve(modal.getSuggestions('..'))).find((entry) => entry.isParent);
		expect(parentSuggestion).toBeDefined();
		if (!parentSuggestion) throw new Error('Expected parent suggestion');
		modal.onChooseSuggestion(parentSuggestion);
		expect(modal.currentLocation.absPath).toBe('C:/ObsidianVault');
		expect(Notice.messages.at(-1)).toBe(
			'Blocked by the “Browse outside vault” setting. Change it in File Palette settings.',
		);
		expect(Notice.durations.at(-1)).toBe(8000);

		modal.inputEl.value = '';
		modal.inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
		expect(modal.currentLocation.absPath).toBe('C:/ObsidianVault');
		expect(Notice.messages.at(-1)).toBe(
			'Blocked by the “Browse outside vault” setting. Change it in File Palette settings.',
		);
		expect(Notice.durations.at(-1)).toBe(8000);
	});

	it('does not navigate into an external folder from a stale suggestion when browsing is disabled', () => {
		plugin.settings.browseOutsideVault = false;
		const modal = new VaultPathSuggestModal(app, tempDir, true, ['title'], false, false, false);
		modal.open();
		const entry = {
			file: null,
			isParent: false,
			name: 'outside-doc.md',
			isFolder: false,
			absPath: norm(join(tempDir, 'outside-doc.md')),
		};

		modal.onChooseSuggestion(entry);

		expect(modal.currentLocation.inVault).toBe(true);
		expect(openedDefaultAppPaths).toEqual([]);
		expect(Notice.messages).toContain(
			'Blocked by the “Browse outside vault” setting. Change it in File Palette settings.',
		);
		expect(Notice.durations.at(-1)).toBe(8000);
	});

	it('blocks external open, copy-link, and system actions when browsing is disabled', () => {
		plugin.settings.browseOutsideVault = false;
		const modal = new VaultPathSuggestModal(app, tempDir, true, ['title'], false, false, false);
		modal.open();
		const absPath = norm(join(tempDir, 'outside-doc.md'));
		const externalFile = app.vault.getFileByPath(`file:${absPath}`);
		if (!(externalFile instanceof TExternalFile)) throw new Error('Expected external file');
		const entry = {
			file: externalFile,
			isParent: false,
			name: 'outside-doc.md',
			isFolder: false,
			absPath,
		};
		const element = document.createElement('div');
		element.addClass('suggestion-item');
		element.addClass('is-selected');
		modal.renderSuggestion(entry, element);
		modal.resultContainerEl.appendChild(element);

		modal.inputEl.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }),
		);
		modal.inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true }));
		modal.inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: '*', bubbles: true, cancelable: true }));
		modal.inputEl.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'L', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }),
		);

		expect(openedFiles).toEqual([]);
		expect(openedDefaultAppPaths).toEqual([]);
		expect(shownPaths).toEqual([]);
		expect(Notice.messages).toHaveLength(4);
		expect(Notice.durations.slice(-4)).toEqual([8000, 8000, 8000, 8000]);
	});

	it('lists external files from disk', async () => {
		plugin.commands.find(({ id }) => id === 'open-palette')?.callback();
		const modal = SuggestModal.instances.at(-1);
		if (!modal) throw new Error('Expected modal to open');

		const suggestions = await Promise.resolve(modal.getSuggestions(''));
		const names = suggestions.map((s) => s.name);
		expect(names).toContain('outside-doc.md');
		expect(names).toContain('readme.txt');
	});

	it('dims disabled actions in footer hints for external folders', () => {
		plugin.commands.find(({ id }) => id === 'open-palette')?.callback();
		const modal = SuggestModal.instances.at(-1);
		if (!modal) throw new Error('Expected modal to open');

		const disabledHints = Array.from(modal.modalEl.querySelectorAll('.fp-hint.is-disabled'));
		const commands = disabledHints.map((el) => el.querySelector('.fp-hint-key')?.textContent);
		expect(commands).toContain(':');
		expect(commands.some((c) => c?.includes('↵'))).toBe(true);
		expect(commands.some((c) => c?.includes('L'))).toBe(true);
	});

	it('shows a notice that sidebar only shows vault files when colon operator is pressed', async () => {
		plugin.commands.find(({ id }) => id === 'open-palette')?.callback();
		const modal = SuggestModal.instances.at(-1);
		if (!modal) throw new Error('Expected modal to open');

		const suggestions = await Promise.resolve(modal.getSuggestions(''));
		const entry = suggestions.find((s) => s.name === 'outside-doc.md');
		if (!entry) throw new Error('Expected outside-doc.md');

		const element = document.createElement('div');
		element.addClass('suggestion-item');
		element.addClass('is-selected');
		modal.renderSuggestion(entry, element);
		modal.resultContainerEl.appendChild(element);

		modal.inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: ':', bubbles: true, cancelable: true }));
		expect(Notice.messages).toContain('The sidebar only shows vault files.');
	});

	it('explains how to enable outside-vault file creation when Shift+Enter is disabled', async () => {
		plugin.commands.find(({ id }) => id === 'open-palette')?.callback();
		const modal = SuggestModal.instances.at(-1);
		if (!modal) throw new Error('Expected modal to open');

		modal.inputEl.value = 'new-outside-file';
		modal.inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));

		expect(Notice.messages).toContain(
			'Blocked by the “Allow creating files outside vault” setting. Change it in File Palette settings.',
		);
		expect(Notice.durations.at(-1)).toBe(8000);
	});

	it('allows creating files outside vault when allowCreateOutsideVault setting is enabled', async () => {
		plugin.settings.allowCreateOutsideVault = true;
		plugin.commands.find(({ id }) => id === 'open-palette')?.callback();
		const modal = SuggestModal.instances.at(-1);
		if (!modal) throw new Error('Expected modal to open');

		modal.inputEl.value = 'new-created-outside';
		modal.inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));

		await vi.waitFor(() => {
			const createdPath = join(tempDir, 'new-created-outside.md');
			expect(readFileSync(createdPath, 'utf8')).toBe('');
			expect(openedFiles.length).toBe(1);
		});
	});

	it('copies a file:/// URI link with Ctrl+Shift+L when outside the vault', async () => {
		const clipboardWrite = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal('navigator', { clipboard: { writeText: clipboardWrite } });

		plugin.commands.find(({ id }) => id === 'open-palette')?.callback();
		const modal = SuggestModal.instances.at(-1);
		if (!modal) throw new Error('Expected modal to open');

		const suggestions = await Promise.resolve(modal.getSuggestions(''));
		const entry = suggestions.find((s) => s.name === 'outside-doc.md');
		if (!entry) throw new Error('Expected outside-doc.md');

		const element = document.createElement('div');
		element.addClass('suggestion-item');
		element.addClass('is-selected');
		modal.renderSuggestion(entry, element);
		modal.resultContainerEl.appendChild(element);

		const event = new KeyboardEvent('keydown', {
			key: 'L',
			ctrlKey: true,
			shiftKey: true,
			bubbles: true,
			cancelable: true,
		});
		modal.inputEl.dispatchEvent(event);

		const expectedLink = generateExternalMarkdownLink(norm(join(tempDir, 'outside-doc.md')), false);
		await vi.waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith(expectedLink));
		await vi.waitFor(() => expect(Notice.messages).toContain('Link copied to clipboard.'));
	});

	it('copies a folder link with Ctrl+Shift+L when outside the vault', async () => {
		mkdirSync(join(tempDir, 'outside-folder'));
		const clipboardWrite = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal('navigator', { clipboard: { writeText: clipboardWrite } });

		plugin.commands.find(({ id }) => id === 'open-palette')?.callback();
		const modal = SuggestModal.instances.at(-1);
		if (!modal) throw new Error('Expected modal to open');

		const suggestions = await Promise.resolve(modal.getSuggestions(''));
		const entry = suggestions.find((s) => s.name === 'outside-folder');
		if (!entry) throw new Error('Expected outside-folder');

		const element = document.createElement('div');
		element.addClass('suggestion-item');
		element.addClass('is-selected');
		modal.renderSuggestion(entry, element);
		modal.resultContainerEl.appendChild(element);

		const event = new KeyboardEvent('keydown', {
			key: 'L',
			ctrlKey: true,
			shiftKey: true,
			bubbles: true,
			cancelable: true,
		});
		modal.inputEl.dispatchEvent(event);

		const expectedLink = generateExternalMarkdownLink(norm(join(tempDir, 'outside-folder')), true);
		await vi.waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith(expectedLink));
		await vi.waitFor(() => expect(Notice.messages).toContain('Link copied to clipboard.'));
	});

	it('returns to vault root and removes .palette-external when query starts with caret', async () => {
		plugin.commands.find(({ id }) => id === 'open-palette')?.callback();
		const modal = SuggestModal.instances.at(-1);
		if (!modal) throw new Error('Expected modal to open');

		expect(modal.modalEl.classList.contains('palette-external')).toBe(true);

		modal.inputEl.value = '^';
		modal.inputEl.dispatchEvent(new Event('input', { bubbles: true }));

		expect(modal.modalEl.classList.contains('palette-external')).toBe(false);
		const pathEl = modal.modalEl.querySelector('.fp-path');
		expect(pathEl?.classList.contains('file-palette-outside')).toBe(false);
		const indicator = modal.modalEl.querySelector('.fp-external-indicator');
		expect(indicator?.getAttribute('data-icon')).toBe('vault');
	});

	it('stays in vault when browseOutsideVault is disabled', async () => {
		plugin.settings.browseOutsideVault = false;
		plugin.commands.find(({ id }) => id === 'open-palette')?.callback();
		const modal = SuggestModal.instances.at(-1);
		if (!modal) throw new Error('Expected modal to open');

		expect(modal.modalEl.classList.contains('palette-external')).toBe(false);
		const pathEl = modal.modalEl.querySelector('.fp-path');
		expect(pathEl?.textContent).toBe('/');
	});

	it('handles ? and * operators on external files', async () => {
		plugin.commands.find(({ id }) => id === 'open-palette')?.callback();
		const modal = SuggestModal.instances.at(-1);
		if (!modal) throw new Error('Expected modal to open');

		const suggestions = await Promise.resolve(modal.getSuggestions(''));
		const entry = suggestions.find((s) => s.name === 'outside-doc.md');
		if (!entry) throw new Error('Expected outside-doc.md');

		const element = document.createElement('div');
		element.addClass('suggestion-item');
		element.addClass('is-selected');
		modal.renderSuggestion(entry, element);
		modal.resultContainerEl.appendChild(element);

		modal.inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true }));
		const expectedOsPath = norm(join(tempDir, 'outside-doc.md')).replace(/\//g, '\\');
		expect(shownPaths).toEqual([expectedOsPath]);

		// Reopen and test *
		plugin.commands.find(({ id }) => id === 'open-palette')?.callback();
		const modal2 = SuggestModal.instances.at(-1);
		if (!modal2) throw new Error('Expected modal2 to open');

		const element2 = document.createElement('div');
		element2.addClass('suggestion-item');
		element2.addClass('is-selected');
		modal2.renderSuggestion(entry, element2);
		modal2.resultContainerEl.appendChild(element2);

		modal2.inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: '*', bubbles: true, cancelable: true }));
		expect(openedDefaultAppPaths).toEqual([expectedOsPath]);
	});

	it('splits locations into breadcrumb segments correctly across vault, Windows, and POSIX', () => {
		// Vault root
		expect(splitLocationPath({ absPath: 'C:/Vault', inVault: true, vaultRelPath: '/' })).toEqual([
			{ name: '/', path: '/', isRoot: true },
		]);

		// Vault subfolders
		expect(splitLocationPath({ absPath: 'C:/Vault/Finance/Projects', inVault: true, vaultRelPath: '/Finance/Projects' })).toEqual([
			{ name: '/', path: '/', isRoot: true },
			{ name: 'Finance', path: '/Finance', isRoot: false },
			{ name: 'Projects', path: '/Finance/Projects', isRoot: false },
		]);

		// Windows path with backslashes
		expect(splitLocationPath({ absPath: 'C:\\Users\\scott\\repos\\docs', inVault: false, vaultRelPath: null })).toEqual([
			{ name: 'C:', path: 'C:/', isRoot: true },
			{ name: 'Users', path: 'C:/Users', isRoot: false },
			{ name: 'scott', path: 'C:/Users/scott', isRoot: false },
			{ name: 'repos', path: 'C:/Users/scott/repos', isRoot: false },
			{ name: 'docs', path: 'C:/Users/scott/repos/docs', isRoot: false },
		]);

		// Windows UNC path
		expect(splitLocationPath({ absPath: '\\\\server\\share\\docs\\sub', inVault: false, vaultRelPath: null })).toEqual([
			{ name: '//server/share', path: '//server/share', isRoot: true },
			{ name: 'docs', path: '//server/share/docs', isRoot: false },
			{ name: 'sub', path: '//server/share/docs/sub', isRoot: false },
		]);

		// POSIX path
		expect(splitLocationPath({ absPath: '/home/scott/docs', inVault: false, vaultRelPath: null })).toEqual([
			{ name: '/', path: '/', isRoot: true },
			{ name: 'home', path: '/home', isRoot: false },
			{ name: 'scott', path: '/home/scott', isRoot: false },
			{ name: 'docs', path: '/home/scott/docs', isRoot: false },
		]);
	});

	it('navigates when clicking the path icon, root, or parent segment', async () => {
		plugin.commands.find(({ id }) => id === 'open-palette')?.callback();
		const modal = SuggestModal.instances.at(-1);
		if (!modal) throw new Error('Expected modal to open');

		const pathEl = modal.modalEl.querySelector('.fp-path');
		if (!pathEl) throw new Error('Expected path element');

		// Check external icon is home if under home, or hard-drive if not
		const iconEl = pathEl.querySelector<HTMLElement>('.fp-path-icon');
		const isUnderHome = norm(tempDir).toLowerCase().startsWith(norm(tmpdir()).toLowerCase() + '/');
		expect(iconEl?.getAttribute('data-icon')).toBe(isUnderHome ? 'home' : 'hard-drive');

		// Click parent segment (the second segment)
		const segments = Array.from(pathEl.querySelectorAll<HTMLElement>('.fp-path-segment'));
		expect(segments.length).toBeGreaterThan(1);

		// Click the root segment
		const rootEl = pathEl.querySelector<HTMLElement>('.fp-path-root');
		expect(rootEl).not.toBeNull();
		rootEl?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

		// Clicking closes current modal and opens next at root
		await vi.waitFor(() => {
			const latestModal = SuggestModal.instances.at(-1);
			expect(latestModal).not.toBeNull();
		});
	});
});

describe('home directory resolution, shortcuts, and Location model', () => {
	let app: App;
	let root: TFolder;

	beforeEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		Notice.messages.length = 0;
		Platform.isDesktopApp = true;
		Platform.isMobile = false;
		Platform.isWin = true;

		root = new TFolder('', '');
		app = {
			vault: {
				adapter: new FileSystemAdapter('C:/TestVault'),
				getRoot: () => root,
				getAbstractFileByPath: () => null,
				getFileByPath: () => null,
				create: vi.fn(),
			},
			workspace: {
				getActiveFile: () => null,
				getLeaf: () => ({ openFile: vi.fn() }),
				getLeavesOfType: () => [],
			},
			metadataCache: { getFileCache: () => null },
			fileManager: { generateMarkdownLink: vi.fn() },
		} as unknown as App;
	});

	it('resolveHome returns null when not on desktop', () => {
		Platform.isDesktopApp = false;
		expect(resolveHome()).toBeNull();
	});

	it('resolveHome uses os.homedir() and normalizes with forward slashes', () => {
		const home = resolveHome();
		expect(home).not.toBeNull();
		expect(home).not.toContain('\\');
		expect(home?.startsWith('/') || /^[a-zA-Z]:\//.test(home ?? '')).toBe(true);
	});

	it('resolveHome falls back to os.userInfo().homedir if os.homedir() returns empty or throws', () => {
		const os = require('os');
		const spyHomedir = vi.spyOn(os, 'homedir').mockImplementation(() => '');
		const spyUserInfo = vi.spyOn(os, 'userInfo').mockReturnValue({ homedir: tmpdir() } as any);

		const resolved = resolveHome();
		expect(resolved).toBe(norm(tmpdir()));
		expect(spyUserInfo).toHaveBeenCalled();

		spyHomedir.mockRestore();
		spyUserInfo.mockRestore();
	});

	it('resolveHome returns null if path is not absolute or does not exist', () => {
		const os = require('os');
		const spyHomedir = vi.spyOn(os, 'homedir').mockReturnValue('relative/path/to/home');

		expect(resolveHome()).toBeNull();

		spyHomedir.mockReturnValue('C:/NonExistentPathThatDoesNotExist_123456');
		expect(resolveHome()).toBeNull();

		spyHomedir.mockRestore();
	});

	it('caches resolveHome per palette open', () => {
		const modal = new VaultPathSuggestModal(app, 'C:/TestVault');
		const home1 = modal.resolveHome();
		const home2 = modal.resolveHome();
		expect(home1).toBe(home2);
	});

	it('~ alone completes to ~/ and previews the user home directory', () => {
		const modal = new VaultPathSuggestModal(app, 'C:/TestVault', true, ['title'], false, true);
		modal.open();

		modal.inputEl.value = '~';
		modal.inputEl.dispatchEvent(new Event('input', { bubbles: true }));

		const home = resolveHome();
		expect(modal.inputEl.value).toBe('~/');
		expect(modal.modalEl.querySelector('.fp-path')?.getAttribute('title')).toBe(home);
		const indicator = modal.modalEl.querySelector('.fp-external-indicator');
		expect(indicator?.getAttribute('data-icon')).toBe('home');
	});

	it('~/ previews the home directory and keeps the typed query', () => {
		const modal = new VaultPathSuggestModal(app, 'C:/TestVault', true, ['title'], false, true);
		modal.open();

		modal.inputEl.value = '~/';
		modal.inputEl.dispatchEvent(new Event('input', { bubbles: true }));

		expect(modal.inputEl.value).toBe('~/');
		expect(modal.modalEl.querySelector('.fp-path')?.getAttribute('title')).toBe(resolveHome());
	});

	it('typing ~ then / keeps one slash and previews home instead of jumping to the OS root', () => {
		const modal = new VaultPathSuggestModal(app, 'C:/TestVault', true, ['title'], false, true);
		modal.open();
		const home = resolveHome();
		const displayedPath = () => modal.modalEl.querySelector('.fp-path')?.getAttribute('title');
		const keystroke = (char: string) => {
			modal.inputEl.value += char;
			modal.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
		};

		keystroke('~');
		expect(modal.inputEl.value).toBe('~/');
		expect(displayedPath()).toBe(home);

		keystroke('/');
		expect(modal.inputEl.value).toBe('~/');
		expect(displayedPath()).toBe(home);

		keystroke('D');
		expect(modal.inputEl.value).toBe('~/D');
		expect(displayedPath()).toBe(home);
		expect(modal.currentLocation.absPath).toBe('C:/TestVault');
	});

	it('repeated slashes right after a completed prefix collapse to a single slash', () => {
		const modal = new VaultPathSuggestModal(app, 'C:/TestVault', true, ['title'], false, true);
		modal.open();
		const keystroke = (char: string) => {
			modal.inputEl.value += char;
			modal.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
		};

		keystroke('^');
		keystroke('/');
		keystroke('/');
		expect(modal.inputEl.value).toBe('^/');
	});

	it('does not complete a prefix that is not typed alone', () => {
		const modal = new VaultPathSuggestModal(app, 'C:/TestVault', true, ['title'], false, true);
		modal.open();
		const keystroke = (char: string) => {
			modal.inputEl.value += char;
			modal.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
		};

		keystroke('a');
		keystroke('~');
		expect(modal.inputEl.value).toBe('a~');

		keystroke('^');
		expect(modal.inputEl.value).toBe('a~^');
	});

	it('does not re-complete a prefix after the user deletes the slash', () => {
		const modal = new VaultPathSuggestModal(app, 'C:/TestVault', true, ['title'], false, true);
		modal.open();
		const keystroke = (char: string) => {
			modal.inputEl.value += char;
			modal.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
		};
		const backspace = () => {
			modal.inputEl.value = modal.inputEl.value.slice(0, -1);
			modal.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
		};

		keystroke('~');
		expect(modal.inputEl.value).toBe('~/');
		backspace();
		expect(modal.inputEl.value).toBe('~');
	});

	it('typing ~\\ treats the backslash as a path separator on Windows', () => {
		const modal = new VaultPathSuggestModal(app, 'C:/TestVault', true, ['title'], false, true);
		modal.open();

		modal.inputEl.value = '~\\';
		modal.inputEl.dispatchEvent(new Event('input', { bubbles: true }));

		expect(modal.inputEl.value).toBe('~\\');
		expect(modal.modalEl.querySelector('.fp-path')?.getAttribute('title')).toBe(resolveHome());
	});

	it('~name without slash is treated as ordinary search text, not user home', () => {
		const modal = new VaultPathSuggestModal(app, 'C:/TestVault');
		modal.open();

		modal.inputEl.value = '~otheruser';
		modal.inputEl.dispatchEvent(new Event('input', { bubbles: true }));

		expect(modal.currentLocation.absPath).toBe('C:/TestVault');
		expect(modal.modalEl.querySelector('.fp-path')?.getAttribute('title')).toBe('/');
	});

	it('^ alone completes to ^/ and previews the vault top', () => {
		const modal = new VaultPathSuggestModal(app, 'C:/Some/Other/Path');
		modal.open();

		modal.inputEl.value = '^';
		modal.inputEl.dispatchEvent(new Event('input', { bubbles: true }));

		expect(modal.inputEl.value).toBe('^/');
		expect(modal.modalEl.querySelector('.fp-path')?.getAttribute('title')).toBe('/');
		const indicator = modal.modalEl.querySelector('.fp-external-indicator');
		expect(indicator?.getAttribute('data-icon')).toBe('vault');
	});

	it('^/ previews the vault root and keeps the typed query', () => {
		const modal = new VaultPathSuggestModal(app, 'C:/Some/Other/Path');
		modal.open();

		modal.inputEl.value = '^/';
		modal.inputEl.dispatchEvent(new Event('input', { bubbles: true }));

		expect(modal.inputEl.value).toBe('^/');
		expect(modal.modalEl.querySelector('.fp-path')?.getAttribute('title')).toBe('/');
	});


	it('^name without slash is treated as ordinary search text', () => {
		const modal = new VaultPathSuggestModal(app, 'C:/Some/Other/Path', true, ['title'], false, true);
		modal.open();

		modal.inputEl.value = '^searchterm';
		modal.inputEl.dispatchEvent(new Event('input', { bubbles: true }));

		expect(modal.currentLocation.absPath).toBe('C:/Some/Other/Path');
	});

	it('typing a drive prefix works instead of triggering the colon operator', () => {
		const modal = new VaultPathSuggestModal(app, 'C:/TestVault', true, ['title'], false, true);
		modal.open();
		modal.inputEl.value = 'C';
		const colonEvent = new KeyboardEvent('keydown', { key: ':', bubbles: true, cancelable: true });
		modal.inputEl.dispatchEvent(colonEvent);
		expect(colonEvent.defaultPrevented).toBe(false);

		modal.inputEl.value = 'C:/';
		modal.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
		expect(modal.modalEl.querySelector('.fp-path')?.getAttribute('title')).toBe('C:/');

		modal.inputEl.value = 'Notes';
		const revealEvent = new KeyboardEvent('keydown', { key: ':', bubbles: true, cancelable: true });
		modal.inputEl.dispatchEvent(revealEvent);
		expect(revealEvent.defaultPrevented).toBe(true);
	});

	it('a typed drive query previews that drive root', () => {
		const modal = new VaultPathSuggestModal(app, 'C:/TestVault', true, ['title'], false, true);
		modal.open();

		modal.inputEl.value = 'D:/';
		modal.inputEl.dispatchEvent(new Event('input', { bubbles: true }));

		expect(modal.modalEl.querySelector('.fp-path')?.getAttribute('title')).toBe('D:/');
	});

	it('/ previews the vault top inside the vault, but the OS root outside', () => {
		// Inside vault
		const inVaultModal = new VaultPathSuggestModal(app, 'C:/TestVault');
		inVaultModal.open();
		inVaultModal.inputEl.value = '/';
		inVaultModal.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
		expect(inVaultModal.modalEl.querySelector('.fp-path')?.getAttribute('title')).toBe('/');

		// Outside vault on Windows
		const outsideModal = new VaultPathSuggestModal(app, 'C:/Users/scott/repos', true, ['title'], false, true);
		outsideModal.open();
		outsideModal.inputEl.value = '/';
		outsideModal.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
		expect(outsideModal.modalEl.querySelector('.fp-path')?.getAttribute('title')).toBe('C:/');
	});

	it('getSystemRootLocation resolves drive root or filesystem root correctly', () => {
		expect(getSystemRootLocation(app, { absPath: 'C:/Users/scott' }).absPath).toBe('C:/');
		expect(getSystemRootLocation(app, { absPath: 'D:/Projects/foo' }).absPath).toBe('D:/');
		expect(getSystemRootLocation(app, { absPath: '/var/log/nginx' }).absPath).toBe('/');
		expect(getSystemRootLocation(app, { absPath: '//server/share/docs' }).absPath).toBe('//server/share');
	});

	it('mobile hides ~ in footer and treats ~ as literal text', () => {
		Platform.isMobile = true;
		const modal = new VaultPathSuggestModal(app, 'C:/TestVault');
		modal.open();

		const footerText = modal.modalEl.querySelector('.fp-footer')?.textContent ?? '';
		expect(footerText).not.toContain('~');
		expect(footerText).toContain('^');

		// Typing ~ on mobile stays put and searches literally; it is not a home shortcut.
		modal.inputEl.value = '~';
		modal.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
		expect(modal.inputEl.value).toBe('~');
		expect(modal.modalEl.querySelector('.fp-path')?.getAttribute('title')).toBe('/');
		expect(modal.getSuggestions('~')).toEqual([]);
	});

	it('Location abstraction provides canCreate, canLink, canReveal, list, and parent', async () => {
		const vaultLoc = makeLocation(app, 'C:/TestVault');
		expect(vaultLoc.canCreate).toBe(true);
		expect(vaultLoc.canLink).toBe(true);
		expect(vaultLoc.canReveal).toBe(true);
		expect(vaultLoc.inVault).toBe(true);

		const extLoc = makeLocation(app, 'C:/External');
		expect(extLoc.canCreate).toBe(false);
		expect(extLoc.canLink).toBe(false);
		expect(extLoc.canReveal).toBe(false);
		expect(extLoc.inVault).toBe(false);
		expect(await extLoc.list()).toEqual([]);
		expect(extLoc.parent()).toBeNull();
		expect(makeLocation(app, 'C:/External', { allowCreateOutsideVault: true }).canCreate).toBe(false);

		const extLocAllowed = makeLocation(app, 'C:/External', {
			browseOutsideVault: true,
			allowCreateOutsideVault: true,
		});
		expect(extLocAllowed.canCreate).toBe(true);
		expect(extLocAllowed.canLink).toBe(true);

		const parentLoc = extLocAllowed.parent();
		expect(parentLoc?.absPath).toBe('C:/');
		expect(parentLoc?.parent()).toBeNull();
	});

	it('stops at drive root on Windows and does not navigate past it', () => {
		expect(getParentPath('C:/')).toBe('C:');
		expect(getParentPath('C:')).toBe('C:');
		const driveRootLoc = makeLocation(app, 'C:/');
		expect(driveRootLoc.parent()).toBeNull();
	});
});

describe('generateExternalMarkdownLink formatting', () => {
	it('formats markdown files with .md stripped from title', () => {
		expect(generateExternalMarkdownLink('C:/Notes/Meeting.md')).toBe('[Meeting](file:///C:/Notes/Meeting.md)');
		expect(generateExternalMarkdownLink('/Users/scott/Docs/Note.MD')).toBe('[Note](file:///Users/scott/Docs/Note.MD)');
	});

	it('preserves extensions in title for non-markdown files', () => {
		expect(generateExternalMarkdownLink('C:/Docs/Annual Report.pdf')).toBe('[Annual Report.pdf](file:///C:/Docs/Annual%20Report.pdf)');
		expect(generateExternalMarkdownLink('C:/Data/records.csv')).toBe('[records.csv](file:///C:/Data/records.csv)');
	});

	it('prepends exclamation mark for image files', () => {
		expect(generateExternalMarkdownLink('C:/Images/diagram.png')).toBe('![diagram.png](file:///C:/Images/diagram.png)');
		expect(generateExternalMarkdownLink('C:/Images/photo.JPG')).toBe('![photo.JPG](file:///C:/Images/photo.JPG)');
		expect(generateExternalMarkdownLink('C:/Images/vector.svg')).toBe('![vector.svg](file:///C:/Images/vector.svg)');
	});

	it('formats folder links using the folder name as title even if it contains dots', () => {
		expect(generateExternalMarkdownLink('C:/Projects/My Folder', true)).toBe('[My Folder](file:///C:/Projects/My%20Folder)');
		expect(generateExternalMarkdownLink('C:/Projects/v1.0.release', true)).toBe('[v1.0.release](file:///C:/Projects/v1.0.release)');
		expect(generateExternalMarkdownLink('/var/log/nginx', true)).toBe('[nginx](file:///var/log/nginx)');
	});

	it('handles root locations', () => {
		expect(generateExternalMarkdownLink('C:/', true)).toBe('[C:](file:///C:/)');
		expect(generateExternalMarkdownLink('/', true)).toBe('[/](file:///)');
	});

	it('handles UNC paths', () => {
		expect(generateExternalMarkdownLink('//server/share/docs/report.pdf')).toBe('[report.pdf](file://server/share/docs/report.pdf)');
	});
});

describe('F2 rename in the palette', () => {
	let tempDir: string;
	let app: App;
	let plugin: FilePalettePlugin & {
		commands: { id: string; callback: () => void }[];
	};
	let root: TFolder;
	let renamed: [unknown, string][];

	const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

	const openPalette = (): VaultPathSuggestModal => {
		plugin.commands.find(({ id }) => id === 'open-palette')?.callback();
		const modal = SuggestModal.instances.at(-1) as VaultPathSuggestModal | undefined;
		if (!modal) throw new Error('Expected modal to open');
		return modal;
	};

	const selectEntry = (modal: VaultPathSuggestModal, entry: unknown): void => {
		const element = document.createElement('div');
		element.addClass('suggestion-item');
		element.addClass('is-selected');
		modal.renderSuggestion(entry as never, element);
		modal.resultContainerEl.appendChild(element);
	};

	const findVaultEntry = async (modal: VaultPathSuggestModal, name: string) => {
		const entries = await Promise.resolve(modal.getSuggestions(''));
		const entry = entries.find((candidate) => candidate.file?.name === name);
		if (!entry) throw new Error(`Expected entry ${name}`);
		return entry;
	};

	const pressF2 = (modal: VaultPathSuggestModal): void => {
		modal.inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true }));
	};

	const renameModal = (): HTMLElement => {
		const modal = Modal.instances.at(-1);
		const input = modal?.contentEl.querySelector('.fp-rename-input');
		if (!modal || !input) throw new Error('Expected rename modal');
		return modal.contentEl as HTMLElement;
	};

	const submitRename = (value: string): void => {
		const input = renameModal().querySelector<HTMLInputElement>('.fp-rename-input');
		if (!input) throw new Error('Expected rename input');
		input.value = value;
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
	};

	beforeEach(async () => {
		vi.restoreAllMocks();
		SuggestModal.instances.length = 0;
		Modal.instances.length = 0;
		Notice.messages.length = 0;
		Notice.durations.length = 0;
		renamed = [];
		Platform.isDesktopApp = true;
		Platform.isWin = true;
		Platform.isMobile = false;

		tempDir = mkdtempSync(join(tmpdir(), 'palette-rename-'));
		writeFileSync(join(tempDir, 'readme.txt'), 'hello\n');
		mkdirSync(join(tempDir, 'sub'));

		root = new TFolder('', '');
		addFile(root, 'note.md');
		addFolder(root, 'Projects');
		const taken = new TFile('taken.md', 'taken.md');

		app = {
			vault: {
				adapter: new FileSystemAdapter('C:/ObsidianVault'),
				getRoot: () => root,
				getAbstractFileByPath: (path: string) => {
					if (path === 'taken.md') return taken;
					return root.children.find((child) => child.path === path) ?? null;
				},
				getFileByPath: () => null,
				create: vi.fn(),
			},
			workspace: {
				getActiveFile: () => null,
				getLeaf: () => ({ openFile: vi.fn(() => Promise.resolve()) }),
				getLeavesOfType: () => [],
			},
			metadataCache: {
				getFileCache: () => null,
			},
			fileManager: {
				generateMarkdownLink: vi.fn(),
				renameFile: vi.fn((file: unknown, path: string) => {
					renamed.push([file, path]);
					return Promise.resolve();
				}),
			},
		} as unknown as App;

		plugin = new FilePalettePlugin(app, {} as never) as typeof plugin;
		await plugin.onload();
	});

	afterEach(() => {
		VaultPathSuggestModal.closeActiveModal();
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	});

	it('renames a vault file with fileManager and keeps the extension unselected', async () => {
		const modal = openPalette();
		selectEntry(modal, await findVaultEntry(modal, 'note.md'));
		pressF2(modal);

		const input = renameModal().querySelector<HTMLInputElement>('.fp-rename-input');
		expect(input?.value).toBe('note.md');
		expect(input?.selectionStart).toBe(0);
		expect(input?.selectionEnd).toBe(4);

		submitRename('renamed.md');
		await flush();
		expect(renamed).toEqual([[root.children.find((child) => child.name === 'note.md'), 'renamed.md']]);
	});

	it('renames a vault folder with fileManager', async () => {
		const modal = openPalette();
		const folder = root.children.find((child) => child.name === 'Projects');
		const entry = {
			file: folder,
			isParent: false,
			name: 'Projects',
			isFolder: true,
			absPath: 'C:/ObsidianVault/Projects',
		};
		selectEntry(modal, entry);
		pressF2(modal);

		const input = renameModal().querySelector<HTMLInputElement>('.fp-rename-input');
		expect(input?.selectionEnd).toBe('Projects'.length);

		submitRename('Archive');
		await flush();
		expect(renamed).toEqual([[folder, 'Archive']]);
	});

	it('shows a validation error and keeps the modal open for invalid names', async () => {
		const modal = openPalette();
		selectEntry(modal, await findVaultEntry(modal, 'note.md'));
		pressF2(modal);

		submitRename('bad/name');
		await flush();
		expect(renamed).toEqual([]);
		expect(renameModal().querySelector('.fp-rename-error')?.textContent).toContain('Names cannot contain');
	});

	it('blocks renaming onto an existing vault path', async () => {
		const modal = openPalette();
		selectEntry(modal, await findVaultEntry(modal, 'note.md'));
		pressF2(modal);

		submitRename('taken.md');
		await flush();
		expect(renamed).toEqual([]);
		expect(Notice.messages.at(-1)).toBe('“taken.md” already exists here.');
	});

	it('does nothing when the name is unchanged', async () => {
		const modal = openPalette();
		selectEntry(modal, await findVaultEntry(modal, 'note.md'));
		pressF2(modal);

		submitRename('note.md');
		await flush();
		expect(renamed).toEqual([]);
	});

	it('does not open a rename dialog for the parent entry', async () => {
		const modal = openPalette();
		const parent = { file: null, isParent: true };
		selectEntry(modal, parent);
		const before = Modal.instances.length;
		pressF2(modal);

		expect(Modal.instances.length).toBe(before);
		expect(Notice.messages.at(-1)).toBe('Select a file or folder to rename.');
	});

	describe('outside the vault', () => {
		const externalFileEntry = () => {
			const real = join(tempDir, 'readme.txt');
			return {
				file: new TExternalFile('readme.txt', 'readme.txt', real),
				isParent: false,
				name: 'readme.txt',
				isFolder: false,
				absPath: norm(real),
			};
		};

		it('renames an external file on disk when both outside-vault settings allow it', async () => {
			plugin.settings.browseOutsideVault = true;
			plugin.settings.allowCreateOutsideVault = true;
			const modal = openPalette();
			selectEntry(modal, externalFileEntry());
			pressF2(modal);

			submitRename('notes.txt');
			await flush();
			expect(existsSync(join(tempDir, 'readme.txt'))).toBe(false);
			expect(readFileSync(join(tempDir, 'notes.txt'), 'utf8')).toBe('hello\n');
			expect(renamed).toEqual([]);
		});

		it('renames an external folder on disk', async () => {
			plugin.settings.browseOutsideVault = true;
			plugin.settings.allowCreateOutsideVault = true;
			const modal = openPalette();
			selectEntry(modal, {
				file: null,
				isParent: false,
				name: 'sub',
				isFolder: true,
				absPath: norm(join(tempDir, 'sub')),
			});
			pressF2(modal);

			submitRename('moved');
			await flush();
			expect(existsSync(join(tempDir, 'sub'))).toBe(false);
			expect(existsSync(join(tempDir, 'moved'))).toBe(true);
		});

		it('blocks external renames when Allow creating files outside vault is off', async () => {
			plugin.settings.browseOutsideVault = true;
			plugin.settings.allowCreateOutsideVault = false;
			const modal = openPalette();
			selectEntry(modal, externalFileEntry());
			const before = Modal.instances.length;
			pressF2(modal);

			expect(Modal.instances.length).toBe(before);
			expect(Notice.messages.at(-1)).toBe(
				'Blocked by the “Allow creating files outside vault” setting. Change it in File Palette settings.',
			);
			expect(existsSync(join(tempDir, 'readme.txt'))).toBe(true);
		});

		it('blocks external renames when Browse outside vault is off', async () => {
			plugin.settings.browseOutsideVault = false;
			plugin.settings.allowCreateOutsideVault = true;
			const modal = openPalette();
			selectEntry(modal, externalFileEntry());
			const before = Modal.instances.length;
			pressF2(modal);

			expect(Modal.instances.length).toBe(before);
			expect(Notice.messages.at(-1)).toBe(
				'Blocked by the “Browse outside vault” setting. Change it in File Palette settings.',
			);
		});
	});
});

