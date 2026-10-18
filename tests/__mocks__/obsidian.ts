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
	name = '';
	toggle: {
		value: boolean;
		setValue: (value: boolean) => void;
		onChange: (callback: (value: boolean) => void | Promise<void>) => void;
		change: (value: boolean) => Promise<void>;
	} | null = null;

	constructor(_containerEl: any) {
		this.containerEl = _containerEl;
		Setting.instances.push(this);
	}

	setName(name: string): this {
		this.name = name;
		return this;
	}
	setDesc(_desc: string): this {
		return this;
	}
	addText(_cb: (text: any) => any): this {
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

	constructor(message: string, _timeout?: number) {
		Notice.messages.push(message);
	}
	setMessage(_message: string): this {
		return this;
	}
	hide(): void {}
}

export const Platform = { isMobile: false, isMacOS: false };

export class Modal {
	app: any;
	modalEl: HTMLElement;
	contentEl: any;
	titleEl: HTMLElement;

	constructor(app: any) {
		this.app = app;
		installDomHelpers();
		this.modalEl = document.createElement('div');
		this.contentEl = document.createElement('div');
		this.titleEl = document.createElement('div');
		this.modalEl.append(this.titleEl, this.contentEl);
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

export function prepareFuzzySearch(query: string): (text: string) => { score: number } | null {
	const normalizedQuery = query.toLowerCase();
	return (text) => {
		const index = text.toLowerCase().indexOf(normalizedQuery);
		return index < 0 ? null : { score: -index };
	};
}

function installDomHelpers(): void {
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
