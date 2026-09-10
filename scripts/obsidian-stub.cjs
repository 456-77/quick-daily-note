/**
 * obsidian 模块的最小桩实现，仅供 headless 集成测试（scripts/run-sync-test.mjs）使用。
 * 提供 sync.ts 用到的运行时 API：Notice / TFile / requestUrl / EventRef。
 * 安装为 .test-build/node_modules/obsidian，与被测 bundle 共享同一份类定义
 * （保证 instanceof TFile 判定成立）。
 */
"use strict";

class TAbstractFile {}
class TFile extends TAbstractFile {}

/** Notice：记录消息供测试断言 */
class Notice {
  static log = [];
  constructor(message) {
    const text = String(message);
    Notice.log.push(text);
    console.log("  [Notice]", text.replace(/\n/g, " | ").slice(0, 140));
  }
}

/** requestUrl：基于 Node fetch（fetch 对任何状态码都 resolve，网络错误 reject） */
async function requestUrl(options) {
  const res = await fetch(options.url, {
    method: options.method || "GET",
    headers: options.headers || {},
    body: options.body,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json };
}

module.exports = { TAbstractFile, TFile, Notice, requestUrl };
