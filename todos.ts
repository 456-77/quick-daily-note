/**
 * 待办条目的数据结构与双向合并。
 *
 * 这里同时是「插件 ↔ 云端快照」的协议定义：网页端写入的也是同一份格式。
 *
 * 为什么条目要有 id 和 updatedAt：待办现在两边都能改（Obsidian 插件、网页端），
 * 合并时必须能按条目对齐、判断哪一侧更新。没有 id 就只能整表覆盖，
 * 一边加一条、另一边勾一条就会互相冲掉。
 */

/** 快照格式版本；不匹配的快照不参与合并（只推不拉，等新版插件覆盖上去） */
export const SNAPSHOT_VERSION = 2;

/** 墓碑保留时长：超过它就认为各设备早已同步过，可从快照里清掉 */
export const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface TodoItem {
  /** 稳定标识，合并时按它对齐两侧的同一条 */
  id: string;
  text: string;
  done: boolean;
  /** 本条最后修改时间（epoch ms），合并取更新的那一侧 */
  updatedAt: number;
  /**
   * 墓碑。删除不能物理移除：另一侧设备合并时看不到这条，会把它当成
   * 「云端新增」又加回来。标记删除再定期清理才安全。
   */
  deleted?: boolean;
}

export interface TodoSnapshot {
  version: number;
  /** 整份快照的生成时间（ISO），用于两个方向判断谁更早 */
  updatedAt: string;
  todos: Record<string, TodoItem[]>;
}

/** 生成条目 id。优先用 crypto.randomUUID（Obsidian 桌面端与移动端都支持） */
export function newTodoId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 生成云端快照字符串。
 *
 * - 丢弃过期墓碑（保留期见 TOMBSTONE_TTL_MS），避免快照无限膨胀
 * - 同一日期内按 updatedAt 升序（新建的排后面），保证两侧顺序一致、渲染稳定
 * - 只含墓碑的日期整条丢掉
 */
export function buildSnapshot(
  todos: Record<string, TodoItem[]>,
  updatedAt: number,
  now: number = Date.now(),
): string {
  const cleaned: Record<string, TodoItem[]> = {};
  for (const [date, items] of Object.entries(todos)) {
    const kept = items
      .filter((item) => !item.deleted || now - item.updatedAt <= TOMBSTONE_TTL_MS)
      .slice()
      .sort((a, b) => a.updatedAt - b.updatedAt);
    if (kept.length > 0) cleaned[date] = kept;
  }
  const snapshot: TodoSnapshot = {
    version: SNAPSHOT_VERSION,
    updatedAt: new Date(updatedAt).toISOString(),
    todos: cleaned,
  };
  return JSON.stringify(snapshot, null, 2);
}

/** 解析云端快照；格式不符或版本不是当前版本时返回 null（调用方据此跳过合并） */
export function parseSnapshot(content: string): TodoSnapshot | null {
  try {
    const parsed = JSON.parse(content) as TodoSnapshot;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.version !== SNAPSHOT_VERSION) return null;
    if (!parsed.todos || typeof parsed.todos !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

export interface MergeResult {
  todos: Record<string, TodoItem[]>;
  /** 合并结果是否与本地不同（不同才需要回推云端） */
  changed: boolean;
}

/**
 * 条目级双向合并。
 *
 * 规则（按 id 对齐）：
 * - 两侧都有 → 取 updatedAt 更大的一侧（含它的日期归属与删除标记）
 * - 只有一侧有 → 直接保留（新增）
 * - 结果里过滤掉墓碑，只含墓碑的日期整个丢掉
 *
 * 「同一条被两边同时改」时后改的赢——文本不做逐字合并，
 * 但不会变成两条重复项。
 */
export function mergeTodos(
  local: Record<string, TodoItem[]>,
  remote: Record<string, TodoItem[]>,
): MergeResult {
  const localIndex = indexById(local);
  const remoteIndex = indexById(remote);
  const ids = new Set<string>([...localIndex.keys(), ...remoteIndex.keys()]);

  const merged: Record<string, TodoItem[]> = {};
  let changed = false;

  for (const id of ids) {
    const l = localIndex.get(id);
    const r = remoteIndex.get(id);
    let picked: { item: TodoItem; date: string };
    if (l && r) {
      picked = r.item.updatedAt > l.item.updatedAt ? r : l;
    } else {
      picked = (l ?? r) as { item: TodoItem; date: string };
    }

    // 与本地不一致就算有变化（本侧没有、或选中的不是本侧那份、或日期被改到别处）
    if (!l || l.item !== picked.item || l.date !== picked.date) changed = true;

    if (picked.item.deleted) {
      // 墓碑不进结果（保留在各自本地，供下次比较）
      continue;
    }
    (merged[picked.date] ??= []).push(picked.item);
  }

  // 统一排序：同一日期内按 updatedAt 升序，两侧得到一致顺序
  for (const items of Object.values(merged)) {
    items.sort((a, b) => a.updatedAt - b.updatedAt);
  }

  return { todos: merged, changed };
}

/** 展平成 id -> { item, date }，重复 id 时保留 updatedAt 更新的那条 */
function indexById(
  todos: Record<string, TodoItem[]>,
): Map<string, { item: TodoItem; date: string }> {
  const map = new Map<string, { item: TodoItem; date: string }>();
  for (const [date, items] of Object.entries(todos)) {
    for (const item of items) {
      if (!item || typeof item.id !== "string") continue;
      const existing = map.get(item.id);
      if (!existing || item.updatedAt > existing.item.updatedAt) {
        map.set(item.id, { item, date });
      }
    }
  }
  return map;
}

/** 过滤墓碑后的条目（渲染、统计、周回顾都用它，别直接读原数组） */
export function liveItems(items: TodoItem[] | undefined): TodoItem[] {
  return (items ?? []).filter((item) => !item.deleted);
}
