// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import FilePalettePlugin from '../src/main';
import { SuggestModal, TFile, TFolder } from './__mocks__/obsidian';
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
	let rootFile: TFile;
	let plugin: FilePalettePlugin & { commands: { id: string; callback: () => void }[] };

	beforeEach(async () => {
		SuggestModal.instances.length = 0;
		root = new TFolder('', '');
		currentFolder = addFolder(root, 'current');
		rootFile = addFile(root, 'Root note.md');
		const nestedFolder = addFolder(currentFolder, 'Nested');
		addFile(nestedFolder, 'Needle note.md');

		const app = {
			vault: { getRoot: () => root },
			workspace: { getActiveFile: () => ({ parent: currentFolder }) },
		} as unknown as App;
		plugin = new FilePalettePlugin(app, {} as never) as FilePalettePlugin & {
			commands: { id: string; callback: () => void }[];
		};
		await plugin.onload();
	});

	it('shows the persistent path above the input and registers the root operator hint', () => {
		plugin.commands.find((command) => command.id === 'open-palette')?.callback();
		const modal = SuggestModal.instances.at(-1);
		expect(modal).toBeDefined();

		const path = modal?.modalEl.querySelector('.file-palette-current-path');
		expect(path?.textContent).toBe('Current folder: current');
		expect(path?.nextElementSibling).toBe(modal?.inputEl.parentElement);
		expect(modal?.instructions).toEqual([{ command: '~', purpose: 'Jump to vault root' }]);
	});

	it('uses the vault root for tilde queries and updates the displayed path', () => {
		plugin.commands.find((command) => command.id === 'open-palette')?.callback();
		const modal = SuggestModal.instances.at(-1);
		if (!modal) throw new Error('Expected the picker modal to open');

		modal.inputEl.value = '~';
		modal.inputEl.dispatchEvent(new Event('input', { bubbles: true }));

		expect(modal.modalEl.querySelector('.file-palette-current-path')?.textContent).toBe('Current folder: /');
		expect(modal.getSuggestions('~').some((entry) => entry.file === rootFile)).toBe(true);
	});

	it('resolves slash-separated folder queries relative to the starting folder', () => {
		plugin.commands.find((command) => command.id === 'open-palette')?.callback();
		const modal = SuggestModal.instances.at(-1);
		expect(modal?.getSuggestions('Nested/Needle').map((entry) => entry.file?.name)).toEqual(['Needle note.md']);
	});

	it('marks parent and file suggestions for compact row styling', () => {
		plugin.commands.find((command) => command.id === 'open-palette')?.callback();
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
		plugin.commands.find((command) => command.id === 'open-palette')?.callback();
		const modal = SuggestModal.instances.at(-1);
		if (!modal) throw new Error('Expected the picker modal to open');
		const path = modal.modalEl.querySelector('.file-palette-current-path');

		modal.close();

		expect(path?.isConnected).toBe(false);
	});
});
