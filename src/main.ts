import {
	AbstractInputSuggest,
	App,
	FileSystemAdapter,
	normalizePath,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	prepareFuzzySearch,
	renderMatches,
	setIcon,
	Setting,
	SuggestModal,
	TAbstractFile,
	TExternalFile,
	TFile,
	TFolder,
} from 'obsidian';
import type { SearchResult, SettingDefinitionItem } from 'obsidian';

const FILE_PALETTE_TITLE = 'File palette';

interface FilePaletteSettings {
	showCommandTitle: boolean;
	searchProperties: string[];
	showPropertyMatches: boolean;
	browseOutsideVault: boolean;
	allowCreateOutsideVault: boolean;
}

const DEFAULT_SETTINGS: FilePaletteSettings = {
	showCommandTitle: true,
	searchProperties: ['title'],
	showPropertyMatches: false,
	browseOutsideVault: true,
	allowCreateOutsideVault: false,
};

export interface PaletteLocation {
	absPath: string; // always the OS path, normalized (forward slashes)
	inVault: boolean; // derived, never stored independently
	vaultRelPath: string | null; // "/Finance" when inVault, else null
}

export const norm = (p: string): string => {
	const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
	return s === '' && p.startsWith('/') ? '/' : s;
};

export function vaultBase(app: App): string | null {
	const a = app.vault?.adapter;
	return a instanceof FileSystemAdapter ? norm(a.getBasePath()) : null;
}

export function makeLocation(app: App, absPath: string): PaletteLocation {
	const abs = norm(absPath);
	const base = vaultBase(app);
	if (!base) {
		const vPath = abs.startsWith('/') ? abs : `/${abs}`;
		return {
			absPath: abs,
			inVault: true,
			vaultRelPath: vPath === '' ? '/' : vPath,
		};
	}
	const ci = Platform.isWin ? (s: string) => s.toLowerCase() : (s: string) => s;
	const inVault = ci(abs) === ci(base) || ci(abs).startsWith(ci(base) + '/');
	return {
		absPath: abs,
		inVault,
		vaultRelPath: inVault ? abs.slice(base.length) || '/' : null,
	};
}


export function getParentPath(abs: string): string {
	const normalized = norm(abs);
	if (/^[a-zA-Z]:$/.test(normalized)) {
		return normalized;
	}
	if (normalized === '' || normalized === '/') {
		return '/';
	}
	const lastSlash = normalized.lastIndexOf('/');
	if (lastSlash < 0) return normalized;
	if (lastSlash === 0) return '/';
	return normalized.slice(0, lastSlash);
}

export function locationFromFolder(app: App, folder: TFolder): PaletteLocation {
	const base = vaultBase(app);
	if (base) {
		const absPath = folder.path ? `${base}/${folder.path}` : base;
		return makeLocation(app, absPath);
	}
	const vPath = folder.path ? (folder.path.startsWith('/') ? folder.path : `/${folder.path}`) : '/';
	return {
		absPath: norm(vPath),
		inVault: true,
		vaultRelPath: vPath,
	};
}

export interface PathSegment {
	name: string;
	path: string;
	isRoot: boolean;
}

export function splitLocationPath(loc: PaletteLocation): PathSegment[] {
	if (loc.inVault) {
		const rel = (loc.vaultRelPath ?? '/').replace(/\\/g, '/');
		const rawSegments = rel.split('/').filter(Boolean);
		const segments: PathSegment[] = [{ name: '/', path: '/', isRoot: true }];

		let accumulated = '';
		for (const part of rawSegments) {
			accumulated += `/${part}`;
			segments.push({ name: part, path: accumulated, isRoot: false });
		}
		return segments;
	}

	const normalized = loc.absPath.replace(/\\/g, '/').replace(/\/+$/, '');

	const uncMatch = normalized.match(/^(\/\/[^/]+\/[^/]+)(?:\/(.*))?$/);
	if (uncMatch) {
		const rootPath = uncMatch[1];
		const subSegments = uncMatch[2] ? uncMatch[2].split('/').filter(Boolean) : [];
		const segments: PathSegment[] = [{ name: rootPath, path: rootPath, isRoot: true }];
		let current = rootPath;
		for (const part of subSegments) {
			current += `/${part}`;
			segments.push({ name: part, path: current, isRoot: false });
		}
		return segments;
	}

	if (/^[a-zA-Z]:/.test(normalized)) {
		const drive = normalized.slice(0, 2);
		const rest = normalized.slice(2).replace(/^\/+/, '');
		const segments: PathSegment[] = [{ name: drive, path: `${drive}/`, isRoot: true }];
		if (rest) {
			const parts = rest.split('/').filter(Boolean);
			let current = drive;
			for (const part of parts) {
				current += `/${part}`;
				segments.push({ name: part, path: current, isRoot: false });
			}
		}
		return segments;
	}

	const parts = normalized.split('/').filter(Boolean);
	const segments: PathSegment[] = [{ name: '/', path: '/', isRoot: true }];
	let current = '';
	for (const part of parts) {
		current += `/${part}`;
		segments.push({ name: part, path: current, isRoot: false });
	}
	return segments;
}

