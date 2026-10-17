// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FilePalettePlugin from '../src/main';
import * as ObsidianMock from './__mocks__/obsidian';
import { Notice, Platform, SuggestModal, TAbstractFile, TFile, TFolder } from './__mocks__/obsidian';
import type { App, Editor } from 'obsidian';

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
		activeEditor?: { editor: Editor };
		getLeaf: (newLeaf?: 'tab' | 'split' | 'window' | boolean) => { openFile: ReturnType<typeof vi.fn> };
		getLeavesOfType: () => { view: { revealInFolder: ReturnType<typeof vi.fn> } }[];
	};
	let openedFiles: TFile[];
	let revealedItems: TAbstractFile[];
	let shownPaths: string[];
	let openedDefaultAppPaths: string[];
	let getFirstLinkpathDest: ReturnType<typeof vi.fn>;
	let plugin: FilePalettePlugin & { commands: { id: string; callback: () => void }[] };

	beforeEach(async () => {
		vi.restoreAllMocks();
		SuggestModal.instances.length = 0;
		Notice.messages.length = 0;
		Platform.isMobile = false;
		root = new TFolder('', '');
		currentFolder = addFolder(root, 'current');
		rootFile = addFile(root, 'Root note.md');
		nestedFolder = addFolder(currentFolder, 'Nested');
		addFile(nestedFolder, 'Needle note.md');

		const filesByPath = new Map([[rootFile.path, rootFile]]);
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
		getFirstLinkpathDest = vi.fn((_linkpath: string, _sourcePath: string) => null as TFile | null);
		workspace = {
			getActiveFile: () => ({ parent: currentFolder, path: 'current/source.md' }),
			activeEditor: undefined,
			getLeaf,
			getLeavesOfType: () => [{ view: { revealInFolder } }],
		};
		app = {
			vault: {
				getRoot: () => root,
				getAbstractFileByPath: (path: string) => filesByPath.get(path) ?? null,
			},
			showInFolder: (path: string) => {
				shownPaths.push(path);
			},
			openWithDefaultApp: (path: string) => {
				openedDefaultAppPaths.push(path);
			},
			workspace,
			metadataCache: { getFirstLinkpathDest },
		} as unknown as App;
		plugin = new FilePalettePlugin(app, {} as never) as FilePalettePlugin & {
			commands: { id: string; callback: () => void }[];
		};
		await plugin.onload();
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

	function setEditor(line: string, cursor: number, selection = ''): void {
		workspace.activeEditor = {
			editor: {
				getSelection: () => selection,
				getCursor: () => ({ line: 0, ch: cursor }),
				getLine: () => line,
			} as unknown as Editor,
		};
	}

	it('shows the persistent path above the input and registers the root operator hint', () => {
		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1);
		expect(modal).toBeDefined();

		const path = modal?.modalEl.querySelector('.file-palette-current-path');
		expect(path?.textContent).toBe('Current folder: current');
		expect(path?.nextElementSibling).toBe(modal?.inputEl.parentElement);
		expect(modal?.instructions).toEqual([
			{ command: '~', purpose: 'Jump to vault root' },
			{ command: ':', purpose: 'Show in Obsidian file navigator' },
			{ command: '?', purpose: 'Show in System File Explorer' },
			{ command: '*', purpose: 'Open with system default app' },
			{ command: 'Mod+Shift+Enter', purpose: 'Open in new tab' },
			{ command: 'Mod+Alt+Enter', purpose: 'Open in new tab group' },
			{ command: 'Mod+Alt+Shift+Enter', purpose: 'Open in new window' },
		]);
	});

	it('uses the vault root for tilde queries and updates the displayed path', () => {
		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1);
		if (!modal) throw new Error('Expected the picker modal to open');

		modal.inputEl.value = '~';
		modal.inputEl.dispatchEvent(new Event('input', { bubbles: true }));

		expect(modal.modalEl.querySelector('.file-palette-current-path')?.textContent).toBe('Current folder: /');
		expect(modal.getSuggestions('~').some((entry) => entry.file === rootFile)).toBe(true);
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

	it('removes the path display when the modal closes', () => {
		runCommand('open-palette');
		const modal = SuggestModal.instances.at(-1);
		if (!modal) throw new Error('Expected the picker modal to open');
		const path = modal.modalEl.querySelector('.file-palette-current-path');

		modal.close();

		expect(path?.isConnected).toBe(false);
	});

	it('opens a directly resolved file from selected text without opening the picker', () => {
		setEditor('', 0, rootFile.path);

		runCommand('find-file-guessing');

		expect(openedFiles).toEqual([rootFile]);
		expect(getFirstLinkpathDest).not.toHaveBeenCalled();
		expect(SuggestModal.instances).toHaveLength(0);
	});

	it('resolves a wiki link at the cursor through Obsidian metadata cache', () => {
		const line = 'See [[Root note|display text]] here';
		setEditor(line, line.indexOf('Root note') + 2);
		getFirstLinkpathDest.mockReturnValue(rootFile);

		runCommand('find-file-guessing');

		expect(getFirstLinkpathDest).toHaveBeenCalledWith('Root note', 'current/source.md');
		expect(openedFiles).toEqual([rootFile]);
		expect(SuggestModal.instances).toHaveLength(0);
	});

	it('opens the picker with the cursor token when no file resolves', () => {
		const line = 'Find Needle near here';
		setEditor(line, line.indexOf('Needle') + 3);

		runCommand('find-file-guessing');

		expect(SuggestModal.instances.at(-1)?.inputEl.value).toBe('Needle');
		expect(openedFiles).toHaveLength(0);
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

	it('hides the new-window shortcut and reports it unavailable on mobile', () => {
		Platform.isMobile = true;
		const modal = highlightEntry(rootFile, '~/Root');

		expect(modal.instructions.some(({ purpose }) => purpose === 'Open in new window')).toBe(false);
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

	it('normalizes a selected wiki link before resolving it', () => {
		setEditor('', 0, ' [[Root note.md|display text]] ');

		runCommand('find-file-guessing');

		expect(openedFiles).toEqual([rootFile]);
		expect(SuggestModal.instances).toHaveLength(0);
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

	it('does not run an item operator when the parent suggestion is highlighted', () => {
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

		expect(revealedItems).toHaveLength(0);
		expect(shownPaths).toHaveLength(0);
		expect(openedDefaultAppPaths).toHaveLength(0);
	});
});
