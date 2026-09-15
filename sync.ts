import { App, EventRef, Notice, TAbstractFile, TFile, requestUrl } from "obsidian";

/**
 * 云同步（daily-sync 服务）客户端。
 *
 * 协议（与后端 M2/M5.1/M7 实现一一对应）：
 * - 推送 POST /api/v1/sync?vault=：批量幂等上传（≤200 条/批，单条 ≤1MB，服务端按内容哈希判重）
 * - 拉取 GET /api/v1/sync?vault=&since=&limit=：按仓库版本号增量；删除以墓碑（deleted=true）下发。
 *   响应中的 attachments 是附件元数据（不含字节），与 records 共用同一个 version 游标
 * - 附件 POST / DELETE / GET /api/v1/sync/attachments?vault=&path=：原始字节流上传（≤10MB）、
 *   墓碑删除、按需下载。附件与正文共用同一个 vault.version 计数器，所以**只有一个游标**
 * - 仓库：vault 参数填本库（Obsidian vault）名字，服务端按用户名下同名牌查找、不存在自动创建
 * - 鉴权（M5.1）：用账号密码登录换 accessToken（JWT，约 2 小时），请求带 Authorization: Bearer；
 *   401 时先用手头的 refreshToken 换新对（一次性轮换），refresh 也失效才用账号密码重新登录。
 *   refreshToken 随同步状态持久化到 data.json，Obsidian 重启无需重新登录
 *
 * 同步状态（游标 + 每个文件上次同步的内容哈希）是每设备独立的，
 * 存在插件本地 data.json 中，不写入库内（避免被同步、被其他设备覆盖）。
 *
 * 冲突策略（后到者胜的客户端落地）：拉取应用时若"本地自上次同步后改过，云端也改过"，
 * 保留本地内容并重新推送（本地胜），在 Notice 中列出冲突文件。
 *
 * 附件策略（M7）：只同步**被同步范围内日记引用到的**附件（见 collectLocalAttachments），
 * 不去镜像整个库的二进制——粘贴图片的落点取决于用户配置（插件自己的 pastedImageFolder
 * 或 Obsidian 原生附件目录），盯目录必然漏，而按引用扫与落点无关。
 */

/** 每设备独立的同步配置与状态（data.json 的 sync 键） */
export interface SyncDeviceState {
  /** 后端地址，如 http://120.26.58.22:8080 */
  serverUrl: string;
  /** 服务端账号（与 Web 登录同一套用户体系） */
  username: string;
  /** 服务端密码（仅本机 data.json，不写入库内文件） */
  password: string;
  /** 自动同步开关（关闭后仅命令/按钮手动触发） */
  enabled: boolean;
  /** 推送范围：folder=日记文件夹，vault=整个库（均限 .md 且排除点开头目录） */
  scope: "folder" | "vault";
  /** 拉取游标（已同步到的仓库版本号），全量拉取即 0 */
  cursor: number;
  /** path -> 上次同步时的内容 SHA-256（十六进制）。冲突判定与跳过无变化推送的依据 */
  hashes: Record<string, string>;
  /**
   * 附件 path -> 上次同步时的内容 SHA-256。与 hashes 分开存：
   * hashes 参与正文的冲突判定，附件有自己的上传方式与体积上限（10MB），
   * 混在一起会让「本地改过没有」的判断在两类文件之间串味。
   */
  attachmentHashes: Record<string, string>;
  /**
   * 附件 path -> `${mtime}:${size}`，纯属省算力的旁路缓存：附件动辄几 MB，
   * 每个周期把所有被引用的附件读一遍重算哈希太浪费，时间戳与大小都没变就跳过读取。
   * 它只是优化——缺失或过期只会多算一次哈希，判定始终以 attachmentHashes 为准。
   */
  attachmentStamps: Record<string, string>;
  /** 上次成功同步的时间戳（ms），0=从未 */
  lastSyncAt: number;
  /** 服务端签发的 refreshToken（30 天滚动轮换），用于静默续期 accessToken */
  refreshToken: string;
}

export const DEFAULT_SYNC_STATE: SyncDeviceState = {
  serverUrl: "",
  username: "",
  password: "",
  enabled: false,
  scope: "folder",
  cursor: 0,
  hashes: {},
  attachmentHashes: {},
  attachmentStamps: {},
  lastSyncAt: 0,
  refreshToken: "",
};

/**
 * 从持久化数据恢复同步状态。三张哈希表都必须深拷贝：
 * `{ ...DEFAULT_SYNC_STATE }` 是浅拷贝，多个实例会共享同一个默认表对象，
 * 一台设备的同步状态会"串"到另一台（曾导致新设备把全部文件误判为本地离线删除而推墓碑）。
 */
export function normalizeSyncState(raw: Partial<SyncDeviceState> | undefined | null): SyncDeviceState {
  return {
    ...DEFAULT_SYNC_STATE,
    ...raw,
    hashes: { ...(raw?.hashes ?? {}) },
    attachmentHashes: { ...(raw?.attachmentHashes ?? {}) },
    attachmentStamps: { ...(raw?.attachmentStamps ?? {}) },
  };
}

export type SyncStatusKind = "off" | "syncing" | "ok" | "error";

/** SyncManager 对宿主插件的依赖（避免直接耦合 Plugin 类型，便于测试替身） */
export interface SyncHost {
  /** 日记文件夹设置（同步范围 scope=folder 时的前缀），空串表示库根目录 */
  getFolder(): string;
  /** 当前 Obsidian 库名（服务端按它定位/自动创建同名云端仓库） */
  getVaultName(): string;
  /** 持久化同步状态到本机 data.json */
  persist(): Promise<void>;
  /** 状态栏等 UI 回调 */
  onStatus(kind: SyncStatusKind, detail?: string): void;
  /**
   * 需要同步但不在库内落盘的内容（路径 -> 文本），如待办数据。
   * 这些路径不写文件：内容由宿主自己维护，云端拉回来的交给
   * {@link mergeVirtualFile} 合并。
   */
  getVirtualFiles(): Record<string, string>;