function getFs(): typeof import('fs') | null {
	if (!Platform.isDesktopApp) return null;
	try {
		return require('fs');
	} catch {
		return null;
	}
}

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

export interface VaultEntry {
	file: TAbstractFile | null;
	isParent: boolean;
	propertyValues?: PropertyMatch[];
	name?: string;
	isFolder?: boolean;
	basename?: string;
	extension?: string;
	absPath?: string;
}

interface PaletteItem {
	name: string;
	isFolder: boolean;
	basename: string;
	extension: string;
	absPath: string;
	file: TAbstractFile | null;
}

interface LocationCapabilities {
	canCreate: boolean;
	canRevealInSidebar: boolean;
	canCopyLink: boolean;
	canOpen: boolean;
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

export class VaultPathSuggestModal extends SuggestModal<VaultEntry> {
	private static activeModal: VaultPathSuggestModal | null = null;
	private static pendingNavigationTimeout: number | ReturnType<typeof setTimeout> | null = null;

	public static getActiveModal(): VaultPathSuggestModal | null {
		return VaultPathSuggestModal.activeModal;
	}

	public static closeActiveModal(except?: VaultPathSuggestModal): void {
		if (VaultPathSuggestModal.pendingNavigationTimeout !== null) {
			window.clearTimeout(VaultPathSuggestModal.pendingNavigationTimeout as number);
			VaultPathSuggestModal.pendingNavigationTimeout = null;
		}
		if (VaultPathSuggestModal.activeModal && VaultPathSuggestModal.activeModal !== except) {
			const modalToClose = VaultPathSuggestModal.activeModal;
			VaultPathSuggestModal.activeModal = null;
			try {
				modalToClose.close();
			} catch {
				// Ignore errors if the modal or its window was already destroyed
			}
		}
	}

	private readonly parentEntry: VaultEntry = { file: null, isParent: true };
	private readonly entryBySuggestion = new WeakMap<HTMLElement, VaultEntry>();
	private pathEl: HTMLDivElement | null = null;
	private indicatorEl: HTMLSpanElement | null = null;
	private pathEllipsisEl: HTMLSpanElement | null = null;
	private ellipsisSeparatorEl: HTMLSpanElement | null = null;
	private pathSegments: HTMLSpanElement[] = [];
	private pathSegmentSeparators: (HTMLSpanElement | null)[] = [];
	private pathResizeObserver: ResizeObserver | null = null;
	currentLocation: PaletteLocation;

