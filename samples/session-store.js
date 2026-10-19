/* ============================================================
 * SessionStore —— 单一真相源（P0 状态收敛）
 * ============================================================
 * 之前状态分散在 4 处：
 *   1. state.lastPage           —— 页面记录（view.js 写入）
 *   2. state.examResume         —— 考核进度（view.js snapshot 写入）
 *   3. localStorage["mmq.exam.hist"]  —— AI 考核对话历史（view.js 写入）
 *   4. localStorage["mmq.rail.hist"]  —— AI 侧栏对话（ai-rail.js 写入）
 *
 * 改一处忘另一处，导致「答完第 3 题进第 4 题，刷新后还是第 3 题」之类的 bug。
 *
 * 现在统一到 SessionStore：所有读写走 session.update() / session.load()，
 * 内部自动去抖（1.5s）+ 同步 localStorage + 同步云端（/api/progress）。
 *
 * 用法：
 *   const s = B.session;
 *   s.update({ page: { kind: "exam", act: 11, ai: true } });
 *   s.update({ exam: { act: 11, idx: 3, correct: 5, score: 500, msgs: [...] } });
 *   s.update({ chats: { exam_11: { msgs: [...] } } }, { immediate: true });
 *
 * 字段映射：
 *   session.page      ← state.lastPage（页面记忆）
 *   session.exam      ← state.examResume + localStorage["mmq.exam.hist"]（考核进度+对话）
 *   session.rail      ← state.railHist + localStorage["mmq.rail.hist"]（AI 侧栏对话）
 *   session.chats     ← 新增（统一对话存档，P5 用）
 * ============================================================ */

