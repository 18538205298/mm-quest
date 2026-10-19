// ============================================================
// public/app/selfcheck.js —— 前端错误自动上报 (2026-09-27)
// 拦截 console.error + window.onerror + unhandledrejection，
// 自动 POST 到 /api/log，写进 data/client-logs.jsonl。
// 这样 AI 可以直接读日志文件，不用等用户复制报错。
// ============================================================
"use strict";

(function () {
  if (typeof window === "undefined") return;

  // ── 拦截 console.error ──
  const origError = console.error.bind(console);
  console.error = function (...args) {
    origError.apply(console, args);
    try {
      const msg = args.map((a) => {
        if (typeof a === "string") return a;
        if (a instanceof Error) return a.message + (a.stack ? "\n" + a.stack : "");
        try { return JSON.stringify(a); } catch (_) { return String(a); }
      }).join(" ");
      fetch("/api/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level: "error", msg: msg, at: Date.now(), src: "console.error" }),
      }).catch(() => {});
    } catch (_) {}
  };

  // ── 拦截未捕获的 JS 错误 ──
  window.addEventListener("error", function (ev) {
    try {
      const msg = "未捕获错误: " + (ev.message || "") + " (at " + (ev.filename || "") + ":" + (ev.lineno || "?") + ")";
      console.error(msg);  // 触发上面的 console.error 拦截
      fetch("/api/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level: "error", msg: msg, at: Date.now(), src: "window.error", stack: ev.error && ev.error.stack }),
      }).catch(() => {});
    } catch (_) {}
  });

  // ── 拦截未处理的 Promise rejection ──
  window.addEventListener("unhandledrejection", function (ev) {
    try {
      const reason = ev.reason;
      const msg = "未处理的 Promise 拒绝: " + (reason instanceof Error ? reason.message : String(reason));
      console.error(msg);
      fetch("/api/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level: "error", msg: msg, at: Date.now(), src: "unhandledrejection", stack: reason instanceof Error ? reason.stack : null }),
      }).catch(() => {});
    } catch (_) {}
  });

  // ── 页面加载自检 ──
  function runSelfcheck() {
    const B = (window.MMQ_BRIDGE = window.MMQ_BRIDGE || {});
    const errors = [];

    function check(name, cond, detail) {
      if (!cond) errors.push(name + (detail ? ": " + detail : ""));
    }

    try {
      check("MMQ_BRIDGE 存在", !!B);
      check("B.state 存在", !!B.state, "app.js 未加载");
      check("B.MAP 存在", !!B.MAP, "data/map.js 未加载");
      check("B.session 存在", !!B.session, "session-store.js 未挂载到桥接对象");
      if (B.session) {
        check("B.session.update 是函数", typeof B.session.update === "function");
        check("B.session.get 是函数", typeof B.session.get === "function");
      }
      check("ChatLayer 类存在", typeof window.ChatLayer === "function", "chat-layer.js 未加载");
      check("ActPage 类存在", typeof window.ActPage === "function", "act-page.js 未加载");
      check("Logger 存在", typeof Logger !== "undefined" && typeof Logger.info === "function", "logger.js 未加载");
      check("showActMap 函数存在", typeof showActMap === "function", "view-map.js 未加载");
      check("loadSections 函数存在", typeof loadSections === "function", "act-anim.js 未加载");
      check("ensureAnim 函数存在", typeof ensureAnim === "function", "act-anim.js 未加载");
      check("#storyWrap 存在", !!document.getElementById("storyWrap"));
      check("#xpBadge 存在", !!document.getElementById("xpBadge"));
    } catch (e) {
      errors.push("自检异常: " + e.message);
    }

    if (errors.length > 0) {
      const msg = "[自检失败] " + errors.length + " 个问题:\n" + errors.map((e) => "  ✗ " + e).join("\n");
      console.error(msg);  // 自动上报
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", runSelfcheck);
  } else {
    runSelfcheck();
  }
})();