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

/** 请求记录：测试用来断言"某条请求确实发出去了"（如按路径补下附件） */
const requests = [];

/**
 * requestUrl：基于 Node fetch（fetch 对任何状态码都 resolve，网络错误 reject）。
 *
 * 与 Obsidian 真实行为对齐：text / json 只在响应类型匹配时才填，
 * arrayBuffer 恒有（附件下载靠它取字节）。若像早期那样无条件 text+JSON.parse，
 * 二进制响应会拿到一堆乱码 text，而真正的 arrayBuffer 是 undefined——
 * 附件下载的 bug 就测不出来了。
 */
async function requestUrl(options) {
  requests.push({ method: options.method || "GET", url: options.url });
  const res = await fetch(options.url, {
    method: options.method || "GET",
    headers: options.headers || {},
    body: options.body,
  });
  const arrayBuffer = await res.arrayBuffer();
  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  const isJson = contentType.includes("json");
  const isText = isJson || contentType.startsWith("text/");
  const text = isText ? new TextDecoder().decode(arrayBuffer) : undefined;
  let json;
  if (isJson) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }
  return { status: res.status, arrayBuffer, text, json };
}

module.exports = { TAbstractFile, TFile, Notice, requestUrl, requests };
