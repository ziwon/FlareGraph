import {
  type App,
  Notice,
  normalizePath,
  Plugin,
  PluginSettingTab,
  Setting,
  type TAbstractFile,
  TFile,
} from 'obsidian';

interface FlareGraphSettings {
  apiUrl: string;
  apiToken: string;
  accessClientId: string;
  accessClientSecret: string;
  pushOnChange: boolean;
  inboxFolder: string;
  dailyNoteFolder: string;
  dailyNoteFormatHint: string;
}

const DEFAULT_SETTINGS: FlareGraphSettings = {
  apiUrl: '',
  apiToken: '',
  accessClientId: '',
  accessClientSecret: '',
  pushOnChange: true,
  inboxFolder: 'Inbox',
  dailyNoteFolder: 'Notes/Daily',
  dailyNoteFormatHint: 'YYYY-MM-DD',
};

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export default class FlareGraphPlugin extends Plugin {
  settings: FlareGraphSettings = DEFAULT_SETTINGS;
  private statusBar!: HTMLElement;
  private pending = new Map<string, number>();

  async onload() {
    await this.loadSettings();
    this.statusBar = this.addStatusBarItem();
    this.setStatus('idle');

    // 1. Instant index trigger (planning §10.2): {path, checksum} only, no body.
    this.registerEvent(this.app.vault.on('modify', (f) => this.schedulePush(f)));
    this.registerEvent(this.app.vault.on('create', (f) => this.schedulePush(f)));
    this.registerEvent(
      this.app.vault.on('delete', (f) => {
        if (f instanceof TFile && f.extension === 'md') void this.push(f.path, undefined, true);
      }),
    );
    this.registerEvent(
      this.app.vault.on('rename', (f, oldPath) => {
        if (f instanceof TFile && f.extension === 'md') {
          void this.push(oldPath, undefined, true);
          this.schedulePush(f);
        }
      }),
    );

    // 2. Inbox consolidation (planning §6.7): local append is safe.
    this.addCommand({
      id: 'consolidate-inbox',
      name: 'Consolidate Inbox into daily note',
      callback: () => void this.consolidateInbox(),
    });

    this.addCommand({
      id: 'push-active-file',
      name: 'Push active file to cloud index',
      callback: () => {
        const f = this.app.workspace.getActiveFile();
        if (f) this.schedulePush(f, 0);
      },
    });

    this.addSettingTab(new FlareGraphSettingTab(this.app, this));
  }

  private schedulePush(f: TAbstractFile, debounceMs = 3000) {
    if (!(f instanceof TFile) || f.extension !== 'md' || !this.settings.pushOnChange) return;
    const existing = this.pending.get(f.path);
    if (existing) window.clearTimeout(existing);
    this.pending.set(
      f.path,
      window.setTimeout(() => {
        this.pending.delete(f.path);
        void this.pushFile(f);
      }, debounceMs),
    );
  }

  private async pushFile(f: TFile) {
    try {
      const content = await this.app.vault.cachedRead(f);
      await this.push(f.path, await sha256Hex(content), false);
    } catch (err) {
      console.error('flaregraph push failed', err);
      this.setStatus('push failed');
    }
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.settings.apiToken) h.Authorization = `Bearer ${this.settings.apiToken}`;
    if (this.settings.accessClientId) {
      h['CF-Access-Client-Id'] = this.settings.accessClientId;
      h['CF-Access-Client-Secret'] = this.settings.accessClientSecret;
    }
    return h;
  }

  private async push(path: string, checksum: string | undefined, deleted: boolean) {
    if (!this.settings.apiUrl) return;
    const res = await fetch(`${this.settings.apiUrl.replace(/\/$/, '')}/api/index/push`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ path, checksum, deleted }),
    });
    this.setStatus(res.ok ? `pushed ${new Date().toLocaleTimeString()}` : `push ${res.status}`);
  }

  /** Move Inbox/*.md content into today's daily note, then delete the originals.
   *  Local writes are safe (ADR-006 applies to the server only). */
  private async consolidateInbox() {
    const inbox = this.app.vault.getFolderByPath(normalizePath(this.settings.inboxFolder));
    if (!inbox) {
      new Notice(`FlareGraph: inbox folder "${this.settings.inboxFolder}" not found`);
      return;
    }
    const files = inbox.children.filter(
      (f): f is TFile => f instanceof TFile && f.extension === 'md',
    );
    if (files.length === 0) {
      new Notice('FlareGraph: inbox is empty');
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const dailyPath = normalizePath(`${this.settings.dailyNoteFolder}/${today}.md`);
    let daily = this.app.vault.getFileByPath(dailyPath);
    if (!daily) {
      const folder = this.settings.dailyNoteFolder;
      if (!this.app.vault.getFolderByPath(normalizePath(folder))) {
        await this.app.vault.createFolder(normalizePath(folder)).catch(() => {});
      }
      daily = await this.app.vault.create(dailyPath, `# ${today}\n`);
    }
    let appended = 0;
    for (const f of files) {
      const content = await this.app.vault.read(f);
      const body = content.replace(/^---[\s\S]*?---\n/, '').trim();
      if (body) {
        await this.app.vault.append(daily, `\n## Inbox: ${f.basename}\n\n${body}\n`);
        appended++;
      }
      await this.app.fileManager.trashFile(f);
    }
    new Notice(`FlareGraph: consolidated ${appended} inbox note(s) into ${dailyPath}`);
  }

  private setStatus(text: string) {
    this.statusBar.setText(`◆ FlareGraph: ${text}`);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class FlareGraphSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: FlareGraphPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Worker URL')
      .setDesc('Deployed FlareGraph worker, e.g. https://flaregraph.example.workers.dev')
      .addText((t) =>
        t.setValue(this.plugin.settings.apiUrl).onChange(async (v) => {
          this.plugin.settings.apiUrl = v.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('API token')
      .setDesc('Bearer token (if not using Cloudflare Access service tokens)')
      .addText((t) =>
        t.setValue(this.plugin.settings.apiToken).onChange(async (v) => {
          this.plugin.settings.apiToken = v.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName('Access service token: Client ID').addText((t) =>
      t.setValue(this.plugin.settings.accessClientId).onChange(async (v) => {
        this.plugin.settings.accessClientId = v.trim();
        await this.plugin.saveSettings();
      }),
    );

    new Setting(containerEl).setName('Access service token: Client Secret').addText((t) =>
      t.setValue(this.plugin.settings.accessClientSecret).onChange(async (v) => {
        this.plugin.settings.accessClientSecret = v.trim();
        await this.plugin.saveSettings();
      }),
    );

    new Setting(containerEl)
      .setName('Push on change')
      .setDesc('Send {path, checksum} to the cloud indexer when a note changes (never the body)')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.pushOnChange).onChange(async (v) => {
          this.plugin.settings.pushOnChange = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName('Inbox folder').addText((t) =>
      t.setValue(this.plugin.settings.inboxFolder).onChange(async (v) => {
        this.plugin.settings.inboxFolder = v.trim() || 'Inbox';
        await this.plugin.saveSettings();
      }),
    );

    new Setting(containerEl).setName('Daily note folder').addText((t) =>
      t.setValue(this.plugin.settings.dailyNoteFolder).onChange(async (v) => {
        this.plugin.settings.dailyNoteFolder = v.trim() || 'Notes/Daily';
        await this.plugin.saveSettings();
      }),
    );
  }
}
