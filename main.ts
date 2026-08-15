import {
  App,
  Editor,
  EditorPosition,
  FileSystemAdapter,
  ItemView,
  MarkdownView,
  Menu,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  requestUrl,
  Setting,
  TAbstractFile,
  TFile,
  TFolder,
  WorkspaceLeaf,
  moment as obsidianMoment,
  normalizePath,
} from "obsidian";
import { detectLanguage } from "./languageDetect";

/**
 * moment 类型兜底：obsidian 的 moment re-export 在部分审核环境（新版
 * TypeScript / 依赖解析差异）会退化为 any，这里显式声明所用到的 API 形状。
 */
interface QdnMoment {
  format(format?: string): string;
  startOf(unit: string): QdnMoment;
  endOf(unit: string): QdnMoment;
  clone(): QdnMoment;
  add(amount: number, unit: string): QdnMoment;
  subtract(amount: number, unit: string): QdnMoment;
  isBefore(other: QdnMoment | string, unit?: string): boolean;
  isAfter(other: QdnMoment | string, unit?: string): boolean;
  isSame(other: QdnMoment | string, unit?: string): boolean;
  isValid(): boolean;
  date(): number;
  month(): number;
}

interface QdnMomentStatic {
  (): QdnMoment;
  (input: string, format: string, strict?: boolean): QdnMoment;
}

const moment: QdnMomentStatic = obsidianMoment as unknown as QdnMomentStatic;

const VIEW_TYPE = "quick-daily-note-view";

interface TodoItem {
  text: string;
  done: boolean;
}

interface QuickDailyNoteSettings {
  /** 日记存放文件夹，空字符串表示库根目录 */
  folder: string;
  /** 日期格式（moment 语法） */
  dateFormat: string;
  /** 按日期关联的待办事项 */
  todos: Record<string, TodoItem[]>;
  /** 每天提醒添加待办 */
  todoReminderEnabled: boolean;
  todoReminderTime: string;
  /** 每天检查未完成待办并提醒 */
  checkReminderEnabled: boolean;
  checkReminderTime: string;
  /** 粘贴代码时自动识别语言并生成代码块 */
  autoDetectCodeLang: boolean;
  /** 启用"选中文本设置标题等级"命令 */
  enableHeadingLevelCommand: boolean;
  /** 粘贴图片自动保存到指定目录 */
  autoSavePastedImages: boolean;
  /** 粘贴图片保存目录（vault 内相对路径） */
  pastedImageFolder: string;
  /** 图片渲染增强 */
  imageEnhancerEnabled: boolean;
  /** 图片最大高度（视口百分比，0=不限制） */
  imageMaxHeightPct: number;
  /** mermaid 初始显示方式：width=适应宽度，original=原始大小 */
  mermaidFitMode: "width" | "original";
  /** mermaid PNG 导出倍率 */
  mermaidPngScale: number;
  /** mermaid 图表最大高度（视口百分比，0=不限制） */
  mermaidMaxHeightPct: number;
  /** 创建日记时自动记录天气 */
  weatherEnabled: boolean;
  /** 天气城市名 */
  weatherCity: string;
}

const DEFAULT_SETTINGS: QuickDailyNoteSettings = {
  folder: "",
  dateFormat: "YYYY-MM-DD",
  todos: {},
  todoReminderEnabled: false,
  todoReminderTime: "08:00",
  checkReminderEnabled: false,
  checkReminderTime: "21:00",
  autoDetectCodeLang: true,
  enableHeadingLevelCommand: true,
  autoSavePastedImages: false,
  pastedImageFolder: "attachments",
  imageEnhancerEnabled: true,
  imageMaxHeightPct: 70,
  mermaidFitMode: "width",
  mermaidPngScale: 2,
  mermaidMaxHeightPct: 60,
  weatherEnabled: false,
  weatherCity: "",
};

/** WMO 天气代码 -> 描述与图标（Open-Meteo） */
const WMO_WEATHER: Record<number, { desc: string; icon: string }> = {
  0: { desc: "晴", icon: "☀️" },
  1: { desc: "基本晴朗", icon: "🌤️" },
  2: { desc: "多云", icon: "⛅" },
  3: { desc: "阴", icon: "☁️" },
  45: { desc: "雾", icon: "🌫️" },
  48: { desc: "雾凇", icon: "🌫️" },
  51: { desc: "毛毛雨", icon: "🌦️" },
  53: { desc: "毛毛雨", icon: "🌦️" },
  55: { desc: "毛毛雨", icon: "🌦️" },
  56: { desc: "冻毛毛雨", icon: "🌧️" },
  57: { desc: "冻毛毛雨", icon: "🌧️" },
  61: { desc: "小雨", icon: "🌧️" },
  63: { desc: "中雨", icon: "🌧️" },
  65: { desc: "大雨", icon: "🌧️" },
  66: { desc: "冻雨", icon: "🌧️" },
  67: { desc: "冻雨", icon: "🌧️" },
  71: { desc: "小雪", icon: "❄️" },
  73: { desc: "中雪", icon: "❄️" },
  75: { desc: "大雪", icon: "❄️" },
  77: { desc: "雪粒", icon: "❄️" },
  80: { desc: "阵雨", icon: "🌦️" },
  81: { desc: "阵雨", icon: "🌦️" },
  82: { desc: "强阵雨", icon: "🌧️" },
  85: { desc: "阵雪", icon: "🌨️" },
  86: { desc: "强阵雪", icon: "🌨️" },
  95: { desc: "雷暴", icon: "⛈️" },
  96: { desc: "雷暴伴冰雹", icon: "⛈️" },
  99: { desc: "雷暴伴冰雹", icon: "⛈️" },
};

/** Open-Meteo 地理编码响应（仅取用字段） */
interface OpenMeteoGeocoding {
  results?: { latitude: number; longitude: number }[];
}

/** Open-Meteo 天气预报响应（仅取用字段） */
interface OpenMeteoForecast {
  current?: { temperature_2m: number; weather_code: number };
  daily?: { temperature_2m_max: number[]; temperature_2m_min: number[] };
}

/** mermaid 缩放状态 */
interface ZoomState {
  naturalW: number;
  naturalH: number;
  /** 缩放倍数，1 = 原始尺寸 */
  scale: number;
  /** 是否处于"适应宽度"模式 */
  fitted: boolean;
}

const I18N = {
  zh: {
    zoomIn: "放大",
    zoomOut: "缩小",
    reset: "重置",
    download: "下载图片",
    fitted: "适应",
    svg: "SVG（矢量）",
    png: "PNG（位图）",
    exportDone: "已下载：",
    exportFailed: "导出失败",
  },
  en: {
    zoomIn: "Zoom in",
    zoomOut: "Zoom out",
    reset: "Reset",
    download: "Download image",
    fitted: "Fit",
    svg: "SVG (vector)",
    png: "PNG (bitmap)",
    exportDone: "Downloaded: ",
    exportFailed: "Export failed",
  },
};

function getI18n(): typeof I18N.zh {
  const w = window as unknown as { moment?: { locale?: () => string } };
  const isZh = (w.moment?.locale?.() || "").toLowerCase().startsWith("zh");
  return isZh ? I18N.zh : I18N.en;
}

/** 图片扩展名集合（用于定位图片文件） */
const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "ico", "tiff",
]);

/** 扩展名 -> MIME 类型 */
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  avif: "image/avif",
  ico: "image/x-icon",
  tiff: "image/tiff",
};

export default class QuickDailyNotePlugin extends Plugin {
  settings: QuickDailyNoteSettings = DEFAULT_SETTINGS;
  /** 定时器 id */
  private reminderTimerId: number | null = null;
  /** 当天已提醒标记（YYYY-MM-DD），避免同一天重复提醒 */
  private lastTodoReminderDate = "";
  private lastCheckReminderDate = "";
  /** 图片渲染增强：DOM 监听器与已处理图片 */
  private imageObserver: MutationObserver | null = null;
  private processedImages = new WeakSet<Element>();
  /** mermaid 渲染增强 */
  private i18n = getI18n();
  private diagramCounter = 0;
  /** 已包装的 mermaid svg，防止重复处理 */
  private processedElements = new WeakSet<Element>();
  /** 滚动容器 -> 缩放状态 */
  private zoomStates = new Map<HTMLElement, ZoomState>();
  private mermaidObserver: MutationObserver | null = null;
  private printStyles: Map<HTMLElement, { css: string; overflow: string }> | null = null;

  async onload() {
    await this.loadSettings();

    this.addRibbonIcon("calendar-plus", "快捷日记", (evt) => {
      this.showMainMenu(evt);
    });

    this.addCommand({
      id: "create-daily-note",
      name: "新建日记（输入名字）",
      callback: () => this.openCreateModal(),
    });

    this.addCommand({
      id: "open-calendar-view",
      name: "打开日历与待办面板",
      callback: () => this.openCalendarView(),
    });

    this.updateHeadingCommand();

    this.addCommand({
      id: "generate-weekly-review",
      name: "生成本周回顾",
      callback: () => this.generateWeeklyReview(),
    });

    this.registerView(VIEW_TYPE, (leaf) => new CalendarView(leaf, this));

    // 粘贴代码时自动识别语言并生成代码块
    this.registerEvent(
      this.app.workspace.on("editor-paste", (evt, editor) => {
        if (evt.defaultPrevented) return;
        if (this.handleEditorPaste(evt, editor)) evt.preventDefault();
      })
    );

    // 图片与 mermaid 渲染增强：监听 DOM 变化，包装渲染结果
    this.startMermaidObserver();
    this.registerEvent(this.app.workspace.on("layout-change", () => this.processRendered()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.processRendered()));
    this.registerEvent(
      this.app.workspace.on("file-open", () => window.setTimeout(() => this.processRendered(), 200)),
    );
    this.updateImageEnhancer();
    this.app.workspace.onLayoutReady(() => this.processMermaids());

    document.addEventListener("click", this.zoomClickHandler, true);

    window.addEventListener("beforeprint", this.onBeforePrint);
    window.addEventListener("afterprint", this.onAfterPrint);

    this.setupReminderTimer();

    this.addSettingTab(new QuickDailyNoteSettingTab(this.app, this));
  }

  onunload() {
    this.imageObserver?.disconnect();
    this.imageObserver = null;
    this.mermaidObserver?.disconnect();
    this.mermaidObserver = null;
    document.removeEventListener("click", this.zoomClickHandler, true);
    window.removeEventListener("beforeprint", this.onBeforePrint);
    window.removeEventListener("afterprint", this.onAfterPrint);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<QuickDailyNoteSettings>);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /** 是否已注册"设置标题等级"命令 */
  private headingCommandRegistered = false;

  /** 按设置开关注册 / 移除"选中文本设置标题等级"命令 */
  updateHeadingCommand() {
    if (this.settings.enableHeadingLevelCommand) {
      if (this.headingCommandRegistered) return;
      this.addCommand({
        id: "set-heading-level",
        name: "选中文本设置标题等级",
        editorCallback: () => {
          new HeadingLevelModal(this.app, this).open();
        },
      });
      this.headingCommandRegistered = true;
    } else if (this.headingCommandRegistered) {
      this.removeCommand("set-heading-level");
      this.headingCommandRegistered = false;
    }
  }

  // ------------------------------------------------------------
  // 图片渲染增强
  // ------------------------------------------------------------