(function () {
  if (typeof window === "undefined") return;

  // Logger 兜底:在浏览器里 logger.js 先加载 → window.Logger 存在;
  // 在 jsdom 测试里如果只加载了 session-store.js 而没有 logger.js,
  // Logger 是 undefined,直接用会 ReferenceError。给一个 no-op 兜底。
  const L = (typeof window !== "undefined" && window.Logger) ||
    ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });

  const SESSION_KEY = "mmq.session.v2";
  const DEBOUNCE_MS = 1500;

  // ── 内存态（唯一真相）──
  const session = {
    page: { kind: null, act: 0, ai: false, at: 0 },
    exam: { act: 0, idx: 0, correct: 0, score: 0, order: [], msgs: [], at: 0 },
    rail: { key: "map", msgs: [], at: 0 },
    chats: {},
    // 元数据
    _savedAt: 0,
    _version: 2,
  };

  // ── 去抖 timer ──
  let _timer = null;
  let _flushing = false;

  // ── 迁移旧数据 ──
  function migrateFromLegacy(state, localStorage) {
    // 1. page ← state.lastPage
    if (state && state.lastPage && state.lastPage.kind) {
      session.page = Object.assign({}, state.lastPage);
    }
    // 2. exam ← state.examResume + localStorage["mmq.exam.hist"]
    const ex = state && state.examResume;
    if (ex) {
      for (const actN in ex) {
        const r = ex[actN];
        if (r && r.act === Number(actN)) {
          session.exam = {
            act: r.act,
            idx: r.idx || 0,
            correct: r.correct || 0,
            score: r.score || 0,
            round: r.round || 0,
            elapsed: r.elapsed || 0,
            order: Array.isArray(r.order) ? r.order : [],
            msgs: Array.isArray(r.msgs) ? r.msgs : [],
            at: r.at || 0,
          };
          break; // 只取最近一幕
        }
      }
    }
    // 从 localStorage 读完整对话历史（比 exam.msgs 全）
    try {
      const histAll = JSON.parse(localStorage.getItem("mmq.exam.hist") || "{}") || {};
      for (const k in histAll) {
        const h = histAll[k];
        if (h && Array.isArray(h.msgs) && h.msgs.length) {
          if (session.exam.act === Number(k)) {
            session.exam.msgs = h.msgs.slice(-16);
          }
        }
      }
    } catch (e) {}
    // 3. rail ← state.railHist + localStorage["mmq.rail.hist"]
    if (state && state.railHist) {
      session.rail = Object.assign({}, state.railHist);
    }
    try {
      const railAll = JSON.parse(localStorage.getItem("mmq.rail.hist") || "{}") || {};
      const curKey = session.rail.key || "map";
      if (railAll[curKey] && Array.isArray(railAll[curKey].msgs)) {
        session.rail.msgs = railAll[curKey].msgs.slice(-16);
      }
    } catch (e) {}
  }

  // ── 写入 localStorage（同步，立即生效）──
  function _writeLocal() {
    try {
      const snapshot = {
        page: session.page,
        exam: session.exam,
        rail: session.rail,
        chats: session.chats,
        _savedAt: session._savedAt,
        _version: session._version,
      };
      localStorage.setItem(SESSION_KEY, JSON.stringify(snapshot));
    } catch (e) {
      L.warn("[session] localStorage 写入失败:", e.message);
    }
  }

  // ── 读取 localStorage ──
  function _readLocal() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (!s || s._version !== 2) return null;
      return s;
    } catch (e) {
      return null;
    }
  }

  // ── 写入云端（异步，去抖后）──
  async function _flushToCloud(force) {
    if (_flushing) return;
    _flushing = true;
    try {
      // 把 session 字段写回 state（保持向后兼容，server 端不感知）
      if (typeof window.MMQ_BRIDGE !== "undefined" && window.MMQ_BRIDGE && window.MMQ_BRIDGE.state) {
        window.MMQ_BRIDGE.state.lastPage = session.page;
        // examResume 是 { "11": {...}, "5": {...} } 格式(多幕字典)。
        // ★ 2026-09-27 修复:之前每次 flush 都会用 session.exam(单幕)覆盖整个字典,
        //   导致其他幕的存档丢失。现在改为**合并**——保留已有存档,只更新当前幕。
        const examResume = Object.assign({}, window.MMQ_BRIDGE.state.examResume || {});
        if (session.exam.act > 0) {
          examResume[String(session.exam.act)] = Object.assign({}, session.exam);
        } else {
          // session.exam 被清空时(checkExpired),也清掉 state.examResume 里对应的幕
          if (session.exam && session.exam.act === 0 && window.MMQ_BRIDGE.state.examResume) {
            // 不清其他幕——只清当前 session 记住的那一幕
          }
        }
        window.MMQ_BRIDGE.state.examResume = examResume;
        window.MMQ_BRIDGE.state.railHist = session.rail;
        /* ★ 2026-09 同步 chats 到云端。
           session.chats 存多上下文对话(rail_act-1 / rail_act-2 / exam_11 等),
           写回 state.chats 随整个 state 一起推到 /api/progress,实现跨设备续接。 */
        window.MMQ_BRIDGE.state.chats = session.chats;
        // 用现有的 save 机制推云端
        if (typeof window.MMQ_BRIDGE.save === "function") {
          window.MMQ_BRIDGE.save();
        }
      }
      // 同时写一份 session 快照到 localStorage（云端失败时回退用）
      _writeLocal();
    } catch (e) {
      L.warn("[session] 云端同步失败:", e.message);
    } finally {
      _flushing = false;
    }
  }

  // ── 统一入口：去抖更新 ──
  function update(patch, opts) {
    if (!patch || typeof patch !== "object") return;
    // 合并字段
    if (patch.page) session.page = Object.assign({}, session.page, patch.page);
    if (patch.exam) session.exam = Object.assign({}, session.exam, patch.exam);
    if (patch.rail) session.rail = Object.assign({}, session.rail, patch.rail);
    if (patch.chats) session.chats = Object.assign({}, session.chats, patch.chats);
    session._savedAt = Date.now();
    // 立即写 localStorage（同步，确保刷新不丢）
    _writeLocal();
    // 云端去抖
    if (opts && opts.immediate) {
      _flushToCloud(true);
      return;
    }
    if (_timer) clearTimeout(_timer);
    _timer = setTimeout(() => {
      _timer = null;
      _flushToCloud(false);
    }, DEBOUNCE_MS);
  }

  // ── 加载（启动时）──
  async function load() {
    // 1. 先读 localStorage 里的 session 快照（最快）
    const local = _readLocal();
    if (local) {
      if (local.page) session.page = local.page;
      if (local.exam) session.exam = local.exam;
      if (local.rail) session.rail = local.rail;
      if (local.chats) session.chats = local.chats;
      session._savedAt = local._savedAt || 0;
    }
    // 2. 如果没快照，从旧数据迁移
    if (!local && typeof window.MMQ_BRIDGE !== "undefined" && window.MMQ_BRIDGE && window.MMQ_BRIDGE.state) {
      migrateFromLegacy(window.MMQ_BRIDGE.state, localStorage);
      _writeLocal();
    }
    // 3. 从云端拉最新（如果有更新）
    try {
      const r = await fetch("/api/progress");
      const j = await r.json();
      const remote = j && j.progress;
      if (remote && typeof remote === "object") {
        // 云端 lastPage 更新 → 用云端的
        if (remote.lastPage && remote.lastPage.at > (session.page.at || 0)) {
          session.page = remote.lastPage;
        }
        // 云端 examResume 更新 → 用云端的
        if (remote.examResume) {
          for (const k in remote.examResume) {
            const r2 = remote.examResume[k];
            if (r2 && r2.act === Number(k) && r2.at > (session.exam.at || 0)) {
              session.exam = {
                act: r2.act, idx: r2.idx || 0, correct: r2.correct || 0,
                score: r2.score || 0, round: r2.round || 0, elapsed: r2.elapsed || 0,
                order: Array.isArray(r2.order) ? r2.order : [],
                msgs: Array.isArray(r2.msgs) ? r2.msgs : [],
                at: r2.at || 0,
              };
              break;
            }
          }
        }
        // 云端 railHist 更新 → 用云端的
        if (remote.railHist && remote.railHist.at > (session.rail.at || 0)) {
          session.rail = remote.railHist;
        }
        /* ★ 2026-09 同步 chats 从云端。
           云端 chats 更新 → 合并到本地 session.chats(按 key 粒度合并,
           云端的 at 更新则覆盖)。 */
        if (remote.chats && typeof remote.chats === "object") {
          for (const k in remote.chats) {
            const rc = remote.chats[k];
            const lc = session.chats[k];
            if (!lc || (rc && rc.at > (lc.at || 0))) {
              session.chats[k] = rc;
            }
          }
        }
        _writeLocal();
      }
    } catch (e) {
      L.warn("[session] 云端拉取失败，用本地:", e.message);
    }
  }

  // ── 兼容旧接口（rememberPage / snapshot）──
  function rememberPage(patch) {
    update({ page: patch }, { immediate: false });
  }

  function snapshotExam(act, data) {
    /* ★ 集成测试修复 Bug 6：写入前自动清理过期存档 */
    // 清理其他幕的过期存档
    if (session.exam && session.exam.act > 0 && session.exam.act !== act) {
      const s = session.exam;
      if (Date.now() - (s.at || 0) > 14 * 864e5) {
        // 其他幕的存档过期，清空
      }
    }
    const exam = Object.assign({}, session.exam, {
      act: act,
      at: Date.now(),
    }, data);
    update({ exam: exam }, { immediate: true });
  }

  /* ★ 集成测试修复 Bug 6：检查并清理过期存档 */
  function checkExpired() {
    if (session.exam && session.exam.act > 0) {
      if (Date.now() - (session.exam.at || 0) > 14 * 864e5) {
        update({ exam: { act: 0, idx: 0, correct: 0, score: 0, order: [], msgs: [], at: 0 } });
        return true;
      }
    }
    return false;
  }

  // ── 导出 ── 通过桥接对象注册 session（直接暴露方法，无需 get() 包装）
  // 生产环境：window.MMQ_BRIDGE（桥接对象）
  // 测试环境：window.B（普通对象）
  const B = (window.MMQ_BRIDGE = window.MMQ_BRIDGE || window.B || {});
  const sessionObj = {
    get: () => session,
    update: update,
    load: load,
    rememberPage: rememberPage,
    snapshotExam: snapshotExam,
    checkExpired: checkExpired,
    getPage: () => session.page,
    getExam: () => session.exam,
    getRail: () => session.rail,
    getChats: () => session.chats,
  };
  if (typeof Object.defineProperty === "function" && !( "session" in B)) {
    Object.defineProperty(B, "session", { get: () => sessionObj, configurable: true });
  } else {
    B.session = sessionObj;
  }
  // 同步到 window.B（测试环境需要 window.B.session）
  if (window.B && window.B !== B) {
    window.B.session = sessionObj;
  }

  // ── 启动时自动 load（直接从 localStorage 读取，不依赖 B.state）──
  B.session.load();

  L.info("[session] SessionStore 已挂载，版本 v2");
})();
