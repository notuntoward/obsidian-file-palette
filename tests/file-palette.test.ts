// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FilePalettePlugin from '../src/main';
import * as ObsidianMock from './__mocks__/obsidian';
import { SuggestModal, TFile, TFolder } from './__mocks__/obsidian';
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
	let rootFile: TFile;
	let app: App;
	let workspace: {
		getActiveFile: () => { parent: TFolder; path: string };
		activeEditor?: { editor: Editor };
		getLeaf: () => { openFile: ReturnType<typeof vi.fn> };
	};
	let openedFiles: TFile[];
	let getFirstLinkpathDest: ReturnType<typeof vi.fn>;
	let plugin: FilePalettePlugin & { commands: { id: string; callback: () => void }[] };

	beforeEach(async () => {
		vi.restoreAllMocks();
		SuggestModal.instances.length = 0;
		root = new TFolder('', '');
		currentFolder = addFolder(root, 'current');
		rootFile = addFile(root, 'Root note.md');
		const nestedFolder = addFolder(currentFolder, 'Nested');
		addFile(nestedFolder, 'Needle note.md');

		const filesByPath = new Map([[rootFile.path, rootFile]]);
		openedFiles = [];
		const openFile = vi.fn((file: TFile) => {
			openedFiles.push(file);
		});
		getFirstLinkpathDest = vi.fn((_linkpath: string, _sourcePath: string) => null as TFile | null);
		workspace = {
			getActiveFile: () => ({ parent: currentFolder, path: 'current/source.md' }),
			activeEditor: undefined,
			getLeaf: () => ({ openFile }),
		};
		app = {
			vault: {
				getRoot: () => root,
				getAbstractFileByPath: (path: string) => filesByPath.get(path) ?? null,
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
		expect(modal?.instructions).toEqual([{ command: '~', purpose: 'Jump to vault root' }]);
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

	it('normalizes a selected wiki link before resolving it', () => {
		setEditor('', 0, ' [[Root note.md|display text]] ');

		runCommand('find-file-guessing');

		expect(openedFiles).toEqual([rootFile]);
		expect(SuggestModal.instances).toHaveLength(0);
	});
});