  /**
   * 拉到云端虚拟文件内容时调用，由宿主把它合并进自己的数据。
   * 返回 true 表示本地因此有改动、需要回推云端（双向同步的关键一步）。
   */
  mergeVirtualFile?(path: string, content: string): boolean;
}

/** 本地修改后延迟推送的静默期：防抖合并连续输入 */
const PUSH_DEBOUNCE_MS = 3000;
/** 周期性全量同步间隔 */
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
/** 启动后延迟首同步，等 Obsidian 索引与界面就绪 */
const STARTUP_DELAY_MS = 5000;
/**
 * 待办数据在云端的记录路径。
 *
 * 它**不是库内文件**——插件把待办内容放在内存里直接推送，不往用户库里写任何东西，
 * 这个路径只作为云端记录与网页端读取的标识（也正因如此，库里若真有同名文件
 * 也不会被当普通文件同步，见 inScope 只放行 .md）。
 */
export const TODO_SYNC_PATH = "daily-sync-todos.json";

/** 服务端限制：单批 ≤200 条 */
const MAX_BATCH = 200;
/** 服务端限制：单条内容 ≤1MB（按 Java String 长度，即 UTF-16 代码单元数） */
const MAX_CONTENT_CHARS = 1_048_576;
/** 拉取分页大小（服务端上限 500，取满即 hasMore=true） */
const PULL_LIMIT = 500;

/**
 * 允许同步的附件扩展名（与后端 AttachmentService.ALLOWED_EXTENSIONS 一一对应）。
 * 刻意不含 svg：svg 能内联脚本，浏览器直出等于开了一条 XSS 通道。
 */
const ATTACHMENT_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "pdf"]);
/** 服务端单文件上限 10MB。本地先挡一道，省一次注定被拒的上传 */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/**
 * 每个同步周期最多补下多少个附件、多少字节。
 * 新设备首次同步时云端可能挂着上百张图，一口气拉完会让 Obsidian 卡住几分钟；
 * 分轮完成，被跳过的下一轮（5 分钟）继续，引用还在不会漏。
 */
const ATTACHMENT_DOWNLOAD_PER_CYCLE = 20;
const ATTACHMENT_DOWNLOAD_BYTES_PER_CYCLE = 50 * 1024 * 1024;

/** 拉取返回的正文记录（与后端 SyncPullResponse.Record 对应） */
interface RemoteRecord {
  path: string;
  content: string;
  deleted: boolean;
  version: number;
}

/** 拉取返回的附件元数据（与后端 SyncPullResponse.AttachmentMeta 对应；不含字节） */
interface RemoteAttachment {
  path: string;
  name: string;
  sha256: string;
  size: number;
  deleted: boolean;
  version: number;
}

/** 401：账号密码被拒 / refresh 失效且登录失败（提示用户去设置里更新，别当成网络错误重试轰炸） */
class SyncAuthError extends Error {
  constructor() {
    super("账号或密码错误");
  }
}

/** SHA-256 十六进制（与后端 HashUtil.sha256Hex 对 UTF-8 字节的结果一致） */
export async function sha256Hex(content: string): Promise<string> {
  return hexOf(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content)));
}

/** SHA-256 十六进制（二进制内容，附件用） */
export async function sha256HexBytes(bytes: ArrayBuffer): Promise<string> {
  return hexOf(await crypto.subtle.digest("SHA-256", bytes));
}

function hexOf(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 取文件名部分的扩展名（小写）；目录名里的点不算 */
function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  return dot > slash + 1 ? path.substring(dot + 1).toLowerCase() : "";
}

export class SyncManager {
  private state: SyncDeviceState;
  private host: SyncHost;
  private app: App;
  private eventRefs: EventRef[] = [];
  private intervalId: number | null = null;
  private flushTimer: number | null = null;
  private configTimer: number | null = null;
  /** 正在把远端变更写回本地（此期间的 vault 事件是回声，不进推送队列） */
  private applyingRemote = 0;
  /** 待推送队列：path -> 最新操作 */
  private dirty = new Map<string, "mod" | "del">();
  /** 一个同步周期进行中（拉取+应用+推送整体互斥） */
  private syncing = false;
  /** 周期内又收到触发（如手动点了立即同步）：周期结束后补一轮 */
  private rerun = false;
  private disposed = false;
  /** 错误 Notice 去重：同一错误只提示一次，成功后复位 */
  private lastErrorNotice = "";
  /** 内存中的 accessToken（JWT，约 2 小时有效）；丢了/过期重新走 refresh→登录 */
  private accessToken: string | null = null;
  /** 本周期认定的虚拟文件路径（不落盘，拉取时跳过写回） */
  private virtualPaths = new Set<string>();
  /** 拉取到的云端虚拟文件内容，推送前用它比较新旧 */
  private remoteVirtual = new Map<string, string>();
  /** 待上传附件队列：path -> 最新操作。附件传的是原始字节、一条一个请求，与正文分批推送分开 */
  private dirtyAttachments = new Map<string, "mod" | "del">();
  /**
   * 本周期「被同步范围内日记引用到」的附件路径集合。
   * 它同时决定上传对象与下载对象——不在这个集合里的附件一律不同步（见文件头附件策略）。
   */
  private referencedAttachments = new Set<string>();
  /** 本轮已补下的附件数与字节数，受每轮上限约束 */
  private downloadedAttachments = 0;
  private downloadedAttachmentBytes = 0;
  /** 本轮因上限被推迟的附件数（只用于提示一次，实际下载留给下个周期） */
  private deferredAttachments = 0;

