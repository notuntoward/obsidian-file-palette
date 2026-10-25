// Minimal mock of the type-only `obsidian` package so that unit tests can
// resolve `import { ... } from "obsidian"` without the real Obsidian runtime.
// Extend these stubs as your tests need them.

export class Plugin {
	app: any;
	manifest: any;
	commands: any[] = [];
	settingTabs: any[] = [];
	data: unknown = null;

	constructor(app: any, manifest: any) {
		this.app = app;
		this.manifest = manifest;
	}

	async onload(): Promise<void> {}
	onunload(): void {}
	addCommand(command: any): any {
		this.commands.push(command);
		return command;
	}
	addSettingTab(tab: any): void {
		this.settingTabs.push(tab);
	}
	async loadData(): Promise<unknown> {
		return this.data;
	}
	async saveData(data: unknown): Promise<void> {
		this.data = data;
	}
	registerEvent(_event: any): void {}
	registerDomEvent(_el: any, _type: string, _callback: any): void {}
	registerInterval(_id: number): number {
		return _id;
	}
}

export class PluginSettingTab {
	app: any;
	plugin: any;
	containerEl: any;

	constructor(app: any, plugin: any) {
		this.app = app;
		this.plugin = plugin;
		installDomHelpers();
		this.containerEl = document.createElement('div');
	}

	display(): void {}
	hide(): void {}
}

export class Setting {
	static instances: Setting[] = [];
	containerEl: any;
	settingEl: any;
	controlEl: HTMLElement;
	name = '';
	toggle: {
		value: boolean;
		setValue: (value: boolean) => void;
		onChange: (callback: (value: boolean) => void | Promise<void>) => void;
		change: (value: boolean) => Promise<void>;
	} | null = null;
	text: {
		value: string;
		placeholder: string;
		inputEl: HTMLInputElement;
		setValue: (value: string) => void;
		setPlaceholder: (value: string) => void;
		onChange: (callback: (value: string) => void | Promise<void>) => void;
		change: (value: string) => Promise<void>;
	} | null = null;

	constructor(_containerEl: any) {
		this.containerEl = _containerEl;
		this.controlEl = _containerEl;
		Setting.instances.push(this);
	}

	setName(name: string): this {
		this.name = name;
		return this;
	}
	setDesc(_desc: string): this {
		return this;
	}
	addText(cb: (text: any) => any): this {
		const text = {
			value: '',
			placeholder: '',
			inputEl: document.createElement('input'),
			callback: (_value: string): void | Promise<void> => {},
			setValue(value: string) {
				this.value = value;
				this.inputEl.value = value;
				return this;
			},
			setPlaceholder(value: string) {
				this.placeholder = value;
				this.inputEl.placeholder = value;
				return this;
			},
			onChange(callback: (value: string) => void | Promise<void>) {
				this.callback = callback;
				return this;
			},
			async change(value: string): Promise<void> {
				this.value = value;
				this.inputEl.value = value;
				await this.callback(value);
			},
		};
		this.text = text;
		cb(text);
		return this;
	}
	addToggle(cb: (toggle: any) => any): this {
		const toggle = {
			value: false,
			callback: (_value: boolean): void | Promise<void> => {},
			setValue(value: boolean): void {
				this.value = value;
			},
			onChange(callback: (value: boolean) => void | Promise<void>): void {
				this.callback = callback;
			},
			async change(value: boolean): Promise<void> {
				this.value = value;
				await this.callback(value);
			},
		};
		this.toggle = toggle;
		cb(toggle);
		return this;
	}
	addButton(_cb: (button: any) => any): this {
		return this;
	}
}

export class Notice {
	static messages: string[] = [];
	static durations: (number | undefined)[] = [];

	constructor(message: string, duration?: number) {
		Notice.messages.push(message);
		Notice.durations.push(duration);
	}
	setMessage(_message: string): this {
		return this;
	}
	hide(): void {}
}

export const Platform = { isMobile: false, isMacOS: false, isDesktopApp: true, isWin: true };

export class FileSystemAdapter {
	constructor(private basePath: string = '') {}
	getBasePath(): string {
		return this.basePath;
	}
}

export class Modal {
        static instances: Modal[] = [];

	app: any;
	modalEl: HTMLElement;
	contentEl: any;
	titleEl: HTMLElement;
        scope = {
                register: (
                        _modifiers: string[] | null,
                        _key: string | null,
                        _callback: (event: KeyboardEvent) => false | void,
                ) => ({}),
        };

	constructor(app: any) {
		this.app = app;
		installDomHelpers();
		this.modalEl = document.createElement('div');
		this.contentEl = document.createElement('div');
		this.titleEl = document.createElement('div');
		this.modalEl.append(this.titleEl, this.contentEl);
                Modal.instances.push(this);
	}

	open(): void {
		this.onOpen();
	}
	close(): void {
		this.onClose();
	}
	onOpen(): void {}
	onClose(): void {}
}

export class SuggestModal<T> extends Modal {
	static instances: SuggestModal<any>[] = [];

	inputEl: HTMLInputElement;
	resultContainerEl: HTMLDivElement;
	instructions: { command: string; purpose: string }[] = [];
	placeholder = '';
	limit = 100;

	constructor(app: any) {
		super(app);
		this.inputEl = document.createElement('input');
		this.resultContainerEl = document.createElement('div');
		this.resultContainerEl.className = 'suggestion-container';
		const inputContainer = document.createElement('div');
		inputContainer.append(this.inputEl);
		this.contentEl.appendChild(this.resultContainerEl);
		this.modalEl.insertBefore(inputContainer, this.contentEl);
		SuggestModal.instances.push(this as SuggestModal<unknown>);
	}

