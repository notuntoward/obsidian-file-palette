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
import {
	alignFuzzyRanges,
	classifyLiteral,
	findLiteralRanges,
	MatchQuality,
	mergeRanges,
	tokenize,
} from 'commons/search';
import {
	focusLeafAndWindow,
	getWindowForLeaf,
	isLeafDetached,
} from 'commons/workspace';
import {
	ownerWindow,
	setTimeoutIn,
	writeClipboardIn,
	type CancelTimer,
} from 'commons/windows';
import { applyFilePageColor } from 'commons/color';

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

export interface PaletteItem {
	name: string;
	isFolder: boolean;
	basename: string;
	extension: string;
	absPath: string;
	file: TAbstractFile | null;
}

export interface LocationOptions {
	browseOutsideVault?: boolean;
	allowCreateOutsideVault?: boolean;
}

export interface PaletteLocation {
	absPath: string; // always the OS path, normalized (forward slashes)
	inVault: boolean; // derived, never stored independently
	vaultRelPath: string | null; // "/Finance" when inVault, else null
	canCreate: boolean;
	canLink: boolean;
	canReveal: boolean;
	list(): Promise<PaletteItem[]> | PaletteItem[];
	parent(): PaletteLocation | null;
}

export const norm = (p: string): string => {
	const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
	if (s === '' && p.startsWith('/')) return '/';
	if (/^[a-zA-Z]:$/.test(s)) return `${s}/`;
	return s;
};

const pathCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function vaultBase(app: App): string | null {
	const a = app.vault?.adapter;
	return a instanceof FileSystemAdapter ? norm(a.getBasePath()) : null;
}

function getOs(): typeof import('os') | null {
	if (!Platform.isDesktopApp) return null;
	try {
		return require('os');
	} catch {
		return null;
	}
}

function getFs(): typeof import('fs') | null {
	if (!Platform.isDesktopApp) return null;
	try {
		return require('fs');
	} catch {
		return null;
	}
}

function getPath(): typeof import('path') | null {
	if (!Platform.isDesktopApp) return null;
	try {
		return require('path');
	} catch {
		return null;
	}
}

export function resolveHome(): string | null {
	if (Platform.isMobile || !Platform.isDesktopApp) return null;
	const osModule = getOs();
	if (!osModule) return null;

	let rawHome: string | null = null;
	try {
		rawHome = osModule.homedir();
	} catch {
		rawHome = null;
	}

	if (!rawHome || rawHome.trim() === '') {
		try {
			rawHome = osModule.userInfo().homedir;
		} catch {
			rawHome = null;
		}
	}

	if (!rawHome || rawHome.trim() === '') {
		return null;
	}

	const pathModule = getPath();
	const isAbsolute = pathModule
		? pathModule.isAbsolute(rawHome)
		: (/^([a-zA-Z]:[/\\]|\/|\\\\)/.test(rawHome));

	if (!isAbsolute) {
		return null;
	}

	const fsModule = getFs();
	if (!fsModule) return null;

	try {
		const stat = fsModule.statSync(rawHome);
		if (!stat.isDirectory()) {
			return null;
		}
	} catch {
		return null;
	}

	return norm(rawHome);
}

export function getParentPath(abs: string): string {
	const normalized = norm(abs);
	// On Windows, enumerating all available drive letters (A:-Z:) reliably and synchronously
	// across mapped network drives, optical drives, and unmounted volumes requires native Win32 APIs
	// or spawning external shell commands (like wmic/powershell/fsutil), which is slow, unreliable,
	// and unavailable in pure Node/Obsidian sandbox. Therefore, we safely stop at the drive root (e.g. C:/).
	if (/^[a-zA-Z]:\/?$/.test(normalized)) {
		return normalized.replace(/\/$/, '');
	}
	if (/^\/\/[^/]+\/[^/]+\/?$/.test(normalized)) {
		return normalized.replace(/\/$/, '');
	}
	if (normalized === '' || normalized === '/') {
		return '/';
	}
	const lastSlash = normalized.lastIndexOf('/');
	if (lastSlash < 0) return normalized;
	if (lastSlash === 0) return '/';
	if (lastSlash === 2 && /^[a-zA-Z]:/.test(normalized)) {
		return normalized.slice(0, 2);
	}
	return normalized.slice(0, lastSlash);
}

function getFolderFromLocation(app: App, loc: { inVault: boolean; vaultRelPath: string | null }): TFolder | null {
	if (!loc.inVault || loc.vaultRelPath === null) return null;
	if (loc.vaultRelPath === '/' || loc.vaultRelPath === '') {
		return app.vault.getRoot();
	}
	const rel = loc.vaultRelPath.replace(/^\/+/, '');
	const file = app.vault.getAbstractFileByPath(rel);
	return file instanceof TFolder ? file : null;
}

function makeItemAbsPath(loc: { absPath: string }, name: string): string {
	if (loc.absPath === '/') return `/${name}`;
	if (loc.absPath.endsWith('/')) return `${loc.absPath}${name}`;
	return norm(`${loc.absPath}/${name}`);
}