  /** 按设置开关注册 / 停用图片增强的 DOM 监听 */
  updateImageEnhancer() {
    if (this.settings.imageEnhancerEnabled) {
      if (this.imageObserver) return;
      this.imageObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of Array.from(mutation.addedNodes)) {
            if (node.instanceOf(Element)) this.processImageNode(node);
          }
        }
      });
      this.imageObserver.observe(document.body, { childList: true, subtree: true });
      this.app.workspace.onLayoutReady(() => this.processImages());
    } else if (this.imageObserver) {
      this.imageObserver.disconnect();
      this.imageObserver = null;
    }
  }

  /** 查找节点及其子树中可增强的图片 */
  private processImageNode(node: Element): void {
    const imgs: HTMLImageElement[] = [];
    if (node.instanceOf(HTMLImageElement)) imgs.push(node);
    imgs.push(...Array.from(node.querySelectorAll("img")));
    for (const img of imgs) {
      if (!this.processedImages.has(img) && img.isConnected) this.enhanceImage(img);
    }
  }

  private processImages(): void {
    if (!this.settings.imageEnhancerEnabled) return;
    for (const img of Array.from(document.querySelectorAll("img"))) {
      if (!this.processedImages.has(img) && img.isConnected) this.enhanceImage(img);
    }
  }

  /** 将渲染出的图片包装进增强容器并附加工具栏 */
  private enhanceImage(img: HTMLImageElement): void {
    if (this.processedImages.has(img)) return;
    const src = img.getAttribute("src") || "";
    if (!src || src.startsWith("data:") || src.startsWith("blob:")) return;
    // 跳过代码块内与已包装的图片
    if (img.closest(".qdn-img-enhancer") || img.closest("pre, code")) return;
    // 只处理编辑器 / 预览区域中的图片（跳过画布、嵌入面板等）
    if (!img.closest(".markdown-preview-view, .cm-content, .markdown-source-view")) return;

    const parent = img.parentElement;
    if (!parent || !parent.isConnected) return;
    this.processedImages.add(img);

    const wrap = createDiv({ cls: "qdn-img-enhancer" });
    parent.insertBefore(wrap, img);
    wrap.appendChild(img);

    this.applyImageSizing(wrap, img);
    this.buildImageToolbar(wrap, img);
  }

  /** 超高图自动限制高度（视口百分比），其余保持自适应宽度 */
  private applyImageSizing(wrap: HTMLElement, img: HTMLImageElement): void {
    const apply = () => {
      const pct = this.settings.imageMaxHeightPct;
      if (pct > 0 && img.naturalHeight > window.innerHeight * (pct / 100)) {
        wrap.addClass("qdn-img-tall");
        wrap.style.setProperty("--qdn-img-maxh", `${pct}vh`);
      } else {
        wrap.removeClass("qdn-img-tall");
      }
    };
    if (img.complete && img.naturalHeight > 0) apply();
    else img.addEventListener("load", apply);
  }

  /** 悬浮工具栏：裁剪 / 放大 / 复制 / 重命名 / 删除；点击图片直接放大 */
  private buildImageToolbar(wrap: HTMLElement, img: HTMLImageElement): void {
    const bar = wrap.createDiv("qdn-img-toolbar");
    const mk = (text: string, title: string, fn: () => void) => {
      bar
        .createEl("button", { cls: "qdn-img-btn", text, attr: { type: "button", title } })
        .addEventListener("click", (e) => {
          e.stopPropagation();
          fn();
        });
    };
    mk("✂", "裁剪", () => this.openCropModal(img));
    mk("⛶", "放大", () => this.openZoomModal(img));
    mk("⧉", "复制", () => void this.copyImage(img));
    mk("✎", "重命名", () => this.openRenameModal(img));
    mk("🗑", "删除", () => this.openDeleteModal(img));
  }

  /**
   * document capture 阶段拦截图片点击：
   * 在事件到达 Obsidian 内置处理器之前接管（防止其打开新标签 / 触发其他弹窗），
   * 并统一从这一处打开放大弹窗。
   */
  private zoomClickHandler = (e: MouseEvent): void => {
    if (!this.settings.imageEnhancerEnabled) return;
    const img = (e.target as HTMLElement | null)?.closest?.(".qdn-img-enhancer img");
    if (!(img instanceof HTMLImageElement)) return;
    e.preventDefault();
    e.stopPropagation();
    this.openZoomModal(img);
  };

  /** 路径规范化：统一分隔符并忽略大小写（Windows） */
  private normPath(s: string): string {
    return s.replace(/\\/g, "/").toLowerCase();
  }

  /** 由渲染出的 img 定位对应的库文件，多重保险依次尝试 */
  resolveImageFile(img: HTMLImageElement): TFile | null {
    // 1) Obsidian 嵌入元素自带 vault 相对路径（![[xxx.png]] 渲染结构）
    const embed = img.closest(".internal-embed, .image-embed");
    const embedSrc = embed?.getAttribute("src");
    if (embedSrc) {
      const f = this.app.vault.getAbstractFileByPath(normalizePath(embedSrc));
      if (f instanceof TFile && IMAGE_EXTENSIONS.has(f.extension.toLowerCase())) return f;
    }

    const raw = img.getAttribute("src") || "";
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      // 保留原始值继续尝试
    }

    // 2) 桌面端：app://local/<绝对路径>，规范化（分隔符/大小写）后与库根比对
    if (decoded.startsWith("app://local/")) {
      const adapter = this.app.vault.adapter;
      const base = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
      const abs = decoded.slice("app://local/".length);
      if (base) {
        if (this.normPath(abs).startsWith(this.normPath(base))) {
          const rel = normalizePath(abs.slice(base.length).replace(/\\/g, "/").replace(/^\/+/, ""));
          const f = this.app.vault.getAbstractFileByPath(rel);
          if (f instanceof TFile) return f;
        }
        // 3) 库根比对失败：按路径尾部匹配候选文件
        const candidates = this.app.vault.getFiles().filter(
          (f) =>
            IMAGE_EXTENSIONS.has(f.extension.toLowerCase()) &&
            this.normPath(abs).endsWith(this.normPath(f.path)),
        );
        if (candidates.length === 1) return candidates[0];
        if (candidates.length > 1 && decoded) {
          const hit = candidates.find((f) => this.normPath(decoded).includes(this.normPath(f.path)));
          if (hit) return hit;
        }
      }
    }

    // 4) 兜底：按文件名匹配（img.alt 或 src 中的文件名），唯一时返回
    const fromAlt = (img.alt || "").trim().replace(/\.\w+$/, "");
    const fromSrc = (decoded.split(/[\\/]/).pop() || "").replace(/\.\w+$/, "").split("?")[0];
    const names = [fromAlt, fromSrc].filter((n) => n.length > 0);
    for (const name of names) {
      const matches = this.app.vault.getFiles().filter(
        (f) => IMAGE_EXTENSIONS.has(f.extension.toLowerCase()) && f.basename === name,
      );
      if (matches.length === 1) return matches[0];
      if (matches.length > 1 && decoded) {
        const hit = matches.find((f) => this.normPath(decoded).includes(this.normPath(f.path)));
        if (hit) return hit;
      }
    }
    return null;
  }

  /** 复制图片到系统剪贴板 */
  copyImage(img: HTMLImageElement): Promise<void> {
    return this.doCopyImage(img);
  }

  private async doCopyImage(img: HTMLImageElement): Promise<void> {
    const file = this.resolveImageFile(img);
    if (!file) {
      new Notice("无法定位图片文件");
      return;
    }
    try {
      const buffer = await this.app.vault.readBinary(file);
      const mime = MIME_BY_EXT[file.extension.toLowerCase()] || "image/png";
      const blob = new Blob([buffer], { type: mime });
      await navigator.clipboard.write([new ClipboardItem({ [mime]: blob })]);
      new Notice("已复制图片到剪贴板");
    } catch (e) {
      console.error("Quick Daily Note: 复制图片失败", e);
      new Notice("复制图片失败，请查看控制台");
    }
  }

  /** 当前打开的图片放大弹窗（防重复打开） */
  private zoomModal: ImageZoomModal | null = null;

  private openZoomModal(img: HTMLImageElement): void {
    this.zoomModal?.close();
    this.zoomModal = new ImageZoomModal(this.app, this, img);
    this.zoomModal.open();
  }

  openCropModal(img: HTMLImageElement): void {
    const file = this.resolveImageFile(img);
    if (!file) {
      new Notice("无法定位图片文件");
      return;
    }
    new ImageCropModal(this.app, this, file).open();
  }

  openRenameModal(img: HTMLImageElement, onDone?: () => void): void {
    const file = this.resolveImageFile(img);
    if (!file) {
      new Notice("无法定位图片文件");
      return;
    }
    new RenameImageModal(this.app, this, file, onDone).open();
  }

  openDeleteModal(img: HTMLImageElement, onDone?: () => void): void {
    const file = this.resolveImageFile(img);
    if (!file) {
      new Notice("无法定位图片文件");
      return;
    }
    new DeleteImageModal(this.app, this, file, onDone).open();
  }

  /** 文件内容变更后，强制刷新页面中已渲染的该图片（加时间戳绕过缓存） */
  refreshRenderedImage(file: TFile): void {
    const fileKey = this.normPath(file.path);
    const bust = `?qdn=${Date.now()}`;
    let refreshed = false;
    for (const img of Array.from(document.querySelectorAll("img"))) {
      const raw = img.getAttribute("src") || "";
      try {
        const key = this.normPath(decodeURIComponent(raw));
        if (key.includes(fileKey) || (raw.startsWith("app://") && key.endsWith(fileKey))) {
          img.setAttribute("src", raw.split("?")[0] + bust);
          refreshed = true;
        }
      } catch {
        // 解码失败则跳过该 img
      }
    }
    // 兜底：未匹配到已渲染的图片时重渲染当前打开的预览
    if (!refreshed) {
      this.app.workspace.getActiveViewOfType(MarkdownView)?.previewMode.rerender();
    }
  }

  /** 文件删除后，隐藏页面中已渲染的该图片（Obsidian 重渲染时按失效链接处理） */
  refreshRemovedImage(file: TFile): void {
    const fileKey = this.normPath(file.path);
    let hidden = false;
    for (const img of Array.from(document.querySelectorAll("img"))) {
      const raw = img.getAttribute("src") || "";
      try {
        const key = this.normPath(decodeURIComponent(raw));
        if (key.includes(fileKey) || (raw.startsWith("app://") && key.endsWith(fileKey))) {
          img.addClass("qdn-img-hidden");
          hidden = true;
        }
      } catch {
        // 解码失败则跳过该 img
      }
    }
    // 兜底：未匹配到已渲染的图片时重渲染当前打开的预览
    if (!hidden) {
      this.app.workspace.getActiveViewOfType(MarkdownView)?.previewMode.rerender();
    }
  }

  /** 收集引用该图片文件的笔记（基于 metadataCache 的链接记录） */
  collectImageRefs(file: TFile): TFile[] {
    return this.app.vault.getMarkdownFiles().filter((md) => {
      const links = this.app.metadataCache.resolvedLinks[md.path] ?? {};
      const unresolved = this.app.metadataCache.unresolvedLinks[md.path] ?? {};
      return links[file.path] || unresolved[file.path];
    });
  }

  /** 判断链接目标是否指向指定图片（完整路径匹配或 basename 匹配） */
  private isImageRef(linkPath: string, file: TFile): boolean {
    let p = linkPath.trim();
    try {
      p = decodeURIComponent(p);
    } catch {
      // 保留原始值继续比较
    }
    p = this.normPath(p);
    if (p === this.normPath(file.path)) return true;
    // 无路径形式（![[xxx.png]]）：按文件名匹配
    return p.split("/").pop() === file.name.toLowerCase();
  }

  /**
   * 删除笔记中对该图片的所有引用（wiki 嵌入与 markdown 图片格式），
   * 代码块内的内容不处理；引用被删空的行一并移除。返回是否修改了笔记。
   */
  async removeImageLinksFromNote(note: TFile, file: TFile): Promise<boolean> {
    const content = await this.app.vault.read(note);
    const lines = content.split("\n");
    const newLines: string[] = [];
    let inFence = false;
    let changed = false;

    for (const line of lines) {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        newLines.push(line);
        continue;
      }
      if (inFence) {
        newLines.push(line);
        continue;
      }

      let newLine = line;
      // wiki 嵌入：![[路径|尺寸或别名]]
      newLine = newLine.replace(/!\[\[[^\]]*\]\]/g, (m) => {
        const inner = m.slice(3, -2);
        const linkPath = inner.split("|")[0];
        return this.isImageRef(linkPath, file) ? "" : m;
      });
      // markdown 图片：![alt](路径 "title")
      newLine = newLine.replace(/!\[[^\]]*\]\([^)]*\)/g, (m) => {
        const url = m.match(/\(([^)]*)\)/)?.[1]?.trim() ?? "";
        const linkPath = url.split(/[?#\s]/)[0];
        return this.isImageRef(linkPath, file) ? "" : m;
      });

      if (newLine !== line) {
        changed = true;
        if (newLine.trim() === "") {
          // 引用被删空的行整行移除（原本就是空白的行保留）
          if (line.trim() !== "") continue;
        }
        newLine = newLine.replace(/[ \t]+$/, "");
      }
      newLines.push(newLine);
    }

    if (changed) {
      await this.app.vault.modify(note, newLines.join("\n"));
    }
    return changed;
  }

  // ------------------------------------------------------------
  // Mermaid 渲染增强（整合自 Mermaid Enhancer 插件）
  // 实现策略：Obsidian 内置 mermaid 渲染器会先把 code.language-mermaid
  // 替换为渲染结果（div.mermaid > svg）。插件通过 MutationObserver 监听，
  // 在内置渲染完成后将 svg 包装进增强容器（自适应宽度 / 缩放工具栏 /
  // 下载），并统一处理打印（PDF 导出）样式。
  // ------------------------------------------------------------

  private startMermaidObserver(): void {
    this.mermaidObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of Array.from(mutation.addedNodes)) {
          if (node.instanceOf(Element)) this.processMermaidNode(node);
        }
      }
    });
    this.mermaidObserver.observe(document.body, { childList: true, subtree: true });
  }

  /** 图片与 mermaid 统一扫描入口 */
  private processRendered(): void {
    this.processImages();
    this.processMermaids();
  }

  /** 查找节点及其子树中 Obsidian 内置渲染出的 mermaid svg */
  private processMermaidNode(node: Element): void {
    const selectors = 'svg[id^="mermaid-"], .mermaid svg';
    const svgs: Element[] = [];
    if (node.matches(selectors)) svgs.push(node);
    svgs.push(...Array.from(node.querySelectorAll(selectors)));
    for (const svg of svgs) {
      if (!this.processedElements.has(svg) && svg.isConnected) this.wrap(svg as SVGSVGElement);
    }
  }

  private processMermaids(): void {
    const svgs = document.querySelectorAll('svg[id^="mermaid-"], .mermaid svg');
    for (const svg of Array.from(svgs)) {
      if (!this.processedElements.has(svg) && svg.isConnected) this.wrap(svg as SVGSVGElement);
    }
  }

  /** 将内置渲染结果包装进增强容器 */
  private wrap(svg: SVGSVGElement): void {
    const mermaidContainer = svg.closest(".mermaid");
    const target = mermaidContainer || svg;
    const parent = target.parentElement;
    if (!parent || !parent.isConnected) return;

    // 已被本插件或其他缩放插件处理过，跳过
    if (parent.hasClass("mermaid-enhancer-scroll")) return;
    if (parent.hasClass("mermaid-zoom-content") || parent.parentElement?.hasClass("mermaid-zoom-container")) return;
    if (target.closest(".mermaid-enhancer-container")) return;

    // 读取原始尺寸（width/height 属性优先，兜底用 viewBox / 实际渲染尺寸）
    const wAttr = parseFloat(svg.getAttribute("width") || "");
    const hAttr = parseFloat(svg.getAttribute("height") || "");
    const vb = svg.viewBox.baseVal;
    const rect = svg.getBoundingClientRect();
    const naturalW = wAttr > 0 ? wAttr : vb.width > 0 ? vb.width : rect.width || 300;
    const naturalH = hAttr > 0 ? hAttr : vb.height > 0 ? vb.height : rect.height || 200;
    if (naturalW <= 0 || naturalH <= 0) return;

    // 去掉 mermaid 写死的 max-width 内联样式，改由插件控制自适应
    if (svg.style.maxWidth) svg.style.removeProperty("max-width");

    const container = createDiv("mermaid-enhancer-container");
    const scroll = container.createDiv("mermaid-enhancer-scroll");
    parent.insertBefore(container, target);
    scroll.appendChild(target);

    const state: ZoomState = {
      naturalW,
      naturalH,
      scale: 1,
      fitted: this.settings.mermaidFitMode === "width",
    };
    this.zoomStates.set(scroll, state);

    this.buildMermaidToolbar(container, scroll, svg, state);
    this.applyZoom(scroll, state);
    this.processedElements.add(svg);
  }

  // ------------------------------------------------------------
  // 缩放控制
  // ------------------------------------------------------------

  private getSvg(scroll: HTMLElement): SVGSVGElement | null {
    return scroll.querySelector<SVGSVGElement>('svg[id^="mermaid-"], .mermaid svg');
  }

  private applyZoom(scroll: HTMLElement, state: ZoomState): void {
    const svg = this.getSvg(scroll);
    if (!svg) return;
    if (state.fitted) {
      const pct = this.settings.mermaidMaxHeightPct;
      if (pct > 0 && state.naturalH > state.naturalW) {
        // 高图：限制高度，宽度按比例自动计算（不超过容器宽度），避免占用大量空间
        svg.removeClass("me-fit-width", "me-zoom-px");
        svg.addClass("me-fit-tall");
        svg.style.removeProperty("width");
        svg.style.height = `${pct}vh`;
      } else {
        // 宽图：适应宽度，高度按比例自动计算
        svg.removeClass("me-fit-tall", "me-zoom-px");
        svg.addClass("me-fit-width");
        svg.style.removeProperty("width");
        svg.style.removeProperty("height");
      }
    } else {
      svg.removeClass("me-fit-width", "me-fit-tall");
      svg.addClass("me-zoom-px");
      svg.style.removeProperty("height");
      svg.style.width = `${Math.max(1, Math.round(state.naturalW * state.scale))}px`;
    }
    const percent = scroll.closest(".mermaid-enhancer-container")?.querySelector(".me-percent");
    if (percent) {
      percent.textContent = state.fitted ? this.i18n.fitted : `${Math.round(state.scale * 100)}%`;
    }
  }

  private zoomBy(scroll: HTMLElement, state: ZoomState, factor: number): void {
    if (state.fitted) {
      // 从"适应"模式切换到像素缩放：以当前适应比例作为起点，平滑过渡
      state.fitted = false;
      const availW = scroll.parentElement?.clientWidth || state.naturalW;
      state.scale = Math.max(0.05, Math.min(1, availW / state.naturalW));
    }
    state.scale = Math.min(8, Math.max(0.05, state.scale * factor));
    this.applyZoom(scroll, state);
  }

  private resetZoom(scroll: HTMLElement, state: ZoomState): void {
    state.fitted = this.settings.mermaidFitMode === "width";
    state.scale = 1;
    this.applyZoom(scroll, state);
  }

  // ------------------------------------------------------------
  // 工具栏
  // ------------------------------------------------------------

  private buildMermaidToolbar(
    container: HTMLElement,
    scroll: HTMLElement,
    svg: SVGSVGElement,
    state: ZoomState,
  ): void {
    const toolbar = container.createDiv("mermaid-enhancer-toolbar");

    const zoomOut = toolbar.createEl("button", {
      cls: "me-btn",
      text: "−",
      attr: { type: "button", title: this.i18n.zoomOut },
    });
    toolbar.createSpan({ cls: "me-percent" });
    const zoomIn = toolbar.createEl("button", {
      cls: "me-btn",
      text: "+",
      attr: { type: "button", title: this.i18n.zoomIn },
    });
    const reset = toolbar.createEl("button", {
      cls: "me-btn",
      text: "↺",
      attr: { type: "button", title: this.i18n.reset },
    });
    const download = toolbar.createEl("button", {
      cls: "me-btn me-download",
      text: "⬇",
      attr: { type: "button", title: this.i18n.download },
    });

    zoomOut.addEventListener("click", (e) => {
      e.stopPropagation();
      this.zoomBy(scroll, state, 1 / 1.25);
    });
    zoomIn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.zoomBy(scroll, state, 1.25);
    });
    reset.addEventListener("click", (e) => {
      e.stopPropagation();
      this.resetZoom(scroll, state);
    });

    // 下载菜单（SVG / PNG）
    const menu = toolbar.createDiv({ cls: "me-download-menu" });
    menu.createEl("button", {
      cls: "me-menu-item",
      text: this.i18n.svg,
      attr: { type: "button" },
    }).addEventListener("click", (e) => {
      e.stopPropagation();
      menu.removeClass("me-open");
      void this.downloadAsSVG(svg, state);
    });
    menu.createEl("button", {
      cls: "me-menu-item",
      text: this.i18n.png,
      attr: { type: "button" },
    }).addEventListener("click", (e) => {
      e.stopPropagation();
      menu.removeClass("me-open");
      void this.downloadAsPNG(svg, state);
    });

    download.addEventListener("click", (e) => {
      e.stopPropagation();
      menu.toggleClass("me-open", !menu.hasClass("me-open"));
    });
    // 点击其他区域关闭菜单；容器销毁后自动移除监听，避免泄漏
    const closeMenu = () => {
      if (!menu.isConnected) {
        document.removeEventListener("click", closeMenu);
        return;
      }
      menu.removeClass("me-open");
    };
    document.addEventListener("click", closeMenu);

    this.applyZoom(scroll, state);
  }

  // ------------------------------------------------------------
  // 下载图片
  // ------------------------------------------------------------

  private getFileName(ext: string): string {
    const base = this.app.workspace.getActiveFile()?.basename || "mermaid";
    return `${base}-mermaid-${this.diagramCounter + 1}.${ext}`;
  }

  private downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = createEl("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    this.diagramCounter++;
  }

  private async downloadAsSVG(svg: SVGSVGElement, state: ZoomState): Promise<void> {
    try {
      const clone = svg.cloneNode(true) as SVGSVGElement;
      clone.setAttribute("width", String(state.naturalW));
      clone.setAttribute("height", String(state.naturalH));
      clone.removeAttribute("style");
      const xml = new XMLSerializer().serializeToString(clone);
      const filename = this.getFileName("svg");
      this.downloadBlob(new Blob([xml], { type: "image/svg+xml;charset=utf-8" }), filename);
      new Notice(`${this.i18n.exportDone}${filename}`);
    } catch (e) {
      console.error("[Mermaid Enhancer]", e);
      new Notice(this.i18n.exportFailed);
    }
  }

  private async downloadAsPNG(svg: SVGSVGElement, state: ZoomState): Promise<void> {
    const scale = Math.max(1, Math.round(this.settings.mermaidPngScale) || 2);
    try {
      const url = this.svgToBlobURL(svg, state);
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("PNG 生成失败（SVG 加载失败）"));
        img.src = url;
      });
      const canvas = createEl("canvas");
      canvas.width = Math.round(state.naturalW * scale);
      canvas.height = Math.round(state.naturalH * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas 不可用");
      ctx.fillStyle = this.getBackgroundColor();
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
      if (!blob) throw new Error("PNG 生成失败");
      const filename = this.getFileName("png");
      this.downloadBlob(blob, filename);
      new Notice(`${this.i18n.exportDone}${filename}`);
    } catch (e) {
      console.error("[Mermaid Enhancer]", e);
      new Notice(this.i18n.exportFailed);
    }
  }

  /** 序列化 SVG 为 Blob URL（克隆时把 foreignObject 转成普通 text，避免 PNG 丢失文字） */
  private svgToBlobURL(svg: SVGSVGElement, state: ZoomState): string {
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("width", String(state.naturalW));
    clone.setAttribute("height", String(state.naturalH));
    clone.removeAttribute("style");
    this.normalizeForeignObjects(svg, clone, state);
    const xml = new XMLSerializer().serializeToString(clone);
    return URL.createObjectURL(new Blob([xml], { type: "image/svg+xml;charset=utf-8" }));
  }

  /**
   * mermaid 的 htmlLabel 使用 foreignObject 承载 HTML 文本，
   * 当 SVG 作为 <img> 加载时浏览器不会渲染其中的 HTML，导致 PNG 导出文字丢失。
   * 这里将 foreignObject 转换为普通 <text> 元素（位置/字号取自原始 DOM）。
   */
  private normalizeForeignObjects(src: SVGSVGElement, clone: SVGSVGElement, state: ZoomState): void {
    const srcFos = Array.from(src.querySelectorAll("foreignObject"));
    const cloneFos = Array.from(clone.querySelectorAll("foreignObject"));
    if (srcFos.length === 0) return;

    const srcRect = src.getBoundingClientRect();
    const displayScale = srcRect.width > 0 ? srcRect.width / state.naturalW : 1;
    const ns = "http://www.w3.org/2000/svg";

    cloneFos.forEach((cfo, i) => {
      const sfo = srcFos[i];
      if (!sfo) {
        cfo.remove();
        return;
      }
      const div = sfo.querySelector("div, span");
      if (!div) {
        cfo.remove();
        return;
      }
      const text = this.flattenLabelText(div as HTMLElement);
      if (!text.trim()) {
        cfo.remove();
        return;
      }

      const r = div.getBoundingClientRect();
      const style = getComputedStyle(div);
      const fontSize = parseFloat(style.fontSize) || 16;
      const lineHeight = fontSize * 1.2;
      const centerX = (r.left + r.width / 2 - srcRect.left) / displayScale;
      const topY = (r.top - srcRect.top) / displayScale;
      const anchor = style.textAlign === "left" ? "start" : "middle";
      const lines = text.split("\n");

      lines.forEach((line, li) => {
        if (!line.trim()) return;
        const t = document.createElementNS(ns, "text");
        t.setAttribute("x", String(anchor === "middle" ? centerX : (r.left - srcRect.left) / displayScale));
        t.setAttribute("y", String(topY + fontSize + li * lineHeight));
        t.setAttribute("font-size", fontSize + "px");
        t.setAttribute("font-family", style.fontFamily || "inherit");
        t.setAttribute("font-weight", style.fontWeight || "normal");
        t.setAttribute("text-anchor", anchor);
        t.setAttribute("fill", style.color || "#000");
        t.textContent = line;
        cfo.parentElement?.insertBefore(t, cfo);
      });
      cfo.remove();
    });
  }

  /** 提取 label 文本并保留 <br/> 换行 */
  private flattenLabelText(el: HTMLElement): string {
    // 遍历子节点提取文本：<br/> 转换行，避免 innerHTML 拼接带来的注入风险
    let out = "";
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeName === "BR") {
        out += "\n";
      } else if (node.nodeType === Node.TEXT_NODE) {
        out += node.textContent ?? "";
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        out += this.flattenLabelText(node as HTMLElement);
      }
    }
    return out;
  }

  /** 取当前 Obsidian 主题的背景色，作为 PNG 画布底色 */
  private getBackgroundColor(): string {
    const bg = getComputedStyle(document.body).backgroundColor;
    if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg;
    return document.body.classList.contains("theme-dark") ? "#1e1e1e" : "#ffffff";
  }

  // ------------------------------------------------------------
  // Mermaid 设置变更响应
  // ------------------------------------------------------------

  onMermaidFitModeChanged(): void {
    for (const [scroll, state] of Array.from(this.zoomStates)) {
      if (!scroll.isConnected) {
        this.zoomStates.delete(scroll);
        continue;
      }
      state.fitted = this.settings.mermaidFitMode === "width";
      state.scale = 1;
      this.applyZoom(scroll, state);
    }
  }

  onMermaidMaxHeightChanged(): void {
    for (const [scroll, state] of Array.from(this.zoomStates)) {
      if (!scroll.isConnected) {
        this.zoomStates.delete(scroll);
        continue;
      }
      this.applyZoom(scroll, state);
    }
  }

  // ------------------------------------------------------------
  // 打印 / 导出 PDF 增强
  // ------------------------------------------------------------

  private onBeforePrint = (): void => {
    // 记录当前缩放状态，打印时强制恢复为适应页面宽度，防止图片被裁剪
    const saved = new Map<HTMLElement, { css: string; overflow: string }>();
    for (const [scroll] of Array.from(this.zoomStates)) {
      if (!scroll.isConnected) {
        this.zoomStates.delete(scroll);
        continue;
      }
      const svg = this.getSvg(scroll);
      if (!svg) continue;
      saved.set(scroll, { css: svg.style.cssText, overflow: scroll.style.overflow });
      // 清除内联尺寸，交给 @media print 中的 !important 规则接管
      svg.style.removeProperty("width");
      svg.style.removeProperty("height");
      svg.style.removeProperty("max-width");
      svg.style.removeProperty("max-height");
      const container = scroll.closest(".mermaid-enhancer-container");
      if (container) container.addClass("me-printing");
    }
    this.printStyles = saved;
  };

  private onAfterPrint = (): void => {
    this.printStyles?.forEach((saved, scroll) => {
      const svg = this.getSvg(scroll);
      if (svg) svg.style.cssText = saved.css;
      scroll.style.overflow = saved.overflow;
      const container = scroll.closest(".mermaid-enhancer-container");
      if (container) container.removeClass("me-printing");
    });
    this.printStyles = null;
  };

  /**
   * 粘贴事件处理：
   * 1. 启用时，图片粘贴自动保存到指定目录并插入链接；
   * 2. 粘贴内容明显是代码且光标不在代码块内时，识别语言并生成代码块。
   */
  /** 返回是否已处理该粘贴事件（true 时由调用方 preventDefault） */
  private handleEditorPaste(evt: ClipboardEvent, editor: Editor): boolean {
    if (this.settings.autoSavePastedImages) {
      const images = this.pastedImages(evt);
      if (images.length > 0) {
        void this.savePastedImages(images, editor);
        return true;
      }
    }

    if (!this.settings.autoDetectCodeLang) return false;
    if (evt.defaultPrevented) return false; // 已被其他插件处理

    const data = evt.clipboardData;
    if (!data || data.files.length > 0) return false; // 文件粘贴不干预

    const text = data.getData("text/plain");
    if (!text.trim()) return false;

    // 整块复制了已有围栏的代码，保持原样
    if (/^\s*(```|~~~)/.test(text)) return false;

    // 光标已在代码块内：交给编辑器默认行为
    if (isInsideCodeBlock(editor, editor.getCursor())) return false;

    const lang = detectLanguage(text, text.includes("\n"));
    if (!lang) return false;

    insertCodeBlock(editor, text, lang);
    new Notice(`已识别为 ${lang} 代码块`, 2500);
    return true;
  }

  /** 从剪贴板提取图片文件 */
  private pastedImages(evt: ClipboardEvent): File[] {
    const data = evt.clipboardData;
    if (!data || data.files.length === 0) return [];
    return Array.from(data.files).filter((f) => f.type.startsWith("image/"));
  }

  /** 将图片保存到设置目录，并在光标处插入图片链接 */
  private async savePastedImages(images: File[], editor: Editor) {
    try {
      const folder = normalizePath(this.settings.pastedImageFolder.trim());
      await this.ensureFolder(folder);

      const links: string[] = [];
      for (const image of images) {
        const ext = this.imageExtension(image);
        const name = await this.uniqueAttachmentName(folder, ext);
        const buffer = await image.arrayBuffer();
        await this.app.vault.createBinary(normalizePath(`${folder}/${name}`), buffer);
        links.push(`![[${name}]]`);
      }

      const cursor = editor.getCursor();
      const line = editor.getLine(cursor.line);
      const prefix = line.slice(0, cursor.ch).trim() ? "\n" : "";
      const suffix = line.slice(cursor.ch).trim() ? "\n" : "";
      editor.replaceSelection(`${prefix}${links.join(" ")}${suffix}`);
      new Notice(`已保存 ${images.length} 张图片到 ${folder || "库根目录"}`, 3000);
    } catch (e) {
      console.error("Quick Daily Note: 保存粘贴图片失败", e);
      new Notice("保存粘贴图片失败，请查看控制台");
    }
  }

  /** 由 MIME 类型推断图片扩展名，未知时用文件名兜底 */
  private imageExtension(file: File): string {
    const map: Record<string, string> = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/gif": "gif",
      "image/webp": "webp",
      "image/svg+xml": "svg",
      "image/bmp": "bmp",
      "image/avif": "avif",
      "image/x-icon": "ico",
    };
    if (map[file.type]) return map[file.type];
    const m = /\.(\w+)$/.exec(file.name);
    return m ? m[1].toLowerCase() : "png";
  }

  /** 生成不重名的图片文件名：Pasted image YYYYMMDDHHmmss，重名自动加序号 */
  private async uniqueAttachmentName(folder: string, ext: string): Promise<string> {
    const base = `Pasted image ${moment().format("YYYYMMDDHHmmss")}`;
    let name = `${base}.${ext}`;
    let i = 1;
    while (this.app.vault.getAbstractFileByPath(normalizePath(`${folder}/${name}`))) {
      name = `${base}-${i}.${ext}`;
      i++;
    }
    return name;
  }

  openCreateModal() {
    new CreateDailyNoteModal(this.app, this).open();
  }

  /**
   * 日记图标点击：弹出菜单选择打开今天的日记或日历与待办面板。
   */
  private showMainMenu(evt: MouseEvent) {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("打开今天的日记")
        .setIcon("calendar-plus")
        .onClick(() => this.handleRibbonClick())
    );
    menu.addItem((item) =>
      item
        .setTitle("日历与待办面板")
        .setIcon("calendar-days")
        .onClick(() => this.openCalendarView())
    );
    menu.showAtMouseEvent(evt);
  }

  /**
   * Ribbon 图标点击：今天已有日记则直接打开，否则弹出新建弹窗。
   */
  async handleRibbonClick() {
    const todayStr = moment().format(this.settings.dateFormat);
    await this.openOrCreateDailyNote(todayStr);
  }

  /**
   * 打开或创建指定日期的日记：已有日记直接打开（多篇时打开名字排序第一篇），
   * 没有则弹窗输入名字创建。
   */
  async openOrCreateDailyNote(dateStr: string) {
    const folderPath = normalizePath(this.settings.folder);
    const folder = folderPath
      ? this.app.vault.getAbstractFileByPath(folderPath)
      : this.app.vault.getRoot();

    const file = this.findDailyNote(folder, dateStr);
    if (file) {
      void this.app.workspace.getLeaf(false).openFile(file);
      return;
    }
    new CreateDailyNoteModal(this.app, this, dateStr).open();
  }

  /** 日记存放文件夹（不存在时返回 null） */
  getDiaryFolder(): TFolder | null {
    const folderPath = normalizePath(this.settings.folder);
    const f = folderPath
      ? this.app.vault.getAbstractFileByPath(folderPath)
      : this.app.vault.getRoot();
    return f instanceof TFolder ? f : null;
  }

  /** 在指定文件夹中查找日期前缀匹配的日记文件，多篇时返回名字排序第一篇 */
  findDailyNote(
    folder: TAbstractFile | null,
    dateStr: string
  ): TFile | null {
    if (!(folder instanceof TFolder)) return null;

    const matches = folder.children.filter(
      (child): child is TFile =>
        child instanceof TFile &&
        child.extension === "md" &&
        child.name.startsWith(`${dateStr} `)
    );
    if (matches.length === 0) return null;

    matches.sort((a, b) => a.name.localeCompare(b.name));
    return matches[0];
  }

  /** 收集文件夹内所有日记文件的日期集合（用于日历打点标记） */
  getDiaryDateSet(): Set<string> {
    const folderPath = normalizePath(this.settings.folder);
    const folder = folderPath
      ? this.app.vault.getAbstractFileByPath(folderPath)
      : this.app.vault.getRoot();
    const set = new Set<string>();
    if (!(folder instanceof TFolder)) return set;

    for (const child of folder.children) {
      if (child instanceof TFile && child.extension === "md") {
        const firstPart = child.name.split(" ")[0];
        if (firstPart) set.add(firstPart);
      }
    }
    return set;
  }

  /**
   * 创建日记：标题 = 日期 + 名字，存放在配置的文件夹中；
   * 同名文件已存在时直接打开，不重复创建。
   */
  async createDailyNote(name: string, dateStr?: string) {
    const date = dateStr ?? moment().format(this.settings.dateFormat);
    const title = `${date} ${name}`;
    const folderPath = normalizePath(this.settings.folder);
    const filePath = normalizePath(
      folderPath ? `${folderPath}/${title}.md` : `${title}.md`
    );

    await this.ensureFolder(folderPath);

    const existing = this.app.vault.getAbstractFileByPath(filePath);
    if (existing instanceof TFile) {
      void this.app.workspace.getLeaf(false).openFile(existing);
      new Notice(`日记已存在，已打开：${title}`);
      this.refreshViews();
      return;
    }

    const file = await this.app.vault.create(filePath, `# ${title}\n`);
    // 创建后自动记录当天天气（异步，失败不影响创建）
    void this.appendWeatherToNote(file);
    void this.app.workspace.getLeaf(false).openFile(file);
    new Notice(`已创建日记：${title}`);
    this.refreshViews();
  }

  /** 文件夹不存在时按层级逐级创建 */
  private async ensureFolder(folderPath: string) {
    if (!folderPath) return;
    if (this.app.vault.getAbstractFileByPath(folderPath)) return;

    const parts = folderPath.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  /** 打开右侧边栏的日历与待办面板，已打开时直接聚焦复用 */
  async openCalendarView() {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE);
    if (existing.length > 0) {
      void workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = workspace.getRightLeaf(false);
    if (!leaf) {
      new Notice("无法打开侧边栏面板");
      return;
    }
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    void workspace.revealLeaf(leaf);
  }

  /** 通知所有日历面板实例刷新 */
  refreshViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof CalendarView) view.refresh();
    }
  }

  /**
   * 将源日期未完成待办顺延到目标日期（带"昨日遗留"标记）。
   * 源日期的未完成项被移走（保留已完成项），避免重复顺延。
   */
  async carryOverTodos(fromDate: string, toDate: string) {
    const items = this.settings.todos[fromDate] ?? [];
    const pending = items.filter((i) => !i.done);
    if (pending.length === 0) return 0;
    const target = this.settings.todos[toDate] ?? [];
    target.push(...pending.map((i) => ({ text: `[昨日遗留] ${i.text}`, done: false })));
    this.settings.todos[toDate] = target;
    this.settings.todos[fromDate] = items.filter((i) => i.done);
    await this.saveSettings();
    this.refreshViews();
    return pending.length;
  }

  /** 判断目标日期是否已包含顺延过来的待办（避免重复顺延） */
  hasCarriedOver(dateStr: string): boolean {
    return (this.settings.todos[dateStr] ?? []).some((i) => i.text.startsWith("[昨日遗留]"));
  }

  /**
   * 生成本周回顾：汇总本周日记、完成/未完成待办与统计，插入当前笔记光标处。
   */
  async generateWeeklyReview() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const editor = view?.editor;
    if (!editor) {
      new Notice("请先打开一个笔记，回顾内容将插入到光标处");
      return;
    }

    const start = moment().startOf("isoWeek");
    const end = moment().endOf("isoWeek");
    const lines: string[] = [];
    lines.push(`## 本周回顾（${start.format("M月D日")} ~ ${end.format("M月D日")}）`);
    lines.push("");

    // 日记汇总
    const folderPath = normalizePath(this.settings.folder);
    const folder = folderPath
      ? this.app.vault.getAbstractFileByPath(folderPath)
      : this.app.vault.getRoot();
    let diaryDays = 0;
    let diaryChars = 0;
    const diaryLines: string[] = [];
    if (folder instanceof TFolder) {
      for (const child of folder.children) {
        if (!(child instanceof TFile) || child.extension !== "md") continue;
        const dateStr = child.name.split(" ")[0];
        const d = moment(dateStr, this.settings.dateFormat, true);
        if (!d.isValid() || d.isBefore(start, "day") || d.isAfter(end, "day")) continue;
        diaryDays++;
        const content = await this.app.vault.read(child);
        diaryChars += content.replace(/\s+/g, "").length;
        diaryLines.push(`- ${d.format("MM-DD dddd")}《${child.basename}》`);
      }
    }
    lines.push(`### 本周日记（${diaryDays} 天，共 ${diaryChars} 字）`);
    lines.push(...(diaryLines.length > 0 ? diaryLines : ["- 本周没有写日记"]));
    lines.push("");

    // 待办汇总
    const doneLines: string[] = [];
    const pendingLines: string[] = [];
    for (let d = start.clone(); d.isBefore(end) || d.isSame(end, "day"); d.add(1, "day")) {
      const dateStr = d.format(this.settings.dateFormat);
      const dateLabel = d.format("MM-DD dddd");
      for (const item of this.settings.todos[dateStr] ?? []) {
        if (item.done) doneLines.push(`- [x] ${item.text}（${dateLabel}）`);
        else pendingLines.push(`- [ ] ${item.text}（${dateLabel}）`);
      }
    }
    lines.push(`### 待办完成（${doneLines.length} 项）`);
    lines.push(...(doneLines.length > 0 ? doneLines : ["- 本周没有完成待办"]));
    lines.push("");
    lines.push(`### 待办未完成（${pendingLines.length} 项）`);
    lines.push(...(pendingLines.length > 0 ? pendingLines : ["- 本周待办全部完成"]));

    const text = lines.join("\n");
    const cursor = editor.getCursor();
    const line = editor.getLine(cursor.line);
    const prefix = line.slice(0, cursor.ch).trim() ? "\n" : "";
    const suffix = line.slice(cursor.ch).trim() ? "\n" : "";
    editor.replaceSelection(`${prefix}${text}${suffix}`);
    new Notice("已插入本周回顾");
  }

  /** 获取指定城市当天天气（Open-Meteo，无需 API key），失败返回 null */
  async fetchWeather(city: string): Promise<string | null> {
    try {
      const geo = (await requestUrl({
        url: `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh`,
      })).json as OpenMeteoGeocoding;
      const hit = geo.results?.[0];
      if (!hit) return null;
      const data = (await requestUrl({
        url: `https://api.open-meteo.com/v1/forecast?latitude=${hit.latitude}&longitude=${hit.longitude}&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=auto&forecast_days=1`,
      })).json as OpenMeteoForecast;
      const code = data.current?.weather_code;
      const w = WMO_WEATHER[code ?? -1] ?? { desc: "未知", icon: "" };
      const temp = Math.round(data.current?.temperature_2m ?? 0);
      const tmax = Math.round(data.daily?.temperature_2m_max?.[0] ?? temp);
      const tmin = Math.round(data.daily?.temperature_2m_min?.[0] ?? temp);
      return `${w.icon} ${w.desc} ${temp}°C（${tmin}~${tmax}°C）`;
    } catch (e) {
      console.warn("Quick Daily Note: 获取天气失败", e);
      return null;
    }
  }

  /** 把天气信息写入日记标题之后（失败静默，不阻塞创建） */
  private async appendWeatherToNote(file: TFile) {
    if (!this.settings.weatherEnabled || !this.settings.weatherCity.trim()) return;
    const weather = await this.fetchWeather(this.settings.weatherCity.trim());
    if (!weather) return;
    try {
      const content = await this.app.vault.read(file);
      const lines = content.split("\n");
      lines.splice(1, 0, `> ${weather}`);
      await this.app.vault.modify(file, lines.join("\n"));
    } catch (e) {
      console.warn("Quick Daily Note: 写入天气失败", e);
    }
  }

  async addTodo(dateStr: string, text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (!this.settings.todos[dateStr]) this.settings.todos[dateStr] = [];
    this.settings.todos[dateStr].push({ text: trimmed, done: false });
    await this.saveSettings();
    this.refreshViews();
  }

  async toggleTodo(dateStr: string, index: number) {
    const items = this.settings.todos[dateStr];
    if (!items || !items[index]) return;
    items[index].done = !items[index].done;
    await this.saveSettings();
    this.refreshViews();
  }

  async deleteTodo(dateStr: string, index: number) {
    const items = this.settings.todos[dateStr];
    if (!items) return;
    items.splice(index, 1);
    await this.saveSettings();
    this.refreshViews();
  }

  /** 修改待办文字内容，空文本不生效 */
  async updateTodoText(dateStr: string, index: number, text: string) {
    const items = this.settings.todos[dateStr];
    if (!items || !items[index]) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    items[index].text = trimmed;
    await this.saveSettings();
    this.refreshViews();
  }

   /**
   * 调整选中文本中的标题等级：最大标题（等级数字最小）变为 targetLevel，
   * 其余标题保持相对层级依次平移；选中文本中没有标题时返回 null。
   */
  adjustHeadings(text: string, targetLevel: number): string | null {
    const headingRe = /^(#{1,6})(.*)$/;
    const lines = text.split("\n");

    let minLevel = 7;
    for (const line of lines) {
      const m = line.match(headingRe);
      if (m && m[1].length < minLevel) minLevel = m[1].length;
    }
    if (minLevel === 7) return null;

    const offset = targetLevel - minLevel;
    return lines
      .map((line) => {
        const m = line.match(headingRe);
        if (!m) return line;
        const level = Math.min(6, Math.max(1, m[1].length + offset));
        return `${"#".repeat(level)}${m[2]}`;
      })
      .join("\n");
  }

  /**
   * 设置定时提醒：每 30 秒检查一次是否到达提醒时间。
   * 启用时若当天时间点已过，则当天不再提醒（从次日生效）。
   */
  setupReminderTimer() {
    if (this.reminderTimerId !== null) {
      window.clearInterval(this.reminderTimerId);
      this.reminderTimerId = null;
    }
    if (!this.settings.todoReminderEnabled && !this.settings.checkReminderEnabled) {
      return;
    }

    const now = moment();
    const todayStr = now.format("YYYY-MM-DD");
    const nowTime = now.format("HH:mm");
    this.lastTodoReminderDate =
      nowTime >= this.settings.todoReminderTime ? todayStr : "";
    this.lastCheckReminderDate =
      nowTime >= this.settings.checkReminderTime ? todayStr : "";

    this.reminderTimerId = window.setInterval(() => this.checkReminders(), 30000);
  }

  /** 检查是否到达提醒时间点并触发提醒 */
  private checkReminders() {
    const now = moment();
    const todayStr = now.format("YYYY-MM-DD");
    const nowTime = now.format("HH:mm");

    if (
      this.settings.todoReminderEnabled &&
      nowTime >= this.settings.todoReminderTime &&
      this.lastTodoReminderDate !== todayStr
    ) {
      this.lastTodoReminderDate = todayStr;
      const notice = new Notice(
        "该添加今天的待办事项了，点击打开日历面板",
        10000
      );
      notice.messageEl.addClass("qdn-notice");
      notice.messageEl.addEventListener("click", () => {
        notice.hide();
        void this.openCalendarView();
      });
    }

    if (
      this.settings.checkReminderEnabled &&
      nowTime >= this.settings.checkReminderTime &&
      this.lastCheckReminderDate !== todayStr
    ) {
      this.lastCheckReminderDate = todayStr;
      const pendingCount = this.countTodayPendingTodos();
      if (pendingCount > 0) {
        const notice = new Notice(
          `今天还有 ${pendingCount} 项待办未完成，点击打开日历面板`,
          10000
        );
        notice.messageEl.addClass("qdn-notice");
        notice.messageEl.addEventListener("click", () => {
          notice.hide();
          void this.openCalendarView();
        });
      }
    }
  }

  /** 统计当天日期的未完成待办数量 */
  private countTodayPendingTodos(): number {
    const todayStr = moment().format(this.settings.dateFormat);
    return (this.settings.todos[todayStr] ?? []).filter(
      (item) => !item.done
    ).length;
  }
}

