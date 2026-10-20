import {
	AbstractInputSuggest,
	App,
	normalizePath,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	prepareFuzzySearch,
	renderMatches,
	Setting,
	SuggestModal,
	TAbstractFile,
	TFile,
	TFolder,
} from 'obsidian';
import type { SearchResult, SettingDefinitionItem } from 'obsidian';

const FILE_PALETTE_TITLE = 'File palette';

interface FilePaletteSettings {
	showCommandTitle: boolean;
	searchProperties: string[];
	showPropertyMatches: boolean;
}

const DEFAULT_SETTINGS: FilePaletteSettings = {
	showCommandTitle: true,
	searchProperties: ['title'],
	showPropertyMatches: false,
};

function normalizeSearchProperties(value: unknown): string[] {
	if (!Array.isArray(value)) return [...DEFAULT_SETTINGS.searchProperties];
	return [...new Set(value
		.filter((property): property is string => typeof property === 'string')
		.map((property) => property.trim())
		.filter(Boolean))];
}

function mergeRanges(ranges: [number, number][]): [number, number][] {
	const sorted = [...ranges].sort((left, right) => left[0] - right[0] || left[1] - right[1]);
	const merged: [number, number][] = [];
	for (const range of sorted) {
		const last = merged[merged.length - 1];
		if (last && range[0] <= last[1]) {
			last[1] = Math.max(last[1], range[1]);
		} else {
			merged.push([...range]);
		}
	}
	return merged;
}

export enum MatchQuality {
	Fuzzy = 1,
	Substring = 2,
	WordPrefix = 3,
	WholeWord = 4,
}

export function tokenize(text: string): string[] {
	// Split on case/digit boundaries BEFORE lowercasing.
	return text
		.replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
		.replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
		.replace(/(\p{L})(\p{N})/gu, '$1 $2')
		.replace(/(\p{N})(\p{L})/gu, '$1 $2')
		.toLowerCase()
		.match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
}

export function classifyLiteral(
	text: string,
	tokens: readonly string[],
	queryWord: string,
): MatchQuality | null {
	const word = queryWord.toLowerCase();
	if (tokens.includes(word)) return MatchQuality.WholeWord;
	if (tokens.some((t) => t.startsWith(word))) return MatchQuality.WordPrefix;
	if (text.toLowerCase().includes(word)) return MatchQuality.Substring;
	return null; // caller then tries prepareFuzzySearch
}

export interface WordMatch {
	quality: MatchQuality;
	isFilename: boolean;
	fuzzyScore: number; // use 0 for literal matches with no fuzzy result
}

/**
 * Ranking rules:
 * 1. Match quality comes first: WholeWord (4) > WordPrefix (3) > Substring (2) > Fuzzy (1).
 *    A whole-word property match beats a scattered fuzzy filename match.
 * 2. For equal match quality, filename matches rank before property matches.
 * 3. For equal quality and field location, the higher fuzzy score breaks the tie.
 * 4. Across multiple query words, files are compared element-by-element after sorting
 *    each file's per-word matches from weakest to strongest (weakest word decides first).
 * 5. Files with completely identical match quality across all query words are ordered
 *    alphabetically by path for stable results.
 */
export function compareWordMatches(a: WordMatch, b: WordMatch): number {
	return (
		a.quality - b.quality ||
		Number(a.isFilename) - Number(b.isFilename) ||
		a.fuzzyScore - b.fuzzyScore
	);
}

function findLiteralRanges(text: string, queryWord: string): [number, number][] {
	const ranges: [number, number][] = [];
	const lowerText = text.toLowerCase();
	const lowerWord = queryWord.toLowerCase();
	if (!lowerWord) return ranges;
	let index = lowerText.indexOf(lowerWord);
	while (index >= 0) {
		ranges.push([index, index + lowerWord.length]);
		index = lowerText.indexOf(lowerWord, index + lowerWord.length);
	}
	return ranges;
}

/**
 * Obsidian's fuzzy matcher may take the first letters of a query word from an
 * earlier word ("su[p]er [olariz]ed") instead of the word start ("super [polariz]ed").
 * When a highlighted run starts mid-word and the unhighlighted letters before it
 * equal the query letters the matcher spent on earlier ranges, extend the run back
 * to the word start and take those letters away from the earlier ranges.
 */
