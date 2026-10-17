import { App, Editor, Plugin, prepareFuzzySearch, SuggestModal, TAbstractFile, TFile, TFolder } from 'obsidian';

interface VaultEntry {
	file: TAbstractFile | null;
	isParent: boolean;
}

class VaultPathSuggestModal extends SuggestModal<VaultEntry> {
	private readonly parentEntry: VaultEntry = { file: null, isParent: true };
	private pathEl: HTMLDivElement | null = null;
	private readonly onInput = (): void => {
		if (this.inputEl.value.startsWith('~')) {
			this.currentFolder = this.app.vault.getRoot();
		}
		this.updateCurrentPathDisplay();
	};
	private readonly onInputKeydown = (event: KeyboardEvent): void => {
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
		this.setInstructions([{ command: '~', purpose: 'Jump to vault root' }]);

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
		const lastSeparator = normalizedQuery.lastIndexOf('/');
		if (lastSeparator < 0) {
			return { folder: absoluteRoot || normalizedQuery.startsWith('/') ? this.app.vault.getRoot() : this.currentFolder, name: normalizedQuery };
		}

		const path = normalizedQuery.slice(0, lastSeparator);
		const name = normalizedQuery.slice(lastSeparator + 1);
		let folder = absoluteRoot || normalizedQuery.startsWith('/') ? this.app.vault.getRoot() : this.currentFolder;
		const relativePath = normalizedQuery.startsWith('/') ? path.slice(1) : path;

		for (const segment of relativePath.split('/').filter(Boolean)) {
			if (segment === '.') continue;
			if (segment === '..') {
				if (folder.parent) folder = folder.parent;
				continue;
			}

			const child = folder.children.find((file) => file.name === segment);
			if (!(child instanceof TFolder)) return null;
			folder = child;
		}

		return { folder, name };
	}
}

export default class FilePalettePlugin extends Plugin {
	async onload(): Promise<void> {
		this.addCommand({
			id: 'open-palette',
			// eslint-disable-next-line obsidianmd/commands/no-plugin-name-in-command-name -- Keep the explicit label requested for discoverability.
			name: 'Open file palette',
			callback: () => {
				const folder = this.app.workspace.getActiveFile()?.parent ?? this.app.vault.getRoot();
				new VaultPathSuggestModal(this.app, folder).open();
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

				const folder = this.app.workspace.getActiveFile()?.parent ?? this.app.vault.getRoot();
				new VaultPathSuggestModal(this.app, folder, guess).open();
			},
		});
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
