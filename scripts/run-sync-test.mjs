/**
 * M3 headless 集成测试：把 sync.ts 打包后接 obsidian 桩，驱动真实 SyncManager
 * 逻辑直连本地 daily-sync 后端，覆盖双设备同步的完整生命周期。
 * M5.1：鉴权改为账号密码登录换 JWT（Bearer），云端仓库按 vault 参数自动创建。
 *
 * 运行：node scripts/run-sync-test.mjs（需后端已在本机 8080 端口运行）
 */
import { build } from "esbuild";
import { createRequire } from "module";
import { setTimeout as sleep } from "timers/promises";
import { mkdirSync, copyFileSync, writeFileSync, rmSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const testBuild = path.join(root, ".test-build");

const BASE = process.env.SYNC_TEST_BASE || "http://localhost:8080";
// 自建测试账号（注册即登录），不依赖库里已有用户；跑完由人工/清理脚本删除
const USERNAME = `plugtest_${Date.now()}`;
const PASSWORD = "PlugTest-2026";

// sync.ts 用到 window.setTimeout 等 Node 下不存在的全局
globalThis.window = globalThis;

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

// ------------------------------------------------------------
// 构建：stub 安装为 .test-build/node_modules/obsidian（与 bundle 共享类身份）
// ------------------------------------------------------------
rmSync(testBuild, { recursive: true, force: true });
mkdirSync(path.join(testBuild, "node_modules", "obsidian"), { recursive: true });
copyFileSync(
  path.join(root, "scripts", "obsidian-stub.cjs"),
  path.join(testBuild, "node_modules", "obsidian", "stub.cjs"),
);
writeFileSync(
  path.join(testBuild, "node_modules", "obsidian", "package.json"),
  JSON.stringify({ name: "obsidian", main: "stub.cjs" }),
);
await build({
  entryPoints: [path.join(root, "sync.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: path.join(testBuild, "sync.bundle.cjs"),
  external: ["obsidian"],
  logLevel: "silent",
});
await build({
  entryPoints: [path.join(root, "todos.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: path.join(testBuild, "todos.bundle.cjs"),
  external: ["obsidian"],
  logLevel: "silent",
});
const require_ = createRequire(import.meta.url);
const { SyncManager, normalizeSyncState, sha256HexBytes } = require_(path.join(testBuild, "sync.bundle.cjs"));
const { mergeTodos, parseSnapshot, buildSnapshot } = require_(path.join(testBuild, "todos.bundle.cjs"));
const stub = require_(path.join(testBuild, "node_modules", "obsidian", "stub.cjs"));

// ------------------------------------------------------------
// 测试用假 vault（内存文件表 + 事件 + 二进制 + metadataCache）
// ------------------------------------------------------------
class FakeVault {
  constructor(name) {
    this.name = name; // 模拟 Obsidian 库名（M5.1：同步按它定位云端仓库）
    this.files = new Map(); // path -> string（文本文件）
    this.binaries = new Map(); // path -> Uint8Array | ArrayBuffer（附件）
    this.folders = new Set();
    this.trashed = [];
    this.listeners = new Map();
    // mtime 用单调递增的假时钟：附件的 mtime+size 旁路缓存要靠它判断"变没变"，
    // 若 mtime 恒为 0，同长度的内容替换会被误判成没变化（同步就失灵了）
    this.clock = 0;
    this.mtimes = new Map();
    // 链接表：引用方笔记 -> 笔记里**原样写的**目标（路径或文件名）。
    // resolvedLinks / unresolvedLinks 由它加当前文件表推导（见下面的 getter），与 Obsidian 一致：
    // 目标能对上实际文件（整路径相同，或文件名相同）才算 resolved，否则进 unresolved。
    //
    // 刻意不做成"测试直接往 resolvedLinks 里塞"：那样能造出 Obsidian 根本不会出现的状态
    // （链接已解析、文件却不存在），而"日记引用的图本地没有"恰恰只可能表现为 unresolved。
    // 上一版就是因为假模型允许了那个非法状态，让"图拉不下来"的 bug 一路测试通过。
    this.linkTargets = new Map();
    this.adapter = {
      exists: async (p) => this.has(p) || this.folders.has(p),
    };
  }
  on(name, cb) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    const ref = { name, cb };
    this.listeners.get(name).add(ref);
    return ref;
  }
  offref(ref) {
    this.listeners.get(ref.name)?.delete(ref);
  }
  emit(name, ...args) {
    for (const { cb } of this.listeners.get(name) ?? []) cb(...args);
  }
  has(p) {
    return this.files.has(p) || this.binaries.has(p);
  }
  sizeOf(p) {
    const bytes = this.binaries.get(p);
    if (bytes !== undefined) return bytes.byteLength;
    const text = this.files.get(p);
    return text === undefined ? 0 : Buffer.byteLength(text, "utf8");
  }
  fileObj(p) {
    const f = new stub.TFile();
    const name = p.split("/").pop();
    const dot = name.lastIndexOf(".");
    f.path = p;
    f.name = name;
    f.extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
    f.basename = dot > 0 ? name.slice(0, dot) : name;
    f.stat = { mtime: this.mtimes.get(p) ?? 0, size: this.sizeOf(p) };
    return f;
  }
  getAbstractFileByPath(p) {
    return this.has(p) ? this.fileObj(p) : null;
  }
  getMarkdownFiles() {
    return [...this.files.keys()].filter((p) => p.endsWith(".md")).map((p) => this.fileObj(p));
  }
  getFiles() {
    return [...this.files.keys(), ...this.binaries.keys()].map((p) => this.fileObj(p));
  }
  async read(file) {
    return this.files.get(file.path);
  }
  async readBinary(file) {
    return this.binaries.get(file.path);
  }
  async modify(file, content) {
    this.files.set(file.path, content);
    this.touch(file.path);
    this.emit("modify", this.fileObj(file.path));
  }
  async modifyBinary(file, bytes) {
    this.binaries.set(file.path, bytes);
    this.touch(file.path);
    this.emit("modify", this.fileObj(file.path));
  }
  async create(path, content) {
    this.files.set(path, content);
    this.touch(path);
    this.emit("create", this.fileObj(path));
  }
  async createBinary(path, bytes) {
    this.binaries.set(path, bytes);
    this.touch(path);
    this.emit("create", this.fileObj(path));
  }
  async trash(file) {
    this.trashed.push(file.path);
    this.files.delete(file.path);
    this.binaries.delete(file.path);
    this.mtimes.delete(file.path);
    this.emit("delete", this.fileObj(file.path));
  }
  async createFolder(path) {
    this.folders.add(path);
  }
  touch(p) {
    this.mtimes.set(p, ++this.clock);
  }
  /** 登记一条「笔记 -> 链接目标」（原样记录，解析交给下面的 getter，模拟 Obsidian 的规则） */
  declareLink(fromPath, target) {
    if (!this.linkTargets.has(fromPath)) this.linkTargets.set(fromPath, new Set());
    this.linkTargets.get(fromPath).add(target);
  }
  /** 把链接目标解析到实际文件：先按整路径，再按文件名（Obsidian 的顺序） */
  resolveTarget(target) {
    const all = [...this.files.keys(), ...this.binaries.keys()];
    return (
      all.find((p) => p === target) ??
      all.find((p) => p.split("/").pop() === target) ??
      null
    );
  }
  /** 能解析到文件的链接：值为解析出的库内路径 */
  get resolvedLinks() {
    const out = {};
    for (const [from, targets] of this.linkTargets) {
      const map = {};
      for (const target of targets) {
        const hit = this.resolveTarget(target);
        if (hit) map[hit] = 1;
      }
      if (Object.keys(map).length > 0) out[from] = map;
    }
    return out;
  }
  /** 解析不到文件的链接：键是笔记里原样写的目标 */
  get unresolvedLinks() {
    const out = {};
    for (const [from, targets] of this.linkTargets) {
      const map = {};
      for (const target of targets) {
        if (!this.resolveTarget(target)) map[target] = 1;
      }
      if (Object.keys(map).length > 0) out[from] = map;
    }
    return out;
  }
  /** 绕过事件的操作（模拟插件未运行时磁盘上的变化） */
  rawSet(p, content) {
    this.files.set(p, content);
    this.touch(p);
  }
  rawSetBinary(p, bytes) {
    this.binaries.set(p, bytes);
    this.touch(p);
  }
  rawDelete(p) {
    this.files.delete(p);
    this.binaries.delete(p);
    this.mtimes.delete(p);
  }
}

function makeManager(vault, state, virtualFiles = {}) {
  const statuses = [];
  const host = {
    getFolder: () => "日记",
    getVaultName: () => vault.name,
    persist: async () => {},
    onStatus: (kind, detail) => statuses.push({ kind, detail }),
    // 虚拟文件（待办数据）默认不参与；需要时由调用方注入
    getVirtualFiles: () => virtualFiles,
  };
  // metadataCache 的两张链接表都从 vault 的链接表 + 文件表实时推导，
  // 插件下一轮扫描就能看到新登记的链接（和 Obsidian 里索引更新后插件读到新链接是一个意思）
  const metadataCache = {
    get resolvedLinks() {
      return vault.resolvedLinks;
    },
    get unresolvedLinks() {
      return vault.unresolvedLinks;
    },
  };
  const app = { vault, metadataCache };
  const manager = new SyncManager(app, state, host);
  return { manager, statuses };
}

function freshState(extra = {}) {
  return normalizeSyncState({
    serverUrl: BASE,
    username: USERNAME,
    password: PASSWORD,
    enabled: true,
    scope: "folder",
    ...extra,
  });
}

// ------------------------------------------------------------
// 后端准备：登录（仓库不再手动创建，由首次同步按 vault 名自动建）
// ------------------------------------------------------------
async function api(method, url, { jwt, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (jwt) headers["Authorization"] = `Bearer ${jwt}`;
  const res = await fetch(BASE + url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => undefined);
  return { status: res.status, json };
}

console.log("== 准备：注册测试账号（注册即登录）==");
const reg = await api("POST", "/api/v1/auth/register", { body: { username: USERNAME, password: PASSWORD } });
assert(reg.status === 200 && reg.json?.code === 0, `注册 ${USERNAME}`);
const AT = reg.json.data.accessToken;

const vaultName = `plugtest-${Date.now()}`;
const vaultQ = encodeURIComponent(vaultName);

async function serverRecords(since = 0) {
  // 按后端分页规则翻页拉全（path 去重取最新版本）
  const byPath = new Map();
  let cursor = since;
  let vaultVersion = since;
  for (;;) {
    const res = await api("GET", `/api/v1/sync?vault=${vaultQ}&since=${cursor}&limit=500`, { jwt: AT });
    const data = res.json.data;
    for (const r of data.records) byPath.set(r.path, r);
    vaultVersion = Math.max(vaultVersion, data.vaultVersion);
    if (!data.hasMore) break;
    // 正文与附件共用一条游标：翻页要取两侧的较大版本号（只取正文那侧会在纯附件页崩掉）
    const tail = [...data.records, ...(data.attachments ?? [])];
    cursor = Math.max(...tail.map((x) => x.version)) - 1;
  }
  return { vaultVersion, hasMore: false, records: [...byPath.values()] };
}

/** 从拉取接口取附件元数据（翻全量后只留非墓碑行） */
async function attachmentRecords() {
  const byPath = new Map();
  let cursor = 0;
  for (;;) {
    const res = await api("GET", `/api/v1/sync?vault=${vaultQ}&since=${cursor}&limit=500`, { jwt: AT });
    const data = res.json.data;
    for (const a of data.attachments ?? []) byPath.set(a.path, a);
    if (!data.hasMore) break;
    const tail = [...data.records, ...(data.attachments ?? [])];
    cursor = Math.max(...tail.map((x) => x.version)) - 1;
  }
  return [...byPath.values()].filter((a) => !a.deleted);
}
async function serverVersion() {
  const res = await api("GET", "/api/v1/vaults", { jwt: AT });
  return res.json.data.find((v) => v.name === vaultName).version;
}

// ------------------------------------------------------------
// 场景 1：设备 A 首次同步（本地既有日记全量上传；仓库自动创建；范围外文件不上传）
// ------------------------------------------------------------
console.log("== 场景 1：首次同步上传（自动建仓 + 范围过滤）==");
const vaultA = new FakeVault(vaultName);
vaultA.rawSet("日记/2026-09-10.md", "# 今日\n- 写 M3 集成测试");
vaultA.rawSet("日记/2026-09-09 灵感.md", "# 灵感\n防抖推送");
vaultA.rawSet("其他/readme.md", "# 不在同步范围");
const stateA = freshState();
const A = makeManager(vaultA, stateA);
A.manager.start();
await A.manager.syncNow("startup");

const vaultList = await api("GET", "/api/v1/vaults", { jwt: AT });
assert(vaultList.json.data.some((v) => v.name === vaultName), `仓库 ${vaultName} 已按库名自动创建`);
let remote = await serverRecords();
assert(
  remote.records.length === 2 && remote.records.some((r) => r.path === "日记/2026-09-10.md"),
  "服务器收到 2 条记录（范围外 readme 未上传）",
);
assert(Object.keys(stateA.hashes).length === 2, "A 的本地哈希表记录 2 个文件");
assert(stateA.cursor === 0, "首次上传后游标暂不推进（pull 先于 push，下轮自愈）");

const v1 = await serverVersion();
await A.manager.syncNow("interval");
const v2 = await serverVersion();
assert(v1 === v2, "无变化的重同步是 no-op（版本不推进）");
assert(stateA.cursor === v2, "第二次同步后游标推进到仓库版本");
assert(stateA.refreshToken !== "", "登录拿到的 refreshToken 已存入设备状态");

// ------------------------------------------------------------
// 场景 2：本地修改 -> 防抖推送
// ------------------------------------------------------------
console.log("== 场景 2：修改防抖推送 ==");
await vaultA.modify(vaultA.fileObj("日记/2026-09-10.md"), "# 今日\n- 写 M3 集成测试\n- 补充：防抖");
await sleep(3500); // 等 3s 防抖 + 网络余量
remote = await serverRecords(0);
const modified = remote.records.find((r) => r.path === "日记/2026-09-10.md");
assert(modified.content.includes("防抖"), "修改已推送到服务器");

// ------------------------------------------------------------
// 场景 3：设备 B 首次拉取（同账号另一台设备，登录换自己的令牌对）
// ------------------------------------------------------------
console.log("== 场景 3：设备 B 全量拉取 ==");
const vaultB = new FakeVault(vaultName);
const stateB = freshState();
const B = makeManager(vaultB, stateB);
B.manager.start();
await B.manager.syncNow("startup");
console.log("    B statuses:", JSON.stringify(B.statuses), "notices:", JSON.stringify(stub.Notice.log));
assert(
  vaultB.files.get("日记/2026-09-10.md") === modified.content &&
    vaultB.files.has("日记/2026-09-09 灵感.md"),
  "B 拉取到 A 的两个文件",
);
assert(vaultB.files.size === 2, "范围外文件未出现在 B");

// ------------------------------------------------------------
// 场景 4：冲突 -> 本地胜
// ------------------------------------------------------------
console.log("== 场景 4：双边修改冲突（本地胜）==");
stub.Notice.log.length = 0;
await vaultA.modify(vaultA.fileObj("日记/2026-09-10.md"), "# 今日\nA 的冲突版本");
await vaultB.modify(vaultB.fileObj("日记/2026-09-10.md"), "# 今日\nB 的冲突版本");
await B.manager.syncNow("manual"); // B 先推
await A.manager.syncNow("manual"); // A 拉取发现冲突 -> 保留本地并重推
remote = await serverRecords(0);
assert(remote.records.find((r) => r.path === "日记/2026-09-10.md").content.includes("A 的冲突版本"),
  "服务器最终是 A 的本地版本（本地胜并重推）");
assert(stub.Notice.log.some((m) => m.includes("都修改过") && m.includes("2026-09-10")),
  "冲突 Notice 已提示");
await B.manager.syncNow("manual");
const bAfter = vaultB.files.get("日记/2026-09-10.md") ?? "";
assert(bAfter.includes("A 的冲突版本"),
  "B 随后被 A 的版本覆盖（后到者胜语义）");

// ------------------------------------------------------------
// 场景 5：删除 -> 墓碑 -> 对端应用
// ------------------------------------------------------------
console.log("== 场景 5：删除墓碑同步 ==");
await vaultA.trash(vaultA.fileObj("日记/2026-09-09 灵感.md"));
await sleep(3500);
remote = await serverRecords(0);
assert(remote.records.find((r) => r.path === "日记/2026-09-09 灵感.md")?.deleted === true,
  "服务器已标记墓碑");
await B.manager.syncNow("manual");
assert(!vaultB.files.has("日记/2026-09-09 灵感.md") && vaultB.trashed.includes("日记/2026-09-09 灵感.md"),
  "B 删除本地文件（进回收站）");

// ------------------------------------------------------------
// 场景 6：离线删除（插件未运行时磁盘删文件）-> 重启后推墓碑
// ------------------------------------------------------------
console.log("== 场景 6：离线删除补推墓碑 ==");
vaultA.rawSet("日记/2026-09-08.md", "# 补一篇");
await A.manager.syncNow("manual");
remote = await serverRecords(0);
assert(remote.records.some((r) => r.path === "日记/2026-09-08.md"), "新文件已上传");
A.manager.destroy();
vaultA.rawDelete("日记/2026-09-08.md"); // 无事件（模拟磁盘直删）
const A2 = makeManager(vaultA, stateA); // 复用 stateA（模拟重启加载持久化状态）
A2.manager.start();
await A2.manager.syncNow("startup");
remote = await serverRecords(0);
assert(remote.records.find((r) => r.path === "日记/2026-09-08.md")?.deleted === true,
  "离线删除在下次同步时补推墓碑");

// ------------------------------------------------------------
// 场景 7：分页拉取（>500 条）
// ------------------------------------------------------------
console.log("== 场景 7：分页拉取 ==");
for (let i = 1; i <= 520; i++) {
  vaultA.rawSet(`日记/bulk-${String(i).padStart(4, "0")}.md`, `# bulk ${i}`);
}
await A2.manager.syncNow("manual");
remote = await serverRecords(0);
const liveCount = remote.records.filter((r) => !r.deleted).length;
assert(liveCount === 521, `服务器共 521 条活记录（当前 ${liveCount}，另有墓碑 ${remote.records.length - liveCount} 条）`);
const vaultD = new FakeVault(vaultName);
const stateD = freshState();
const D = makeManager(vaultD, stateD);
D.manager.start();
await D.manager.syncNow("startup");
assert(vaultD.files.size === 521, `新设备一次同步拉全 521 条（当前 ${vaultD.files.size}，分页翻页生效）`);
assert(stateD.cursor === remote.vaultVersion, "D 游标推进到仓库版本");

// ------------------------------------------------------------
// 场景 8：账号密码错误
// ------------------------------------------------------------
console.log("== 场景 8：账号密码错误 ==");
stub.Notice.log.length = 0;
const vaultE = new FakeVault(vaultName);
const E = makeManager(vaultE, freshState({ password: "wrong-password" }));
E.manager.start();
await E.manager.syncNow("startup");
assert(E.statuses.some((s) => s.kind === "error"), "状态进入 error");
assert(stub.Notice.log.some((m) => m.includes("账号或密码错误")), "401 有明确提示");

// ------------------------------------------------------------
// 场景 9：待办容错——某台设备同步状态丢失（重装 / 清 data.json）也不丢数据
// ------------------------------------------------------------
console.log("\n== 场景 9：待办状态丢失后不破坏云端 ==");
{
  const todoVault = `plugtest-todo-${Date.now()}`;
  const now = Date.now();
  const mkItem = (id, text) => ({ id, text, done: false, updatedAt: now });
  const pullCloud = async () => {
    const res = await api("GET",
      `/api/v1/sync?vault=${encodeURIComponent(todoVault)}&since=0&limit=500`, { jwt: AT });
    const rec = res.json.data.records.find((r) => r.path === "daily-sync-todos.json");
    return rec ? parseSnapshot(rec.content) : null;
  };

  // 设备 A：两条待办，推上去
  let localA = { "2026-01-01": [mkItem("a1", "买牛奶"), mkItem("a2", "写周报")] };
  const mkHost = (name, getTodos, setTodos, files) => ({
    getFolder: () => "日记",
    getVaultName: () => name,
    persist: async () => {},
    onStatus: () => {},
    getVirtualFiles: () => {
      files["daily-sync-todos.json"] = buildSnapshot(getTodos(), now);
      return files;
    },
    mergeVirtualFile: (_p, content) => {
      const snap = parseSnapshot(content);
      if (!snap) return false;
      const merged = mergeTodos(getTodos(), snap.todos);
      if (!merged.changed) return false;
      setTodos(merged.todos);
      return true;
    },
  });

  const countCloud = async () => Object.values((await pullCloud())?.todos ?? {}).flat().length;

  const filesA = {};
  const mgrA = new SyncManager({ vault: new FakeVault(todoVault) }, freshState(),
    mkHost(todoVault, () => localA, (t) => { localA = t; }, filesA));
  await mgrA.syncNow("manual");
  assert((await countCloud()) === 2, `两条待办已同步到云端（当前 ${await countCloud()}）`);

  // 设备 A 的同步状态丢了（重装插件 / 清掉 data.json），本地只有 a1 的旧快照
  let localA2 = { "2026-01-01": [mkItem("a1", "买牛奶")] };
  const filesA2 = {};
  const mgrA2 = new SyncManager({ vault: new FakeVault(todoVault) }, freshState(),
    mkHost(todoVault, () => localA2, (t) => { localA2 = t; }, filesA2));
  await mgrA2.syncNow("manual");

  assert(localA2["2026-01-01"].length === 2,
    `状态丢失后同步，本地从云端补回缺失条目（当前 ${localA2["2026-01-01"].length}）`);
  assert((await countCloud()) === 2, `云端依然是 2 条（当前 ${await countCloud()}）`);

  mgrA.destroy();
  mgrA2.destroy();
}

// ------------------------------------------------------------
// 场景 10：待办条目级双向合并（网页端改动回流到插件）
// ------------------------------------------------------------
console.log("\n== 场景 10：待办条目级双向合并 ==");
{
  const mergeVault = `plugtest-merge-${Date.now()}`;
  // 时间戳必须用真实时间：buildSnapshot 会把「30 天前的墓碑」当过期清掉，
  // 用 1000/4000 这种假值会让条目被误判成过期
  const now = Date.now();
  // 模拟插件侧的 settings.todos（条目带 id/updatedAt）
  let localTodos = {
    "2026-01-01": [
      { id: "t1", text: "买牛奶", done: false, updatedAt: now },
      { id: "t2", text: "写周报", done: false, updatedAt: now },
    ],
  };
  const virtualFiles = {};
  const host = {
    getFolder: () => "日记",
    getVaultName: () => mergeVault,
    persist: async () => {},
    onStatus: () => {},
    getVirtualFiles: () => {
      virtualFiles["daily-sync-todos.json"] = buildSnapshot(localTodos, now);
      return virtualFiles;
    },
    // 真实插件里这个方法把云端快照合并进 settings.todos
    mergeVirtualFile: (_p, content) => {
      const snap = parseSnapshot(content);
      if (!snap) return false;
      const merged = mergeTodos(localTodos, snap.todos);
      if (!merged.changed) return false;
      localTodos = merged.todos;
      return true;
    },
  };
  const vM = new FakeVault(mergeVault);
  const mgr = new SyncManager({ vault: vM }, freshState(), host);
  await mgr.syncNow("manual");
  assert(localTodos["2026-01-01"].length === 2, "插件端首次同步上传了 2 条待办");

  // 模拟「网页端」直接改云端：给 t2 打勾、再新增一条 t3
  const syncUrl = `/api/v1/sync?vault=${encodeURIComponent(mergeVault)}`;
  const webTodos = {
    "2026-01-01": [
      { id: "t1", text: "买牛奶", done: false, updatedAt: now },
      { id: "t2", text: "写周报", done: true, updatedAt: now + 1000 },
      { id: "t3", text: "网页端加的", done: false, updatedAt: now + 1000 },
    ],
  };
  const webPush = await api("POST", syncUrl, {
    jwt: AT,
    body: { items: [{ path: "daily-sync-todos.json", content: buildSnapshot(webTodos, now + 1000) }] },
  });
  assert(webPush.status === 200, "网页端提交了新快照（含新增与勾选）");

  // 插件再同步：应把网页端的改动合并进来
  await mgr.syncNow("manual");
  const afterMerge = localTodos["2026-01-01"];
  assert(afterMerge.length === 3, `合并后本地 3 条（当前 ${afterMerge.length}）`);
  assert(
    afterMerge.map((i) => i.id).sort().join(",") === "t1,t2,t3",
    "网页端新增的 t3 已回流到本地",
  );
  assert(afterMerge.find((i) => i.id === "t2")?.done === true, "网页端的勾选状态已合并到本地");

  // 反向：插件端删一条，应以墓碑同步到云端
  localTodos["2026-01-01"].find((i) => i.id === "t1").deleted = true;
  localTodos["2026-01-01"].find((i) => i.id === "t1").updatedAt = now + 2000;
  await mgr.syncNow("manual");
  const pull = await api("GET", `${syncUrl}&since=0&limit=500`, { jwt: AT });
  const cloudRec = pull.json.data.records.find((r) => r.path === "daily-sync-todos.json");
  const cloudSnap = parseSnapshot(cloudRec.content);
  assert(
    cloudSnap.todos["2026-01-01"].find((i) => i.id === "t1")?.deleted === true,
    "插件端的删除以墓碑同步到云端",
  );

  mgr.destroy();
}

// ------------------------------------------------------------
// 场景 7：附件同步（M7）
//   只同步被日记引用到的图片（附件在日记文件夹之外也照样同步）；
//   重复同步幂等；空库设备按需补齐且逐字节一致；删引用+删文件 -> 墓碑 -> 对端进回收站；
//   没被引用的、以及白名单外的（.exe）一律不上云
// ------------------------------------------------------------
console.log("== 场景 7：附件同步 ==");

const PNG_A = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PNG_B = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9]);
const shaOf = (bytes) =>
  sha256HexBytes(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const vaultF = new FakeVault(vaultName);
vaultF.rawSet("日记/2026-09-11.md", "# 有图\n![[截图.png]]");
vaultF.rawSetBinary("attachments/截图.png", PNG_A);
vaultF.rawSetBinary("attachments/没人引用.png", PNG_B); // 没被任何日记引用：不该上云
vaultF.rawSetBinary("attachments/木马.exe", PNG_A); // 白名单外：不该上云
vaultF.declareLink("日记/2026-09-11.md", "attachments/截图.png");

const stateF = freshState();
const F = makeManager(vaultF, stateF);
F.manager.start();
await F.manager.syncNow("manual");

let remoteAtts = await attachmentRecords();
assert(remoteAtts.length === 1, `只上传被引用的附件（实际 ${remoteAtts.length} 条）`);
assert(
  remoteAtts[0]?.path === "attachments/截图.png",
  "被同步的是日记引用到的那张（虽然它在日记文件夹之外）",
);
assert(remoteAtts[0]?.sha256 === (await shaOf(PNG_A)), "云端 sha256 与本地内容一致");
assert(remoteAtts[0]?.name === "截图.png", "云端记录了文件名（网页端 ![[截图.png]] 靠它反查）");

const vfBefore = await serverVersion();
await F.manager.syncNow("interval");
assert((await serverVersion()) === vfBefore, "附件无变化的重同步是 no-op（版本号不推进）");

// 设备 G：空库，从零补齐附件
const vaultG = new FakeVault(vaultName);
const stateG = freshState();
const G = makeManager(vaultG, stateG);
G.manager.start();
await G.manager.syncNow("manual");
const pulled = vaultG.binaries.get("attachments/截图.png");
assert(pulled !== undefined, "空库设备拉到了图片文件");
const pulledBytes = new Uint8Array(pulled);
assert(
  pulledBytes.length === PNG_A.length && pulledBytes.every((b, i) => b === PNG_A[i]),
  "对端图片字节与源端逐字节一致",
);

// 换内容：应重传并更新 sha256
vaultF.rawSetBinary("attachments/截图.png", PNG_B);
await F.manager.syncNow("manual");
remoteAtts = await attachmentRecords();
assert(remoteAtts[0]?.sha256 === (await shaOf(PNG_B)), "图片内容变化后重传（sha256 已更新）");

// 删引用 + 删本地文件 -> 墓碑 -> 对端进回收站
vaultF.rawSet("日记/2026-09-11.md", "# 没图了");
delete vaultF.resolvedLinks["日记/2026-09-11.md"];
vaultF.rawDelete("attachments/截图.png");
await F.manager.syncNow("manual");
assert((await attachmentRecords()).length === 0, "云端附件已置墓碑（非墓碑行 0 条）");
await G.manager.syncNow("manual");
assert(vaultG.trashed.includes("attachments/截图.png"), "对端跟随删除，文件进了回收站");

F.manager.destroy();
G.manager.destroy();

// ------------------------------------------------------------
// 场景 8：附件落在游标之外（复现"传得上去、拉不下来"）
//   设备 A 用 2.8.0（不认识 pull 响应里的 attachments 字段）拉过一轮后，游标会取
//   vaultVersion，把当时那些附件的版本号一并吞掉；之后升级到 2.9.0 再拉，增量里
//   永远不会再出现这些附件。下载必须由"本地日记的引用"反推，而不是等云端下发。
// ------------------------------------------------------------
console.log("== 场景 8：附件落在游标之外 ==");

const LOST = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7, 7]);
const LOST_MD = "# 游标之外的图\n![[lost.png]]";

/** 以原始字节直接传一个附件（模拟另一台设备的上传，绕开插件） */
async function serverUploadAttachment(path, bytes) {
  const res = await fetch(
    `${BASE}/api/v1/sync/attachments?vault=${vaultQ}&path=${encodeURIComponent(path)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", Authorization: `Bearer ${AT}` },
      body: bytes,
    },
  );
  return { status: res.status, json: await res.json().catch(() => undefined) };
}

// 别的设备把图与日记推上云
const upAtt = await serverUploadAttachment("attachments/lost.png", LOST);
assert(upAtt.status === 200 && upAtt.json?.data?.status === "stored", "另一台设备把图传上了云");
const upMd = await api("POST", `/api/v1/sync?vault=${vaultQ}`, {
  jwt: AT,
  body: { items: [{ path: "日记/2026-09-12.md", content: LOST_MD }] },
});
assert(upMd.status === 200, "另一台设备把引用它的日记也推上了云");

// 设备 H：本地有这篇日记（含引用），但游标已经推到当前仓库版本 —— 附件元数据被吞掉
const vaultH = new FakeVault(vaultName);
vaultH.rawSet("日记/2026-09-12.md", LOST_MD);
vaultH.declareLink("日记/2026-09-12.md", "attachments/lost.png");
const stateH = freshState();
stateH.cursor = await serverVersion();
const H2 = makeManager(vaultH, stateH);
H2.manager.start();
const requestsBefore = stub.requests.length;
await H2.manager.syncNow("manual");

const pulledLost = vaultH.binaries.get("attachments/lost.png");
assert(pulledLost !== undefined, "游标越过附件版本号后，仍按日记引用把图补了下来");
if (pulledLost !== undefined) {
  const bytes = new Uint8Array(pulledLost);
  assert(
    bytes.length === LOST.length && bytes.every((b, i) => b === LOST[i]),
    "补下来的字节与云端一致",
  );
  // 关键：这一轮拉取是空的（游标已在附件版本之后），所以图只可能是按文件名主动取回来的。
  // 断言请求确实发出去了，避免这条测试因为别的路径恰好生效而"假通过"
  const pulledByName = stub.requests
    .slice(requestsBefore)
    .some(
      (r) =>
        r.method === "GET" &&
        r.url.includes("/api/v1/sync/attachments") &&
        r.url.includes(`name=${encodeURIComponent("lost.png")}`),
    );
  assert(pulledByName, "确实发出了按文件名取图的 GET 请求（而不是等拉取流下发元数据）");
}

// 云端根本没有的引用（图片只在别的设备上、或已被删除）：静默跳过，不该抛错
vaultH.rawSet("日记/2026-09-12.md", `${LOST_MD}\n![[云端没有这张.png]]`);
vaultH.declareLink("日记/2026-09-12.md", "attachments/云端没有这张.png");
let missingOk = true;
try {
  await H2.manager.syncNow("manual");
} catch (e) {
  missingOk = false;
  console.error("    ", e);
}
assert(missingOk && H2.statuses.at(-1)?.kind === "ok", "云端没有的引用静默跳过，同步整体仍成功");

H2.manager.destroy();

// ------------------------------------------------------------
// 场景 9：日记里是裸文件名引用、云端那张图在别的目录（线上实际遇到的情形）
//   笔记写 ![[Pasted image x.png]]，图不在本地；云端存的是 image/Pasted image x.png。
//   必须按文件名去要，并落到**服务端告诉我们的那个路径**上——落到别处的话，下一轮扫描
//   会把它当成另一个附件重复上传，云端就多出一份。
// ------------------------------------------------------------
console.log("== 场景 9：裸文件名引用 + 云端在别的目录 ==");

const CLOUD_IMG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5, 5, 5, 5, 5]);
const IMG_NAME = "Pasted image 20260901.png";
const CLOUD_PATH = `image/${IMG_NAME}`;
const REF_MD = `# 基名引用\n![[${IMG_NAME}]]`;

const upImg = await serverUploadAttachment(CLOUD_PATH, CLOUD_IMG);
assert(upImg.status === 200 && upImg.json?.data?.status === "stored", "另一台设备把图传到 image/ 目录");
await api("POST", `/api/v1/sync?vault=${vaultQ}`, {
  jwt: AT,
  body: { items: [{ path: "日记/2026-09-13.md", content: REF_MD }] },
});

// 设备 I：本地有这篇日记（写的是裸文件名），但图不在本地 —— 链接因此解析不到
const vaultI = new FakeVault(vaultName);
vaultI.rawSet("日记/2026-09-13.md", REF_MD);
vaultI.declareLink("日记/2026-09-13.md", IMG_NAME); // 笔记里原样写的：只有文件名，没有目录
const stateI = freshState();
stateI.cursor = await serverVersion(); // 游标已在附件版本之后：拉取流不会再下发它的元数据
const I = makeManager(vaultI, stateI);
I.manager.start();
const reqsBefore9 = stub.requests.length;
await I.manager.syncNow("manual");

const pulledImg = vaultI.binaries.get(CLOUD_PATH);
assert(pulledImg !== undefined, `按文件名取回并落在云端路径 ${CLOUD_PATH} 上`);
if (pulledImg !== undefined) {
  const bytes = new Uint8Array(pulledImg);
  assert(
    bytes.length === CLOUD_IMG.length && bytes.every((b, i) => b === CLOUD_IMG[i]),
    "取回的字节与云端一致",
  );
}
const askedByName = stub.requests
  .slice(reqsBefore9)
  .some((r) => r.method === "GET" && r.url.includes("/api/v1/sync/attachments") && r.url.includes("name="));
assert(askedByName, "走的是按文件名（name=）取回，而不是按路径");

// 没有被落成第二份：云端这个文件名下仍只有一行，且本地库根没凭空多出同名文件
const sameName = (await attachmentRecords()).filter(
  (a) => a.path === CLOUD_PATH || a.path === IMG_NAME || a.path.endsWith(`/${IMG_NAME}`),
);
assert(sameName.length === 1 && sameName[0].path === CLOUD_PATH, `云端没有多出重复附件（仍是 ${CLOUD_PATH}）`);
assert(vaultI.binaries.get(IMG_NAME) === undefined, "没有在库根凭空造一个同名文件");

I.manager.destroy();

// ------------------------------------------------------------
A2.manager.destroy();
B.manager.destroy();
D.manager.destroy();
E.manager.destroy();

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