	private readonly onInput = (): void => {
		if (this.inputEl.value.startsWith('~')) {
			this.currentLocation = this.getVaultRootLocation();
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
			if (!entry || entry.isParent || entry.isFolder || entry.file instanceof TFolder) return;
			const destination = event.shiftKey && event.altKey
				? 'window'
				: event.shiftKey ? 'tab' : 'split';
			event.preventDefault();
			if (entry.file instanceof TFile) {
				this.openInDestination(entry.file, destination);
				return;
			}
			if (entry.absPath) {
				this.openExternalFile(entry.absPath, destination);
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

		if (event.key === 'Backspace' && this.inputEl.value === '') {
			const parent = this.getParentLocation();
			if (parent) {
				event.preventDefault();
				this.navigateToLocation(parent);
			}
		}
	};

	constructor(
		app: App,
		locationOrFolder: TFolder | PaletteLocation | string,
		private readonly showCommandTitle = true,
		private readonly searchProperties: string[] = DEFAULT_SETTINGS.searchProperties,
		private readonly showPropertyMatches = DEFAULT_SETTINGS.showPropertyMatches,
		private readonly browseOutsideVault = DEFAULT_SETTINGS.browseOutsideVault,
		private readonly allowCreateOutsideVault = DEFAULT_SETTINGS.allowCreateOutsideVault,
	) {
		super(app);
		if (typeof locationOrFolder === 'string') {
			this.currentLocation = makeLocation(app, locationOrFolder);
		} else if ('absPath' in locationOrFolder) {
			this.currentLocation = locationOrFolder;
		} else {
			this.currentLocation = locationFromFolder(app, locationOrFolder);
		}
		this.setPlaceholder('Search this folder; select a folder to open it');
	}

	get currentFolder(): TFolder {
		return this.getFolderFromLocation(this.currentLocation) ?? this.app.vault.getRoot();
	}

	getSuggestions(query: string): VaultEntry[] | Promise<VaultEntry[]> {
		const target = this.getQueryLocation(query);
		if (!target) return [];
		const { location, name } = target;

		if (location.inVault) {
			const items = this.listVaultFolder(location);
			return this.filterItems(items, name, location);
		}

		return this.listFolder(location).then((items) => this.filterItems(items, name, location));
	}

	renderSuggestion(entry: VaultEntry, element: HTMLElement): void {
		this.entryBySuggestion.set(element, entry);
		element.addClass('file-palette-suggestion');
		if (entry.isParent) {
			element.setText('.. (parent folder)');
			return;
		}

		const isFolder = entry.isFolder ?? (entry.file instanceof TFolder);
		const name = entry.name ?? entry.file?.name ?? '';
		const basename = entry.basename ?? (entry.file instanceof TFile ? entry.file.basename : name);
		const extension = entry.extension ?? (entry.file instanceof TFile ? entry.file.extension : '');

		if (isFolder) {
			element.createSpan({ cls: 'file-palette-suggestion-name' }).setText(`${name}/`);
			return;
		}

		const details = element.createDiv({ cls: 'file-palette-suggestion-details' });
		details.createDiv({ cls: 'file-palette-suggestion-name' }).setText(basename);
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
		if (extension.toLowerCase() !== 'md' && extension !== '') {
			element.createSpan({ cls: 'file-palette-suggestion-extension' }).setText(extension.toUpperCase());
		}
	}

	onChooseSuggestion(entry: VaultEntry): void {
		if (entry.isParent) {
			const parent = this.getParentLocation();
			if (parent) this.navigateToLocation(parent);
			return;
		}

		const isFolder = entry.isFolder ?? (entry.file instanceof TFolder);
		if (isFolder) {
			const nextAbs = entry.absPath ?? (entry.file ? this.makeItemAbsPath(this.currentLocation, entry.file.name) : '');
			if (nextAbs) {
				this.navigateToLocation(makeLocation(this.app, nextAbs));
			}
			return;
		}

		if (entry.file instanceof TFile) {
			void this.app.workspace.getLeaf(false).openFile(entry.file);
			this.close();
			return;
		}

		if (entry.absPath) {
			this.openExternalFile(entry.absPath);
		}
	}

	open(): void {
		VaultPathSuggestModal.closeActiveModal(this);
		VaultPathSuggestModal.activeModal = this;
		super.open();
	}

	close(): void {
		if (VaultPathSuggestModal.activeModal === this) {
			VaultPathSuggestModal.activeModal = null;
		}
		super.close();
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
			this.pathEl = header.createDiv({ cls: 'fp-path file-palette-current-path palette-path' });
			this.pathEl.setAttribute('aria-label', 'Current folder path');
			this.indicatorEl = this.pathEl.createSpan({ cls: 'fp-path-icon fp-external-indicator' });
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
		if (VaultPathSuggestModal.activeModal === this) {
			VaultPathSuggestModal.activeModal = null;
		}
		this.inputEl.removeEventListener('keydown', this.onInputKeydown);
		this.inputEl.removeEventListener('input', this.onInput);
		this.pathResizeObserver?.disconnect();
		this.pathResizeObserver = null;
		this.modalEl.querySelector('.fp-header')?.remove();
		this.modalEl.querySelector('.fp-footer')?.remove();
		this.modalEl.classList.remove('palette-external');
		this.pathEl = null;
		this.indicatorEl = null;
		this.pathEllipsisEl = null;
		this.ellipsisSeparatorEl = null;
		this.pathSegments = [];
		this.pathSegmentSeparators = [];
		this.contentEl.empty();
	}

	private getCapabilities(loc: PaletteLocation = this.currentLocation): LocationCapabilities {
		return {
			canCreate: loc.inVault,
			canRevealInSidebar: loc.inVault,
			canCopyLink: loc.inVault,
			canOpen: true,
		};
	}

	private renderFooter(loc: PaletteLocation = this.currentLocation): void {
		let footer = this.modalEl.querySelector<HTMLElement>('.fp-footer');
		if (!footer) {
			footer = this.modalEl.createDiv({ cls: 'fp-footer' });
			footer.setAttribute('aria-label', 'Keyboard shortcuts');
		} else {
			footer.empty();
		}

		const caps = this.getCapabilities(loc);
		const modifier = Platform.isMacOS ? '⌘' : 'Ctrl+';
		const shift = Platform.isMacOS ? '⇧' : 'Shift+';
		const alternate = Platform.isMacOS ? '⌥' : 'Alt+';
		const shortcuts = footer.createDiv({ cls: 'fp-footer-shortcuts' });
		const actions = shortcuts.createDiv({ cls: 'fp-footer-actions' });
		this.renderHint(actions, 'Tab', 'Complete');
		this.renderHint(actions, '~', 'Root');
		this.renderHint(actions, ':', 'Reveal', !caps.canRevealInSidebar);
		this.renderHint(actions, '?', 'Explorer');
		this.renderHint(actions, '*', 'App');
		this.renderHint(actions, `${modifier}${shift}L`, 'Link', !caps.canCopyLink);

		const openers = shortcuts.createDiv({ cls: 'fp-footer-openers' });
		this.renderHint(openers, '↵', 'Open');
		this.renderHint(openers, `${shift}↵`, 'Create', !caps.canCreate);
		this.renderHint(openers, `${modifier}${shift}↵`, 'New tab');
		this.renderHint(openers, `${modifier}${alternate}↵`, 'Group');
		if (!Platform.isMobile) this.renderHint(openers, `${modifier}${alternate}${shift}↵`, 'Window');
	}

	private renderHint(container: HTMLElement, command: string, purpose: string, disabled = false): void {
		const hint = container.createDiv({ cls: disabled ? 'fp-hint is-disabled' : 'fp-hint' });
		if (disabled) {
			hint.style.opacity = '0.4';
		}
		const key = hint.createSpan({ cls: 'fp-hint-command' });
		key.setText(command);
		if (command.includes('↵')) {
			key.setAttribute('title', command.replace('↵', Platform.isMacOS ? 'Return' : 'Enter'));
		}
		hint.createSpan({ cls: 'fp-hint-purpose' }).setText(purpose);
	}

	private completeSelectedSuggestion(): void {
		const selectedSuggestion = this.resultContainerEl.querySelector<HTMLElement>('.suggestion-item.is-selected');
		const entry = selectedSuggestion ? this.entryBySuggestion.get(selectedSuggestion) : null;
		if (!entry) return;

		let completedName = '';
		if (entry.isParent) {
			completedName = '../';
		} else if (entry.isFolder || entry.file instanceof TFolder) {
			completedName = `${entry.name ?? entry.file?.name}/`;
		} else if (entry.file instanceof TFile || !entry.isFolder) {
			const ext = entry.extension ?? (entry.file instanceof TFile ? entry.file.extension : '');
			const base = entry.basename ?? (entry.file instanceof TFile ? entry.file.basename : entry.name ?? '');
			completedName = ext.toLowerCase() === 'md'
				? base
				: (entry.name ?? entry.file?.name ?? '');
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

	private async copySelectedLink(): Promise<void> {
		const selectedSuggestion = this.resultContainerEl.querySelector<HTMLElement>('.suggestion-item.is-selected');
		const entry = selectedSuggestion ? this.entryBySuggestion.get(selectedSuggestion) : null;
		if (!entry || entry.isParent || entry.isFolder || entry.file instanceof TFolder) {
			new Notice('Select a file to copy its link.');
			return;
		}
		if (!navigator.clipboard?.writeText) {
			new Notice('Copying links is not available on this device.');
			return;
		}

		try {
			if (this.currentLocation.inVault && entry.file instanceof TFile) {
				const sourcePath = this.app.workspace.getActiveFile()?.path ?? '';
				const link = this.app.fileManager.generateMarkdownLink(entry.file, sourcePath);
				await navigator.clipboard.writeText(link);
				new Notice('Link copied to clipboard.');
				return;
			}

			// Outside vault: copy a file:/// link
			const absPath = entry.absPath ?? (entry.file ? this.makeItemAbsPath(this.currentLocation, entry.file.name) : '');
			const fileUri = `file:///${norm(absPath).replace(/^\/+/, '')}`;
			await navigator.clipboard.writeText(fileUri);
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

	private openExternalFile(absPath: string, destination?: 'tab' | 'split' | 'window'): void {
		if (destination === 'window' && Platform.isMobile) {
			new Notice('Opening a file in a new window is not available on mobile.');
			return;
		}

		// Try resolving as TExternalFile via vault API
		const externalFile = this.app.vault.getFileByPath(`file:${absPath}`) ?? this.app.vault.getFileByPath(absPath);
		if (externalFile instanceof TFile) {
			if (destination) {
				this.openInDestination(externalFile, destination);
			} else {
				void this.app.workspace.getLeaf(false).openFile(externalFile).catch((error: unknown) => {
					const reason = error instanceof Error ? error.message : String(error);
					new Notice(`Could not open file: ${reason}`);
				});
				this.close();
			}
			return;
		}

		// Fallback to opening with system default app
		const app = this.app as AppWithExternalActions;
		if (app.openWithDefaultApp) {
			try {
				void Promise.resolve(app.openWithDefaultApp.call(this.app, absPath)).catch((error: unknown) => {
					const reason = error instanceof Error ? error.message : String(error);
					new Notice(`Could not open item with the system default app: ${reason}`);
				});
				this.close();
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				new Notice(`Could not open item with the system default app: ${reason}`);
			}
		} else {
			new Notice('Opening items with the system default app is not available on this device.');
		}
	}

	private async createNewFileFromQuery(): Promise<void> {
		const target = this.getQueryLocation(this.inputEl.value);
		if (!target) {
			new Notice('The specified folder does not exist.');
			return;
		}

		const rawName = target.name.trim();
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

		if (target.location.inVault) {
			const folderPath = target.location.vaultRelPath === '/' ? '' : (target.location.vaultRelPath?.slice(1) ?? '');
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
			return;
		}

		// Outside vault
		if (!this.allowCreateOutsideVault) {
			new Notice('Creating files outside the vault is turned off.');
			return;
		}

		const fsModule = getFs();
		if (!fsModule) {
			new Notice('Creating files outside the vault is not available on this device.');
			return;
		}

		const fullPath = norm(`${target.location.absPath}/${fileName}`);
		try {
			if (fsModule.existsSync(fullPath)) {
				const stat = fsModule.statSync(fullPath);
				if (stat.isDirectory()) {
					new Notice(`A folder named "${fileName}" already exists.`);
					return;
				}
				const baseNameOnly = hasExtension ? rawName.slice(0, extensionIndex) : rawName;
				new Notice(`"${baseNameOnly}" already exists — opening file.`);
				this.close();
				this.openExternalFile(fullPath);
				return;
			}

			await fsModule.promises.writeFile(fullPath, '', 'utf8');
			this.close();
			this.openExternalFile(fullPath);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			new Notice(`Could not create file: ${reason}`);
		}
	}

	private runSelectedOperator(operator: ':' | '?' | '*'): void {
		const selectedSuggestion = this.resultContainerEl.querySelector<HTMLElement>('.suggestion-item.is-selected');
		const entry = selectedSuggestion ? this.entryBySuggestion.get(selectedSuggestion) : null;
		if (!entry) return;

		const targetLoc = this.getQueryLocation(this.inputEl.value)?.location ?? this.currentLocation;

		if (operator === ':') {
			if (!targetLoc.inVault) {
				new Notice('The sidebar only shows vault files.');
				return;
			}
			const folder = this.getFolderFromLocation(targetLoc);
			const target = entry.isParent ? folder?.parent : entry.file;
			if (!target) return;

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

		let targetPath = '';
		if (targetLoc.inVault) {
			const folder = this.getFolderFromLocation(targetLoc);
			const target = entry.isParent ? folder?.parent : entry.file;
			if (!target) return;
			targetPath = target.path;
		} else {
			if (entry.isParent) {
				targetPath = getParentPath(targetLoc.absPath);
			} else {
				targetPath = entry.absPath ?? '';
			}
			if (Platform.isWin) {
				targetPath = targetPath.replace(/\//g, '\\');
			}
		}

		if (targetPath === undefined) return;

		const app = this.app as AppWithExternalActions;
		if (operator === '*') {
			if (!app.openWithDefaultApp) {
				new Notice('Opening items with the system default app is not available on this device.');
				return;
			}

			try {
				void Promise.resolve(app.openWithDefaultApp.call(this.app, targetPath)).catch((error: unknown) => {
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
			void Promise.resolve(app.showInFolder.call(this.app, targetPath)).catch((error: unknown) => {
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
		const loc = this.getQueryLocation(this.inputEl.value)?.location ?? this.currentLocation;

		this.modalEl.classList.toggle('palette-external', !loc.inVault);

		this.pathEl.empty();
		this.pathEllipsisEl = null;
		this.ellipsisSeparatorEl = null;
		this.pathSegments = [];
		this.pathSegmentSeparators = [];

		const fullDisplayPath = loc.inVault
			? (loc.vaultRelPath || '/')
			: loc.absPath.replace(/\\/g, '/');
		this.pathEl.setAttribute('title', fullDisplayPath);

		const segments = splitLocationPath(loc);
		const rootSegment = segments[0];

		// 1. Icon (Click jumps to root)
		this.indicatorEl = this.pathEl.createSpan({
			cls: 'fp-path-icon fp-external-indicator',
			attr: {
				'aria-label': loc.inVault ? 'Vault root' : 'Drive root',
				role: 'button',
				tabindex: '-1',
			},
		});
		setIcon(this.indicatorEl, loc.inVault ? 'vault' : 'hard-drive');
		this.indicatorEl.addEventListener('click', (e) => {
			e.stopPropagation();
			this.navigateToLocation(
				loc.inVault ? this.getVaultRootLocation() : makeLocation(this.app, rootSegment.path),
			);
		});

		// 2. Root segment (/ or C:)
		const isRootOnly = segments.length === 1;
		const rootEl = this.pathEl.createSpan({
			cls: isRootOnly ? 'fp-path-root fp-path-current' : 'fp-path-root',
			attr: { role: 'button', tabindex: '-1' },
		});
		rootEl.setText(rootSegment.name);
		rootEl.addEventListener('click', (e) => {
			e.stopPropagation();
			this.navigateToLocation(
				loc.inVault ? this.getVaultRootLocation() : makeLocation(this.app, rootSegment.path),
			);
		});

		if (isRootOnly) {
			this.renderFooter(loc);
			return;
		}

		// 3. Middle Ellipsis element (hidden until truncation occurs)
		this.pathEllipsisEl = this.pathEl.createSpan({ cls: 'fp-path-ellipsis fp-path-hidden' });
		this.ellipsisSeparatorEl = this.createPathSeparator('/');
		this.ellipsisSeparatorEl.setText('');
		this.ellipsisSeparatorEl.classList.add('fp-path-hidden');

		// 4. Subfolders
		for (let index = 1; index < segments.length; index++) {
			const seg = segments[index];
			const isLast = index === segments.length - 1;

			// Separator
			let sepEl: HTMLSpanElement | null = null;
			if (index > 1 || (!loc.inVault && rootSegment.name !== '/')) {
				sepEl = this.createPathSeparator('/');
			}
			this.pathSegmentSeparators.push(sepEl);

			const segmentEl = this.pathEl.createSpan({
				cls: isLast ? 'fp-path-segment fp-path-current' : 'fp-path-segment fp-path-parent',
				attr: { role: 'button', tabindex: '-1' },
			});
			segmentEl.setText(seg.name);
			segmentEl.addEventListener('click', (e) => {
				e.stopPropagation();
				this.navigateToLocation(makeLocation(this.app, seg.path));
			});
			this.pathSegments.push(segmentEl);
		}

		this.updatePathTruncation();
		this.renderFooter(loc);
	}

	private createPathSeparator(char = '/'): HTMLSpanElement {
		const separator = this.pathEl?.createSpan({ cls: 'fp-path-separator' });
		separator?.setText(char);
		separator?.setAttribute('aria-hidden', 'true');
		if (!separator) throw new Error('Could not create a folder path separator');
		return separator;
	}

	private updatePathTruncation(): void {
		if (!this.pathEl || !this.pathEllipsisEl) return;
		this.pathSegments.forEach((segment) => segment.classList.remove('fp-path-hidden'));
		this.pathSegmentSeparators.forEach((separator) => separator?.classList.remove('fp-path-hidden'));
		this.pathEllipsisEl.classList.add('fp-path-hidden');
		this.pathEllipsisEl.setText('');
		this.ellipsisSeparatorEl?.classList.add('fp-path-hidden');
		this.ellipsisSeparatorEl?.setText('');

		const minVisible = Math.min(this.pathSegments.length, 2);
		const maxCollapse = this.pathSegments.length - minVisible;
		let firstVisibleSegment = 0;

		while (
			this.pathEl.scrollWidth > this.pathEl.clientWidth &&
			firstVisibleSegment < maxCollapse
		) {
			this.pathSegments[firstVisibleSegment].classList.add('fp-path-hidden');
			this.pathSegmentSeparators[firstVisibleSegment]?.classList.add('fp-path-hidden');
			this.pathEllipsisEl.classList.remove('fp-path-hidden');
			this.pathEllipsisEl.setText('…');
			this.ellipsisSeparatorEl?.classList.remove('fp-path-hidden');
			this.ellipsisSeparatorEl?.setText('/');
			firstVisibleSegment++;
		}
	}

	private navigateToLocation(location: PaletteLocation): void {
		this.close();
		if (VaultPathSuggestModal.pendingNavigationTimeout !== null) {
			window.clearTimeout(VaultPathSuggestModal.pendingNavigationTimeout as number);
			VaultPathSuggestModal.pendingNavigationTimeout = null;
		}
		VaultPathSuggestModal.pendingNavigationTimeout = window.setTimeout(() => {
			VaultPathSuggestModal.pendingNavigationTimeout = null;
			new VaultPathSuggestModal(
				this.app,
				location,
				this.showCommandTitle,
				this.searchProperties,
				this.showPropertyMatches,
				this.browseOutsideVault,
				this.allowCreateOutsideVault,
			).open();
		}, 0);
	}

	private navigateToFolder(folder: TFolder): void {
		this.navigateToLocation(locationFromFolder(this.app, folder));
	}

	private getItemSearchData(item: PaletteItem): {
		fields: SearchableField[];
		displayProperties: RawProperty[];
	} {
		if (item.file) {
			return this.getFileSearchData(item.file);
		}

		const fields: SearchableField[] = [];
		const displayProperties: RawProperty[] = [];

		const text = item.isFolder ? item.name : item.basename;
		fields.push({
			text,
			tokens: tokenize(text),
			isFilename: true,
			itemOffset: 0,
		});

		return { fields, displayProperties };
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

	private getFolderFromLocation(loc: PaletteLocation): TFolder | null {
		if (!loc.inVault || loc.vaultRelPath === null) return null;
		if (loc.vaultRelPath === '/' || loc.vaultRelPath === '') {
			return this.app.vault.getRoot();
		}
		const rel = loc.vaultRelPath.replace(/^\/+/, '');
		const file = this.app.vault.getAbstractFileByPath(rel);
		return file instanceof TFolder ? file : null;
	}

	private getParentLocation(): PaletteLocation | null {
		if (this.currentLocation.inVault && !this.browseOutsideVault) {
			const folder = this.getFolderFromLocation(this.currentLocation);
			if (folder?.parent) {
				return locationFromFolder(this.app, folder.parent);
			}
			return null;
		}
		const parentPath = getParentPath(this.currentLocation.absPath);
		if (parentPath === this.currentLocation.absPath) {
			return null;
		}
		return makeLocation(this.app, parentPath);
	}

	private getVaultRootLocation(): PaletteLocation {
		const root = this.app.vault.getRoot();
		return locationFromFolder(this.app, root);
	}

	private makeItemAbsPath(loc: PaletteLocation, name: string): string {
		return norm(`${loc.absPath}/${name}`);
	}

	private listVaultFolder(loc: PaletteLocation): PaletteItem[] {
		const targetFolder = this.getFolderFromLocation(loc);
		if (!targetFolder) return [];
		return targetFolder.children.map((file) => ({
			name: file.name,
			isFolder: file instanceof TFolder,
			basename: file instanceof TFile ? file.basename : file.name,
			extension: file instanceof TFile ? file.extension : '',
			absPath: this.makeItemAbsPath(loc, file.name),
			file,
		}));
	}

	private async listFolder(loc: PaletteLocation): Promise<PaletteItem[]> {
		if (loc.inVault) {
			return this.listVaultFolder(loc);
		}
		if (!Platform.isDesktopApp) return [];
		const fsModule = getFs();
		if (!fsModule) return [];
		try {
			const dirents = await fsModule.promises.readdir(loc.absPath, { withFileTypes: true });
			const items: PaletteItem[] = [];
			for (const dirent of dirents) {
				const isFolder = dirent.isDirectory();
				const isFile = dirent.isFile();
				if (!isFolder && !isFile) continue;
				const name = dirent.name;
				const extIndex = name.lastIndexOf('.');
				const basename = extIndex > 0 ? name.slice(0, extIndex) : name;
				const extension = extIndex > 0 ? name.slice(extIndex + 1) : '';
				items.push({
					name,
					isFolder,
					basename,
					extension,
					absPath: norm(`${loc.absPath}/${name}`),
					file: null,
				});
			}
			return items;
		} catch {
			return [];
		}
	}

	private filterItems(
		items: PaletteItem[],
		queryName: string,
		targetLocation: PaletteLocation,
	): VaultEntry[] {
		const words = queryName.trim().split(/\s+/).filter(Boolean);
		const searchers = words.map((word) => prepareFuzzySearch(word));

		const entries = items.flatMap((item) => {
			const { fields, displayProperties } = this.getItemSearchData(item);

			if (!words.length) {
				const propertyValues = (item.file instanceof TFile) && this.showPropertyMatches
					? displayProperties.map(({ property, value }) => ({ property, value, match: null }))
					: undefined;
				return [{
					entry: {
						file: item.file,
						isParent: false,
						propertyValues,
						name: item.name,
						isFolder: item.isFolder,
						basename: item.basename,
						extension: item.extension,
						absPath: item.absPath,
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
					file: item.file,
					isParent: false,
					propertyValues,
					name: item.name,
					isFolder: item.isFolder,
					basename: item.basename,
					extension: item.extension,
					absPath: item.absPath,
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
			const leftPath = left.entry.file?.path ?? left.entry.absPath ?? '';
			const rightPath = right.entry.file?.path ?? right.entry.absPath ?? '';
			return leftPath.localeCompare(rightPath);
		});

		const suggestions: VaultEntry[] = entries.map(({ entry }) => entry);

		const hasParent = targetLocation.inVault
			? (this.browseOutsideVault ? getParentPath(targetLocation.absPath) !== targetLocation.absPath : !!this.getFolderFromLocation(targetLocation)?.parent)
			: (getParentPath(targetLocation.absPath) !== targetLocation.absPath);

		if (hasParent && (!words.length || words.every((word) => prepareFuzzySearch(word)('..')))) {
			suggestions.unshift(this.parentEntry);
		}

		return suggestions;
	}

	private getQueryLocation(query: string): { location: PaletteLocation; name: string } | null {
		const absoluteRoot = query.startsWith('~');
		const normalizedQuery = absoluteRoot ? query.slice(1) : query;
		const baseLocation = absoluteRoot || (this.currentLocation.inVault && normalizedQuery.startsWith('/'))
			? this.getVaultRootLocation()
			: this.currentLocation;

		const lastSeparator = normalizedQuery.lastIndexOf('/');
		if (lastSeparator < 0) return { location: baseLocation, name: normalizedQuery };

		const subPath = normalizedQuery.slice(0, lastSeparator);
		const name = normalizedQuery.slice(lastSeparator + 1);

		let resolvedAbsPath = baseLocation.absPath;
		const relativePath = normalizedQuery.startsWith('/') ? subPath.slice(1) : subPath;

		for (const segment of relativePath.split('/').filter(Boolean)) {
			if (segment === '.') continue;
			if (segment === '..') {
				resolvedAbsPath = getParentPath(resolvedAbsPath);
				continue;
			}
			resolvedAbsPath = norm(`${resolvedAbsPath}/${segment}`);
		}

		const location = makeLocation(this.app, resolvedAbsPath);
		if (location.inVault) {
			const folder = this.getFolderFromLocation(location);
			if (!folder) return null;
		}
		return { location, name };
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
				this.openPalette();
			},
		});
		if (typeof this.app.workspace?.on === 'function') {
			this.registerEvent(
				this.app.workspace.on('window-close', (win, window) => {
					const active = VaultPathSuggestModal.getActiveModal();
					if (active) {
						const doc = active.modalEl?.ownerDocument;
						if (doc && (doc === win?.doc || doc === window?.document || doc.defaultView === window || doc.defaultView === win?.win)) {
							VaultPathSuggestModal.closeActiveModal();
						}
					}
				})
			);
		}
	}

	onunload(): void {
		VaultPathSuggestModal.closeActiveModal();
	}

	openPalette(): void {
		VaultPathSuggestModal.closeActiveModal();
		new VaultPathSuggestModal(
			this.app,
			this.getActiveLocation(),
			this.settings.showCommandTitle,
			this.settings.searchProperties,
			this.settings.showPropertyMatches,
			this.settings.browseOutsideVault,
			this.settings.allowCreateOutsideVault,
		).open();
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
		const browseOutsideVault =
			'browseOutsideVault' in settings &&
			typeof settings.browseOutsideVault === 'boolean'
				? settings.browseOutsideVault
				: DEFAULT_SETTINGS.browseOutsideVault;
		const allowCreateOutsideVault =
			'allowCreateOutsideVault' in settings &&
			typeof settings.allowCreateOutsideVault === 'boolean'
				? settings.allowCreateOutsideVault
				: DEFAULT_SETTINGS.allowCreateOutsideVault;
		this.settings = {
			showCommandTitle,
			searchProperties,
			showPropertyMatches,
			browseOutsideVault,
			allowCreateOutsideVault,
		};
	}

	private getActiveLocation(): PaletteLocation {
		const base = vaultBase(this.app);
		const vaultRoot = this.app.vault.getRoot();
		const vaultRootLocation = base
			? makeLocation(this.app, base)
			: locationFromFolder(this.app, vaultRoot);

		if (!this.settings.browseOutsideVault) {
			const activeFile = this.app.workspace.getActiveFile();
			if (activeFile && !(activeFile instanceof TExternalFile) && !activeFile.path.startsWith('file:')) {
				return locationFromFolder(this.app, activeFile.parent ?? vaultRoot);
			}
			return vaultRootLocation;
		}

		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			return vaultRootLocation;
		}

		let fileAbsPath: string | null = null;
		if (activeFile instanceof TExternalFile || typeof (activeFile as unknown as { getRealPath?: () => string }).getRealPath === 'function') {
			fileAbsPath = norm((activeFile as unknown as { getRealPath: () => string }).getRealPath());
		} else if (activeFile.path.startsWith('file:')) {
			fileAbsPath = norm(activeFile.path.slice(5));
		} else {
			const leaf = this.app.workspace.getMostRecentLeaf?.() ?? null;
			const viewStateFile = (leaf?.view?.getState?.() as { file?: string } | undefined)?.file;
			if (typeof viewStateFile === 'string' && viewStateFile.startsWith('file:')) {
				fileAbsPath = norm(viewStateFile.slice(5));
			} else if (base) {
				fileAbsPath = norm(`${base}/${activeFile.path}`);
			} else {
				return locationFromFolder(this.app, activeFile.parent ?? vaultRoot);
			}
		}

		if (!fileAbsPath) {
			return vaultRootLocation;
		}

		const parentAbsPath = getParentPath(fileAbsPath);
		return makeLocation(this.app, parentAbsPath);
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
			{
				name: 'Browse outside vault',
				desc: 'Allow the palette to open in and navigate to folders outside the vault. When off, the palette stays inside the vault as before.',
				control: {
					type: 'toggle',
					key: 'browseOutsideVault',
					defaultValue: DEFAULT_SETTINGS.browseOutsideVault,
				},
			},
			{
				name: 'Allow creating files outside vault',
				desc: 'Let Shift+Enter create files while browsing outside the vault.',
				control: {
					type: 'toggle',
					key: 'allowCreateOutsideVault',
					defaultValue: DEFAULT_SETTINGS.allowCreateOutsideVault,
				},
			},
		];
	}

	getControlValue(key: string): unknown {
		if (key === 'showCommandTitle') return this.plugin.settings.showCommandTitle;
		if (key === 'showPropertyMatches') return this.plugin.settings.showPropertyMatches;
		if (key === 'browseOutsideVault') return this.plugin.settings.browseOutsideVault;
		if (key === 'allowCreateOutsideVault') return this.plugin.settings.allowCreateOutsideVault;
		return undefined;
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		if (
			(key !== 'showCommandTitle' &&
				key !== 'showPropertyMatches' &&
				key !== 'browseOutsideVault' &&
				key !== 'allowCreateOutsideVault') ||
			typeof value !== 'boolean'
		)
			return;
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