const EXTERNAL_LINK_IMAGE_EXTENSIONS = new Set(['bmp', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif']);

export function generateExternalMarkdownLink(targetPath: string, isFolder = false): string {
	const normalized = targetPath.replace(/\\/g, '/');
	let trimmed = normalized;
	if (trimmed !== '/' && !/^[a-zA-Z]:\/$/.test(trimmed)) {
		trimmed = trimmed.replace(/\/+$/, '');
	}

	let filename = '';
	if (/^[a-zA-Z]:\/$/.test(trimmed)) {
		filename = trimmed.slice(0, 2);
	} else if (trimmed === '/') {
		filename = '/';
	} else {
		const lastSlash = trimmed.lastIndexOf('/');
		filename = lastSlash === -1 ? trimmed : trimmed.slice(lastSlash + 1);
	}

	let title = '';
	let extension = '';

	if (isFolder || trimmed === '/' || /^[a-zA-Z]:\/$/.test(trimmed)) {
		title = filename;
	} else {
		const dotIndex = filename.lastIndexOf('.');
		if (dotIndex > 0 && dotIndex < filename.length - 1) {
			extension = filename.slice(dotIndex + 1).toLowerCase();
		}
		title = extension === 'md' ? filename.slice(0, dotIndex) : filename;
	}

	const encodedPath = trimmed.replace(/[\\\x00\x08\x0B\x0C\x0E-\x1F ]/g, (char) => encodeURIComponent(char));
	const uri = encodedPath.startsWith('//')
		? `file:${encodedPath}`
		: encodedPath.startsWith('/')
			? `file://${encodedPath}`
			: `file:///${encodedPath}`;
	const link = `[${title}](${uri})`;
	return !isFolder && EXTERNAL_LINK_IMAGE_EXTENSIONS.has(extension) ? `!${link}` : link;
}

export class PaletteLocationImpl implements PaletteLocation {
	public readonly absPath: string;
	public readonly inVault: boolean;
	public readonly vaultRelPath: string | null;
	public readonly canCreate: boolean;
	public readonly canLink: boolean;
	public readonly canReveal: boolean;

	constructor(
		private readonly app: App,
		absPath: string,
		private readonly options: LocationOptions = {},
	) {
		const abs = norm(absPath);
		this.absPath = abs;
		const base = vaultBase(app);
		if (!base) {
			const vPath = abs.startsWith('/') ? abs : `/${abs}`;
			this.inVault = true;
			this.vaultRelPath = vPath === '' ? '/' : vPath;
		} else {
			const ci = Platform.isWin ? (s: string) => s.toLowerCase() : (s: string) => s;
			const inVault = ci(abs) === ci(base) || ci(abs).startsWith(ci(base) + '/');
			this.inVault = inVault;
			this.vaultRelPath = inVault ? abs.slice(base.length) || '/' : null;
		}

		const allowCreateOutside = options.allowCreateOutsideVault ?? DEFAULT_SETTINGS.allowCreateOutsideVault;
		this.canCreate = this.inVault || allowCreateOutside;
		this.canLink = true;
		this.canReveal = this.inVault;
	}

	listSync(): PaletteItem[] {
		if (!this.inVault) return [];
		const targetFolder = getFolderFromLocation(this.app, this);
		if (!targetFolder) return [];
		return targetFolder.children.map((file) => ({
			name: file.name,
			isFolder: file instanceof TFolder,
			basename: file instanceof TFile ? file.basename : file.name,
			extension: file instanceof TFile ? file.extension : '',
			absPath: makeItemAbsPath(this, file.name),
			file,
		}));
	}

	async list(): Promise<PaletteItem[]> {
		if (this.inVault) {
			return this.listSync();
		}

		if (!Platform.isDesktopApp) return [];
		const fsModule = getFs();
		if (!fsModule) return [];

		try {
			const dirents = await fsModule.promises.readdir(this.absPath, { withFileTypes: true });
			const items: PaletteItem[] = [];
			for (const dirent of dirents) {
				let isFolder = dirent.isDirectory();
				let isFile = dirent.isFile();
				if (typeof dirent.isSymbolicLink === 'function' && dirent.isSymbolicLink()) {
					try {
						const stat = fsModule.statSync(`${this.absPath}/${dirent.name}`);
						isFolder = stat.isDirectory();
						isFile = stat.isFile();
					} catch {
						continue;
					}
				}
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
					absPath: norm(`${this.absPath}/${name}`),
					file: null,
				});
			}
			return items;
		} catch {
			return [];
		}
	}

	parent(): PaletteLocation | null {
		const browseOutside = this.options.browseOutsideVault ?? DEFAULT_SETTINGS.browseOutsideVault;
		if (this.inVault && !browseOutside) {
			const folder = getFolderFromLocation(this.app, this);
			if (folder?.parent) {
				return locationFromFolder(this.app, folder.parent, this.options);
			}
			return null;
		}
		const parentPath = getParentPath(this.absPath);
		if (norm(parentPath) === this.absPath) {
			return null;
		}
		return new PaletteLocationImpl(this.app, parentPath, this.options);
	}
}

export function makeLocation(app: App, absPath: string, options?: LocationOptions): PaletteLocation {
	return new PaletteLocationImpl(app, absPath, options);
}

