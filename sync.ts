import { App, EventRef, Notice, TAbstractFile, TFile, requestUrl } from "obsidian";

/**
 * 云同步（daily-sync 服务）客户端。
 *
 * 协议（与后端 M2 实现一一对应）：
 * - 推送 POST /api/v1/sync：批量幂等上传（≤200 条/批，单条 ≤1MB，服务端按内容哈希判重）
 * - 拉取 GET /api/v1/sync?since=&limit=：按仓库版本号增量；删除以墓碑（deleted=true）下发
 * - 鉴权：X-Sync-Token 头，dst_ 开头的设备令牌（一台设备一枚，撤销立即 401）
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
  /** dst_ 同步令牌 */
  token: string;
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
}

export const DEFAULT_SYNC_STATE: SyncDeviceState = {
  serverUrl: "",
  token: "",
  enabled: false,
  scope: "folder",
  cursor: 0,
  hashes: {},
  lastSyncAt: 0,
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
  /** 持久化同步状态到本机 data.json */
  persist(): Promise<void>;
  /** 状态栏等 UI 回调 */
  onStatus(kind: SyncStatusKind, detail?: string): void;
}

/** 本地修改后延迟推送的静默期：防抖合并连续输入 */
const PUSH_DEBOUNCE_MS = 3000;
/** 周期性全量同步间隔 */
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
/** 启动后延迟首同步，等 Obsidian 索引与界面就绪 */
const STARTUP_DELAY_MS = 5000;
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

/** 401：令牌无效或已撤销（提示用户去设置里更新，别当成网络错误重试轰炸） */
class SyncAuthError extends Error {
  constructor() {
    super("同步令牌无效或已撤销");
  }
}

/** SHA-256 十六进制（与后端 HashUtil.sha256Hex 对 UTF-8 字节的结果一致） */
export async function sha256Hex(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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

  constructor(app: App, state: SyncDeviceState, host: SyncHost) {
    this.app = app;
    this.state = state;
    this.host = host;
  }

  /** 服务端地址与令牌都已配置 */
  get configured(): boolean {
    return this.state.serverUrl.trim() !== "" && this.state.token.trim() !== "";
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
      if (trigger === "manual") new Notice("云同步：请先在插件设置中填写服务端地址与同步令牌");
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
  // HTTP
  // ------------------------------------------------------------

  private async api<T = unknown>(
    method: "GET" | "POST",
    since?: number,
    body?: unknown,
  ): Promise<T> {
    let base = this.state.serverUrl.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(base)) base = "http://" + base;
    const url =
      method === "GET" ? `${base}/api/v1/sync?since=${since}&limit=${PULL_LIMIT}` : `${base}/api/v1/sync`;
    let res;
    try {
      res = await requestUrl({
        url,
        method,
        headers: { "Content-Type": "application/json", "X-Sync-Token": this.state.token.trim() },
        body: method === "POST" ? JSON.stringify(body) : undefined,
        throw: false,
      });
    } catch (err) {
      throw new Error(`无法连接同步服务器（${String(err)}）`);
    }
    if (res.status === 401) throw new SyncAuthError();
    if (res.status !== 200) throw new Error(`服务器返回 HTTP ${res.status}`);
    const json = res.json as { code?: number; message?: string; data?: T } | undefined;
    if (!json || json.code !== 0 || json.data === undefined) {
      throw new Error((json && json.message) || "响应格式错误");
    }
    return json.data;
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
    new Notice(isAuth ? "云同步失败：令牌无效或已撤销，请在插件设置中更新" : `云同步失败：${key}`);
  }
}

/** 拉取响应（与后端 SyncPullResponse 对应） */
interface SyncPullData {
  vaultVersion: number;
  hasMore: boolean;
  records: RemoteRecord[];
}
