import { ItemView, loadPrism, Notice, setIcon, TFile } from 'obsidian';
import type { App, ViewStateResult, WorkspaceLeaf } from 'obsidian';

export const READONLY_VIEW_TYPE = 'file-palette-readonly';

interface FileSource {
	path: string;
	inVault: boolean;
}

interface PrismApi {
	languages: Record<string, unknown>;
	highlightElement(element: Element): void;
}

function isFileSource(value: unknown): value is FileSource {
	return typeof value === 'object' && value !== null &&
		'path' in value && typeof value.path === 'string' && value.path.length > 0 &&
		'inVault' in value && typeof value.inVault === 'boolean';
}

export function getRegisteredViewType(app: App, extension: string): string | undefined {
	const registry = (app as App & {
		viewRegistry?: { getTypeByExtension?: (extension: string) => string | undefined };
	}).viewRegistry;
	if (typeof registry?.getTypeByExtension !== 'function') {
		throw new Error('Obsidian’s file type registry is unavailable.');
	}
	return registry.getTypeByExtension(extension.toLowerCase());
}

export async function readTextSource(app: App, source: FileSource): Promise<string> {
	let bytes: Uint8Array;
	if (source.inVault) {
		bytes = new Uint8Array(await app.vault.adapter.readBinary(source.path));
	} else {
		const fs: typeof import('fs') = require('fs');
		bytes = await fs.promises.readFile(source.path);
	}

	let encoding = 'utf-8';
	if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
	else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
	else if (bytes.includes(0)) throw new Error('This file is not a supported text file.');

	try {
		const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
		if (text.includes('\0')) throw new Error('Invalid text');
		return text;
	} catch {
		throw new Error('This file is not a supported text file.');
	}
}

export class ReadonlyFileView extends ItemView {
	private source: FileSource | null = null;
	private generation = 0;

	getViewType(): string {
		return READONLY_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.source?.path.split(/[\\/]/).pop() || 'Read-only file';
	}

	getIcon(): string {
		return 'lock';
	}

	getState(): Record<string, unknown> {
		return this.source ? { ...this.source } : {};
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		await super.setState(state, result);
		if (!isFileSource(state)) {
			throw new Error('Invalid read-only file view state.');
		}
		this.source = state;
		const generation = ++this.generation;
		this.contentEl.empty();
		const label = this.contentEl.createDiv({ cls: 'fp-readonly-label' });
		const icon = label.createSpan({ cls: 'fp-readonly-icon' });
		setIcon(icon, 'lock');
		label.createSpan({ text: 'Read-only' });
		try {
			const text = await readTextSource(this.app, state);
			if (generation !== this.generation) return;
			const code = this.contentEl.createEl('pre', { cls: 'fp-readonly-code' }).createEl('code');
			code.textContent = text;
			const name = state.path.split(/[\\/]/).pop() ?? '';
			const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
			if (extension && /^[a-z0-9-]+$/.test(extension)) {
				try {
					const prism: PrismApi = await loadPrism();
					if (generation !== this.generation) return;
					if (typeof prism.languages[extension] === 'object' && prism.languages[extension] !== null) {
						code.classList.add(`language-${extension}`);
						prism.highlightElement(code);
					}
				} catch (error) {
					const reason = error instanceof Error ? error.message : String(error);
					new Notice(`Could not highlight file: ${reason}`);
				}
			}
			new Notice('Opened read-only: Obsidian has no registered view for this file type.');
		} catch (error) {
			if (generation !== this.generation) return;
			const reason = error instanceof Error ? error.message : String(error);
			this.contentEl.createDiv({ cls: 'fp-readonly-error', text: `Could not read file: ${reason}` });
			new Notice(`Could not read file: ${reason}`);
		}
	}

	async onClose(): Promise<void> {
		this.generation++;
	}
}

export async function openPaletteFile(
	app: App,
	options: {
		name: string;
		absPath: string;
		vaultPath?: string;
		file: TFile | null;
		destination?: 'tab' | 'split' | 'window';
	},
): Promise<void> {
	const extensionIndex = options.name.lastIndexOf('.');
	const extension = extensionIndex > 0 ? options.name.slice(extensionIndex + 1) : '';
	const registered = getRegisteredViewType(app, extension);
	const leaf: WorkspaceLeaf = app.workspace.getLeaf(options.destination ?? false);
	if (registered) {
		const file = options.file ?? app.vault.getFileByPath(`file:${options.absPath}`) ??
			app.vault.getFileByPath(options.absPath);
		if (!(file instanceof TFile)) {
			throw new Error('Obsidian could not resolve this file for its registered view.');
		}
		await leaf.openFile(file);
		return;
	}
	const source: FileSource = options.vaultPath !== undefined
		? { path: options.vaultPath, inVault: true }
		: { path: options.absPath, inVault: false };
	await leaf.setViewState({ type: READONLY_VIEW_TYPE, state: { ...source }, active: true });
}