export function locationFromFolder(app: App, folder: TFolder, options?: LocationOptions): PaletteLocation {
	const base = vaultBase(app);
	if (base) {
		const absPath = folder.path ? `${base}/${folder.path}` : base;
		return makeLocation(app, absPath, options);
	}
	const vPath = folder.path ? (folder.path.startsWith('/') ? folder.path : `/${folder.path}`) : '/';
	return makeLocation(app, vPath, options);
}

export function getSystemRootLocation(app: App, loc: { absPath: string }, options?: LocationOptions): PaletteLocation {
	const normalized = norm(loc.absPath);
	if (/^[a-zA-Z]:/.test(normalized)) {
		return makeLocation(app, `${normalized.slice(0, 2)}/`, options);
	}
	const uncMatch = normalized.match(/^(\/\/[^/]+\/[^/]+)/);
	if (uncMatch) {
		return makeLocation(app, uncMatch[1], options);
	}
	return makeLocation(app, '/', options);
}

export interface PathSegment {
	name: string;
	path: string;
	isRoot: boolean;
}

export function splitLocationPath(loc: { absPath: string; inVault: boolean; vaultRelPath?: string | null }): PathSegment[] {
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

function normalizeSearchProperties(value: unknown): string[] {
	if (!Array.isArray(value)) return [...DEFAULT_SETTINGS.searchProperties];
	return [...new Set(value
		.filter((property): property is string => typeof property === 'string')
		.map((property) => property.trim())
		.filter(Boolean))];
}

export {
	alignFuzzyRanges,
	classifyLiteral,
	findLiteralRanges,
	MatchQuality,
	mergeRanges,
	tokenize,
};

export interface WordMatch {
	quality: MatchQuality;
	isFilename: boolean;
	fuzzyScore: number;
}

export function compareWordMatches(a: WordMatch, b: WordMatch): number {
	return (
		a.quality - b.quality ||
		Number(a.isFilename) - Number(b.isFilename) ||
		a.fuzzyScore - b.fuzzyScore
	);
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
	private static cancelPendingNavigation: CancelTimer | null = null;

	public static getActiveModal(): VaultPathSuggestModal | null {
		return VaultPathSuggestModal.activeModal;
	}

	public static closeActiveModal(except?: VaultPathSuggestModal): void {
		if (VaultPathSuggestModal.cancelPendingNavigation) {
			VaultPathSuggestModal.cancelPendingNavigation();
			VaultPathSuggestModal.cancelPendingNavigation = null;
		}
		if (VaultPathSuggestModal.activeModal && VaultPathSuggestModal.activeModal !== except) {
			const modalToClose = VaultPathSuggestModal.activeModal;
			VaultPathSuggestModal.activeModal = null;
			try {
				modalToClose.close();
			} catch {
				// Ignore errors if the modal was already destroyed
			}
		}
	}

	private readonly parentEntry: VaultEntry = { file: null, isParent: true };
	private readonly entryBySuggestion = new WeakMap<HTMLElement, VaultEntry>();
	private readonly searchDataCache = new Map<string, { fields: SearchableField[]; displayProperties: RawProperty[] }>();
	private cachedHomeDir: string | null | undefined = undefined;
	limit = 100;
	private pathEl: HTMLDivElement | null = null;
	private indicatorEl: HTMLSpanElement | null = null;
	private pathEllipsisEl: HTMLSpanElement | null = null;
	private ellipsisSeparatorEl: HTMLSpanElement | null = null;
	private pathSegments: HTMLSpanElement[] = [];
	private pathSegmentSeparators: (HTMLSpanElement | null)[] = [];
	private pathResizeObserver: ResizeObserver | null = null;
	private suggestionObserver: MutationObserver | null = null;
	currentLocation: PaletteLocation;

	resolveHome(): string | null {
		if (this.cachedHomeDir === undefined) {
			this.cachedHomeDir = resolveHome();
		}
		return this.cachedHomeDir;
	}

	private isClearingShortcut = false;

	private readonly onInput = (): void => {
		if (this.isClearingShortcut) return;
		const val = this.inputEl.value;
		if (val === '^') {
			this.currentLocation = this.getVaultRootLocation();
			this.updateCurrentPathDisplay();
			this.isClearingShortcut = true;
			this.inputEl.value = '';
			this.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
			this.isClearingShortcut = false;
			return;
		}
		if (val.startsWith('^/')) {
			this.currentLocation = this.getVaultRootLocation();
		} else if (val === '~') {
			const home = this.resolveHome();
			if (home) {
				this.currentLocation = makeLocation(this.app, home, {
					browseOutsideVault: this.browseOutsideVault,
					allowCreateOutsideVault: this.allowCreateOutsideVault,
				});
				this.updateCurrentPathDisplay();
				this.isClearingShortcut = true;
				this.inputEl.value = '';
				this.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
				this.isClearingShortcut = false;
				return;
			} else if (Platform.isMobile) {
				this.currentLocation = this.getVaultRootLocation();
				this.updateCurrentPathDisplay();
				this.isClearingShortcut = true;
				this.inputEl.value = '';
				this.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
				this.isClearingShortcut = false;
				return;
			} else {
				this.isClearingShortcut = true;
				this.inputEl.value = '';
				this.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
				this.isClearingShortcut = false;
				new Notice('User home directory could not be resolved.');
				return;
			}
		} else if (val.startsWith('~/')) {
			const home = this.resolveHome();
			if (home) {
				this.currentLocation = makeLocation(this.app, home, {
					browseOutsideVault: this.browseOutsideVault,
					allowCreateOutsideVault: this.allowCreateOutsideVault,
				});
			} else if (Platform.isMobile) {
				this.currentLocation = this.getVaultRootLocation();
			} else {
				new Notice('User home directory could not be resolved.');
			}
		} else if (!this.currentLocation.inVault && (val === '/' || val.startsWith('/'))) {
			this.currentLocation = getSystemRootLocation(this.app, this.currentLocation, {
				browseOutsideVault: this.browseOutsideVault,
				allowCreateOutsideVault: this.allowCreateOutsideVault,
			});
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

		if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
			const rawQuery = this.inputEl.value.trim();
			if (rawQuery !== '') {
				const target = this.getQueryLocation(this.inputEl.value);
				if (target && target.name === '') {
					const selectedSuggestion = this.resultContainerEl.querySelector<HTMLElement>('.suggestion-item.is-selected');
					const firstSuggestion = this.resultContainerEl.querySelector<HTMLElement>('.suggestion-item');
					const isFirst = !selectedSuggestion || selectedSuggestion === firstSuggestion;
					const entry = selectedSuggestion ? this.entryBySuggestion.get(selectedSuggestion) : null;
					if (!entry || entry.isParent || isFirst) {
						event.preventDefault();
						this.navigateToLocation(target.location);
						return;
					}
				}
			}
		}

		if (event.key === 'Backspace' && this.inputEl.value === '') {
			const parent = this.currentLocation.parent();
			if (parent) {
				if (!parent.inVault && Platform.isDesktopApp) {
					const fsModule = getFs();
					if (fsModule) {
						try {
							fsModule.readdirSync(parent.absPath);
						} catch (error) {
							const reason = error instanceof Error ? error.message : String(error);
							new Notice(`Cannot open folder: ${reason}`);
							return;
						}
					}
				}
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
		const locationOptions = {
			browseOutsideVault: this.browseOutsideVault,
			allowCreateOutsideVault: this.allowCreateOutsideVault,
		};
		if (typeof locationOrFolder === 'string') {
			this.currentLocation = makeLocation(app, locationOrFolder, locationOptions);
		} else if ('absPath' in locationOrFolder && typeof locationOrFolder.list === 'function') {
			this.currentLocation = locationOrFolder;
		} else if ('absPath' in locationOrFolder) {
			this.currentLocation = makeLocation(app, locationOrFolder.absPath, locationOptions);
		} else {
			this.currentLocation = locationFromFolder(app, locationOrFolder, locationOptions);
		}
		this.setPlaceholder('Search this folder; select a folder to open it');
	}

	get currentFolder(): TFolder {
		return getFolderFromLocation(this.app, this.currentLocation) ?? this.app.vault.getRoot();
	}

	getSuggestions(query: string): VaultEntry[] | Promise<VaultEntry[]> {
		const target = this.getQueryLocation(query);
		if (!target) return [];
		const { location, name } = target;

		if (location.inVault && location instanceof PaletteLocationImpl) {
			const items = location.listSync();
			return this.filterItems(items, name, location);
		}

		const listRes = location.list();
		if (Array.isArray(listRes)) {
			return this.filterItems(listRes, name, location);
		}
		return listRes.then((items) => this.filterItems(items, name, location));
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
		const nameEl = details.createDiv({ cls: 'file-palette-suggestion-name' });
		nameEl.setText(basename);

		if (entry.file instanceof TFile) {
			applyFilePageColor(this.app, nameEl, entry.file);
			element.setAttribute('data-path', entry.file.path);
		} else if (entry.absPath && !isFolder) {
			applyFilePageColor(this.app, nameEl, entry.absPath);
			element.setAttribute('data-path', entry.absPath);
		}
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

	onChooseSuggestion(entry: VaultEntry, evt?: MouseEvent | KeyboardEvent): void {
		const targetLoc = this.getCurrentTargetLocation();

		const rawQuery = this.inputEl?.value.trim() ?? '';
		const target = this.getQueryLocation(rawQuery);
		const hasTraversedPath = target && target.name === '' && target.location.absPath !== this.currentLocation.absPath;

		if (hasTraversedPath) {
			const isMouseClickOnParent = evt instanceof MouseEvent && entry.isParent;
			if (!isMouseClickOnParent) {
				const selectedEl = this.resultContainerEl?.querySelector<HTMLElement>('.suggestion-item.is-selected');
				const firstEl = this.resultContainerEl?.querySelector<HTMLElement>('.suggestion-item');
				const isFirstSuggestion = !selectedEl || selectedEl === firstEl;

				if (entry.isParent || isFirstSuggestion) {
					this.navigateToLocation(target.location);
					return;
				}
			}
		}

		if (entry.isParent) {
			const parent = targetLoc.parent();
			if (parent) {
				if (!parent.inVault && Platform.isDesktopApp) {
					const fsModule = getFs();
					if (fsModule) {
						try {
							fsModule.readdirSync(parent.absPath);
						} catch (error) {
							const reason = error instanceof Error ? error.message : String(error);
							new Notice(`Cannot open folder: ${reason}`);
							return;
						}
					}
				}
				this.navigateToLocation(parent);
			}
			return;
		}

		const isFolder = entry.isFolder ?? (entry.file instanceof TFolder);
		if (isFolder) {
			const nextAbs = entry.absPath ?? (entry.file ? makeItemAbsPath(targetLoc, entry.file.name) : '');
			if (nextAbs) {
				if (!targetLoc.inVault && Platform.isDesktopApp) {
					const fsModule = getFs();
					if (fsModule) {
						try {
							fsModule.readdirSync(nextAbs);
						} catch (error) {
							const reason = error instanceof Error ? error.message : String(error);
							new Notice(`Cannot open folder: ${reason}`);
							return;
						}
					}
				}
				this.navigateToLocation(makeLocation(this.app, nextAbs, {
					browseOutsideVault: this.browseOutsideVault,
					allowCreateOutsideVault: this.allowCreateOutsideVault,
				}));
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

		if (this.resultContainerEl && typeof MutationObserver !== 'undefined') {
			this.suggestionObserver = new MutationObserver(() => this.updateFooterHints());
			this.suggestionObserver.observe(this.resultContainerEl, {
				attributes: true,
				subtree: true,
				attributeFilter: ['class'],
				childList: true,
			});
		}

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
		this.suggestionObserver?.disconnect();
		this.suggestionObserver = null;
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

	private getCurrentTargetLocation(): PaletteLocation {
		return this.getQueryLocation(this.inputEl?.value ?? '')?.location ?? this.currentLocation;
	}

	private renderFooter(loc: PaletteLocation = this.getCurrentTargetLocation()): void {
		let footer = this.modalEl.querySelector<HTMLElement>('.fp-footer');
		if (!footer) {
			footer = this.modalEl.createDiv({ cls: 'fp-footer' });
			footer.setAttribute('aria-label', 'Keyboard shortcuts');
		} else {
			footer.empty();
		}

		const modifier = Platform.isMacOS ? '⌘' : 'Ctrl+';
		const shift = Platform.isMacOS ? '⇧' : 'Shift+';
		const alternate = Platform.isMacOS ? '⌥' : 'Alt+';
		const shortcuts = footer.createDiv({ cls: 'fp-footer-shortcuts' });
		const actions = shortcuts.createDiv({ cls: 'fp-footer-actions' });

		const homeDir = this.resolveHome();
		this.renderHint(actions, 'Tab', 'Complete');
		if (homeDir !== null) {
			this.renderHint(actions, '~', 'Home');
		}
		this.renderHint(actions, '^', 'Vault');
		this.renderHint(actions, ':', 'Reveal', !loc.canReveal, 'fp-hint-reveal');
		this.renderHint(actions, '?', 'Explorer');
		this.renderHint(actions, '*', 'App');
		this.renderHint(actions, `${modifier}${shift}L`, 'Link', !loc.canLink, 'fp-hint-link');

		const openers = shortcuts.createDiv({ cls: 'fp-footer-openers' });
		this.renderHint(openers, '↵', 'Open');
		this.renderHint(openers, `${shift}↵`, 'Create', !loc.canCreate, 'fp-hint-create');
		this.renderHint(openers, `${modifier}${shift}↵`, 'New tab', false, 'fp-hint-tab');
		this.renderHint(openers, `${modifier}${alternate}↵`, 'Group', false, 'fp-hint-group');
		if (!Platform.isMobile) {
			this.renderHint(openers, `${modifier}${alternate}${shift}↵`, 'Window', false, 'fp-hint-window');
		}

		this.updateFooterHints(loc);
	}

	private updateFooterHints(loc: PaletteLocation = this.getCurrentTargetLocation()): void {
		const footer = this.modalEl.querySelector<HTMLElement>('.fp-footer');
		if (!footer) return;

		const selectedEl = this.resultContainerEl?.querySelector<HTMLElement>('.suggestion-item.is-selected');
		const entry = selectedEl ? this.entryBySuggestion.get(selectedEl) : null;
		const isFolder = !!entry && Boolean(entry.isFolder || entry.file instanceof TFolder);
		const isFile = !!entry && !entry.isParent && !isFolder;

		const canLink = loc.canLink && !!entry && !entry.isParent && (loc.inVault ? isFile : true);
		const canOpenInLeaf = isFile;

		const linkHint = footer.querySelector<HTMLElement>('.fp-hint-link');
		if (linkHint) {
			linkHint.classList.toggle('is-disabled', !canLink);
			linkHint.style.opacity = canLink ? '' : '0.4';
		}

		const tabHint = footer.querySelector<HTMLElement>('.fp-hint-tab');
		if (tabHint) {
			tabHint.classList.toggle('is-disabled', !canOpenInLeaf);
			tabHint.style.opacity = canOpenInLeaf ? '' : '0.4';
		}

		const groupHint = footer.querySelector<HTMLElement>('.fp-hint-group');
		if (groupHint) {
			groupHint.classList.toggle('is-disabled', !canOpenInLeaf);
			groupHint.style.opacity = canOpenInLeaf ? '' : '0.4';
		}

		const windowHint = footer.querySelector<HTMLElement>('.fp-hint-window');
		if (windowHint) {
			windowHint.classList.toggle('is-disabled', !canOpenInLeaf);
			windowHint.style.opacity = canOpenInLeaf ? '' : '0.4';
		}

		const createHint = footer.querySelector<HTMLElement>('.fp-hint-create');
		if (createHint) {
			createHint.classList.toggle('is-disabled', !loc.canCreate);
			createHint.style.opacity = loc.canCreate ? '' : '0.4';
		}

		const revealHint = footer.querySelector<HTMLElement>('.fp-hint-reveal');
		if (revealHint) {
			revealHint.classList.toggle('is-disabled', !loc.canReveal);
			revealHint.style.opacity = loc.canReveal ? '' : '0.4';
		}
	}

	private renderHint(container: HTMLElement, command: string, purpose: string, disabled = false, cls?: string): void {
		const classes = ['fp-hint'];
		if (disabled) classes.push('is-disabled');
		if (cls) classes.push(cls);
		const hint = container.createDiv({ cls: classes.join(' ') });
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

		const val = this.inputEl.value;
		let prefix = '';
		if (val.startsWith('^')) {
			const withoutCaret = val.slice(1);
			const slashIndex = withoutCaret.lastIndexOf('/');
			prefix = slashIndex >= 0 ? `^${withoutCaret.slice(0, slashIndex + 1)}` : '^/';
		} else if (val.startsWith('~')) {
			const withoutTilde = val.slice(1);
			const slashIndex = withoutTilde.lastIndexOf('/');
			prefix = slashIndex >= 0 ? `~${withoutTilde.slice(0, slashIndex + 1)}` : '~/';
		} else {
			const slashIndex = val.lastIndexOf('/');
			prefix = slashIndex >= 0 ? val.slice(0, slashIndex + 1) : '';
		}

		const nextValue = `${prefix}${completedName}`;
		this.inputEl.value = nextValue;
		this.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
		this.inputEl.setSelectionRange(nextValue.length, nextValue.length);
	}

	private async copySelectedLink(): Promise<void> { 
		const targetLoc = this.getCurrentTargetLocation();
		const selectedSuggestion = this.resultContainerEl.querySelector<HTMLElement>('.suggestion-item.is-selected');
		const entry = selectedSuggestion ? this.entryBySuggestion.get(selectedSuggestion) : null;

		if (!entry || entry.isParent) {
			new Notice(targetLoc.inVault ? 'Select a file to copy its link.' : 'Select a file or folder to copy its link.');
			return;
		}

		if (targetLoc.inVault && (entry.isFolder || entry.file instanceof TFolder)) {
			new Notice('Select a file to copy its link.');
			return;
		}

		const win = ownerWindow(this.containerEl ?? this.modalEl ?? this.contentEl ?? this.inputEl) ?? window;

		try {
			if (targetLoc.inVault) {
				if (entry.file instanceof TFile) {
					const sourcePath = this.app.workspace.getActiveFile()?.path ?? '';
					const link = this.app.fileManager.generateMarkdownLink(entry.file, sourcePath);
					const success = await writeClipboardIn(win, link);
					if (success) {
						new Notice('Link copied to clipboard.');
					} else {
						new Notice('Copying links is not available on this device.');
					}
				}
				return;
			}

			const isFolder = Boolean(entry.isFolder || entry.file instanceof TFolder);
			const absPath =
				entry.absPath ??
				(entry.file
					? makeItemAbsPath(targetLoc, entry.file.name)
					: entry.name
						? makeItemAbsPath(targetLoc, entry.name)
						: '');
			if (!absPath) {
				new Notice('Could not determine file path.');
				return;
			}

			const link = generateExternalMarkdownLink(absPath, isFolder);
			const success = await writeClipboardIn(win, link);
			if (success) {
				new Notice('Link copied to clipboard.');
			} else {
				new Notice('Copying links is not available on this device.');
			}
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
			const folder = getFolderFromLocation(this.app, targetLoc);
			const target = entry.isParent ? folder?.parent : entry.file;
			if (!target) return;

			const modalWin = ownerWindow(this.containerEl ?? this.modalEl ?? this.contentEl ?? this.inputEl);
			const fileExplorerLeaves = this.app.workspace.getLeavesOfType('file-explorer');
			const fileExplorerLeaf = (modalWin
				? fileExplorerLeaves.find((leaf) => !isLeafDetached(leaf) && getWindowForLeaf(leaf) === modalWin)
				: undefined) ?? fileExplorerLeaves.find((leaf) => !isLeafDetached(leaf)) ?? fileExplorerLeaves[0];

			if (!fileExplorerLeaf) {
				new Notice('The Obsidian file navigator is not available.');
				return;
			}

			const fileExplorerView = fileExplorerLeaf.view as
				| FileExplorerViewLike
				| undefined;
			if (!fileExplorerView?.revealInFolder) {
				new Notice('The Obsidian file navigator is not available.');
				return;
			}

			if (typeof this.app.workspace.setActiveLeaf === 'function') {
				focusLeafAndWindow(this.app, fileExplorerLeaf);
			}
			(this.app.workspace as { revealLeaf?: (leaf: unknown) => void }).revealLeaf?.(fileExplorerLeaf);
			fileExplorerView.revealInFolder(target);
			this.close();
			return;
		}

		let targetPath = '';
		if (targetLoc.inVault) {
			const folder = getFolderFromLocation(this.app, targetLoc);
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
		this.pathEl.classList.toggle('file-palette-outside', !loc.inVault);

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

		// 1. Icon (Click jumps to root or home)
		let iconName = 'vault';
		if (!loc.inVault) {
			const home = this.resolveHome();
			if (home) {
				const ci = Platform.isWin ? (s: string) => s.toLowerCase() : (s: string) => s;
				const isAtOrUnderHome = ci(loc.absPath) === ci(home) || ci(loc.absPath).startsWith(ci(home) + '/');
				iconName = isAtOrUnderHome ? 'home' : 'hard-drive';
			} else {
				iconName = 'hard-drive';
			}
		}

		this.indicatorEl = this.pathEl.createSpan({
			cls: loc.inVault
				? 'fp-path-icon fp-external-indicator'
				: 'fp-path-icon fp-external-indicator is-external',
			attr: {
				'aria-label': loc.inVault ? 'Vault root' : (iconName === 'home' ? 'Home directory' : 'Drive root'),
				role: 'button',
				tabindex: '-1',
			},
		});
		setIcon(this.indicatorEl, iconName);
		this.indicatorEl.addEventListener('click', (e) => {
			e.stopPropagation();
			if (loc.inVault) {
				this.navigateToLocation(this.getVaultRootLocation());
			} else if (iconName === 'home') {
				const home = this.resolveHome();
				if (home) {
					this.navigateToLocation(makeLocation(this.app, home, {
						browseOutsideVault: this.browseOutsideVault,
						allowCreateOutsideVault: this.allowCreateOutsideVault,
					}));
				} else {
					this.navigateToLocation(makeLocation(this.app, rootSegment.path));
				}
			} else {
				this.navigateToLocation(makeLocation(this.app, rootSegment.path));
			}
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
				this.navigateToLocation(makeLocation(this.app, seg.path, {
					browseOutsideVault: this.browseOutsideVault,
					allowCreateOutsideVault: this.allowCreateOutsideVault,
				}));
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
			this.pathEl.clientWidth > 0 &&
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
		const win = ownerWindow(this.containerEl ?? this.modalEl ?? this.contentEl ?? this.inputEl) ?? window;
		this.close();
		if (VaultPathSuggestModal.cancelPendingNavigation) {
			VaultPathSuggestModal.cancelPendingNavigation();
			VaultPathSuggestModal.cancelPendingNavigation = null;
		}
		VaultPathSuggestModal.cancelPendingNavigation = setTimeoutIn(win, () => {
			VaultPathSuggestModal.cancelPendingNavigation = null;
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

	private getItemSearchData(item: PaletteItem): {
		fields: SearchableField[];
		displayProperties: RawProperty[];
	} {
		const cacheKey = item.file ? item.file.path : item.absPath;
		const cached = this.searchDataCache.get(cacheKey);
		if (cached) return cached;

		const data = this.computeItemSearchData(item);
		this.searchDataCache.set(cacheKey, data);
		return data;
	}

	private computeItemSearchData(item: PaletteItem): {
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

	private getDisplayProperties(file: TFile): RawProperty[] {
		const displayProperties: RawProperty[] = [];
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (frontmatter) {
			for (const property of this.searchProperties) {
				const value: unknown = frontmatter[property];
				if (typeof value === 'string') {
					displayProperties.push({ property, value });
				} else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
					const items = value.map((item) => item.trim()).filter(Boolean);
					if (items.length > 0) {
						displayProperties.push({ property, value: items.join(', ') });
					}
				}
			}
		}
		return displayProperties;
	}

	private getVaultRootLocation(): PaletteLocation {
		const root = this.app.vault.getRoot();
		return locationFromFolder(this.app, root, {
			browseOutsideVault: this.browseOutsideVault,
			allowCreateOutsideVault: this.allowCreateOutsideVault,
		});
	}

	private filterItems(
		items: PaletteItem[],
		queryName: string,
		targetLocation: PaletteLocation,
	): VaultEntry[] {
		const words = queryName.trim().split(/\s+/).filter(Boolean);

		const hasParent = targetLocation.parent() !== null;

		if (!words.length) {
			const entries: VaultEntry[] = items.map((item) => {
				const propertyValues =
					item.file instanceof TFile && this.showPropertyMatches
						? this.getDisplayProperties(item.file).map(({ property, value }) => ({
								property,
								value,
								match: null,
						  }))
						: undefined;

				return {
					file: item.file,
					isParent: false,
					propertyValues,
					name: item.name,
					isFolder: item.isFolder,
					basename: item.basename,
					extension: item.extension,
					absPath: item.absPath,
				};
			});

			entries.sort((left, right) => {
				const leftPath = left.file?.path ?? left.absPath ?? '';
				const rightPath = right.file?.path ?? right.absPath ?? '';
				return pathCollator.compare(leftPath, rightPath);
			});

			const maxEntries = hasParent ? this.limit - 1 : this.limit;
			const suggestions: VaultEntry[] = entries.slice(0, maxEntries);

			if (hasParent) {
				suggestions.unshift(this.parentEntry);
			}

			return suggestions;
		}

		const searchers = words.map((word) => prepareFuzzySearch(word));

		const entries = items.flatMap((item) => {
			const { fields, displayProperties } = this.getItemSearchData(item);

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
			return pathCollator.compare(leftPath, rightPath);
		});

		const maxEntries = hasParent ? this.limit - 1 : this.limit;
		const suggestions: VaultEntry[] = entries.slice(0, maxEntries).map(({ entry }) => entry);

		if (hasParent && words.every((word) => prepareFuzzySearch(word)('..'))) {
			suggestions.unshift(this.parentEntry);
		}

		return suggestions;
	}

	private getQueryLocation(query: string): { location: PaletteLocation; name: string } | null {
		const locationOptions = {
			browseOutsideVault: this.browseOutsideVault,
			allowCreateOutsideVault: this.allowCreateOutsideVault,
		};

		let baseLocation: PaletteLocation;
		let remainingQuery: string;

		if (query === '~' || query.startsWith('~/')) {
			const home = this.resolveHome();
			if (home) {
				baseLocation = makeLocation(this.app, home, locationOptions);
				remainingQuery = query === '~' ? '' : query.slice(2);
			} else if (Platform.isMobile) {
				baseLocation = this.getVaultRootLocation();
				remainingQuery = query === '~' ? '' : query.slice(2);
			} else {
				return { location: this.currentLocation, name: query };
			}
		} else if (query === '^' || query.startsWith('^/')) {
			baseLocation = this.getVaultRootLocation();
			remainingQuery = query === '^' ? '' : query.slice(2);
		} else if (query.startsWith('/')) {
			if (this.currentLocation.inVault) {
				baseLocation = this.getVaultRootLocation();
			} else {
				baseLocation = getSystemRootLocation(this.app, this.currentLocation, locationOptions);
			}
			remainingQuery = query.slice(1);
		} else if (/^[a-zA-Z]:(\/|\\)?/.test(query)) {
			const drive = query.slice(0, 2).toUpperCase() + '/';
			baseLocation = makeLocation(this.app, drive, locationOptions);
			remainingQuery = query.slice(2).replace(/^[/\\]+/, '');
		} else if (query.startsWith('//')) {
			const uncMatch = query.match(/^(\/\/[^/]+\/[^/]+)(?:\/(.*))?$/);
			if (uncMatch) {
				baseLocation = makeLocation(this.app, uncMatch[1], locationOptions);
				remainingQuery = uncMatch[2] ?? '';
			} else {
				baseLocation = this.currentLocation;
				remainingQuery = query;
			}
		} else {
			baseLocation = this.currentLocation;
			remainingQuery = query;
		}

		const lastSeparator = remainingQuery.lastIndexOf('/');
		if (lastSeparator < 0) {
			return { location: baseLocation, name: remainingQuery };
		}

		const subPath = remainingQuery.slice(0, lastSeparator);
		const name = remainingQuery.slice(lastSeparator + 1);

		let resolvedAbsPath = baseLocation.absPath;
		for (const segment of subPath.split('/').filter(Boolean)) {
			if (segment === '.') continue;
			if (segment === '..') {
				resolvedAbsPath = getParentPath(resolvedAbsPath);
				continue;
			}
			resolvedAbsPath = resolvedAbsPath === '/' || resolvedAbsPath.endsWith('/')
				? `${resolvedAbsPath}${segment}`
				: `${resolvedAbsPath}/${segment}`;
		}

		const location = makeLocation(this.app, resolvedAbsPath, locationOptions);
		if (location.inVault) {
			const folder = getFolderFromLocation(this.app, location);
			if (!folder) return null;
		} else if (Platform.isDesktopApp) {
			const fsModule = getFs();
			if (fsModule) {
				try {
					if (!fsModule.existsSync(location.absPath) || !fsModule.statSync(location.absPath).isDirectory()) {
						return null;
					}
				} catch {
					return null;
				}
			}
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
						const doc = active.modalEl?.ownerDocument ?? active.containerEl?.ownerDocument;
						const closedDoc = win?.doc ?? window?.document;
						const modalWindow = ownerWindow(active.modalEl ?? active.containerEl);
						const closedWindow = window ?? win?.win ?? win?.doc?.defaultView;
						if (
							(doc && closedDoc && doc === closedDoc) ||
							(modalWindow && closedWindow && modalWindow === closedWindow)
						) {
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
			? makeLocation(this.app, base, this.settings)
			: locationFromFolder(this.app, vaultRoot, this.settings);

		if (!this.settings.browseOutsideVault) {
			const activeFile = this.app.workspace.getActiveFile();
			if (activeFile && !(activeFile instanceof TExternalFile) && !activeFile.path.startsWith('file:')) {
				return locationFromFolder(this.app, activeFile.parent ?? vaultRoot, this.settings);
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
				return locationFromFolder(this.app, activeFile.parent ?? vaultRoot, this.settings);
			}
		}

		if (!fileAbsPath) {
			return vaultRootLocation;
		}

		const parentAbsPath = getParentPath(fileAbsPath);
		return makeLocation(this.app, parentAbsPath, this.settings);
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