// ------------------------------------------------------------
// 粘贴代码块辅助函数
// ------------------------------------------------------------

/** 判断光标所在行是否位于代码块（``` 或 ~~~ 围栏）内部 */
function isInsideCodeBlock(editor: Editor, cursor: EditorPosition): boolean {
  let inBlock = false;
  for (let i = 0; i <= cursor.line; i++) {
    if (/^\s*(```|~~~)/.test(editor.getLine(i))) inBlock = !inBlock;
  }
  return inBlock;
}

/** 在光标处插入带语言围栏的代码块，前后自动补空行使代码块独立成段 */
function insertCodeBlock(editor: Editor, code: string, lang: string): void {
  const clean = code.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  const fence = "```";
  const block = `${fence}${lang}\n${clean}\n${fence}`;

  const cursor = editor.getCursor();
  const line = editor.getLine(cursor.line);
  const prefix = line.slice(0, cursor.ch).trim() ? "\n" : "";
  const suffix = line.slice(cursor.ch).trim() ? "\n" : "";
  editor.replaceSelection(`${prefix}${block}${suffix}`);
}

class CalendarView extends ItemView {
  private plugin: QuickDailyNotePlugin;
  /** 当前展示的年月 */
  private viewMoment: ReturnType<typeof moment>;
  /** 当前选中的日期（dateFormat 格式） */
  private selectedDate: string;
  /** 正在编辑的待办索引，null 表示无编辑状态 */
  private editingIndex: number | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: QuickDailyNotePlugin) {
    super(leaf);
    this.plugin = plugin;
    this.viewMoment = moment().startOf("month");
    this.selectedDate = moment().format(plugin.settings.dateFormat);
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return "快捷日记";
  }

  getIcon(): string {
    return "calendar-days";
  }

  async onOpen() {
    this.render();
  }

  async onClose() {}

  refresh() {
    this.render();
  }

  private render() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("qdn-panel");
    this.renderCalendar(containerEl);
    this.renderTodos(containerEl);
  }

  private renderCalendar(root: HTMLElement) {
    const wrapper = root.createDiv("qdn-calendar");
    const header = wrapper.createDiv("qdn-cal-header");

    const prevBtn = header.createEl("button", { text: "‹", cls: "qdn-cal-nav" });
    prevBtn.setAttr("aria-label", "上个月");
    prevBtn.addEventListener("click", () => {
      this.viewMoment.subtract(1, "month");
      this.render();
    });

    header.createDiv("qdn-cal-title").setText(this.viewMoment.format("YYYY年M月"));

    const nextBtn = header.createEl("button", { text: "›", cls: "qdn-cal-nav" });
    nextBtn.setAttr("aria-label", "下个月");
    nextBtn.addEventListener("click", () => {
      this.viewMoment.add(1, "month");
      this.render();
    });

    const grid = wrapper.createDiv("qdn-cal-grid");
    for (const weekday of ["一", "二", "三", "四", "五", "六", "日"]) {
      grid.createDiv("qdn-cal-cell qdn-cal-weekday").setText(weekday);
    }

    const diarySet = this.plugin.getDiaryDateSet();
    const todayStr = moment().format(this.plugin.settings.dateFormat);
    const dateFormat = this.plugin.settings.dateFormat;
    const gridStart = this.viewMoment
      .clone()
      .startOf("month")
      .startOf("isoWeek");

    for (let i = 0; i < 42; i++) {
      const day = gridStart.clone().add(i, "day");
      const dateStr = day.format(dateFormat);
      const cell = grid.createDiv("qdn-cal-cell");
      cell.setText(day.date().toString());

      if (day.month() !== this.viewMoment.month()) {
        cell.addClass("qdn-cal-outside");
      }
      if (dateStr === todayStr) cell.addClass("qdn-cal-today");
      if (dateStr === this.selectedDate) cell.addClass("qdn-cal-selected");
      if (diarySet.has(dateStr)) cell.createSpan("qdn-cal-dot");

      cell.addEventListener("click", () => {
        // 单击仅切换选中日期与待办列表，不打开日记
        this.selectedDate = dateStr;
        this.render();
      });
      cell.addEventListener("dblclick", () => {
        // 双击打开/创建该日日记
        void this.plugin.openOrCreateDailyNote(dateStr);
      });
    }

    this.renderStats(wrapper);
  }

  /** 日记统计：本月天数 / 连续天数 / 今日字数 */
  private renderStats(wrapper: HTMLElement) {
    const diarySet = this.plugin.getDiaryDateSet();
    const dateFormat = this.plugin.settings.dateFormat;

    // 本月写日记天数（用严格解析过滤非日期命名文件）
    let monthCount = 0;
    for (const s of diarySet) {
      const d = moment(s, dateFormat, true);
      if (d.isValid() && d.format("YYYY-MM") === this.viewMoment.format("YYYY-MM")) monthCount++;
    }

    // 连续写日记天数（从今天往回数，上限 730 天防死循环）
    let streak = 0;
    for (let d = moment(), guard = 0; guard < 730; guard++, d.subtract(1, "day")) {
      if (diarySet.has(d.format(dateFormat))) streak++;
      else break;
    }

    const stats = wrapper.createDiv("qdn-stats");
    stats.createSpan().setText(`本月 ${monthCount} 天`);
    stats.createSpan().setText(`连续 ${streak} 天`);
    const wordEl = stats.createSpan();
    const todayFile = this.plugin.findDailyNote(this.plugin.getDiaryFolder(), moment().format(dateFormat));
    if (todayFile) {
      wordEl.setText("今日 …");
      void this.loadWordCount(todayFile, wordEl);
    } else {
      wordEl.setText("今日未写");
    }
  }

  private async loadWordCount(file: TFile, el: HTMLElement) {
    try {
      const content = await this.plugin.app.vault.read(file);
      el.setText(`今日 ${content.replace(/\s+/g, "").length} 字`);
    } catch {
      el.setText("今日 0 字");
    }
  }

  private renderTodos(root: HTMLElement) {
    const wrapper = root.createDiv("qdn-todos");

    // 昨日未完成待办顺延提示（仅今天显示，且今天尚未顺延过）
    const todayStr = moment().format(this.plugin.settings.dateFormat);
    if (this.selectedDate === todayStr) {
      const yesterdayStr = moment().subtract(1, "day").format(this.plugin.settings.dateFormat);
      const pendingCount = (this.plugin.settings.todos[yesterdayStr] ?? []).filter(
        (i) => !i.done,
      ).length;
      if (pendingCount > 0 && !this.plugin.hasCarriedOver(todayStr)) {
        const banner = wrapper.createDiv("qdn-carryover");
        banner.createSpan().setText(`昨天有 ${pendingCount} 项待办未完成`);
        banner
          .createEl("button", { text: "顺延到今天", cls: "qdn-carryover-btn" })
          .addEventListener("click", () => {
            void this.plugin.carryOverTodos(yesterdayStr, todayStr);
          });
      }
    }

    const header = wrapper.createDiv("qdn-todos-header");
    const dateLabel = header.createDiv("qdn-todos-date");
    dateLabel.createSpan().setText(`待办 · ${this.selectedDate}`);
    dateLabel
      .createEl("button", { text: "打开日记", cls: "qdn-open-note-btn" })
      .addEventListener("click", () => {
        void this.plugin.openOrCreateDailyNote(this.selectedDate);
      });

    const items = this.plugin.settings.todos[this.selectedDate] ?? [];
    const pending = items.filter((item) => !item.done).length;
    header.createSpan({ cls: "qdn-todos-count" }).setText(`${pending} 项未完成`);

    const list = wrapper.createDiv("qdn-todo-list");
    if (items.length === 0) {
      list.createDiv("qdn-todo-empty").setText("暂无待办，添加一条吧");
    } else {
      items.forEach((item, index) => {
        const row = list.createDiv("qdn-todo-item");
        if (item.done) row.addClass("qdn-todo-completed");
        const checkbox = row.createEl("input", { type: "checkbox" });
        checkbox.checked = item.done;
        checkbox.addEventListener("change", () => {
          void this.plugin.toggleTodo(this.selectedDate, index);
        });

        if (this.editingIndex === index) {
          // 编辑状态：渲染输入框，回车保存、Esc 取消、失焦保存
          const input = row.createEl("input", {
            type: "text",
            cls: "qdn-todo-edit-input",
          });
          input.value = item.text;
          input.addEventListener("keydown", (evt) => {
            if (evt.key === "Enter") {
              evt.preventDefault();
                void this.plugin.updateTodoText(this.selectedDate, index, input.value);
              this.editingIndex = null;
              this.render();
            } else if (evt.key === "Escape") {
              this.editingIndex = null;
              this.render();
            }
          });
          input.addEventListener("blur", () => {
            if (this.editingIndex !== index) return;
            void this.plugin.updateTodoText(this.selectedDate, index, input.value);
            this.editingIndex = null;
          });
          window.setTimeout(() => {
            input.focus();
            input.select();
          }, 0);
        } else {
          const text = row.createDiv("qdn-todo-text");
          text.setText(item.text);
          text.addEventListener("dblclick", () => {
            this.editingIndex = index;
            this.render();
          });

          const editBtn = row.createEl("button", {
            text: "✎",
            cls: "qdn-todo-edit-btn",
          });
          editBtn.setAttr("aria-label", "编辑");
          editBtn.addEventListener("click", () => {
            this.editingIndex = index;
            this.render();
          });
        }

        row
          .createEl("button", { text: "×", cls: "qdn-todo-delete" })
          .addEventListener("click", () => {
            void this.plugin.deleteTodo(this.selectedDate, index);
          });
      });
    }

    const inputRow = wrapper.createDiv("qdn-todo-add");
    const input = inputRow.createEl("input", {
      type: "text",
      placeholder: "添加待办，回车确认",
    });
    input.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        void this.plugin.addTodo(this.selectedDate, input.value);
        input.value = "";
      }
    });
    inputRow
      .createEl("button", { text: "添加", cls: "qdn-todo-add-btn" })
      .addEventListener("click", () => {
        void this.plugin.addTodo(this.selectedDate, input.value);
        input.value = "";
      });
  }
}