export function alignFuzzyRanges(
	text: string,
	ranges: [number, number][],
	queryWord: string,
): [number, number][] {
	const query = queryWord.toLowerCase();
	const lower = text.toLowerCase();
	const isWordChar = (char: string) => /[\p{L}\p{N}]/u.test(char);
	const out: [number, number][] = [];
	let consumed = 0;
	for (const [rangeStart, rangeEnd] of [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
		let start = rangeStart;
		let wordStart = rangeStart;
		while (wordStart > 0 && isWordChar(text[wordStart - 1])) wordStart--;
		const gap = rangeStart - wordStart;
		const previous = out[out.length - 1];
		if (
			gap > 0 &&
			gap <= consumed &&
			(!previous || previous[1] <= wordStart) &&
			lower.slice(wordStart, rangeStart) === query.slice(consumed - gap, consumed)
		) {
			let remaining = gap;
			while (remaining > 0 && out.length) {
				const last = out[out.length - 1];
				const length = last[1] - last[0];
				if (length <= remaining) {
					out.pop();
					remaining -= length;
				} else {
					last[1] -= remaining;
					remaining = 0;
				}
			}
			start = wordStart;
		}
		out.push([start, rangeEnd]);
		consumed += rangeEnd - rangeStart;
	}
	return mergeRanges(out);
}

interface SearchableField {
	text: string;
	tokens: string[];
	isFilename: boolean;
	property?: string;
	itemOffset: number;
}

interface RawProperty {
	property: string;
	value: string;
}

interface VaultEntry {
	file: TAbstractFile | null;
	isParent: boolean;
	propertyValues?: PropertyMatch[];
}

interface PropertyMatch {
	property: string;
	value: string;
	match: SearchResult | null;
}

interface FileExplorerViewLike {
	revealInFolder?: (file: TAbstractFile) => void;
}

type AppWithExternalActions = App & {
	showInFolder?: (path: string) => void | Promise<void>;
	openWithDefaultApp?: (path: string) => void | Promise<void>;
};

class VaultPathSuggestModal extends SuggestModal<VaultEntry> {
	private readonly parentEntry: VaultEntry = { file: null, isParent: true };
	private readonly entryBySuggestion = new WeakMap<HTMLElement, VaultEntry>();
	private pathEl: HTMLDivElement | null = null;
	private pathEllipsisEl: HTMLSpanElement | null = null;
	private pathSegments: HTMLSpanElement[] = [];
	private pathSegmentSeparators: HTMLSpanElement[] = [];
	private pathResizeObserver: ResizeObserver | null = null;
	private readonly onInput = (): void => {
		if (this.inputEl.value.startsWith('~')) {
			this.currentFolder = this.app.vault.getRoot();
		}
		this.updateCurrentPathDisplay();
	};
	private readonly onInputKeydown = (event: KeyboardEvent): void => {
		if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) {
			event.preventDefault();
			if (!event.shiftKey) {
				this.completeSelectedSuggestion();
			}
			return;
		}

		if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && (event.shiftKey || event.altKey)) {
			const selectedSuggestion = this.resultContainerEl.querySelector<HTMLElement>('.suggestion-item.is-selected');
			const entry = selectedSuggestion ? this.entryBySuggestion.get(selectedSuggestion) : null;
			if (entry?.file instanceof TFile) {
				const destination = event.shiftKey && event.altKey
					? 'window'
					: event.shiftKey ? 'tab' : 'split';
				event.preventDefault();
				this.openInDestination(entry.file, destination);
				return;
			}
		}

		if (event.key === 'Enter' && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
			event.preventDefault();
			void this.createNewFileFromQuery();
			return;
		}

		if (event.key === ':' || event.key === '?' || event.key === '*') {
			event.preventDefault();
			this.runSelectedOperator(event.key);
			return;
		}

		if (event.key.toLowerCase() === 'l' && (event.ctrlKey || event.metaKey) && event.shiftKey) {
			event.preventDefault();
			void this.copySelectedLink();
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
		private readonly showCommandTitle = true,
		private readonly searchProperties: string[] = DEFAULT_SETTINGS.searchProperties,
		private readonly showPropertyMatches = DEFAULT_SETTINGS.showPropertyMatches,
	) {
		super(app);
		this.setPlaceholder('Search this folder; select a folder to open it');
	}

	getSuggestions(query: string): VaultEntry[] {
		const location = this.getQueryFolder(query);
		if (!location) return [];
		const { folder, name } = location;
		const words = name.trim().split(/\s+/).filter(Boolean);
		const searchers = words.map((word) => prepareFuzzySearch(word));

		const entries = folder.children.flatMap((file) => {
			const { fields, displayProperties } = this.getFileSearchData(file);

			if (!words.length) {
				const propertyValues = file instanceof TFile && this.showPropertyMatches
					? displayProperties.map(({ property, value }) => ({ property, value, match: null }))
					: undefined;
				return [{
					entry: {
						file,
						isParent: false,
						propertyValues,
					},
					sortedWordMatches: [] as WordMatch[],
				}];
			}

			const propertyHitsByProperty = new Map<string, { matches: [number, number][]; scores: number[] }>();
			if (this.showPropertyMatches) {
				for (const { property } of displayProperties) {
					propertyHitsByProperty.set(property, { matches: [], scores: [] });
				}
			}

			const bestWordMatches: WordMatch[] = [];

			for (let wIndex = 0; wIndex < words.length; wIndex++) {
				const queryWord = words[wIndex];
				const search = searchers[wIndex];
				let bestMatchForWord: WordMatch | null = null;

				for (const field of fields) {
					const literalQuality = classifyLiteral(field.text, field.tokens, queryWord);
					let fieldMatch: WordMatch | null = null;
					let fieldRanges: [number, number][] = [];
					let fieldScore = 0;

					if (literalQuality !== null) {
						const fuzzyResult = search(field.text);
						fieldScore = fuzzyResult ? fuzzyResult.score : 0;
						fieldRanges = fuzzyResult?.matches?.length
							? alignFuzzyRanges(field.text, fuzzyResult.matches as [number, number][], queryWord)
							: findLiteralRanges(field.text, queryWord);
						fieldMatch = {
							quality: literalQuality,
							isFilename: field.isFilename,
							fuzzyScore: fieldScore,
						};
					} else {
						const fuzzyResult = search(field.text);
						if (fuzzyResult) {
							fieldScore = fuzzyResult.score;
							fieldRanges = alignFuzzyRanges(
								field.text,
								(fuzzyResult.matches as [number, number][] | undefined) ?? [],
								queryWord,
							);
							fieldMatch = {
								quality: MatchQuality.Fuzzy,
								isFilename: field.isFilename,
								fuzzyScore: fieldScore,
							};
						}
					}

					if (fieldMatch) {
						if (!bestMatchForWord || compareWordMatches(fieldMatch, bestMatchForWord) > 0) {
							bestMatchForWord = fieldMatch;
						}
						if (!field.isFilename && field.property && this.showPropertyMatches) {
							const propHit = propertyHitsByProperty.get(field.property);
							if (propHit) {
								const shiftedRanges: [number, number][] = fieldRanges.map(([start, end]) => [
									start + field.itemOffset,
									end + field.itemOffset,
								]);
								propHit.matches.push(...shiftedRanges);
								propHit.scores.push(fieldScore);
							}
						}
					}
				}

				if (!bestMatchForWord) {
					return [];
				}

				bestWordMatches.push(bestMatchForWord);
			}

			const sortedWordMatches = [...bestWordMatches].sort(compareWordMatches);

			const propertyValues: PropertyMatch[] | undefined = this.showPropertyMatches
				? displayProperties.map(({ property, value }) => {
					const hit = propertyHitsByProperty.get(property);
					const match: SearchResult | null = hit?.scores.length
						? {
							score: hit.scores.reduce((sum, score) => sum + score, 0),
							matches: mergeRanges(hit.matches),
						}
						: null;
					return {
						property,
						value,
						match,
					};
				})
				: undefined;

			return [{
				entry: {
					file,
					isParent: false,
					propertyValues,
				},
				sortedWordMatches,
			}];
		});

		entries.sort((left, right) => {
			for (let i = 0; i < left.sortedWordMatches.length; i++) {
				const diff = compareWordMatches(left.sortedWordMatches[i], right.sortedWordMatches[i]);
				if (diff !== 0) {
					return -diff;
				}
			}
			const leftPath = left.entry.file?.path ?? '';
			const rightPath = right.entry.file?.path ?? '';
			return leftPath.localeCompare(rightPath);
		});
		const suggestions: VaultEntry[] = entries.map(({ entry }) => entry);

		if (folder.parent && (!words.length || words.every((word) => prepareFuzzySearch(word)('..')))) {
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
		const details = element.createDiv({ cls: 'file-palette-suggestion-details' });
		details.createDiv({ cls: 'file-palette-suggestion-name' }).setText(file.basename);
		if (entry.propertyValues?.length) {
			const properties = details.createDiv({ cls: 'file-palette-suggestion-properties' });
			for (const propertyValue of entry.propertyValues) {
				const propertyEl = properties.createDiv({ cls: 'file-palette-suggestion-property' });
				propertyEl.createSpan({ cls: 'file-palette-suggestion-property-name' }).setText(`${propertyValue.property}:`);
				renderMatches(
					propertyEl.createSpan({ cls: 'file-palette-suggestion-property-value' }),
					propertyValue.value,
					propertyValue.match?.matches ?? null,
				);
			}
		}
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
		this.modalEl.addClass('file-palette-modal');
		this.setTitle(this.showCommandTitle ? FILE_PALETTE_TITLE : '');
		const inputContainer = this.inputEl.parentElement;
		if (inputContainer) {
			const header = this.modalEl.createDiv({ cls: 'fp-header' });
			const title = header.createDiv({ cls: 'fp-title' });
			title.setText(FILE_PALETTE_TITLE);
			title.hidden = !this.showCommandTitle;
			this.pathEl = header.createDiv({ cls: 'fp-path file-palette-current-path' });
			this.pathEl.setAttribute('aria-label', 'Current folder path');
			inputContainer.before(header);
		}
		this.updateCurrentPathDisplay();
		if (this.pathEl && typeof ResizeObserver !== 'undefined') {
			this.pathResizeObserver = new ResizeObserver(() => this.updatePathTruncation());
			this.pathResizeObserver.observe(this.pathEl);
		}
		this.renderFooter();

		this.inputEl.addEventListener('keydown', this.onInputKeydown);
		this.inputEl.addEventListener('input', this.onInput);
	}
	onClose(): void {
		this.inputEl.removeEventListener('keydown', this.onInputKeydown);
		this.inputEl.removeEventListener('input', this.onInput);
		this.pathResizeObserver?.disconnect();
		this.pathResizeObserver = null;
		this.modalEl.querySelector('.fp-header')?.remove();
		this.modalEl.querySelector('.fp-footer')?.remove();
		this.pathEl = null;
		this.pathEllipsisEl = null;
		this.pathSegments = [];
		this.pathSegmentSeparators = [];
		this.contentEl.empty();
	}

	private renderFooter(): void {
		const footer = this.modalEl.createDiv({ cls: 'fp-footer' });
		footer.setAttribute('aria-label', 'Keyboard shortcuts');
		const modifier = Platform.isMacOS ? '⌘' : 'Ctrl+';
		const shift = Platform.isMacOS ? '⇧' : 'Shift+';
		const alternate = Platform.isMacOS ? '⌥' : 'Alt+';
		const shortcuts = footer.createDiv({ cls: 'fp-footer-shortcuts' });
		const actions = shortcuts.createDiv({ cls: 'fp-footer-actions' });
		this.renderHint(actions, 'Tab', 'Complete');
		this.renderHint(actions, '~', 'Root');
		this.renderHint(actions, ':', 'Reveal');
		this.renderHint(actions, '?', 'Explorer');
		this.renderHint(actions, '*', 'App');
		this.renderHint(actions, `${modifier}${shift}L`, 'Link');

		const openers = shortcuts.createDiv({ cls: 'fp-footer-openers' });
		this.renderHint(openers, '↵', 'Open');
		this.renderHint(openers, `${shift}↵`, 'Create');
		this.renderHint(openers, `${modifier}${shift}↵`, 'New tab');
		this.renderHint(openers, `${modifier}${alternate}↵`, 'Group');
		if (!Platform.isMobile) this.renderHint(openers, `${modifier}${alternate}${shift}↵`, 'Window');
	}

	private completeSelectedSuggestion(): void {
		const selectedSuggestion = this.resultContainerEl.querySelector<HTMLElement>('.suggestion-item.is-selected');
		const entry = selectedSuggestion ? this.entryBySuggestion.get(selectedSuggestion) : null;
		if (!entry) return;

		let completedName = '';
		if (entry.isParent) {
			completedName = '../';
		} else if (entry.file instanceof TFolder) {
			completedName = `${entry.file.name}/`;
		} else if (entry.file instanceof TFile) {
			completedName = entry.file.extension.toLowerCase() === 'md'
				? entry.file.basename
				: entry.file.name;
		}

		if (!completedName) return;

		let prefix = '';
		if (this.inputEl.value.startsWith('~')) {
			const withoutTilde = this.inputEl.value.slice(1);
			const slashIndex = withoutTilde.lastIndexOf('/');
			prefix = slashIndex >= 0 ? `~${withoutTilde.slice(0, slashIndex + 1)}` : '~';
		} else {
			const slashIndex = this.inputEl.value.lastIndexOf('/');
			prefix = slashIndex >= 0 ? this.inputEl.value.slice(0, slashIndex + 1) : '';
		}

		const nextValue = `${prefix}${completedName}`;
		this.inputEl.value = nextValue;
		this.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
		this.inputEl.setSelectionRange(nextValue.length, nextValue.length);
	}

	private renderHint(container: HTMLElement, command: string, purpose: string): void {
		const hint = container.createDiv({ cls: 'fp-hint' });
		const key = hint.createSpan({ cls: 'fp-hint-command' });
		key.setText(command);
		if (command.includes('↵')) {
			key.setAttribute('title', command.replace('↵', Platform.isMacOS ? 'Return' : 'Enter'));
		}
		hint.createSpan({ cls: 'fp-hint-purpose' }).setText(purpose);
	}

	private async copySelectedLink(): Promise<void> {
		const selectedSuggestion = this.resultContainerEl.querySelector<HTMLElement>('.suggestion-item.is-selected');
		const entry = selectedSuggestion ? this.entryBySuggestion.get(selectedSuggestion) : null;
		if (!entry?.file) return;
		if (!(entry.file instanceof TFile)) {
			new Notice('Select a file to copy its link.');
			return;
		}
		if (!navigator.clipboard?.writeText) {
			new Notice('Copying links is not available on this device.');
			return;
		}

		try {
			const sourcePath = this.app.workspace.getActiveFile()?.path ?? '';
			const link = this.app.fileManager.generateMarkdownLink(entry.file, sourcePath);
			await navigator.clipboard.writeText(link);
			new Notice('Link copied to clipboard.');
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			new Notice(`Could not copy link: ${reason}`);
		}
	}

	private openInDestination(file: TFile, destination: 'tab' | 'split' | 'window'): void {
		if (destination === 'window' && Platform.isMobile) {
			new Notice('Opening a file in a new window is not available on mobile.');
			return;
		}

		try {
			void this.app.workspace.getLeaf(destination).openFile(file).catch((error: unknown) => {
				const reason = error instanceof Error ? error.message : String(error);
				new Notice(`Could not open file in a ${destination}: ${reason}`);
			});
			this.close();
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			new Notice(`Could not open file in a ${destination}: ${reason}`);
		}
	}

	private async createNewFileFromQuery(): Promise<void> {
		const location = this.getQueryFolder(this.inputEl.value);
		if (!location) {
			new Notice('The specified folder does not exist.');
			return;
		}

		const rawName = location.name.trim();
		if (!rawName) {
			new Notice('Enter a file name to create a note.');
			return;
		}

		if (/[*\\/<>:|?#^[\]]/.test(rawName)) {
			new Notice('File name contains invalid characters.');
			return;
		}

		const extensionIndex = rawName.lastIndexOf('.');
		const hasExtension = extensionIndex > 0;
		const fileName = hasExtension ? rawName : `${rawName}.md`;
		const folderPath = location.folder.path;
		const fullPath = normalizePath(folderPath ? `${folderPath}/${fileName}` : fileName);

		const existing = this.app.vault.getAbstractFileByPath(fullPath);
		if (existing instanceof TFile) {
			new Notice(`"${existing.basename}" already exists — opening file.`);
			this.close();
			void this.app.workspace.getLeaf(false).openFile(existing).catch((error: unknown) => {
				const reason = error instanceof Error ? error.message : String(error);
				new Notice(`Could not open file: ${reason}`);
			});
			return;
		}
		if (existing instanceof TFolder) {
			new Notice(`A folder named "${fileName}" already exists.`);
			return;
		}

		try {
			const newFile = await this.app.vault.create(fullPath, '');
			this.close();
			void this.app.workspace.getLeaf(false).openFile(newFile).catch((error: unknown) => {
				const reason = error instanceof Error ? error.message : String(error);
				new Notice(`Could not open file: ${reason}`);
			});
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			new Notice(`Could not create file: ${reason}`);
		}
	}

	private runSelectedOperator(operator: ':' | '?' | '*'): void {
		const selectedSuggestion = this.resultContainerEl.querySelector<HTMLElement>('.suggestion-item.is-selected');
		const entry = selectedSuggestion ? this.entryBySuggestion.get(selectedSuggestion) : null;
		if (!entry) return;
		const folder = this.getQueryFolder(this.inputEl.value)?.folder ?? this.currentFolder;
		const target = entry.isParent ? folder.parent : entry.file;
		if (!target) return;

		if (operator === ':') {
			const fileExplorerLeaf = this.app.workspace.getLeavesOfType('file-explorer')[0];
			const fileExplorerView = fileExplorerLeaf?.view as
				| FileExplorerViewLike
				| undefined;
			if (!fileExplorerView?.revealInFolder) {
				new Notice('The Obsidian file navigator is not available.');
				return;
			}

			(this.app.workspace as { revealLeaf?: (leaf: unknown) => void }).revealLeaf?.(fileExplorerLeaf);
			fileExplorerView.revealInFolder(target);
			this.close();
			return;
		}

		const app = this.app as AppWithExternalActions;
		if (operator === '*') {
			if (!app.openWithDefaultApp) {
				new Notice('Opening items with the system default app is not available on this device.');
				return;
			}

			try {
				void Promise.resolve(app.openWithDefaultApp.call(this.app, target.path)).catch((error: unknown) => {
					const reason = error instanceof Error ? error.message : String(error);
					new Notice(`Could not open item with the system default app: ${reason}`);
				});
				this.close();
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				new Notice(`Could not open item with the system default app: ${reason}`);
			}
			return;
		}

		if (!app.showInFolder) {
			new Notice('Showing items in System File Explorer is not available on this device.');
			return;
		}

		try {
			void Promise.resolve(app.showInFolder.call(this.app, target.path)).catch((error: unknown) => {
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
		const segments = folder.path.split('/').filter(Boolean);
		const fullPath = segments.length ? `/${segments.join('/')}` : '/';
		this.pathEl.empty();
		this.pathEl.setAttribute('title', fullPath);
		this.pathEllipsisEl = null;
		this.pathSegments = [];
		this.pathSegmentSeparators = [];

		if (!segments.length) {
			this.pathEl.createSpan({ cls: 'fp-path-current' }).setText('/');
			return;
		}

		this.pathEllipsisEl = this.pathEl.createSpan({ cls: 'fp-path-ellipsis' });
		this.createPathSeparator();
		for (let index = 0; index < segments.length; index++) {
			const segment = this.pathEl.createSpan({
				cls: index === segments.length - 1 ? 'fp-path-segment fp-path-current' : 'fp-path-segment fp-path-parent',
			});
			segment.setText(segments[index]);
			this.pathSegments.push(segment);
			if (index < segments.length - 1) {
				this.pathSegmentSeparators.push(this.createPathSeparator());
			}
		}
		this.updatePathTruncation();
	}

	private createPathSeparator(): HTMLSpanElement {
		const separator = this.pathEl?.createSpan({ cls: 'fp-path-separator' });
		separator?.setText('/');
		separator?.setAttribute('aria-hidden', 'true');
		if (!separator) throw new Error('Could not create a folder path separator');
		return separator;
	}

	private updatePathTruncation(): void {
		if (!this.pathEl || !this.pathEllipsisEl) return;
		this.pathSegments.forEach((segment) => segment.classList.remove('fp-path-hidden'));
		this.pathSegmentSeparators.forEach((separator) => separator.classList.remove('fp-path-hidden'));
		this.pathEllipsisEl.setText('');

		let firstVisibleSegment = 0;
		while (
			this.pathEl.scrollWidth > this.pathEl.clientWidth &&
			firstVisibleSegment < this.pathSegments.length - 1
		) {
			this.pathSegments[firstVisibleSegment].classList.add('fp-path-hidden');
			this.pathSegmentSeparators[firstVisibleSegment]?.classList.add('fp-path-hidden');
			this.pathEllipsisEl.setText('…');
			firstVisibleSegment++;
		}
	}

	private navigateToFolder(folder: TFolder): void {
		this.close();
		window.setTimeout(() => {
			new VaultPathSuggestModal(
				this.app,
				folder,
				this.showCommandTitle,
				this.searchProperties,
				this.showPropertyMatches,
			).open();
		}, 0);
	}

	private getFileSearchData(file: TAbstractFile): {
		fields: SearchableField[];
		displayProperties: RawProperty[];
	} {
		const fields: SearchableField[] = [];
		const displayProperties: RawProperty[] = [];

		if (file instanceof TFolder) {
			fields.push({
				text: file.name,
				tokens: tokenize(file.name),
				isFilename: true,
				itemOffset: 0,
			});
			return { fields, displayProperties };
		}

		if (file instanceof TFile) {
			fields.push({
				text: file.basename,
				tokens: tokenize(file.basename),
				isFilename: true,
				itemOffset: 0,
			});

			const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
			if (frontmatter) {
				for (const property of this.searchProperties) {
					const value: unknown = frontmatter[property];
					if (typeof value === 'string') {
						fields.push({
							text: value,
							tokens: tokenize(value),
							isFilename: false,
							property,
							itemOffset: 0,
						});
						displayProperties.push({ property, value });
					} else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
						const items = value.map((item) => item.trim()).filter(Boolean);
						if (items.length > 0) {
							let offset = 0;
							for (const item of items) {
								fields.push({
									text: item,
									tokens: tokenize(item),
									isFilename: false,
									property,
									itemOffset: offset,
								});
								offset += item.length + 2;
							}
							displayProperties.push({ property, value: items.join(', ') });
						}
					}
				}
			}
		}

		return { fields, displayProperties };
	}

	private getRawProperties(file: TFile): RawProperty[] {
		return this.getFileSearchData(file).displayProperties;
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
	settings: FilePaletteSettings = {
		...DEFAULT_SETTINGS,
		searchProperties: [...DEFAULT_SETTINGS.searchProperties],
	};

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new FilePaletteSettingTab(this.app, this));
		this.addCommand({
			id: 'open-palette',
			// eslint-disable-next-line obsidianmd/commands/no-plugin-name-in-command-name -- Keep the explicit label requested for discoverability.
			name: 'Open file palette',
			callback: () => {
				new VaultPathSuggestModal(
					this.app,
					this.getActiveFolder(),
					this.settings.showCommandTitle,
					this.settings.searchProperties,
					this.settings.showPropertyMatches,
				).open();
			},
		});
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private async loadSettings(): Promise<void> {
		const savedSettings: unknown = await this.loadData();
		const settings = typeof savedSettings === 'object' && savedSettings !== null ? savedSettings : {};
		const showCommandTitle =
			'showCommandTitle' in settings &&
			typeof settings.showCommandTitle === 'boolean'
				? settings.showCommandTitle
				: DEFAULT_SETTINGS.showCommandTitle;
		const searchProperties =
			'searchProperties' in settings && Array.isArray(settings.searchProperties)
				? normalizeSearchProperties(settings.searchProperties)
				: [...DEFAULT_SETTINGS.searchProperties];
		const showPropertyMatches =
			'showPropertyMatches' in settings &&
			typeof settings.showPropertyMatches === 'boolean'
				? settings.showPropertyMatches
				: DEFAULT_SETTINGS.showPropertyMatches;
		this.settings = { showCommandTitle, searchProperties, showPropertyMatches };
	}

	private getActiveFolder(): TFolder {
		return this.app.workspace.getActiveFile()?.parent ?? this.app.vault.getRoot();
	}
}

interface PropertySuggestion {
	property: string;
	isAllowed: boolean;
}

class PropertyNameSuggest extends AbstractInputSuggest<PropertySuggestion> {
	private readonly properties: PropertySuggestion[];

	constructor(
		app: App,
		private readonly onSelectProperty: (value: string) => void,
		private readonly propertyInputEl: HTMLInputElement,
	) {
		super(app, propertyInputEl);
		this.properties = this.collectPropertyNames();
		this.onSelect((suggestion) => {
			if (!suggestion.isAllowed) return;
			this.onSelectProperty(this.replaceCurrentProperty(suggestion.property));
		});
	}

	renderSuggestion(suggestion: PropertySuggestion, element: HTMLElement): void {
		if (suggestion.isAllowed) {
			element.setText(suggestion.property);
		} else {
			element.addClass('fp-property-disabled');
			const nameSpan = element.createSpan({ cls: 'fp-property-name' });
			nameSpan.setText(suggestion.property);
			const labelSpan = element.createSpan({ cls: 'fp-property-unsupported' });
			labelSpan.setText(' (unsupported)');
		}
	}

	selectSuggestion(suggestion: PropertySuggestion, evt: MouseEvent | KeyboardEvent): void {
		if (!suggestion.isAllowed) {
			new Notice(`Property "${suggestion.property}" is not a string or string list.`);
			return;
		}
		super.selectSuggestion(suggestion, evt);
	}

	protected getSuggestions(_query: string): PropertySuggestion[] {
		const value = this.getValue();
		const cursor = this.propertyInputEl.selectionStart ?? value.length;
		const tokenStart = value.lastIndexOf(',', cursor - 1) + 1;
		const currentToken = value.slice(tokenStart, cursor).trim();
		const alreadySelected = new Set(
			value.slice(0, tokenStart).split(',').map((property) => property.trim().toLowerCase()).filter(Boolean),
		);
		const search = prepareFuzzySearch(currentToken);
		const matches: { suggestion: PropertySuggestion; score: number }[] = [];
		for (const suggestion of this.properties) {
			if (alreadySelected.has(suggestion.property.toLowerCase())) continue;
			const match = currentToken ? search(suggestion.property) : { score: 0, matches: [] };
			if (match) matches.push({ suggestion, score: match.score });
		}
		return matches
			.sort(
				(left, right) =>
					Number(right.suggestion.isAllowed) - Number(left.suggestion.isAllowed) ||
					right.score - left.score ||
					left.suggestion.property.localeCompare(right.suggestion.property),
			)
			.map(({ suggestion }) => suggestion);
	}

	private collectPropertyNames(): PropertySuggestion[] {
		const allowed = new Set<string>();
		const disallowed = new Set<string>();

		for (const file of this.app.vault.getMarkdownFiles()) {
			const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
			if (!frontmatter) continue;
			for (const [property, value] of Object.entries(frontmatter)) {
				if (value === null || value === undefined) continue;
				if (
					typeof value === 'string' ||
					(Array.isArray(value) && value.every((item) => typeof item === 'string'))
				) {
					allowed.add(property);
				} else {
					disallowed.add(property);
				}
			}
		}

		const allPropertyNames = new Set([...allowed, ...disallowed]);
		const result: PropertySuggestion[] = [];
		for (const property of allPropertyNames) {
			const isAllowed = allowed.has(property) && !disallowed.has(property);
			result.push({ property, isAllowed });
		}
		return result;
	}

	private replaceCurrentProperty(property: string): string {
		const value = this.getValue();
		const cursor = this.propertyInputEl.selectionStart ?? value.length;
		let tokenStart = value.lastIndexOf(',', cursor - 1) + 1;
		while (tokenStart < cursor && /\s/.test(value[tokenStart])) tokenStart++;
		const tokenEndIndex = value.indexOf(',', cursor);
		const tokenEnd = tokenEndIndex < 0 ? value.length : tokenEndIndex;
		const suffix = value.slice(tokenEnd);
		const nextValue = `${value.slice(0, tokenStart)}${property}${suffix || ', '}`;
		const nextCursor = tokenStart + property.length + (suffix ? 0 : 2);
		this.setValue(nextValue);
		this.propertyInputEl.setSelectionRange(nextCursor, nextCursor);
		return nextValue;
	}
}

class FilePaletteSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: FilePalettePlugin) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: 'Show command title',
				desc: 'Show “File palette” above the current folder path in the file picker.',
				control: {
					type: 'toggle',
					key: 'showCommandTitle',
					defaultValue: DEFAULT_SETTINGS.showCommandTitle,
				},
			},
			{
				name: 'Search properties',
				desc: 'Comma-separated frontmatter properties to search alongside file names. Only string and string list values are searched.',
				render: (setting) => {
					let propertySuggest: PropertyNameSuggest | null = null;
					setting.addText((text) => {
						const saveSearchProperties = (value: string): Promise<void> =>
							this.saveSearchProperties(value, (nextValue) => text.setValue(nextValue));
						text
							.setPlaceholder('title, category')
							.setValue(this.plugin.settings.searchProperties.join(', '))
							.onChange(saveSearchProperties);
						propertySuggest = new PropertyNameSuggest(
							this.app,
							saveSearchProperties,
							text.inputEl,
						);
					});
					return () => propertySuggest?.close();
				},
			},
			{
				name: 'Show matching properties',
				desc: 'Show configured string and string list properties below each matching file name, with matched text highlighted.',
				control: {
					type: 'toggle',
					key: 'showPropertyMatches',
					defaultValue: DEFAULT_SETTINGS.showPropertyMatches,
				},
			},
		];
	}

	getControlValue(key: string): unknown {
		if (key === 'showCommandTitle') return this.plugin.settings.showCommandTitle;
		if (key === 'showPropertyMatches') return this.plugin.settings.showPropertyMatches;
		return undefined;
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		if ((key !== 'showCommandTitle' && key !== 'showPropertyMatches') || typeof value !== 'boolean') return;
		const previousValue = this.plugin.settings[key];
		this.plugin.settings[key] = value;
		try {
			await this.plugin.saveSettings();
		} catch (error) {
			this.plugin.settings[key] = previousValue;
			const reason = error instanceof Error ? error.message : String(error);
			new Notice(`Could not save file palette settings: ${reason}`);
		}
	}

	private async saveSearchProperties(value: string, setValue: (value: string) => void): Promise<void> {
		const previousProperties = this.plugin.settings.searchProperties;
		this.plugin.settings.searchProperties = normalizeSearchProperties(value.split(','));
		try {
			await this.plugin.saveSettings();
		} catch (error) {
			this.plugin.settings.searchProperties = previousProperties;
			setValue(previousProperties.join(', '));
			const reason = error instanceof Error ? error.message : String(error);
			new Notice(`Could not save file palette settings: ${reason}`);
		}
	}
}
