import { App, Editor, Notice, Plugin, prepareFuzzySearch, SuggestModal, TAbstractFile, TFile, TFolder } from 'obsidian';

interface VaultEntry {
	file: TAbstractFile | null;
	isParent: boolean;
}

interface FileExplorerViewLike {
	revealInFolder?: (file: TAbstractFile) => void;
}

type AppWithShowInFolder = App & {
	showInFolder?: (path: string) => void | Promise<void>;
};

class VaultPathSuggestModal extends SuggestModal<VaultEntry> {
	private readonly parentEntry: VaultEntry = { file: null, isParent: true };
	private readonly entryBySuggestion = new WeakMap<HTMLElement, VaultEntry>();
	private pathEl: HTMLDivElement | null = null;
	private readonly onInput = (): void => {
		if (this.inputEl.value.startsWith('~')) {
			this.currentFolder = this.app.vault.getRoot();
		}
		this.updateCurrentPathDisplay();
	};
	private readonly onInputKeydown = (event: KeyboardEvent): void => {
		if (event.key === ':' || event.key === '?') {
			event.preventDefault();
			this.runSelectedOperator(event.key);
			return;
		}

		if (event.key === 'Backspace' && this.inputEl.value === '' && this.currentFolder.parent) {
			event.preventDefault();
			this.navigateToFolder(this.currentFolder.parent);
		}
	};

	constructor(
		app: App,
		private currentFolder: TFolder,
		private readonly initialQuery = '',
	) {
		super(app);
		this.setPlaceholder('Search this folder; select a folder to open it');
	}

	getSuggestions(query: string): VaultEntry[] {
		const location = this.getQueryFolder(query);
		if (!location) return [];
		const { folder, name } = location;
		const search = prepareFuzzySearch(name);
		const entries = folder.children.flatMap((file) => {
			const match = search(file.name);
			return match ? [{ entry: { file, isParent: false }, score: match.score }] : [];
		});
		entries.sort((left, right) => right.score - left.score);
		const suggestions: VaultEntry[] = entries.map(({ entry }) => entry);

		if (folder.parent && (!name || prepareFuzzySearch(name)('..'))) {
			suggestions.unshift(this.parentEntry);
		}

		return suggestions;
	}

	renderSuggestion(entry: VaultEntry, element: HTMLElement): void {
		this.entryBySuggestion.set(element, entry);
		element.addClass('file-palette-suggestion');
		if (entry.isParent) {
			element.setText('.. (parent folder)');
			return;
		}

		const file = entry.file;
		if (!file) return;
		if (file instanceof TFolder) {
			element.createSpan({ cls: 'file-palette-suggestion-name' }).setText(`${file.name}/`);
			return;
		}

		if (!(file instanceof TFile)) return;
		element.createSpan({ cls: 'file-palette-suggestion-name' }).setText(file.basename);
		if (file.extension.toLowerCase() !== 'md') {
			element.createSpan({ cls: 'file-palette-suggestion-extension' }).setText(file.extension.toUpperCase());
		}
	}

	onChooseSuggestion(entry: VaultEntry): void {
		if (entry.isParent) {
			if (this.currentFolder.parent) this.navigateToFolder(this.currentFolder.parent);
			return;
		}

		if (entry.file instanceof TFolder) {
			this.navigateToFolder(entry.file);
			return;
		}

		if (entry.file instanceof TFile) {
			void this.app.workspace.getLeaf(false).openFile(entry.file);
			this.close();
		}
	}

	onOpen(): void {
		super.onOpen();
		this.setTitle('Find file');
		this.pathEl = this.inputEl.parentElement?.createDiv({ cls: 'file-palette-current-path' }) ?? null;
		if (this.pathEl) this.inputEl.parentElement?.before(this.pathEl);
		this.updateCurrentPathDisplay();
		this.setInstructions([
			{ command: '~', purpose: 'Jump to vault root' },
			{ command: ':', purpose: 'Show in Obsidian file navigator' },
			{ command: '?', purpose: 'Show in System File Explorer' },
		]);

		this.inputEl.addEventListener('keydown', this.onInputKeydown);
		this.inputEl.addEventListener('input', this.onInput);
		if (this.initialQuery) {
			this.inputEl.value = this.initialQuery;
			this.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
		}
	}
	onClose(): void {
		this.inputEl.removeEventListener('keydown', this.onInputKeydown);
		this.inputEl.removeEventListener('input', this.onInput);
		this.pathEl?.remove();
		this.pathEl = null;
		this.contentEl.empty();
	}

	private runSelectedOperator(operator: ':' | '?'): void {
		const selectedSuggestion = this.resultContainerEl.querySelector<HTMLElement>('.suggestion-item.is-selected');
		const entry = selectedSuggestion ? this.entryBySuggestion.get(selectedSuggestion) : null;
		if (!entry?.file) return;

		if (operator === ':') {
			const fileExplorerView = this.app.workspace.getLeavesOfType('file-explorer')[0]?.view as
				| FileExplorerViewLike
				| undefined;
			if (!fileExplorerView?.revealInFolder) {
				new Notice('The Obsidian file navigator is not available.');
				return;
			}

			fileExplorerView.revealInFolder(entry.file);
			this.close();
			return;
		}

		const app = this.app as AppWithShowInFolder;
		if (!app.showInFolder) {
			new Notice('Showing items in System File Explorer is not available on this device.');
			return;
		}

		try {
			void Promise.resolve(app.showInFolder.call(this.app, entry.file.path)).catch((error: unknown) => {
				const reason = error instanceof Error ? error.message : String(error);
				new Notice(`Could not show item in System File Explorer: ${reason}`);
			});
			this.close();
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			new Notice(`Could not show item in System File Explorer: ${reason}`);
		}
	}