class CreateDailyNoteModal extends Modal {
  private plugin: QuickDailyNotePlugin;
  private dateStr: string;

  constructor(app: App, plugin: QuickDailyNotePlugin, dateStr?: string) {
    super(app);
    this.plugin = plugin;
    this.dateStr = dateStr ?? moment().format(plugin.settings.dateFormat);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("qdn-modal");
    contentEl.empty();

    contentEl.createEl("h3", { text: `新建日记 ${this.dateStr}` });

    const input = contentEl.createEl("input", {
      type: "text",
      placeholder: "输入日记名字，例如：项目周报",
    });
    input.addClass("qdn-input");
    input.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        this.submit(input.value);
      }
    });

    const buttonRow = contentEl.createDiv("qdn-actions");
    const createBtn = buttonRow.createEl("button", {
      text: "创建",
      cls: "mod-cta",
    });
    createBtn.addEventListener("click", () => this.submit(input.value));
    buttonRow
      .createEl("button", { text: "取消" })
      .addEventListener("click", () => {
        this.close();
      });

    window.setTimeout(() => input.focus(), 50);
  }

  private submit(name: string) {
    const trimmed = name.trim();
    if (!trimmed) {
      new Notice("请输入日记名字");
      return;
    }
    void this.plugin.createDailyNote(trimmed, this.dateStr);
    this.close();
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

class HeadingLevelModal extends Modal {
  private plugin: QuickDailyNotePlugin;

  constructor(app: App, plugin: QuickDailyNotePlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("qdn-modal");
    contentEl.empty();

    contentEl.createEl("h3", { text: "设置标题等级" });
    contentEl
      .createDiv("qdn-heading-hint")
      .setText("文本块内最大标题将变为所选等级，子标题保持相对层级");

    const grid = contentEl.createDiv("qdn-heading-grid");
    const names = [
      "一级标题",
      "二级标题",
      "三级标题",
      "四级标题",
      "五级标题",
      "六级标题",
    ];
    for (let level = 1; level <= 6; level++) {
      const btn = grid.createEl("button", { cls: "qdn-heading-btn" });
      btn.type = "button";
      btn.setText("#".repeat(level) + " " + names[level - 1]);
      btn.addEventListener("click", () => this.applyLevel(level));
    }
  }

  /** 点击等级时重新获取活动编辑器与选区，保证引用有效 */
  private applyLevel(level: number) {
    try {
      const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
      const editor = view?.editor;
      const selection = editor?.getSelection() ?? "";
      if (!editor || !selection) {
        new Notice("请先在笔记中选中文本块");
        return;
      }

      const newText = this.plugin.adjustHeadings(selection, level);
      if (newText === null) {
        new Notice("选中的文本中没有标题");
        return;
      }
      editor.replaceSelection(newText);
    } catch (e) {
      console.error("Quick Daily Note: 设置标题等级失败", e);
      new Notice("设置标题等级失败，请查看控制台");
    } finally {
      this.close();
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

/**
 * 图片放大弹窗：点击图片 / 点击遮罩 / 按 Esc 均可关闭，
 * 工具栏提供裁剪、复制、重命名、删除。
 */
class ImageZoomModal extends Modal {
  private plugin: QuickDailyNotePlugin;
  private img: HTMLImageElement;

  constructor(app: App, plugin: QuickDailyNotePlugin, img: HTMLImageElement) {
    super(app);
    this.plugin = plugin;
    this.img = img;
  }

  /** capture 级监听，避免被编辑器等其他按键处理拦截 */
  private escHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  };

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("qdn-img-zoom");
    contentEl.empty();
    // 弹窗宽度贴合图片，避免大图四周留白
    this.modalEl.addClass("qdn-img-zoom-modal");

    // 图片容器：工具栏绝对定位悬浮在图片右上方
    const body = contentEl.createDiv("qdn-img-zoom-body");
    const imgEl = body.createEl("img", {
      attr: { src: this.img.getAttribute("src") || "" },
    });
    imgEl.addEventListener("click", (e) => {
      e.stopPropagation();
      this.close();
    });
    // 图片加载完成后按适屏显示宽度调整弹窗宽度（防止被 Modal 默认宽度截住）
    imgEl.addEventListener("load", () => {
      const naturalW = imgEl.naturalWidth;
      const naturalH = imgEl.naturalHeight;
      if (naturalW <= 0 || naturalH <= 0) return;
      const availW = window.innerWidth * 0.96;
      const availH = window.innerHeight * 0.88;
      const scale = Math.min(1, availW / naturalW, availH / naturalH);
      const displayW = Math.ceil(naturalW * scale);
      this.modalEl.style.width =
        Math.min(displayW + 12, Math.floor(window.innerWidth * 0.96)) + "px";
    });

    const file = this.plugin.resolveImageFile(this.img);
    if (file) {
      const bar = body.createDiv("qdn-img-zoom-toolbar");
      const mk = (text: string, title: string, fn: () => void) => {
        bar
          .createEl("button", { cls: "qdn-img-btn", text, attr: { type: "button", title } })
          .addEventListener("click", (e) => {
            e.stopPropagation();
            fn();
          });
      };
      mk("✂", "裁剪", () => this.plugin.openCropModal(this.img));
      mk("⧉", "复制到剪贴板", () => void this.plugin.copyImage(this.img));
      mk("✎", "重命名", () => this.plugin.openRenameModal(this.img, () => this.close()));
      mk("🗑", "删除", () => this.plugin.openDeleteModal(this.img, () => this.close()));
    }

    contentEl.createDiv("qdn-img-zoom-hint").setText("点击图片、遮罩或按 Esc 关闭");
    // 遮罩（.modal-bg）是 modalEl 的兄弟元素，点击遮罩关闭
    const modalBg = this.modalEl.previousElementSibling as HTMLElement | null;
    if (modalBg) modalBg.addEventListener("click", () => this.close());
    document.addEventListener("keydown", this.escHandler, true);
  }

  onClose() {
    document.removeEventListener("keydown", this.escHandler, true);
    const { contentEl } = this;
    contentEl.empty();
  }
}

/** 图片裁剪弹窗：拖拽选择区域，确认后按原图分辨率裁切并覆盖保存 */
class ImageCropModal extends Modal {
  private plugin: QuickDailyNotePlugin;
  private file: TFile;
  private area!: HTMLElement;
  private image!: HTMLImageElement;
  private selector!: HTMLElement;
  private sizeLabel!: HTMLElement;
  private hint!: HTMLElement;
  private cropBtn!: HTMLButtonElement;
  private naturalW = 0;
  private naturalH = 0;
  private startX = 0;
  private startY = 0;
  private rect: { x: number; y: number; w: number; h: number } | null = null;
  private url = "";

  /** 拖拽结束后触发（挂在 document 上，鼠标移出图片区域也能正常结束） */
  private handleMouseMove = (e: MouseEvent) => {
    if (!this.rect) return;
    const rect = this.area.getBoundingClientRect();
    const x = e.clientX - rect.left + this.area.scrollLeft;
    const y = e.clientY - rect.top + this.area.scrollTop;
    this.rect.x = Math.min(this.startX, x);
    this.rect.y = Math.min(this.startY, y);
    this.rect.w = Math.abs(x - this.startX);
    this.rect.h = Math.abs(y - this.startY);
    this.updateSelector();
  };

  private handleMouseUp = () => {
    document.removeEventListener("mousemove", this.handleMouseMove);
    document.removeEventListener("mouseup", this.handleMouseUp);
    if (!this.rect) return;
    if (this.rect.w < 2 || this.rect.h < 2) {
      // 误触 / 选区过小：清空并提示重新选择
      this.rect = null;
      this.selector.hide();
      this.sizeLabel.hide();
      this.cropBtn.hide();
      this.hint.setText("选区太小，请在图片上重新拖拽选择裁剪区域");
      return;
    }
    // 选区有效：弹出裁剪按钮
    this.cropBtn.show();
    this.hint.setText("已选中区域，点击「裁剪」完成，或重新拖拽调整选区");
  };

  constructor(app: App, plugin: QuickDailyNotePlugin, file: TFile) {
    super(app);
    this.plugin = plugin;
    this.file = file;
  }

  onOpen() {
    const { contentEl } = this;
    this.modalEl.addClass("qdn-crop-modal");
    contentEl.empty();
    contentEl.createEl("h3", { text: `裁剪图片：${this.file.name}` });
    void this.loadImage();
  }

  private async loadImage() {
    try {
      const buffer = await this.plugin.app.vault.readBinary(this.file);
      const mime = MIME_BY_EXT[this.file.extension.toLowerCase()] || "image/png";
      this.url = URL.createObjectURL(new Blob([buffer], { type: mime }));
      this.image = new Image();
      await new Promise<void>((resolve, reject) => {
        this.image.onload = () => resolve();
        this.image.onerror = () => reject(new Error("图片加载失败"));
        this.image.src = this.url;
      });
      this.naturalW = this.image.naturalWidth;
      this.naturalH = this.image.naturalHeight;

      const { contentEl } = this;
      this.area = contentEl.createDiv("qdn-crop-area");
      this.area.appendChild(this.image);
      // 弹窗宽度贴合图片适屏显示宽度（同放大弹窗）
      const availW = window.innerWidth * 0.96;
      const availH = window.innerHeight * 0.88;
      const scale = Math.min(1, availW / this.naturalW, availH / this.naturalH);
      const displayW = Math.ceil(this.naturalW * scale);
      this.modalEl.style.width =
        Math.min(displayW + 12, Math.floor(window.innerWidth * 0.96)) + "px";

      this.selector = this.area.createDiv("qdn-crop-select");
      this.selector.hide();
      this.sizeLabel = this.area.createDiv("qdn-crop-size");
      this.sizeLabel.hide();
      this.hint = contentEl.createDiv("qdn-crop-hint");
      this.hint.setText("按住鼠标拖拽选择裁剪区域，松开鼠标后确认");

      // 工具栏浮动在图片右上方（拦截 mousedown，避免误触发选区）
      const bar = this.area.createDiv("qdn-crop-toolbar");
      bar.addEventListener("mousedown", (e) => e.stopPropagation());
      this.cropBtn = bar.createEl("button", { text: "裁剪", cls: "mod-cta" });
      this.cropBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.applyCrop();
      });
      // 拖拽完成前不显示裁剪按钮，避免误点
      this.cropBtn.hide();
      bar.createEl("button", { text: "取消" }).addEventListener("click", (e) => {
        e.stopPropagation();
        this.close();
      });

      this.area.addEventListener("mousedown", (e) => this.onMouseDown(e));
    } catch (e) {
      console.error("Quick Daily Note: 加载图片失败", e);
      new Notice("加载图片失败");
      this.close();
    }
  }

  /** 选区坐标换算：显示尺寸 -> 原图像素 */
  private toNatural(value: number, natural: number, displayed: number): number {
    return Math.max(0, Math.round((value * natural) / displayed));
  }

  private onMouseDown(e: MouseEvent) {
    e.preventDefault();
    const rect = this.area.getBoundingClientRect();
    this.startX = e.clientX - rect.left + this.area.scrollLeft;
    this.startY = e.clientY - rect.top + this.area.scrollTop;
    this.rect = { x: this.startX, y: this.startY, w: 0, h: 0 };
    this.cropBtn.hide();
    this.hint.setText("松开鼠标完成选区");
    this.updateSelector();
    // 监听挂到 document：鼠标移出图片区域再松开也能正常结束
    document.addEventListener("mousemove", this.handleMouseMove);
    document.addEventListener("mouseup", this.handleMouseUp);
  }

  private updateSelector() {
    if (!this.rect) return;
    this.selector.show();
    this.selector.style.left = this.rect.x + "px";
    this.selector.style.top = this.rect.y + "px";
    this.selector.style.width = this.rect.w + "px";
    this.selector.style.height = this.rect.h + "px";
    this.sizeLabel.show();
    this.sizeLabel.style.left = this.rect.x + "px";
    this.sizeLabel.style.top = Math.max(0, this.rect.y - 20) + "px";
    this.sizeLabel.setText(`${this.rect.w} × ${this.rect.h}`);
  }

  /** 按选区裁切并覆盖保存原文件 */
  private async applyCrop() {
    if (!this.rect || this.rect.w < 2 || this.rect.h < 2) {
      new Notice("请先拖拽选择裁剪区域");
      return;
    }
    const areaRect = this.area.getBoundingClientRect();
    const scaleX = this.naturalW / areaRect.width;
    const scaleY = this.naturalH / areaRect.height;
    const sx = this.toNatural(this.rect.x, this.naturalW, areaRect.width);
    const sy = this.toNatural(this.rect.y, this.naturalH, areaRect.height);
    const sw = Math.max(1, Math.round(this.rect.w * scaleX));
    const sh = Math.max(1, Math.round(this.rect.h * scaleY));

    try {
      const canvas = createEl("canvas");
      canvas.width = sw;
      canvas.height = sh;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas 不可用");
      ctx.drawImage(this.image, sx, sy, sw, sh, 0, 0, sw, sh);
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
      if (!blob) throw new Error("裁剪结果生成失败");
      await this.plugin.app.vault.modifyBinary(this.file, await blob.arrayBuffer());
      // 文件已更新，强制刷新页面中已渲染的该图片
      this.plugin.refreshRenderedImage(this.file);
      new Notice("已裁剪图片");
      this.close();
    } catch (e) {
      console.error("Quick Daily Note: 裁剪图片失败", e);
      new Notice("裁剪图片失败，请查看控制台");
    }
  }

  onClose() {
    if (this.url) URL.revokeObjectURL(this.url);
    const { contentEl } = this;
    contentEl.empty();
  }
}

