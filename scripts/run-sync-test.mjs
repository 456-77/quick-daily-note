/**
 * M3 headless 集成测试：把 sync.ts 打包后接 obsidian 桩，驱动真实 SyncManager
 * 逻辑直连本地 daily-sync 后端，覆盖双设备同步的完整生命周期。
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
const USERNAME = "shuiyi";
const PASSWORD = "yourPassword123";

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
const require_ = createRequire(import.meta.url);
const { SyncManager, normalizeSyncState } = require_(path.join(testBuild, "sync.bundle.cjs"));
const stub = require_(path.join(testBuild, "node_modules", "obsidian", "stub.cjs"));

// ------------------------------------------------------------
// 测试用假 vault（内存文件表 + 事件）
// ------------------------------------------------------------
class FakeVault {
  constructor() {
    this.files = new Map();
    this.folders = new Set();
    this.trashed = [];
    this.listeners = new Map();
    this.adapter = {
      exists: async (p) => this.files.has(p) || this.folders.has(p),
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
  fileObj(p) {
    const f = new stub.TFile();
    f.path = p;
    f.name = p.split("/").pop();
    f.extension = "md";
    f.basename = f.name.replace(/\.md$/, "");
    return f;
  }
  getAbstractFileByPath(p) {
    return this.files.has(p) ? this.fileObj(p) : null;
  }
  getMarkdownFiles() {
    return [...this.files.keys()].filter((p) => p.endsWith(".md")).map((p) => this.fileObj(p));
  }
  async read(file) {
    return this.files.get(file.path);
  }
  async modify(file, content) {
    this.files.set(file.path, content);
    this.emit("modify", this.fileObj(file.path));
  }
  async create(path, content) {
    this.files.set(path, content);
    this.emit("create", this.fileObj(path));
  }
  async trash(file) {
    this.trashed.push(file.path);
    this.files.delete(file.path);
    this.emit("delete", this.fileObj(file.path));
  }
  async createFolder(path) {
    this.folders.add(path);
  }
  /** 绕过事件的操作（模拟插件未运行时磁盘上的变化） */
  rawSet(p, content) {
    this.files.set(p, content);
  }
  rawDelete(p) {
    this.files.delete(p);
  }
}

function makeManager(vault, state) {
  const statuses = [];
  const host = {
    getFolder: () => "日记",
    persist: async () => {},
    onStatus: (kind, detail) => statuses.push({ kind, detail }),
  };
  const manager = new SyncManager({ vault }, state, host);
  return { manager, statuses };
}

function freshState(token, extra = {}) {
  return normalizeSyncState({ serverUrl: BASE, token, enabled: true, scope: "folder", ...extra });
}

// ------------------------------------------------------------
// 后端准备：登录 -> 建仓库 -> 签两枚令牌
// ------------------------------------------------------------
async function api(method, url, { token, jwt, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["X-Sync-Token"] = token;
  if (jwt) headers["Authorization"] = `Bearer ${jwt}`;
  const res = await fetch(BASE + url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => undefined);
  return { status: res.status, json };
}

console.log("== 准备：登录 / 建仓库 / 签发令牌 ==");
const login = await api("POST", "/api/v1/auth/login", { body: { username: USERNAME, password: PASSWORD } });
assert(login.status === 200 && login.json?.code === 0, "登录成功");
const AT = login.json.data.accessToken;

const vaultName = `plugtest-${Date.now()}`;
const createVault = await api("POST", "/api/v1/vaults", { jwt: AT, body: { name: vaultName } });
assert(createVault.status === 200 && createVault.json?.code === 0, `创建仓库 ${vaultName}`);
const vaultId = createVault.json.data.id;

const [tokenAres, tokenBres] = await Promise.all([
  api("POST", `/api/v1/vaults/${vaultId}/tokens`, { jwt: AT, body: { name: "test-a" } }),
  api("POST", `/api/v1/vaults/${vaultId}/tokens`, { jwt: AT, body: { name: "test-b" } }),
]);
const TOKEN_A = tokenAres.json.data.token;
const TOKEN_B = tokenBres.json.data.token;
assert(TOKEN_A.startsWith("dst_") && TOKEN_B.startsWith("dst_"), "签发两枚同步令牌");

async function serverRecords(since = 0) {
  // 按后端分页规则翻页拉全（path 去重取最新版本）
  const byPath = new Map();
  let cursor = since;
  let vaultVersion = since;
  for (;;) {
    const res = await api("GET", `/api/v1/sync?since=${cursor}&limit=500`, { token: TOKEN_A });
    const data = res.json.data;
    for (const r of data.records) byPath.set(r.path, r);
    vaultVersion = Math.max(vaultVersion, data.vaultVersion);
    if (!data.hasMore) break;
    cursor = data.records[data.records.length - 1].version - 1;
  }
  return { vaultVersion, hasMore: false, records: [...byPath.values()] };
}
async function serverVersion() {
  const res = await api("GET", "/api/v1/vaults", { jwt: AT });
  return res.json.data.find((v) => v.id === vaultId).version;
}

// ------------------------------------------------------------
// 场景 1：设备 A 首次同步（本地既有日记全量上传；范围外文件不上传）
// ------------------------------------------------------------
console.log("== 场景 1：首次同步上传（含范围过滤）==");
const vaultA = new FakeVault();
vaultA.rawSet("日记/2026-09-10.md", "# 今日\n- 写 M3 集成测试");
vaultA.rawSet("日记/2026-09-09 灵感.md", "# 灵感\n防抖推送");
vaultA.rawSet("其他/readme.md", "# 不在同步范围");
const stateA = freshState(TOKEN_A);
const A = makeManager(vaultA, stateA);
A.manager.start();
await A.manager.syncNow("startup");

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
// 场景 3：设备 B 首次拉取
// ------------------------------------------------------------
console.log("== 场景 3：设备 B 全量拉取 ==");
const vaultB = new FakeVault();
const stateB = freshState(TOKEN_B);
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
const vaultD = new FakeVault();
const stateD = freshState(TOKEN_B);
const D = makeManager(vaultD, stateD);
D.manager.start();
await D.manager.syncNow("startup");
assert(vaultD.files.size === 521, `新设备一次同步拉全 521 条（当前 ${vaultD.files.size}，分页翻页生效）`);
assert(stateD.cursor === remote.vaultVersion, "D 游标推进到仓库版本");

// ------------------------------------------------------------
// 场景 8：无效令牌
// ------------------------------------------------------------
console.log("== 场景 8：无效令牌 ==");
stub.Notice.log.length = 0;
const vaultE = new FakeVault();
const E = makeManager(vaultE, freshState("dst_deadbeef"));
E.manager.start();
await E.manager.syncNow("startup");
assert(E.statuses.some((s) => s.kind === "error"), "状态进入 error");
assert(stub.Notice.log.some((m) => m.includes("令牌无效或已撤销")), "401 有明确提示");

// ------------------------------------------------------------
A2.manager.destroy();
B.manager.destroy();
D.manager.destroy();
E.manager.destroy();

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