	setPlaceholder(placeholder: string): void {
		this.placeholder = placeholder;
	}

	setTitle(title: string): void {
		this.titleEl.textContent = title;
	}

	setInstructions(instructions: { command: string; purpose: string }[]): void {
		this.instructions = instructions;
	}

	getSuggestions(_query: string): T[] {
		return [];
	}

	renderSuggestion(_value: T, _element: HTMLElement): void {}

	onChooseSuggestion(_item: T, _evt: MouseEvent | KeyboardEvent): void {}
}

export class AbstractInputSuggest<T> {
	static instances: AbstractInputSuggest<any>[] = [];
	private selectCallback: ((value: T, evt: MouseEvent | KeyboardEvent) => any) | null = null;

	constructor(public app: any, public inputEl: HTMLInputElement) {
		AbstractInputSuggest.instances.push(this as AbstractInputSuggest<unknown>);
	}

	onSelect(callback: (value: T, evt: MouseEvent | KeyboardEvent) => any): this {
		this.selectCallback = callback;
		return this;
	}

	getValue(): string {
		return this.inputEl.value;
	}

	setValue(value: string): void {
		this.inputEl.value = value;
	}

	getSuggestions(query: string): T[] {
		return query ? [] : [];
	}

	suggestions(query = this.getValue()): T[] {
		return this.getSuggestions(query);
	}

	renderSuggestion(_value: T, _element: HTMLElement): void {}

	selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): void {
		this.selectCallback?.(value, evt);
	}

	select(value: T | string): void {
		if (typeof value === 'string') {
			const suggestions = this.suggestions();
			const matched = suggestions.find((item: any) =>
				item === value || (typeof item === 'object' && item !== null && item.property === value)
			);
			if (matched) {
				this.selectSuggestion(matched as T, new KeyboardEvent('keydown'));
				return;
			}
		}
		this.selectSuggestion(value as T, new KeyboardEvent('keydown'));
	}

	close(): void {}
}

export class TAbstractFile {
	constructor(
		public name: string,
		public path: string,
	) {}
}

export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];
	parent: TFolder | null = null;
}

export class TFile extends TAbstractFile {
	basename: string;
	extension: string;

	constructor(name: string, path: string) {
		super(name, path);
		const extensionIndex = name.lastIndexOf('.');
		this.basename = extensionIndex < 0 ? name : name.slice(0, extensionIndex);
		this.extension = extensionIndex < 0 ? '' : name.slice(extensionIndex + 1);
	}
}

export class TExternalFile extends TFile {
	constructor(name: string, path: string, private realPath: string) {
		super(name, path);
	}
	getRealPath(): string {
		return this.realPath;
	}
}

export function setIcon(parent: HTMLElement, iconId: string): void {
	parent.setAttribute('data-icon', iconId);
}

export function normalizePath(path: string): string {
	return path
		.replace(/\\/g, '/')
		.replace(/\/+/g, '/')
		.replace(/^\/+/, '')
		.replace(/\/+$/, '');
}

export function prepareFuzzySearch(query: string): (text: string) => { score: number } | null {
	const normalizedQuery = query.toLowerCase();
	return (text) => {
		const index = text.toLowerCase().indexOf(normalizedQuery);
		return index < 0 ? null : {
			score: -index,
			matches: normalizedQuery ? [[index, index + normalizedQuery.length]] : [],
		};
	};
}

export function renderMatches(
	element: HTMLElement | DocumentFragment,
	text: string,
	matches: [number, number][] | null,
): void {
	let offset = 0;
	for (const [start, end] of matches ?? []) {
		element.append(document.createTextNode(text.slice(offset, start)));
		const highlight = document.createElement('span');
		highlight.className = 'suggestion-highlight';
		highlight.textContent = text.slice(start, end);
		element.append(highlight);
		offset = end;
	}
	element.append(document.createTextNode(text.slice(offset)));
}

function installDomHelpers(): void {
	if (!('createEl' in HTMLElement.prototype)) {
		Object.defineProperty(HTMLElement.prototype, 'createEl', {
			value(this: HTMLElement, tag: string, options?: { cls?: string; text?: string; type?: string }): HTMLElement {
				const element = document.createElement(tag);
				if (options?.cls) element.className = options.cls;
				if (options?.text) element.textContent = options.text;
				if (options?.type && 'type' in element) (element as HTMLInputElement).type = options.type;
				this.appendChild(element);
				return element;
			},
		});
	}
	if ('createDiv' in HTMLElement.prototype) return;

	Object.defineProperties(HTMLElement.prototype, {
		createDiv: {
			value(this: HTMLElement, options?: { cls?: string }): HTMLDivElement {
				const element = document.createElement('div');
				if (options?.cls) element.className = options.cls;
				this.appendChild(element);
				return element;
			},
		},
		createSpan: {
			value(this: HTMLElement, options?: { cls?: string }): HTMLSpanElement {
				const element = document.createElement('span');
				if (options?.cls) element.className = options.cls;
				this.appendChild(element);
				return element;
			},
		},
		setText: {
			value(this: HTMLElement, text: string): void {
				this.textContent = text;
			},
		},
		addClass: {
			value(this: HTMLElement, ...classes: string[]): void {
				this.classList.add(...classes);
			},
		},
		toggleClass: {
			value(this: HTMLElement, className: string, value?: boolean): boolean {
				return this.classList.toggle(className, value);
			},
		},
		empty: {
			value(this: HTMLElement): void {
				this.replaceChildren();
			},
		},
	});
}

export class Component {
	load(): void {}
	onload(): void {}
	unload(): void {}
	onunload(): void {}
}