class RenameImageModal extends Modal {
  private plugin: QuickDailyNotePlugin;
  private file: TFile;
  private onRenamed?: () => void;

  constructor(app: App, plugin: QuickDailyNotePlugin, file: TFile, onRenamed?: () => void) {
    super(app);
    this.plugin = plugin;
    this.file = file;
    this.onRenamed = onRenamed;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("qdn-modal");
    contentEl.empty();
    contentEl.createEl("h3", { text: "重命名图片" });

    const input = contentEl.createEl("input", { type: "text", placeholder: "输入新文件名" });
    input.addClass("qdn-input");
    input.value = this.file.basename;
    input.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        void this.submit(input.value);
      }
    });

    const buttonRow = contentEl.createDiv("qdn-actions");
    buttonRow
      .createEl("button", { text: "重命名", cls: "mod-cta" })
      .addEventListener("click", () => void this.submit(input.value));
    buttonRow.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());

    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 50);
  }

  private async submit(name: string) {
    const trimmed = name.trim();
    if (!trimmed) {
      new Notice("请输入文件名");
      return;
    }
    // 扩展名保持不变，避免已插入的链接失效
    const base = trimmed.replace(/\.\w+$/, "");
    if (base === this.file.basename) {
      this.close();
      return;
    }
    const folder = this.file.parent?.path ?? "";
    const newPath = normalizePath(
      folder ? `${folder}/${base}.${this.file.extension}` : `${base}.${this.file.extension}`,
    );
    if (this.app.vault.getAbstractFileByPath(newPath)) {
      new Notice("该名称已存在");
      return;
    }
    try {
      await this.app.vault.rename(this.file, newPath);
      new Notice("已重命名");
      this.close();
      this.onRenamed?.();
    } catch (e) {
      console.error("Quick Daily Note: 重命名图片失败", e);
      new Notice("重命名失败，请查看控制台");
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

class DeleteImageModal extends Modal {
  private plugin: QuickDailyNotePlugin;
  private file: TFile;
  private onDeleted?: () => void;

  constructor(app: App, plugin: QuickDailyNotePlugin, file: TFile, onDeleted?: () => void) {
    super(app);
    this.plugin = plugin;
    this.file = file;
    this.onDeleted = onDeleted;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("qdn-modal");
    contentEl.empty();
    contentEl.createEl("h3", { text: "删除图片" });
    contentEl
      .createDiv("qdn-heading-hint")
      .setText(`确定删除图片「${this.file.name}」吗？文件将移动到系统回收站。`);

    const buttonRow = contentEl.createDiv("qdn-actions");
    buttonRow
      .createEl("button", { text: "删除", cls: "mod-cta qdn-danger-btn" })
      .addEventListener("click", () => void this.doDelete());
    buttonRow.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
  }

  private async doDelete() {
    try {
      // 先记录引用该图片的笔记（文件删除后 metadataCache 会更新，需提前收集）
      const refNotes = this.plugin.collectImageRefs(this.file);
      await this.plugin.app.fileManager.trashFile(this.file);
      // 隐藏页面中已渲染的该图片
      this.plugin.refreshRemovedImage(this.file);

      // 同步清理笔记中的引用链接
      let cleaned = 0;
      for (const note of refNotes) {
        try {
          if (await this.plugin.removeImageLinksFromNote(note, this.file)) cleaned++;
        } catch (e) {
          console.error(`Quick Daily Note: 清理引用失败（${note.path}）`, e);
        }
      }
      new Notice(
        cleaned > 0
          ? `已删除：${this.file.name}（并清理 ${cleaned} 篇笔记中的引用）`
          : `已删除：${this.file.name}`,
        4000,
      );
      this.close();
      this.onDeleted?.();
    } catch (e) {
      console.error("Quick Daily Note: 删除图片失败", e);
      new Notice("删除失败，请查看控制台");
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

/** 声明式设置条目（Obsidian 1.13+ 设置搜索 API 的最小形状） */
interface QdnSettingDefinition {
  name: string;
  desc?: string;
}

class QuickDailyNoteSettingTab extends PluginSettingTab {
  plugin: QuickDailyNotePlugin;

  constructor(app: App, plugin: QuickDailyNotePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /** 声明式设置定义：让设置项出现在 Obsidian 1.13+ 的设置搜索中 */
  getSettingDefinitions(): QdnSettingDefinition[] {
    return [
      { name: "存放位置", desc: "日记文件的存放文件夹，留空则存放在库根目录" },
      { name: "日期格式", desc: "moment 日期格式，例如：YYYY-MM-DD" },
      { name: "粘贴代码自动识别语言", desc: "粘贴代码时自动识别编程语言并生成代码块" },
      { name: "选中文本设置标题等级", desc: "将选中文本块内的标题统一调整到指定等级" },
      { name: "粘贴图片保存到指定目录", desc: "粘贴图片自动保存到指定目录并插入链接" },
      { name: "图片渲染增强", desc: "图片自适应宽度，工具栏可裁剪、放大、复制、重命名、删除" },
      { name: "Mermaid 图表", desc: "初始显示方式、PNG 导出倍率、图表最大高度" },
      { name: "创建日记时自动记录天气", desc: "创建日记后自动写入当天天气（Open-Meteo）" },
      { name: "定时提醒", desc: "添加待办提醒与未完成待办检查" },
    ];
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("快捷日记设置").setHeading();

    new Setting(containerEl)
      .setName("存放位置")
      .setDesc("日记文件的存放文件夹，留空则存放在库根目录（例如：日记/工作）")
      .addText((text) =>
        text
          .setPlaceholder("日记")
          .setValue(this.plugin.settings.folder)
          .onChange(async (value) => {
            this.plugin.settings.folder = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("日期格式")
      .setDesc("使用 moment 日期格式，例如：YYYY-MM-DD 或 YYYYMMDD")
      .addText((text) =>
        text
          .setPlaceholder("YYYY-MM-DD")
          .setValue(this.plugin.settings.dateFormat)
          .onChange(async (value) => {
            this.plugin.settings.dateFormat = value.trim() || "YYYY-MM-DD";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl).setName("功能开关").setHeading();

    new Setting(containerEl)
      .setName("粘贴代码自动识别语言")
      .setDesc("粘贴代码时自动识别编程语言并生成带围栏的代码块；光标已在代码块内或粘贴内容已带围栏时不干预。")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoDetectCodeLang)
          .onChange(async (value) => {
            this.plugin.settings.autoDetectCodeLang = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("选中文本设置标题等级")
      .setDesc("启用后可在命令面板或快捷键调用「选中文本设置标题等级」，将选中文本块内的标题统一调整到指定等级。")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableHeadingLevelCommand)
          .onChange(async (value) => {
            this.plugin.settings.enableHeadingLevelCommand = value;
            await this.plugin.saveSettings();
            this.plugin.updateHeadingCommand();
          })
      );

    new Setting(containerEl)
      .setName("粘贴图片保存到指定目录")
      .setDesc("粘贴图片时自动将图片保存到下方目录并在文中插入链接；关闭时使用 Obsidian 默认行为。")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoSavePastedImages)
          .onChange(async (value) => {
            this.plugin.settings.autoSavePastedImages = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("图片保存目录")
      .setDesc("vault 内相对路径，留空则保存到库根目录。")
      .addText((text) =>
        text
          .setPlaceholder("attachments")
          .setValue(this.plugin.settings.pastedImageFolder)
          .onChange(async (value) => {
            this.plugin.settings.pastedImageFolder = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("图片渲染增强")
      .setDesc("图片默认自适应宽度（超高图限制高度），鼠标悬停显示工具栏，可裁剪、放大、复制、重命名、删除。")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.imageEnhancerEnabled)
          .onChange(async (value) => {
            this.plugin.settings.imageEnhancerEnabled = value;
            await this.plugin.saveSettings();
            this.plugin.updateImageEnhancer();
          })
      );

    new Setting(containerEl)
      .setName("图片最大高度")
      .setDesc("超高图自动限制高度（占视口高度的百分比），点击图片可放大查看完整内容；0 表示不限制。")
      .addDropdown((dd) => {
        dd.addOption("0", "不限制");
        dd.addOption("40", "40%");
        dd.addOption("60", "60%");
        dd.addOption("70", "70%");
        dd.addOption("80", "80%");
        dd.setValue(String(this.plugin.settings.imageMaxHeightPct));
        dd.onChange(async (v) => {
          this.plugin.settings.imageMaxHeightPct = parseInt(v, 10);
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl).setName("Mermaid 图表").setHeading();

    new Setting(containerEl)
      .setName("初始显示方式")
      .setDesc("适应宽度：图表自动缩放至容器宽度，无需左右滚动；原始大小：按图表原始像素尺寸显示。")
      .addDropdown((dd) => {
        dd.addOption("width", "适应宽度");
        dd.addOption("original", "原始大小");
        dd.setValue(this.plugin.settings.mermaidFitMode);
        dd.onChange(async (v) => {
          this.plugin.settings.mermaidFitMode = v as "width" | "original";
          await this.plugin.saveSettings();
          this.plugin.onMermaidFitModeChanged();
        });
      });

    new Setting(containerEl)
      .setName("PNG 导出倍率")
      .setDesc("导出 PNG 图片时的分辨率倍率（数值越大越清晰）。")
      .addDropdown((dd) => {
        dd.addOption("1", "1x");
        dd.addOption("2", "2x（推荐）");
        dd.addOption("3", "3x");
        dd.setValue(String(this.plugin.settings.mermaidPngScale));
        dd.onChange(async (v) => {
          this.plugin.settings.mermaidPngScale = parseInt(v, 10);
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("图表最大高度")
      .setDesc("适应宽度时限制图表高度（占视口高度的百分比），超高图自动等比缩小避免占用过多空间；点击放大可查看完整细节。")
      .addDropdown((dd) => {
        dd.addOption("0", "不限制");
        dd.addOption("40", "40%");
        dd.addOption("60", "60%");
        dd.addOption("80", "80%");
        dd.setValue(String(this.plugin.settings.mermaidMaxHeightPct));
        dd.onChange(async (v) => {
          this.plugin.settings.mermaidMaxHeightPct = parseInt(v, 10);
          await this.plugin.saveSettings();
          this.plugin.onMermaidMaxHeightChanged();
        });
      });

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "提示：更改图表设置仅对新渲染的图表生效，切换笔记或重新打开笔记即可看到效果。",
    });

    new Setting(containerEl).setName("天气记录").setHeading();

    new Setting(containerEl)
      .setName("创建日记时自动记录天气")
      .setDesc("创建日记后自动获取当天天气并写入日记标题下方；数据来自 Open-Meteo，无需 API key。")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.weatherEnabled)
          .onChange(async (value) => {
            this.plugin.settings.weatherEnabled = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("城市")
      .setDesc("天气查询城市名，例如：北京、上海。")
      .addText((text) =>
        text
          .setPlaceholder("北京")
          .setValue(this.plugin.settings.weatherCity)
          .onChange(async (value) => {
            this.plugin.settings.weatherCity = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl).setName("定时提醒").setHeading();

    new Setting(containerEl)
      .setName("添加待办提醒")
      .setDesc("每天到指定时间提醒添加待办，点击通知可打开日历面板")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.todoReminderEnabled)
          .onChange(async (value) => {
            this.plugin.settings.todoReminderEnabled = value;
            await this.plugin.saveSettings();
            this.plugin.setupReminderTimer();
          })
      )
      .addText((text) => {
        text.inputEl.type = "time";
        text.setValue(this.plugin.settings.todoReminderTime);
        text.onChange(async (value) => {
          this.plugin.settings.todoReminderTime = value || "08:00";
          await this.plugin.saveSettings();
          this.plugin.setupReminderTimer();
        });
      });

    new Setting(containerEl)
      .setName("未完成待办检查")
      .setDesc("每天到指定时间检查所有待办，若存在未完成项则提醒")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.checkReminderEnabled)
          .onChange(async (value) => {
            this.plugin.settings.checkReminderEnabled = value;
            await this.plugin.saveSettings();
            this.plugin.setupReminderTimer();
          })
      )
      .addText((text) => {
        text.inputEl.type = "time";
        text.setValue(this.plugin.settings.checkReminderTime);
        text.onChange(async (value) => {
          this.plugin.settings.checkReminderTime = value || "21:00";
          await this.plugin.saveSettings();
          this.plugin.setupReminderTimer();
        });
      });

    new Setting(containerEl).setName("使用说明").setHeading();

    const help = containerEl.createDiv("qdn-help");
    const addSection = (title: string, items: string[]) => {
      new Setting(help).setName(title).setHeading();
      const ul = help.createEl("ul");
      for (const item of items) ul.createEl("li", { text: item });
    };

    addSection("快捷日记", [
      "点击左侧功能区日历图标，或使用命令「新建日记（输入名字）」，创建标题为「日期+名字」的日记；已存在同名日记时直接打开。",
      "在日历面板中双击日期可打开或创建该日日记。",
    ]);

    addSection("日历与待办", [
      "右侧边栏日历面板按日期管理待办：底部输入框回车添加，勾选完成，双击文字编辑，✎ 修改，× 删除。",
      "命令「打开日历与待办面板」可随时打开面板。",
      "昨天有未完成待办时，面板顶部显示「顺延到今天」横幅，点击将未完成项移到今天并标记「昨日遗留」。",
    ]);

    addSection("定时提醒", [
      "设置提醒时间后，到点提醒添加待办或检查未完成待办，点击通知可直接打开日历面板。",
    ]);

    addSection("标题等级", [
      "选中文本后运行命令「选中文本设置标题等级」，选择目标等级，文本块内最大标题变为该等级，子标题保持相对层级。",
    ]);

    addSection("粘贴增强", [
      "粘贴代码：自动识别编程语言（支持 30+ 种）并生成带围栏的代码块；普通文字、单行弱特征、代码块内粘贴均不干预。",
      "粘贴图片：开启「粘贴图片保存到指定目录」后，粘贴的图片自动保存到指定目录（vault 内相对路径，留空为库根目录），并在光标处插入图片链接。",
    ]);

    addSection("图片渲染增强", [
      "笔记中的图片自动适应宽度，超高图按设置限制高度；鼠标悬停图片出现悬浮工具栏。",
      "点击图片放大查看，弹窗右上角工具栏可裁剪、复制、重命名、删除（删除会同步清理笔记中的引用，文件进入系统回收站）。",
    ]);

    addSection("Mermaid 图表增强", [
      "Mermaid 图表自动适应宽度，超高图按设置限制高度。",
      "图表右上角工具栏可放大/缩小、重置、下载 SVG 或 PNG（可调导出倍率）。",
      "打印或导出 PDF 时图表自动适配页面宽度，不会被裁剪。",
    ]);

    addSection("周回顾与统计", [
      "命令「生成本周回顾」将本周日记（篇目、天数、字数）与完成/未完成待办汇总为 Markdown，插入当前笔记光标处。",
      "日历下方显示本月日记天数、连续写日记天数、今日字数统计。",
    ]);

    addSection("天气记录", [
      "开启「创建日记时自动记录天气」并填写城市名后，新建日记会自动获取当天天气写入标题下方（数据来自 Open-Meteo，无需 API key，失败不影响创建）。",
    ]);
  }
}