  constructor(app: App, state: SyncDeviceState, host: SyncHost) {
    this.app = app;
    this.state = state;
    this.host = host;
  }

  /** 服务端地址与账号密码都已配置 */
  get configured(): boolean {
    return (
      this.state.serverUrl.trim() !== "" &&
      this.state.username.trim() !== "" &&
      this.state.password !== ""
    );
  }

  /** 注册文件钩子与周期定时器（插件 onload 时调用） */
  start(): void {
    if (this.disposed) return;
    this.eventRefs.push(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile) this.schedulePush(file.path, "mod");
      }),
      this.app.vault.on("create", (file) => {
        if (file instanceof TFile) this.schedulePush(file.path, "mod");
      }),
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile) this.schedulePush(file.path, "del");
      }),
      this.app.vault.on("rename", (file, oldPath) => this.onRename(file, oldPath)),
    );
    this.intervalId = window.setInterval(() => {
      if (this.state.enabled && this.configured) void this.syncNow("interval");
    }, SYNC_INTERVAL_MS);
    this.refreshStatus();
  }

  /** 布局就绪后的首次同步（插件 onLayoutReady 回调里调用） */
  beginStartupSync(): void {
    if (this.disposed || !this.state.enabled || !this.configured) return;
    window.setTimeout(() => {
      if (!this.disposed && this.state.enabled) void this.syncNow("startup");
    }, STARTUP_DELAY_MS);
  }

  /** 设置页改了地址/令牌/开关后调用：防抖后自动做一次同步验证连通性 */
  onConfigChanged(): void {
    if (this.configTimer !== null) window.clearTimeout(this.configTimer);
    this.configTimer = window.setTimeout(() => {
      this.configTimer = null;
      if (this.disposed) return;
      if (this.state.enabled && this.configured) void this.syncNow("startup");
      else this.refreshStatus();
    }, 2500);
  }

  /** 重置游标并全量拉取（本地状态异常时的自愈入口） */
  resetCursorAndSync(): void {
    this.state.cursor = 0;
    void this.syncNow("manual");
  }

  /**
   * 虚拟文件内容变化后调用（如待办增删改）。
   * 它们不落盘，不会触发 vault 文件事件，所以要主动入队并走防抖推送。
   */
  touchVirtual(): void {
    if (!this.state.enabled || !this.configured) return;
    for (const path of Object.keys(this.host.getVirtualFiles())) {
      this.dirty.set(path, "mod");
    }
    this.armFlushTimer();
  }

  /** 插件卸载：清理钩子与定时器，尽力把未发出的变更推上去 */
  destroy(): void {
    this.disposed = true;
    for (const ref of this.eventRefs) this.app.vault.offref(ref);
    this.eventRefs = [];
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.flushTimer !== null) {
      window.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.configTimer !== null) {
      window.clearTimeout(this.configTimer);
      this.configTimer = null;
    }
    if ((this.dirty.size > 0 || this.dirtyAttachments.size > 0) && this.configured) void this.flushPushes();
  }

  /** 完整同步周期：扫描本地差异 -> 拉取应用 -> 推送本地变更 */
  async syncNow(trigger: "manual" | "startup" | "interval" | "retry"): Promise<void> {
    if (this.disposed) return;
    if (!this.configured) {
      this.refreshStatus();
      if (trigger === "manual") new Notice("云同步：请先在插件设置中填写服务端地址与账号密码");
      return;
    }
    if (this.syncing) {
      this.rerun = true;
      return;
    }
    this.syncing = true;
    try {
      this.host.onStatus("syncing");
      // 每轮重置下载额度：上一轮被上限推迟的附件在这一轮接着下
      this.downloadedAttachments = 0;
      this.downloadedAttachmentBytes = 0;
      this.deferredAttachments = 0;
      await this.scanLocalFiles();
      await this.pullAndApply();
      await this.doFlush();
      this.state.lastSyncAt = Date.now();
      this.lastErrorNotice = "";
      this.host.onStatus("ok");
      if (this.deferredAttachments > 0) {
        new Notice(
          `云同步：还有 ${this.deferredAttachments} 个附件本轮未下载完（单轮有上限），下个周期继续`,
          6000,
        );
      }
    } catch (err) {
      this.notifyError(err);
      this.host.onStatus("error", err instanceof Error ? err.message : String(err));
    } finally {
      this.syncing = false;
      await this.host.persist().catch(() => {});
      if (this.rerun && !this.disposed) {
        this.rerun = false;
        void this.syncNow("retry");
      }
    }
  }

  /** 防抖期结束/卸载时的推送入口（独立于 syncNow，轻量：只发不等） */
  private async flushPushes(): Promise<void> {
    if ((this.dirty.size === 0 && this.dirtyAttachments.size === 0) || !this.configured) return;
    if (this.syncing) return; // 周期结束时会统一带上这些变更
    this.syncing = true;
    try {
      await this.doFlush();
      this.state.lastSyncAt = Date.now();
      this.host.onStatus("ok");
    } catch (err) {
      this.notifyError(err);
      this.host.onStatus("error", err instanceof Error ? err.message : String(err));
    } finally {
      this.syncing = false;
      await this.host.persist().catch(() => {});
      if (this.rerun && !this.disposed) {
        this.rerun = false;
        void this.syncNow("retry");
      }
    }
  }

  // ------------------------------------------------------------
  // 本地变更收集（防抖）
  // ------------------------------------------------------------

  private schedulePush(path: string, op: "mod" | "del", ignoreScope = false): void {
    if (!this.state.enabled || !this.configured) return;
    if (this.applyingRemote > 0) return;
    if (!path.endsWith(".md")) {
      // 附件：这里只做"看着像附件就先排队"的粗筛，能不能上传由引用集决定
      // （见 flushAttachments）。范围判定对附件没有意义——附件往往躺在日记文件夹之外
      // （库根的 attachments/ 之类），它的去留由"有没有被范围内的日记引用"决定。
      if (this.isAttachmentPath(path)) {
        this.dirtyAttachments.set(path, op);
        this.armFlushTimer();
      }
      return;
    }
    if (!ignoreScope && !this.inScope(path)) return;
    this.dirty.set(path, op);
    this.armFlushTimer();
  }

  /** 重命名 = 旧路径推墓碑（可能移出同步范围，绕过范围检查，服务端对未知路径是 no-op）+ 新路径推内容 */
  private onRename(file: TAbstractFile, oldPath: string): void {
    if (!this.state.enabled || !this.configured) return;
    if (this.applyingRemote > 0) return;
    if (oldPath.endsWith(".md")) {
      this.dirty.set(oldPath, "del");
      this.armFlushTimer();
    } else if (this.isAttachmentPath(oldPath)) {
      this.dirtyAttachments.set(oldPath, "del");
      this.armFlushTimer();
    }
    if (file instanceof TFile) this.schedulePush(file.path, "mod");
  }

  /**
   * 是否算"附件"：不是正文（.md / .json）、不在点开头目录、扩展名在附件白名单内。
   * 白名单必须与后端 AttachmentService 保持一致——不一致的话本地会把注定被 400 拒的文件
   * 反复往上推。
   */
  private isAttachmentPath(path: string): boolean {
    if (path.endsWith(".md") || path.endsWith(".json")) return false;
    if (path.split("/").some((seg) => seg.startsWith("."))) return false;
    return ATTACHMENT_EXTENSIONS.has(extensionOf(path));
  }

  /**
   * 收集「被同步范围内日记引用到的」本地附件路径。
   *
   * 按引用扫而不是按目录扫：粘贴图片的落点取决于用户配置（插件自己的 pastedImageFolder，
   * 或 Obsidian 原生的附件目录——autoSavePastedImages 默认还是关的，粘贴其实走 Obsidian 设置），
   * 盯目录必然漏；而 metadataCache 已经把链接解析好了，顺带还排除了同名的普通文本文件。
   * 代价是没被任何日记引用的图片不会上云——这正是要的效果：不镜像无用的二进制。
   */
  private collectLocalAttachments(): Set<string> {
    const paths = new Set<string>();
    for (const md of this.app.vault.getMarkdownFiles()) {
      if (!this.inScope(md.path)) continue;
      const links = this.app.metadataCache?.resolvedLinks?.[md.path];
      if (!links) continue;
      for (const target of Object.keys(links)) {
        if (this.isAttachmentPath(target)) paths.add(target);
      }
    }
    return paths;
  }

  private armFlushTimer(): void {
    if (this.flushTimer !== null) window.clearTimeout(this.flushTimer);
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      void this.flushPushes();
    }, PUSH_DEBOUNCE_MS);
  }

  /** path 是否在推送范围内（.md、非点开头目录；scope=folder 时还需落在日记文件夹内） */
  inScope(path: string): boolean {
    if (!path.endsWith(".md")) return false;
    if (path.split("/").some((seg) => seg.startsWith("."))) return false;
    if (this.state.scope === "vault") return true;
    const folder = this.host.getFolder().trim().replace(/\\/g, "/").replace(/\/+$/, "");
    if (folder === "") return true;
    return path.startsWith(folder + "/");
  }

  /**
   * 扫描本地文件与上次同步哈希的差异（首台设备上传既有日记、离线期间的修改都靠它进队列）。
   * 拉取应用阶段认定的冲突也会写 dirty，与这里互不冲突（Map 后写覆盖）。
   */
  private async scanLocalFiles(): Promise<void> {
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!this.inScope(file.path)) continue;
      const hash = await sha256Hex(await this.app.vault.read(file));
      if (this.state.hashes[file.path] !== hash) this.dirty.set(file.path, "mod");
    }
    // 虚拟文件（待办数据）不在库里，单独比对内存内容的哈希
    const virtual = this.host.getVirtualFiles();
    this.virtualPaths = new Set(Object.keys(virtual));
    for (const [path, content] of Object.entries(virtual)) {
      const hash = await sha256Hex(content);
      if (this.state.hashes[path] !== hash) this.dirty.set(path, "mod");
    }
    await this.scanLocalAttachments();
  }

  /**
   * 扫描被引用的本地附件，把有变化的排进上传队列。
   *
   * 用 mtime+size 做旁路缓存：附件动辄几 MB，每个周期把所有引用到的附件读一遍重算哈希
   * 太浪费，时间戳与大小都没变就跳过读取。缓存只影响性能不影响正确性——哈希缺失时
   * 多算一次即可（缓存永远不当成"已同步"的依据，判断一律看 attachmentHashes）。
   */
  private async scanLocalAttachments(): Promise<void> {
    this.referencedAttachments = this.collectLocalAttachments();
    for (const path of this.referencedAttachments) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) continue; // 引用到了但本地还没这个文件：等拉取补齐
      const stamp = `${file.stat.mtime}:${file.stat.size}`;
      if (this.state.attachmentStamps[path] === stamp && this.state.attachmentHashes[path] !== undefined) {
        continue;
      }
      const hash = await sha256HexBytes(await this.app.vault.readBinary(file));
      this.state.attachmentStamps[path] = stamp;
      if (this.state.attachmentHashes[path] !== hash) this.dirtyAttachments.set(path, "mod");
    }
    // 同步过、但现在既没被引用、本地也没了这个文件的 -> 推墓碑，让其他设备跟着清掉。
    // 只删引用、文件还留着的**不**推墓碑：云端那份留着更保守，用户日后重新引用无需重传
    for (const path of Object.keys(this.state.attachmentHashes)) {
      if (this.referencedAttachments.has(path)) continue;
      if (this.app.vault.getAbstractFileByPath(path)) continue;
      this.dirtyAttachments.set(path, "del");
    }
  }

  // ------------------------------------------------------------
  // 推送
  // ------------------------------------------------------------

  /**
   * 把两个队列的变更发出（调用方需已持有 syncing 锁）。
   * 附件先行：正文里的 `![[图]]` 一落地就该有图可显示，先传图再传正文能少一次"图裂开"的瞬间。
   */
  private async doFlush(): Promise<void> {
    await this.flushAttachments();
    while (this.dirty.size > 0) {
      const items: { path: string; content: string | null; deleted: boolean; hash: string | null }[] = [];
      const batchPaths: string[] = [];
      for (const [path, op] of this.dirty) {
        if (items.length >= MAX_BATCH) break;
        if (op === "del") {
          items.push({ path, content: null, deleted: true, hash: null });
          batchPaths.push(path);
          continue;
        }
        // 虚拟文件（待办数据）的内容在内存里，库里没有对应文件
        const virtualContent = this.host.getVirtualFiles()[path];
        if (virtualContent !== undefined) {
          const virtualHash = await sha256Hex(virtualContent);
          if (this.state.hashes[path] === virtualHash) {
            this.dirty.delete(path);
            continue;
          }
          // 拉取阶段的 mergeVirtualFile 已经把云端内容并进本地，
          // 所以这里推的就是合并结果（同时含两侧改动），不再需要「云端更新就跳过」
          items.push({ path, content: virtualContent, deleted: false, hash: virtualHash });
          batchPaths.push(path);
          continue;
        }
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) {
          // 防抖窗口内文件又被删了：转为墓碑
          items.push({ path, content: null, deleted: true, hash: null });
          batchPaths.push(path);
          continue;
        }
        const content = await this.app.vault.read(file);
        if (content.length > MAX_CONTENT_CHARS) {
          new Notice(`云同步：${path} 超过 1MB 上限，本条已跳过`);
          this.dirty.delete(path);
          continue;
        }
        const hash = await sha256Hex(content);
        if (this.state.hashes[path] === hash) {
          this.dirty.delete(path); // 与上次同步一致，无需上传
          continue;
        }
        items.push({ path, content, deleted: false, hash });
        batchPaths.push(path);
      }
      if (items.length === 0) break;
      await this.api("POST", undefined, {
        items: items.map((it) =>
          it.deleted ? { path: it.path, deleted: true } : { path: it.path, content: it.content },
        ),
      });
      for (const it of items) {
        if (it.deleted) delete this.state.hashes[it.path];
        else this.state.hashes[it.path] = it.hash!;
      }
      for (const p of batchPaths) this.dirty.delete(p);
    }
  }

  // ------------------------------------------------------------
  // 附件的推送（一条一个请求）
  // ------------------------------------------------------------

  /**
   * 上传/删除附件。
   *
   * <p>一条一个请求是刻意的：服务端"一次上传占一个版本号"，而正文是"一批占一个版本号"，
   * 这保证同一个版本号下只有一类行，拉取时的两表归并才不会歧义（见后端 SyncService.pull）。
   *
   * <p>上传前先刷新引用集：文件事件只能说明"某个二进制文件动了"，它该不该上云
   * 由"有没有被范围内日记引用"决定（见 collectLocalAttachments）。不在引用集里就从队列丢掉，
   * 免得用户往库里丢了一堆还没打算用的图片也全推上去。
   *
   * <p>单条失败不拖垮整轮：记下第一个错误继续处理剩下的，最后再抛出，让状态栏如实报错。
   */
  private async flushAttachments(): Promise<void> {
    if (this.dirtyAttachments.size === 0) return;
    this.referencedAttachments = this.collectLocalAttachments();
    let firstError: Error | null = null;
    // 遍历快照：处理过程中可能有新事件入队（如 createBinary 触发的 create），让它们留给下一轮
    for (const [path, op] of [...this.dirtyAttachments]) {
      if (this.disposed) return;
      this.dirtyAttachments.delete(path);
      if (op === "mod" && !this.referencedAttachments.has(path)) continue;
      try {
        if (op === "del") {
          await this.deleteAttachment(path);
        } else {
          await this.uploadAttachment(path);
        }
      } catch (err) {
        // 归一化成 Error：最后要重新抛出，非 Error 的值会让调用方取不到 message
        if (firstError === null) firstError = err instanceof Error ? err : new Error(String(err));
      }
    }
    if (firstError !== null) throw firstError;
  }

  /**
   * 上传单个附件。与正文推送同样的幂等姿势：哈希一致就不发请求；
   * 真发上去服务端也会对"同路径同内容"回 unchanged 且不推进版本号。
   */
  private async uploadAttachment(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      await this.deleteAttachment(path); // 防抖窗口内文件又被删了：转为墓碑
      return;
    }
    const bytes = await this.app.vault.readBinary(file);
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      // 本地先挡一道，省一次注定被服务端 413 拒绝的上传
      new Notice(`云同步：附件 ${path} 超过 10MB 上限，已跳过`);
      return;
    }
    const hash = await sha256HexBytes(bytes);
    this.state.attachmentStamps[path] = `${file.stat.mtime}:${file.stat.size}`;
    if (this.state.attachmentHashes[path] === hash) return;
    await this.attachmentRequest("POST", `&path=${encodeURIComponent(path)}`, bytes);
    this.state.attachmentHashes[path] = hash;
  }

  private async deleteAttachment(path: string): Promise<void> {
    await this.attachmentRequest("DELETE", `&path=${encodeURIComponent(path)}`);
    delete this.state.attachmentHashes[path];
    delete this.state.attachmentStamps[path];
  }

  // ------------------------------------------------------------
  // 拉取与应用
  // ------------------------------------------------------------

  /**
   * 增量拉取并应用到本地（按 M2 分页规则翻页，path 去重取最新版本）。
   * 正文与附件共用同一条 version 游标，按 path 各自去重。
   */
  private async pullAndApply(): Promise<void> {
    const applied = new Map<string, RemoteRecord>();
    const appliedAttachments = new Map<string, RemoteAttachment>();
    let since = this.state.cursor;
    let finalCursor = this.state.cursor;
    for (;;) {
      const data = await this.api<SyncPullData>("GET", since);
      const attachments = data.attachments ?? [];
      for (const rec of data.records) applied.set(rec.path, rec);
      for (const att of attachments) appliedAttachments.set(att.path, att);
      for (const rec of data.records) {
        if (rec.version > finalCursor) finalCursor = rec.version;
      }
      for (const att of attachments) {
        if (att.version > finalCursor) finalCursor = att.version;
      }
      if (data.vaultVersion > finalCursor) finalCursor = data.vaultVersion;
      if (!data.hasMore) break;
      // 页尾是本页最大版本号（服务端按 version 归并后截断），所以要取两侧的较大者；
      // 回退一个版本让同版本组整组重取，客户端按 path 去重，重复是预期行为
      const lastRecordVersion = data.records.length > 0 ? data.records[data.records.length - 1].version : 0;
      const lastAttachmentVersion = attachments.length > 0 ? attachments[attachments.length - 1].version : 0;
      const next = Math.max(lastRecordVersion, lastAttachmentVersion) - 1;
      if (next <= since) break; // 防御：正常不会发生（见 M2 1.4 不变式）
      since = next;
    }

    const conflicts: string[] = [];
    this.applyingRemote++;
    try {
      // 附件先落地再落正文：正文里的 ![[图]] 一出现就该有图可看，不用等下一轮
      for (const att of appliedAttachments.values()) await this.applyAttachment(att, conflicts);
      for (const rec of applied.values()) await this.applyRecord(rec, conflicts);
    } finally {
      this.applyingRemote--;
    }
    if (conflicts.length > 0) {
      const preview = conflicts.slice(0, 5).join("\n");
      new Notice(
        `云同步：${conflicts.length} 个文件本地与云端都修改过，已保留本地版本并重新上传：\n${preview}` +
          (conflicts.length > 5 ? "\n…" : ""),
        8000,
      );
    }
    this.state.cursor = finalCursor;
  }

  /** 应用单条远端记录（冲突时本地胜：保留本地并标记重推） */
  private async applyRecord(rec: RemoteRecord, conflicts: string[]): Promise<void> {
    // 虚拟文件不落盘：内容由宿主维护。这里把云端内容交给宿主做合并
    // （待办就是靠这条从网页端回流到 Obsidian），并保留一份用于比较。
    if (this.virtualPaths.has(rec.path)) {
      if (rec.deleted) {
        this.remoteVirtual.delete(rec.path);
        return;
      }
      this.remoteVirtual.set(rec.path, rec.content);
      if (this.host.mergeVirtualFile?.(rec.path, rec.content)) {
        // 合并改动了本地 → 本轮 doFlush 会把它推回去，让其他设备也拿到合并结果
        this.dirty.set(rec.path, "mod");
      }
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(rec.path);
    const knownHash = this.state.hashes[rec.path];

    if (rec.deleted) {
      delete this.state.hashes[rec.path];
      if (file instanceof TFile) {
        const localHash = await sha256Hex(await this.app.vault.read(file));
        if (knownHash === undefined || localHash === knownHash) {
          // 本地未改动（或本设备不知道它）-> 跟随云端删除，进回收站
          await this.app.vault.trash(file, false);
        } else {
          // 本地有未同步修改 + 云端已删 -> 本地胜，重新推送复活
          conflicts.push(`${rec.path}（云端已删除，本地有修改，已恢复上传）`);
          this.dirty.set(rec.path, "mod");
        }
      }
      return;
    }

    const remoteHash = await sha256Hex(rec.content);
    if (file instanceof TFile) {
      const localHash = await sha256Hex(await this.app.vault.read(file));
      if (localHash === remoteHash) {
        this.state.hashes[rec.path] = remoteHash; // 已一致
        return;
      }
      if (knownHash === undefined || localHash === knownHash) {
        // 本地自上次同步后未改 -> 云端覆盖
        await this.app.vault.modify(file, rec.content);
        this.state.hashes[rec.path] = remoteHash;
      } else {
        // 双边修改 -> 本地胜，标记重推
        conflicts.push(`${rec.path}（本地与云端都修改过，已保留本地并重新上传）`);
        this.dirty.set(rec.path, "mod");
      }
      return;
    }
    if (file) return; // 同路径被文件夹等占用，异常情况跳过

    if (knownHash !== undefined && knownHash === remoteHash) {
      // 上次同步的就是这份内容而本地文件已不在 -> 本地删除未推送，以墓碑同步
      this.dirty.set(rec.path, "del");
      return;
    }
    // 云端新文件（或云端改过而本地没有）-> 云端胜，重建
    await this.ensureParentFolders(rec.path);
    await this.app.vault.create(rec.path, rec.content);
    this.state.hashes[rec.path] = remoteHash;
  }

  /**
   * 应用单条远端附件元数据（冲突策略与正文完全一致：本地改动过就本地胜并重推）。
   *
   * <p>下载**不**受引用集约束：服务端只会知道被某台设备的日记引用过的附件
   * （各设备都只上传被引用的），所以云端列出什么就是该补的。
   * 引用集只用来决定上传与墓碑（见 flushAttachments）。
   *
   * <p>每轮下载有条数与字节上限，被推迟的下一轮继续——引用还在就不会漏，
   * 只是不会让新设备一开就卡在几百张图上。
   */
  private async applyAttachment(rec: RemoteAttachment, conflicts: string[]): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(rec.path);
    const knownHash = this.state.attachmentHashes[rec.path];

    if (rec.deleted) {
      delete this.state.attachmentHashes[rec.path];
      delete this.state.attachmentStamps[rec.path];
      if (file instanceof TFile) {
        const localHash = await sha256HexBytes(await this.app.vault.readBinary(file));
        if (knownHash === undefined || localHash === knownHash) {
          // 本地未改动（或本设备不知道它）-> 跟随云端删除，进回收站
          await this.app.vault.trash(file, false);
        } else {
          // 本地有未同步修改 + 云端已删 -> 本地胜，重新推送复活
          conflicts.push(`${rec.path}（云端已删除，本地有修改，已恢复上传）`);
          this.dirtyAttachments.set(rec.path, "mod");
        }
      }
      return;
    }

    if (file instanceof TFile) {
      const localHash = await sha256HexBytes(await this.app.vault.readBinary(file));
      if (localHash === rec.sha256) {
        this.state.attachmentHashes[rec.path] = rec.sha256; // 已一致
        return;
      }
      if (knownHash === undefined || localHash === knownHash) {
        // 本地自上次同步后未改 -> 云端覆盖
        await this.downloadAttachmentInto(rec.path);
      } else {
        conflicts.push(`${rec.path}（本地与云端都修改过，已保留本地并重新上传）`);
        this.dirtyAttachments.set(rec.path, "mod");
      }
      return;
    }
    if (file) return; // 同路径被文件夹占用，异常情况跳过

    if (knownHash !== undefined && knownHash === rec.sha256) {
      // 上次同步的就是这份内容而本地文件已不在 -> 本地删除未推送，以墓碑同步
      this.dirtyAttachments.set(rec.path, "del");
      return;
    }
    await this.downloadAttachmentInto(rec.path);
  }

  /** 把云端附件补到本地（受每轮上限约束）。服务端 404（盘上文件丢了）只跳过，不打断整轮 */
  private async downloadAttachmentInto(path: string): Promise<void> {
    if (
      this.downloadedAttachments >= ATTACHMENT_DOWNLOAD_PER_CYCLE ||
      this.downloadedAttachmentBytes >= ATTACHMENT_DOWNLOAD_BYTES_PER_CYCLE
    ) {
      this.deferredAttachments++;
      return;
    }
    const bytes = await this.downloadAttachment(path);
    if (!bytes) return;
    this.downloadedAttachments++;
    this.downloadedAttachmentBytes += bytes.byteLength;
    await this.ensureParentFolders(path);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await this.app.vault.modifyBinary(existing, bytes);
    else await this.app.vault.createBinary(path, bytes);
    this.state.attachmentHashes[path] = await sha256HexBytes(bytes);
  }

  /** 逐级创建父文件夹（vault.create 不会自动建目录） */
  private async ensureParentFolders(path: string): Promise<void> {
    const parts = path.split("/");
    parts.pop();
    let cur = "";
    for (const seg of parts) {
      cur = cur === "" ? seg : `${cur}/${seg}`;
      if (!(await this.app.vault.adapter.exists(cur))) {
        await this.app.vault.createFolder(cur);
      }
    }
  }

  // ------------------------------------------------------------
  // HTTP 与鉴权
  // ------------------------------------------------------------

  /**
   * 调正文同步接口（JSON）：自动带 Bearer accessToken；401（过期/失效）时强制换新令牌后
   * 重试一次，仍 401 才视为账号密码有问题。所有调用都在 syncing 锁内串行，无并发抢号问题。
   */
  private async api<T = unknown>(
    method: "GET" | "POST",
    since?: number,
    body?: unknown,
  ): Promise<T> {
    const vault = encodeURIComponent(this.host.getVaultName());
    const url =
      method === "GET"
        ? `${this.baseUrl()}/api/v1/sync?vault=${vault}&since=${since}&limit=${PULL_LIMIT}`
        : `${this.baseUrl()}/api/v1/sync?vault=${vault}`;

    let res = await this.send(url, method, await this.ensureAccessToken(),
      method === "POST" ? JSON.stringify(body) : undefined, "application/json");
    if (res.status === 401) {
      res = await this.send(url, method, await this.ensureAccessToken(true),
        method === "POST" ? JSON.stringify(body) : undefined, "application/json");
      if (res.status === 401) throw new SyncAuthError();
    }
    if (res.status !== 200) throw new Error(`服务器返回 HTTP ${res.status}`);
    const json = res.json as { code?: number; message?: string; data?: T } | undefined;
    if (!json || json.code !== 0 || json.data === undefined) {
      throw new Error((json && json.message) || "响应格式错误");
    }
    return json.data;
  }

  /**
   * 调附件接口（URL 带 vault 名，与正文同步同一套仓库定位）。续期逻辑与 {@link api} 相同。
   *
   * @param query 形如 `&path=<urlencoded>`
   * @param bytes 上传时是文件原始字节；下载/删除传 undefined
   */
  private async attachmentRequest(
    method: "GET" | "POST" | "DELETE",
    query: string,
    bytes?: ArrayBuffer,
  ): Promise<{ status: number; json: unknown; bytes: ArrayBuffer | null }> {
    const url = `${this.baseUrl()}/api/v1/sync/attachments?vault=${encodeURIComponent(this.host.getVaultName())}${query}`;
    let res = await this.send(url, method, await this.ensureAccessToken(), bytes, "application/octet-stream");
    if (res.status === 401) {
      res = await this.send(url, method, await this.ensureAccessToken(true), bytes, "application/octet-stream");
      if (res.status === 401) throw new SyncAuthError();
    }
    if (res.status !== 200) {
      // 服务端的 message 有信息量（"只同步 png / ..."、"仓库附件配额已满"），别丢了
      const message = (res.json as { message?: string } | undefined)?.message;
      throw new Error(`附件同步失败（HTTP ${res.status}）${message ? "：" + message : ""}`);
    }
    return res;
  }

  /** 下载附件原始字节。非凭证类失败只告警返回 null（服务端盘上文件丢了、单张图坏掉都不该打断整轮同步） */
  private async downloadAttachment(path: string): Promise<ArrayBuffer | null> {
    try {
      return (await this.attachmentRequest("GET", `&path=${encodeURIComponent(path)}`)).bytes;
    } catch (err) {
      if (err instanceof SyncAuthError) throw err;
      console.warn(`Quick Daily Note: 附件下载失败 ${path}`, err);
      return null;
    }
  }

  /** 服务端地址归一化：去掉尾部斜杠，没写协议就按 http 补（本地联调常只写 ip:port） */
  private baseUrl(): string {
    const base = this.state.serverUrl.trim().replace(/\/+$/, "");
    return /^https?:\/\//i.test(base) ? base : "http://" + base;
  }

  /**
   * 单次 HTTP 请求（不解释业务状态码）。
   *
   * @param body 已序列化好的 JSON 串，或附件上传的原始字节；GET/DELETE 传 undefined
   */
  private async send(
    url: string,
    method: "GET" | "POST" | "DELETE",
    accessToken: string,
    body: string | ArrayBuffer | undefined,
    contentType: string,
  ): Promise<{ status: number; json: unknown; bytes: ArrayBuffer | null }> {
    try {
      const res = await requestUrl({
        url,
        method,
        headers: { "Content-Type": contentType, Authorization: `Bearer ${accessToken}` },
        body,
        throw: false,
      });
      return { status: res.status, json: res.json, bytes: res.arrayBuffer };
    } catch (err) {
      throw new Error(`无法连接同步服务器（${String(err)}）`);
    }
  }

  /**
   * 拿可用的 accessToken：
   * 有缓存直接用；force（401 后）或无缓存时先试 refreshToken 换新对
   * （服务端一次性轮换，旧 refresh 立即作废），refresh 不可用（过期/作废/网络异常）
   * 一律落到账号密码登录——登录被拒才是真正的凭证问题，抛 SyncAuthError。
   * 轮换出的新 refreshToken 即刻持久化，防中途退出丢失。
   */
  private async ensureAccessToken(force = false): Promise<string> {
    if (!force && this.accessToken) return this.accessToken;
    if (this.state.refreshToken) {
      try {
        const data = await this.tokenRequest("/api/v1/auth/refresh", {
          refreshToken: this.state.refreshToken,
        });
        this.applyTokenPair(data);
        return this.accessToken!;
      } catch {
        // refresh 已过期/被轮换作废（或暂时连不上——登录请求会给出真实原因）
        this.state.refreshToken = "";
      }
    }
    const data = await this.tokenRequest("/api/v1/auth/login", {
      username: this.state.username.trim(),
      password: this.state.password,
    });
    this.applyTokenPair(data);
    return this.accessToken!;
  }

  /** 登录/刷新接口的裸请求：非 200 一律按服务端 message 抛错，401 视为凭证问题 */
  private async tokenRequest(path: string, payload: unknown): Promise<TokenPairData> {
    let res;
    try {
      res = await requestUrl({
        url: `${this.baseUrl()}${path}`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        throw: false,
      });
    } catch (err) {
      throw new Error(`无法连接同步服务器（${String(err)}）`);
    }
    const json = res.json as { code?: number; message?: string; data?: TokenPairData } | undefined;
    if (res.status === 401 || (json && json.code === 401)) throw new SyncAuthError();
    if (res.status !== 200 || !json || json.code !== 0 || !json.data) {
      throw new Error((json && json.message) || `登录接口返回 HTTP ${res.status}`);
    }
    return json.data;
  }

  /** 记下新的令牌对；refreshToken 落 state（同步周期结束统一持久化，此处再兜底刷一次盘） */
  private applyTokenPair(data: TokenPairData): void {
    this.accessToken = data.accessToken;
    this.state.refreshToken = data.refreshToken;
    void this.host.persist().catch(() => {});
  }

  // ------------------------------------------------------------
  // 状态与提示
  // ------------------------------------------------------------

  private refreshStatus(): void {
    if (this.configured && this.state.enabled) this.host.onStatus("ok");
    else this.host.onStatus("off");
  }

  /** 错误提示去重：同一错误只 Notice 一次，成功后复位（避免周期重试刷屏） */
  private notifyError(err: unknown): void {
    const isAuth = err instanceof SyncAuthError;
    const key = isAuth ? "auth" : err instanceof Error ? err.message : String(err);
    if (key === this.lastErrorNotice) return;
    this.lastErrorNotice = key;
    new Notice(isAuth ? "云同步失败：账号或密码错误，请在插件设置中更新" : `云同步失败：${key}`);
  }
}

/** 拉取响应（与后端 SyncPullResponse 对应） */
interface SyncPullData {
  vaultVersion: number;
  hasMore: boolean;
  records: RemoteRecord[];
  /** 附件元数据，与 records 共用同一条 version 游标 */
  attachments: RemoteAttachment[];
}

/** 登录/刷新响应（与后端 TokenResponse 对应；refreshToken 一次性轮换） */
interface TokenPairData {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}
