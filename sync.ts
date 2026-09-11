import { App, EventRef, Notice, TAbstractFile, TFile, requestUrl } from "obsidian";

/**
 * 云同步（daily-sync 服务）客户端。
 *
 * 协议（与后端 M2/M5.1 实现一一对应）：
 * - 推送 POST /api/v1/sync?vault=：批量幂等上传（≤200 条/批，单条 ≤1MB，服务端按内容哈希判重）
 * - 拉取 GET /api/v1/sync?vault=&since=&limit=：按仓库版本号增量；删除以墓碑（deleted=true）下发
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
  lastSyncAt: 0,
  refreshToken: "",
};

/**
 * 从持久化数据恢复同步状态。必须深拷贝 hashes：
 * `{ ...DEFAULT_SYNC_STATE }` 是浅拷贝，多个实例会共享同一个默认哈希表对象，
 * 一台设备的同步状态会"串"到另一台（曾导致新设备把全部文件误判为本地离线删除而推墓碑）。
 */
export function normalizeSyncState(raw: Partial<SyncDeviceState> | undefined | null): SyncDeviceState {
  return { ...DEFAULT_SYNC_STATE, ...raw, hashes: { ...(raw?.hashes ?? {}) } };
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
   * 这些路径只参与推送、拉取时跳过写回：权威数据由插件自己维护，
   * 从云端覆盖回来会破坏本地。
   */
  getVirtualFiles(): Record<string, string>;
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

/** 拉取返回的记录（与后端 SyncPullResponse.Record 对应） */
interface RemoteRecord {
  path: string;
  content: string;
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
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 云端快照是否比本地新（决定要不要放弃本次推送）。
 *
 * 优先比较快照里的 updatedAt。本地还没有时间戳时——老版本升级上来，
 * settings 里新增的字段是 0——退化为比较条目总数：那时无法判断谁更新，
 * 就取保守策略，只有本地条目比云端多才认为该推（否则会拿旧数据覆盖云端）。
 *
 * 任何解析失败都当作「不新」：宁可多推一次，也不能让本地数据卡住推不上去。
 */
function isRemoteNewer(remote: string, local: string): boolean {
  try {
    const remoteSnap = JSON.parse(remote) as SnapshotShape;
    const localSnap = JSON.parse(local) as SnapshotShape;
    const remoteAt = Date.parse(remoteSnap.updatedAt ?? "");
    const localAt = Date.parse(localSnap.updatedAt ?? "");
    if (!Number.isNaN(remoteAt) && localAt > 0) {
      return remoteAt > localAt;
    }
    return countTodos(remoteSnap.todos) >= countTodos(localSnap.todos);
  } catch {
    return false;
  }
}

interface SnapshotShape {
  updatedAt?: string;
  todos?: Record<string, unknown[]>;
}

function countTodos(todos: Record<string, unknown[]> | undefined): number {
  if (!todos) return 0;
  return Object.values(todos).reduce(
    (sum, items) => sum + (Array.isArray(items) ? items.length : 0),
    0
  );
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
    if (this.dirty.size > 0 && this.configured) void this.flushPushes();
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
      await this.scanLocalFiles();
      await this.pullAndApply();
      await this.doFlush();
      this.state.lastSyncAt = Date.now();
      this.lastErrorNotice = "";
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

  /** 防抖期结束/卸载时的推送入口（独立于 syncNow，轻量：只发不等） */
  private async flushPushes(): Promise<void> {
    if (this.dirty.size === 0 || !this.configured) return;
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
    if (!path.endsWith(".md")) return;
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
    }
    if (file instanceof TFile) this.schedulePush(file.path, "mod");
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
  }

  // ------------------------------------------------------------
  // 推送
  // ------------------------------------------------------------

  /** 把 dirty 队列分批发出（调用方需已持有 syncing 锁） */
  private async doFlush(): Promise<void> {
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
          // 云端更新则放弃本次推送：待办快照是「整体覆盖」语义，而本机可能还没追上
          // （库同步工具尚未把最新待办拉到本机），照推会用旧数据覆盖其他设备的新数据。
          // 记下云端的哈希，避免每轮都重复入队重试。
          const remote = this.remoteVirtual.get(path);
          if (remote !== undefined && isRemoteNewer(remote, virtualContent)) {
            this.state.hashes[path] = await sha256Hex(remote);
            this.dirty.delete(path);
            continue;
          }
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
  // 拉取与应用
  // ------------------------------------------------------------

  /** 增量拉取并应用到本地（按 M2 分页规则翻页，path 去重取最新版本） */
  private async pullAndApply(): Promise<void> {
    const applied = new Map<string, RemoteRecord>();
    let since = this.state.cursor;
    let finalCursor = this.state.cursor;
    for (;;) {
      const data = await this.api<SyncPullData>("GET", since);
      for (const rec of data.records) applied.set(rec.path, rec);
      for (const rec of data.records) {
        if (rec.version > finalCursor) finalCursor = rec.version;
      }
      if (data.vaultVersion > finalCursor) finalCursor = data.vaultVersion;
      if (!data.hasMore) break;
      const last = data.records[data.records.length - 1];
      const next = last.version - 1;
      if (next <= since) break; // 防御：正常不会发生（见 M2 1.4 不变式）
      since = next;
    }

    const conflicts: string[] = [];
    this.applyingRemote++;
    try {
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
    // 虚拟文件不落盘：权威数据由插件自己维护（如待办的本地设置），
    // 从云端写回会覆盖本地。这里只记下云端内容，推送时用它判断谁更新。
    if (this.virtualPaths.has(rec.path)) {
      if (rec.deleted) this.remoteVirtual.delete(rec.path);
      else this.remoteVirtual.set(rec.path, rec.content);
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
   * 调同步接口：自动带 Bearer accessToken；401（过期/失效）时强制换新令牌后重试一次，
   * 仍 401 才视为账号密码有问题。所有 api 调用都在 syncing 锁内串行，无并发抢号问题。
   */
  private async api<T = unknown>(
    method: "GET" | "POST",
    since?: number,
    body?: unknown,
  ): Promise<T> {
    let base = this.state.serverUrl.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(base)) base = "http://" + base;
    const vault = encodeURIComponent(this.host.getVaultName());
    const url =
      method === "GET"
        ? `${base}/api/v1/sync?vault=${vault}&since=${since}&limit=${PULL_LIMIT}`
        : `${base}/api/v1/sync?vault=${vault}`;

    let res = await this.request(url, method, await this.ensureAccessToken(), body);
    if (res.status === 401) {
      res = await this.request(url, method, await this.ensureAccessToken(true), body);
      if (res.status === 401) throw new SyncAuthError();
    }
    if (res.status !== 200) throw new Error(`服务器返回 HTTP ${res.status}`);
    const json = res.json as { code?: number; message?: string; data?: T } | undefined;
    if (!json || json.code !== 0 || json.data === undefined) {
      throw new Error((json && json.message) || "响应格式错误");
    }
    return json.data;
  }

  /** 单次 HTTP 请求（不解释业务状态码） */
  private async request(
    url: string,
    method: "GET" | "POST",
    accessToken: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    try {
      const res = await requestUrl({
        url,
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: method === "POST" ? JSON.stringify(body) : undefined,
        throw: false,
      });
      return { status: res.status, json: res.json };
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
    let base = this.state.serverUrl.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(base)) base = "http://" + base;
    let res;
    try {
      res = await requestUrl({
        url: `${base}${path}`,
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
}

/** 登录/刷新响应（与后端 TokenResponse 对应；refreshToken 一次性轮换） */
interface TokenPairData {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}