	private updateCurrentPathDisplay(): void {
		if (!this.pathEl) return;
		const folder = this.getQueryFolder(this.inputEl.value)?.folder ?? this.currentFolder;
		this.pathEl.setText(`Current folder: ${folder.path || '/'}`);
	}

	private navigateToFolder(folder: TFolder): void {
		this.close();
		window.setTimeout(() => {
			new VaultPathSuggestModal(this.app, folder).open();
		}, 0);
	}

	private getQueryFolder(query: string): { folder: TFolder; name: string } | null {
		const absoluteRoot = query.startsWith('~');
		const normalizedQuery = absoluteRoot ? query.slice(1) : query;
		const folder = absoluteRoot || normalizedQuery.startsWith('/') ? this.app.vault.getRoot() : this.currentFolder;
		const lastSeparator = normalizedQuery.lastIndexOf('/');
		if (lastSeparator < 0) return { folder, name: normalizedQuery };

		const path = normalizedQuery.slice(0, lastSeparator);
		const name = normalizedQuery.slice(lastSeparator + 1);
		let targetFolder = folder;
		const relativePath = normalizedQuery.startsWith('/') ? path.slice(1) : path;

		for (const segment of relativePath.split('/').filter(Boolean)) {
			if (segment === '.') continue;
			if (segment === '..') {
				if (targetFolder.parent) targetFolder = targetFolder.parent;
				continue;
			}

			const child = targetFolder.children.find((file) => file.name === segment);
			if (!(child instanceof TFolder)) return null;
			targetFolder = child;
		}

		return { folder: targetFolder, name };
	}
}

export default class FilePalettePlugin extends Plugin {
	async onload(): Promise<void> {
		this.addCommand({
			id: 'open-palette',
			// eslint-disable-next-line obsidianmd/commands/no-plugin-name-in-command-name -- Keep the explicit label requested for discoverability.
			name: 'Open file palette',
			callback: () => {
				new VaultPathSuggestModal(this.app, this.getActiveFolder()).open();
			},
		});
		this.addCommand({
			id: 'find-file-guessing',
			name: 'Find file (guessing)',
			callback: () => {
				const activeEditor = this.app.workspace.activeEditor;
				const guess = this.getEditorGuess(activeEditor?.editor);
				const target = guess ? this.resolveTarget(guess) : null;

				if (target) {
					void this.app.workspace.getLeaf(false).openFile(target);
					return;
				}

				new VaultPathSuggestModal(this.app, this.getActiveFolder(), guess).open();
			},
		});
	}

	private getActiveFolder(): TFolder {
		return this.app.workspace.getActiveFile()?.parent ?? this.app.vault.getRoot();
	}

	private getEditorGuess(editor: Editor | undefined): string {
		if (!editor) return '';

		const selection = editor.getSelection().trim();
		if (selection) return this.normalizeGuess(selection);

		const cursor = editor.getCursor();
		const line = editor.getLine(cursor.line);
		const linkStart = line.lastIndexOf('[[', cursor.ch);
		const linkEnd = line.indexOf(']]', cursor.ch);
		if (linkStart >= 0 && linkEnd >= 0) {
			const link = line.slice(linkStart + 2, linkEnd);
			const aliasStart = link.indexOf('|');
			const linkpath = (aliasStart < 0 ? link : link.slice(0, aliasStart)).trim();
			if (linkpath) return linkpath;
		}

		let start = cursor.ch;
		while (start > 0 && !this.isGuessDelimiter(line[start - 1])) start--;

		let end = cursor.ch;
		while (end < line.length && !this.isGuessDelimiter(line[end])) end++;

		return line.slice(start, end).trim();
	}

	private normalizeGuess(guess: string): string {
		let normalized = guess.trim();
		if (normalized.startsWith('[[') && normalized.endsWith(']]')) {
			normalized = normalized.slice(2, -2);
			const aliasStart = normalized.indexOf('|');
			if (aliasStart >= 0) normalized = normalized.slice(0, aliasStart);
		}
		return normalized.trim();
	}

	private isGuessDelimiter(character: string | undefined): boolean {
		return character === undefined || character.trim() === '' || '[](){}<>"\'|'.includes(character);
	}

	private resolveTarget(guess: string): TFile | null {
		const directMatch = this.app.vault.getAbstractFileByPath(guess);
		if (directMatch instanceof TFile) return directMatch;

		const sourcePath = this.app.workspace.getActiveFile()?.path ?? '';
		return this.app.metadataCache.getFirstLinkpathDest(guess, sourcePath);
	}
}
