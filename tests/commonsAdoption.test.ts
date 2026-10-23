// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	alignFuzzyRanges,
	classifyLiteral,
	findLiteralRanges,
	MatchQuality,
	tokenize,
	VaultPathSuggestModal,
} from '../src/main';
import * as searchCommons from 'commons/search';
import * as workspaceCommons from 'commons/workspace';
import * as windowsCommons from 'commons/windows';
import {
	Notice,
	Platform,
	SuggestModal,
	TAbstractFile,
	TFile,
	TFolder,
} from './__mocks__/obsidian';
import type { App } from 'obsidian';

describe('commons adoption in obsidian-file-palette', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		VaultPathSuggestModal.closeActiveModal();
		SuggestModal.instances.length = 0;
		Notice.messages.length = 0;
		Platform.isMobile = false;
	});

	afterEach(() => {
		VaultPathSuggestModal.closeActiveModal();
	});

	describe('search and matching engine delegation', () => {
		it('delegates tokenize to commons/search', () => {
			const text = 'Hong20energyForecastingReview';
			expect(tokenize(text)).toEqual(searchCommons.tokenize(text));
			expect(tokenize('PDFExtractionNotes')).toEqual(['pdf', 'extraction', 'notes']);
		});

		it('delegates classifyLiteral to commons/search', () => {
			const tokens = ['energy', 'forecasting', 'review'];
			expect(classifyLiteral('energyForecastingReview', tokens, 'forecasting')).toBe(
				searchCommons.MatchQuality.WholeWord,
			);
			expect(classifyLiteral('Pinson', ['pinson'], 'pin')).toBe(
				searchCommons.MatchQuality.WordPrefix,
			);
		});

		it('delegates alignFuzzyRanges to commons/search', () => {
			const ranges: [number, number][] = [[1, 3]];
			expect(alignFuzzyRanges('energy', ranges, 'e')).toEqual(
				searchCommons.alignFuzzyRanges('energy', ranges, 'e'),
			);
		});
	});

	describe('file navigator reveal (:) multi-window and detached handling', () => {
		it('selects the file-explorer leaf matching the modal owner window and activates it', () => {
			const rootFolder = new TFolder('', '');
			const file = new TFile('test.md', 'test.md');
			(file as any).parent = rootFolder;
			rootFolder.children.push(file);

			const mainWin = window;
			const popoutDoc = document.implementation.createHTMLDocument('popout');
			const popoutWin = {
				document: popoutDoc,
				closed: false,
				focus: vi.fn(),
			} as unknown as Window;
			Object.defineProperty(popoutDoc, 'defaultView', { value: popoutWin, configurable: true });

			const revealInFolderMain = vi.fn();
			const revealInFolderPopout = vi.fn();

			const mainLeaf: any = {
				view: { revealInFolder: revealInFolderMain },
				getContainer: () => ({ win: mainWin }),
			};
			const popoutLeaf: any = {
				view: { revealInFolder: revealInFolderPopout },
				getContainer: () => ({ win: popoutWin }),
			};
			const detachedLeaf: any = {
				detached: true,
				view: { revealInFolder: vi.fn() },
				getContainer: () => ({ win: popoutWin }),
			};

			const revealLeaf = vi.fn();
			const setActiveLeaf = vi.fn();

			const mockApp: any = {
				vault: {
					getRoot: () => rootFolder,
					getAbstractFileByPath: vi.fn((path: string) => (path === '' ? rootFolder : file)),
					getFileByPath: vi.fn(() => file),
				},
				workspace: {
					getActiveFile: () => file,
					getLeavesOfType: vi.fn((type: string) => {
						if (type === 'file-explorer') return [detachedLeaf, mainLeaf, popoutLeaf];
						return [];
					}),
					revealLeaf,
					setActiveLeaf,
				},
			};

			const modal = new VaultPathSuggestModal(
				mockApp as App,
				{
					absPath: '/',
					inVault: true,
					vaultRelPath: '',
					canCreate: true,
					canLink: true,
					canReveal: true,
					list: () => [],
					parent: () => null,
				},
				true,
				[],
				false,
				false,
				false,
			);

			// Place modal in popout window DOM
			modal.containerEl = popoutDoc.createElement('div');
			popoutDoc.body.appendChild(modal.containerEl);
			modal.resultContainerEl = popoutDoc.createElement('div');
			modal.containerEl.appendChild(modal.resultContainerEl);

			const itemEl = popoutDoc.createElement('div');
			itemEl.className = 'suggestion-item is-selected';
			modal.resultContainerEl.appendChild(itemEl);

			const entry = {
				name: 'test.md',
				path: 'test.md',
				file,
				isFolder: false,
			};
			(modal as any).entryBySuggestion.set(itemEl, entry);

			const focusSpy = vi.spyOn(workspaceCommons, 'focusLeafAndWindow');

			(modal as any).runSelectedOperator(':');

			// Should pick popoutLeaf, not mainLeaf or detachedLeaf
			expect(revealInFolderPopout).toHaveBeenCalledWith(file);
			expect(revealInFolderMain).not.toHaveBeenCalled();
			expect(revealLeaf).toHaveBeenCalledWith(popoutLeaf);
			expect(focusSpy).toHaveBeenCalledWith(mockApp, popoutLeaf);
		});

		it('reveals via internal file-explorer plugin when leaf.view.revealInFolder is missing (regression test)', () => {
			const rootFolder = new TFolder('', '');
			const file = new TFile('test.md', 'test.md');
			(file as any).parent = rootFolder;
			rootFolder.children.push(file);

			const mainWin = window;
			const revealInFolderInternal = vi.fn();

			// Real Obsidian: leaf.view.revealInFolder is undefined before revealLeaf or deferred load
			const leaf: any = {
				view: { getViewType: () => 'file-explorer' },
				getContainer: () => ({ win: mainWin }),
			};

			const mockApp: any = {
				vault: {
					getRoot: () => rootFolder,
					getAbstractFileByPath: vi.fn((path: string) => (path === '' ? rootFolder : file)),
					getFileByPath: vi.fn(() => file),
				},
				workspace: {
					getActiveFile: () => file,
					getLeavesOfType: vi.fn((type: string) => (type === 'file-explorer' ? [leaf] : [])),
					revealLeaf: vi.fn(),
					setActiveLeaf: vi.fn(),
				},
				internalPlugins: {
					getPluginById: (id: string) =>
						id === 'file-explorer' ? { instance: { revealInFolder: revealInFolderInternal } } : null,
				},
			};

			const modal = new VaultPathSuggestModal(
				mockApp as App,
				{
					absPath: '/',
					inVault: true,
					vaultRelPath: '',
					canCreate: true,
					canLink: true,
					canReveal: true,
					list: () => [],
					parent: () => null,
				},
				true,
				[],
				false,
				false,
				false,
			);

			modal.containerEl = document.createElement('div');
			document.body.appendChild(modal.containerEl);
			modal.resultContainerEl = document.createElement('div');
			modal.containerEl.appendChild(modal.resultContainerEl);

			const itemEl = document.createElement('div');
			itemEl.className = 'suggestion-item is-selected';
			modal.resultContainerEl.appendChild(itemEl);

			const entry = {
				name: 'test.md',
				path: 'test.md',
				file,
				isFolder: false,
			};
			(modal as any).entryBySuggestion.set(itemEl, entry);

			const closeSpy = vi.spyOn(modal, 'close');

			(modal as any).runSelectedOperator(':');

			expect(revealInFolderInternal).toHaveBeenCalledWith(file);
			expect(Notice.messages).not.toContain('The Obsidian file navigator is not available.');
			expect(closeSpy).toHaveBeenCalled();
		});
	});

	describe('clipboard link copy owner window scoping', () => {
		it('delegates to writeClipboardIn on the modal owner window', async () => {
			const rootFolder = new TFolder('', '');
			const file = new TFile('note.md', 'note.md');
			file.basename = 'note';
			(file as any).parent = rootFolder;
			rootFolder.children.push(file);

			const popoutDoc = document.implementation.createHTMLDocument('popout');
			const popoutWin = {
				document: popoutDoc,
				closed: false,
				focus: vi.fn(),
				navigator: {
					clipboard: {
						writeText: vi.fn().mockResolvedValue(undefined),
					},
				},
			} as unknown as Window;
			Object.defineProperty(popoutDoc, 'defaultView', { value: popoutWin, configurable: true });

			const mockApp: any = {
				fileManager: {
					generateMarkdownLink: vi.fn(() => '[[note]]'),
				},
				workspace: {
					getActiveFile: () => file,
				},
			};

			const modal = new VaultPathSuggestModal(
				mockApp as App,
				{
					absPath: '/',
					inVault: true,
					vaultRelPath: '',
					canCreate: true,
					canLink: true,
					canReveal: true,
					list: () => [],
					parent: () => null,
				},
				true,
				[],
				false,
				false,
				false,
			);

			modal.containerEl = popoutDoc.createElement('div');
			popoutDoc.body.appendChild(modal.containerEl);
			modal.resultContainerEl = popoutDoc.createElement('div');
			modal.containerEl.appendChild(modal.resultContainerEl);

			const itemEl = popoutDoc.createElement('div');
			itemEl.className = 'suggestion-item is-selected';
			modal.resultContainerEl.appendChild(itemEl);

			const entry = {
				name: 'note.md',
				path: 'note.md',
				file,
				isFolder: false,
			};
			(modal as any).entryBySuggestion.set(itemEl, entry);

			const writeClipboardSpy = vi.spyOn(windowsCommons, 'writeClipboardIn');

			await (modal as any).copySelectedLink();

			expect(writeClipboardSpy).toHaveBeenCalledWith(popoutWin, '[[note]]');
			expect(Notice.messages).toContain('Link copied to clipboard.');
		});
	});

	describe('navigation timer owner window scoping', () => {
		it('uses setTimeoutIn on owner window when navigating locations and cancels on close', () => {
			const popoutDoc = document.implementation.createHTMLDocument('popout');
			const popoutWin = {
				document: popoutDoc,
				closed: false,
				setTimeout: vi.fn((_fn: () => void, _ms: number) => 1234),
				clearTimeout: vi.fn(),
			} as unknown as Window;
			Object.defineProperty(popoutDoc, 'defaultView', { value: popoutWin, configurable: true });

			const setTimeoutSpy = vi.spyOn(windowsCommons, 'setTimeoutIn');

			const mockApp: any = {
				workspace: {},
			};

			const modal = new VaultPathSuggestModal(
				mockApp as App,
				{
					absPath: '/',
					inVault: true,
					vaultRelPath: '',
					canCreate: true,
					canLink: true,
					canReveal: true,
					list: () => [],
					parent: () => null,
				},
				true,
				[],
				false,
				false,
				false,
			);

			modal.containerEl = popoutDoc.createElement('div');
			popoutDoc.body.appendChild(modal.containerEl);

			const targetLoc = {
				absPath: '/folder',
				inVault: true,
				vaultRelPath: 'folder',
				canCreate: true,
				canLink: true,
				canReveal: true,
				list: () => [],
				parent: () => null,
			};

			(modal as any).navigateToLocation(targetLoc);

			expect(setTimeoutSpy).toHaveBeenCalledWith(popoutWin, expect.any(Function), 0);

			VaultPathSuggestModal.closeActiveModal();
		});
	});
	describe('file coloring via page color props', () => {
		it('colors file suggestions with page color props and sets data-path', async () => {
			const mockApp = {
				vault: {
					getAbstractFileByPath: vi.fn(),
				},
				metadataCache: {
					getFileCache: vi.fn(),
				},
				workspace: {
					on: vi.fn(() => ({})),
				},
				plugins: {
					getPlugin: vi.fn((id: string) =>
						id === 'page-color-prop'
							? { getFileColor: (f: any) => (f.path === 'Seattle/ai-searches.md' ? '#0e9afd' : null) }
							: null,
					),
				},
			};

			const modal = new VaultPathSuggestModal(
				mockApp as unknown as App,
				{
					absPath: '/',
					inVault: true,
					vaultRelPath: '',
					canCreate: true,
					canLink: true,
					canReveal: true,
					list: () => [],
					parent: () => null,
				},
				true,
				[],
				false,
				false,
				false,
			);

			const file = new TFile('ai-searches.md', 'Seattle/ai-searches.md') as unknown as TFile;
			file.basename = 'ai-searches';
			file.extension = 'md';

			const el = document.createElement('div');
			modal.renderSuggestion(
				{ file: file as any, name: 'ai-searches.md', basename: 'ai-searches', extension: 'md', isParent: false },
				el,
			);

			const nameEl = el.querySelector('.file-palette-suggestion-name') as HTMLElement;
			expect(nameEl).not.toBeNull();
			expect(nameEl.style.getPropertyValue('--page-color')).toBe('#0e9afd');
			expect(nameEl.classList.contains('has-page-color')).toBe(true);
			expect(el.getAttribute('data-path')).toBe('Seattle/ai-searches.md');
		});
	});
});
