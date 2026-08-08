/* 다지기 — 퀴즈 재풀이 + 키워드 판정 제안 + 소문항 단위 기록 (localStorage)
   판정 철학: 자동 판정은 "제안"일 뿐. 기록은 언제나 본인이 O·△·X 버튼을 눌러 확정한다. */
"use strict";

const DATA = window.DAJIGI_DATA || [];
const KEY = "dajigi_v1";
const AI_OFF_NAME = "dajigi_ai_off";
/* AI 채점: 암기PT 전용 Supabase 프로젝트 (온고지신과 완전 분리, Gemini 키는 서버 시크릿) */
const AI_FN_URL = "https://fqofdlwnzdoqabcnolbz.supabase.co/functions/v1/amgipt-grade";
const AI_FN_KEY = "sb_publishable_cyPOjYPJ4xuWquF0M-O52g_eY4nQ7F5";
const DAY = 24 * 60 * 60 * 1000;

/* ---------- 클라우드 동기화 ----------
   기록이 브라우저에서 지워져도(캐시 삭제, iOS 정리) 안 날아가게 서버에 자동 백업.
   기기마다 무작위 동기화 코드가 생기고, 그 코드가 곧 계정이다. 다른 기기에 코드를 넣으면 기록이 합쳐진다. */
const SYNC_URL = "https://fqofdlwnzdoqabcnolbz.supabase.co/functions/v1/amgipt-sync";
const SYNC_KEY_NAME = "dajigi_sync_key";
let SYNC_STATE = "wait"; // wait | ok | fail
let pushTimer = null;
function syncKey() { return localStorage.getItem(SYNC_KEY_NAME) || ""; }
function makeSyncKey() {
  const a = new Uint8Array(18);
  crypto.getRandomValues(a);
  const k = "amgipt-" + [...a].map(b => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");
  localStorage.setItem(SYNC_KEY_NAME, k);
  return k;
}
async function syncCall(body) {
  const res = await fetch(SYNC_URL, {
    method: "POST", keepalive: true,
    headers: { "content-type": "application/json", apikey: AI_FN_KEY, Authorization: "Bearer " + AI_FN_KEY },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}
function schedulePush() {
  if (!syncKey()) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushNow, 2500);
}
async function pushNow() {
  clearTimeout(pushTimer); pushTimer = null;
  const k = syncKey();
  if (!k) return;
  try { await syncCall({ op: "push", key: k, data: S }); SYNC_STATE = "ok"; }
  catch { SYNC_STATE = "fail"; }
  updateSyncFoot();
}
function mergeRemote(remote) {
  let added = 0;
  for (const [k, arr] of Object.entries(remote.records || {})) {
    const cur = S.records[k] || (S.records[k] = []);
    for (const r of arr) if (!cur.some(c => c.t === r.t && c.r === r.r)) { cur.push(r); added++; }
    cur.sort((a, b) => (a.t || 0) - (b.t || 0));
  }
  if (remote.lastExport && (!S.lastExport || remote.lastExport > S.lastExport)) S.lastExport = remote.lastExport;
  if ((remote.streakDays || 0) > (S.streakDays || 0)) S.streakDays = remote.streakDays;
  if (remote.lastGoalDate && (!S.lastGoalDate || remote.lastGoalDate > S.lastGoalDate)) S.lastGoalDate = remote.lastGoalDate;
  if (remote.goal && remote.goal.d === todayStr() && (!S.goal || S.goal.d !== todayStr() || remote.goal.n > S.goal.n)) S.goal = remote.goal;
  return added;
}
async function pullAndMerge() {
  const k = syncKey();
  if (!k) return;
  try {
    const r = await syncCall({ op: "pull", key: k });
    if (r && r.data && r.data.records) { mergeRemote(r.data); persist(); }
    SYNC_STATE = "ok";
  } catch { SYNC_STATE = "fail"; }
  if (!location.hash || location.hash === "#") renderHome(); else updateSyncFoot();
  pushNow();
}
function syncFootText() {
  const n = Object.values(S.records).reduce((a, h) => a + h.length, 0);
  const st = SYNC_STATE === "ok" ? "클라우드에 자동 백업됨"
    : SYNC_STATE === "fail" ? "클라우드 연결 안 됨, 이 브라우저에만 저장"
    : "클라우드 동기화 중";
  return `기록 ${n}건 · ${st}`;
}
function updateSyncFoot() {
  const el = document.getElementById("syncfoot");
  if (el) el.textContent = syncFootText();
}

/* ---------- 복습 모드: 단권화 데이터 → 퀴즈 구조로 변환 ----------
   각 항목 = 문항 1개 + 소문항 2개(키워드 인출 ver / 설명 쓰기 ver). 채점 키워드는 공유. */
for (const set of (window.DAJIGI_DAN || [])) {
  DATA.push({
    id: set.id,
    subject: set.subject,
    range: set.range,
    title: set.title,
    scope: "출처: " + set.source,
    base: "단권화 원문 그대로 · 키워드 인출 ver / 설명 쓰기 ver",
    mode: "review",
    rules: null,
    questions: set.items.map(it => ({
      no: it.no, points: 0, frame: "단권화 · " + set.subject, title: it.title,
      body: "",
      subs: [
        { no: "인출", hideHead: true, points: 0, type: "essay",
          prompt: "",
          ph: "키워드 나열이든 서술이든, 아는 만큼",
          groups: it.groups, answer: it.model }
      ]
    }))
  });
}

/* ---------- 저장소 ---------- */
function loadStore() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && typeof s === "object" && s.records) return s;
  } catch (e) { /* 손상 시 초기화 */ }
  return { records: {}, lastExport: null };
}
let S = loadStore();
function persist() { localStorage.setItem(KEY, JSON.stringify(S)); schedulePush(); }

/* 마이그레이션: 복습 모드 소문항이 키워드/설명 2개에서 인출 1개로 통합됨. 기존 기록 병합 */
(function migrateDanSubIds() {
  let changed = false;
  for (const key of Object.keys(S.records)) {
    const m = key.match(/^(dan-.+\|\d+)\|(키워드|설명)$/);
    if (!m) continue;
    const nk = m[1] + "|인출";
    const merged = (S.records[nk] || []).concat(S.records[key]);
    merged.sort((a, b) => (a.t || 0) - (b.t || 0));
    S.records[nk] = merged;
    delete S.records[key];
    changed = true;
  }
  if (changed) persist();
})();

function subId(quiz, q, sub) { return quiz.id + "|" + q.no + "|" + sub.no; }
function history(id) { return S.records[id] || []; }
function latest(id) { const h = history(id); return h.length ? h[h.length - 1] : null; }
function record(id, r, auto, miss, rq) {
  const h = S.records[id] || (S.records[id] = []);
  const t = Date.now();
  const last = h[h.length - 1];
  const m = (miss && miss.length) ? miss : undefined;
  // AI 재질문 목록(JSON 문자열로 전달됨): 다음 집중 인출의 문제 목록으로 쓴다
  let q;
  if (r !== "O" && rq) { try { q = JSON.parse(rq); } catch { q = rq; } }
  if (Array.isArray(q) && !q.length) q = undefined;
  // 같은 세션에서 판정을 바꾸면(10분 안) 새 줄이 아니라 정정으로 처리
  if (last && t - last.t < 10 * 60 * 1000) {
    last.r = r; last.a = auto || last.a; last.t = t;
    if (m) last.m = m; else delete last.m;
    if (q) last.rq = q; else delete last.rq;
  }
  else h.push({ d: todayStr(), r, a: auto || null, t, ...(m ? { m } : {}), ...(q ? { rq: q } : {}) });
  persist();
}

/* 누가기록: 이 소문항에서 지금까지 놓친 포인트를 집계 */
function missLog(id) {
  const counts = new Map();
  for (const rec of history(id)) for (const name of (rec.m || [])) {
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/* ---------- 간격 엔진(고정 코드) ----------
   몰랐다(X)→1일, 부분(△)→2일, 완벽(O)→연속 횟수에 따라 4·7·14·21일 */
const INTERVALS = [4, 7, 14, 21];
function todayStr() {
  const t = new Date();
  return new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function addDays(d, n) {
  const t = new Date(d + "T00:00:00");
  t.setDate(t.getDate() + n);
  const off = t.getTimezoneOffset();
  const loc = new Date(t.getTime() - off * 60 * 1000);
  return loc.toISOString().slice(0, 10);
}
function oStreak(id) {
  const h = history(id);
  let s = 0;
  for (let i = h.length - 1; i >= 0 && h[i].r === "O"; i--) s++;
  return s;
}
function subState(id) {
  const h = history(id);
  if (!h.length) return { status: "new", isDue: false, chronic: false };
  const last = h[h.length - 1];
  const streak = oStreak(id);
  let ivl;
  if (last.r === "X") ivl = 1;
  else if (last.r === "T") ivl = 2;
  else ivl = INTERVALS[Math.min(streak - 1, INTERVALS.length - 1)];
  const due = addDays(last.d, ivl);
  const chronic = h.length >= 2 && h[h.length - 1].r === "X" && h[h.length - 2].r === "X";
  return { status: last.r === "O" ? "review" : "relearn", last, ivl, due, isDue: due <= todayStr(), chronic, streak };
}
function previewIvl(id, v) {
  if (v === "X") return "내일 다시";
  if (v === "T") return "2일 뒤";
  return INTERVALS[Math.min(oStreak(id), INTERVALS.length - 1)] + "일 뒤";
}
function allSubs() {
  const out = [];
  for (const quiz of DATA)
    for (let qi = 0; qi < quiz.questions.length; qi++) {
      const q = quiz.questions[qi];
      for (let si = 0; si < q.subs.length; si++)
        out.push({ quiz, q, sub: q.subs[si], qi, si, id: subId(quiz, q, q.subs[si]) });
    }
  return out;
}
const NEW_PER_DAY = 10;
function buildQueue(mode) {
  const subs = allSubs().map(x => ({ ...x, st: subState(x.id) }));
  if (mode === "chronic") return subs.filter(x => x.st.chronic);
  const relearn = subs.filter(x => x.st.status === "relearn" && x.st.isDue);
  const review = subs.filter(x => x.st.status === "review" && x.st.isDue);
  const fresh = subs.filter(x => x.st.status === "new").slice(0, NEW_PER_DAY);
  return [...relearn, ...review, ...fresh];
}
function queueCounts() {
  const subs = allSubs().map(x => subState(x.id));
  return {
    fresh: subs.filter(s => s.status === "new").length,
    relearn: subs.filter(s => s.status === "relearn" && s.isDue).length,
    review: subs.filter(s => s.status === "review" && s.isDue).length,
    chronic: subs.filter(s => s.chronic).length
  };
}

/* 음성 인식(Web Speech API): 마이크 버튼 토글, 말한 내용이 답안 칸에 실시간 입력 */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const MIC_OK = !!SR;
let MIC = null;
function stopMic() {
  if (!MIC) return;
  const m = MIC; MIC = null;
  try { m.rec.stop(); } catch { /* 무시 */ }
  if (m.btn && m.btn.isConnected) m.btn.classList.remove("rec");
}
function toggleMic(subEl, btn) {
  if (MIC) { stopMic(); return; }
  const ta = subEl.querySelector("textarea.answer");
  if (!ta) return;
  const rec = new SR();
  rec.lang = "ko-KR";
  rec.continuous = true;
  rec.interimResults = true;
  const base = ta.value ? ta.value.replace(/\s+$/, "") + " " : "";
  rec.onresult = ev => {
    let text = "";
    for (let i = 0; i < ev.results.length; i++) text += ev.results[i][0].transcript;
    ta.value = base + text;
    ta.dispatchEvent(new Event("input", { bubbles: true })); // 초안 자동저장 연동
  };
  rec.onend = () => stopMic();
  rec.onerror = () => stopMic();
  try { rec.start(); } catch { return; }
  btn.classList.add("rec");
  MIC = { rec, btn };
}

/* 답안 초안 자동저장: 쓰다가 나가도 안 사라진다. 판정 확정 시 지운다 */
const DRAFT_KEY = "dajigi_drafts";
let DRAFTS = {};
try { DRAFTS = JSON.parse(localStorage.getItem(DRAFT_KEY)) || {}; } catch { DRAFTS = {}; }
function draftGet(k) { return DRAFTS[k] || ""; }
function draftSet(k, v) {
  if (v) DRAFTS[k] = v; else delete DRAFTS[k];
  localStorage.setItem(DRAFT_KEY, JSON.stringify(DRAFTS));
}
function draftClearSub(id) {
  for (const k of Object.keys(DRAFTS)) if (k === id || k.startsWith(id + "#")) delete DRAFTS[k];
  localStorage.setItem(DRAFT_KEY, JSON.stringify(DRAFTS));
}

/* 데일리 골(미니 10장) + 스트릭 */
function bumpGoal() {
  const today = todayStr();
  if (!S.goal || S.goal.d !== today) S.goal = { d: today, n: 0 };
  S.goal.n++;
  if (S.goal.n === 10 && S.lastGoalDate !== today) {
    S.streakDays = (S.lastGoalDate === addDays(today, -1)) ? (S.streakDays || 0) + 1 : 1;
    S.lastGoalDate = today;
  }
  persist();
}
function goalToday() { return (S.goal && S.goal.d === todayStr()) ? S.goal.n : 0; }

/* ---------- 판정(고정 코드) ---------- */
function norm(s) {
  return (s || "").toLowerCase()
    .replace(/[\s·ㆍ‧.,()\[\]{}<>『』「」“”‘’"'\-–—_\/\\?!:;~`^*|]/g, "");
}
function judgeTerm(inputs, parts) {
  return parts.map((p, i) => p.accept.some(a => norm(a) === norm(inputs[i]) && norm(inputs[i]) !== ""));
}
function judgeEssay(input, groups) {
  const n = norm(input);
  return groups.map(g => n !== "" && g.variants.some(v => n.includes(norm(v))));
}
function suggestFrom(flags) {
  if (!flags.length) return null;
  const hit = flags.filter(Boolean).length;
  return hit === flags.length ? "O" : hit === 0 ? "X" : "T";
}

/* ---------- 유틸 ---------- */
const $ = sel => document.querySelector(sel);
/* 단색 스트로크 아이콘 (이모지 대신) */
const ICONS = {
  doc: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/><path d="M9 12h6M9 16h6"/>',
  recall: '<path d="M3 12a9 9 0 1 0 2.6-6.4L3 8"/><path d="M3 3v5h5"/>',
  bolt: '<polygon points="13 2 3 14 11 14 10 22 21 9 13 9 13 2" fill="currentColor" stroke="none"/>',
  pin: '<path d="M12 21s-6-5.3-6-10a6 6 0 1 1 12 0c0 4.7-6 10-6 10z"/><circle cx="12" cy="11" r="2"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" fill="currentColor" stroke="none"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.8 2.8L16 9"/>',
  mic: '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/>'
};
function ico(name) {
  return `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
}
function md(text) { return marked.parse(text || "", { gfm: true, breaks: true }); }
function esc(s) { return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"); }
function vName(v) { return v === "O" ? "O 맞음" : v === "T" ? "△ 부분" : "X 틀림"; }
function dotsHtml(id) {
  const h = history(id).slice(-6);
  if (!h.length) return "";
  return '<span class="dots">' + h.map(r =>
    `<span class="dot ${r.r}" title="${r.d} ${vName(r.r)}"></span>`).join("") + "</span>";
}
function isWeak(id) { const l = latest(id); return !!l && l.r !== "O"; }

/* ---------- 홈 ---------- */
function aiOn() { return localStorage.getItem(AI_OFF_NAME) !== "1"; }

function quizStats(quiz) {
  let total = 0, tried = 0, ok = 0, weak = 0;
  quiz.questions.forEach(q => q.subs.forEach(sub => {
    total++;
    const l = latest(subId(quiz, q, sub));
    if (l) { tried++; if (l.r === "O") ok++; else weak++; }
  }));
  return { total, tried, ok, weak };
}

/* 범위 목록 (온고지신 도서관 패턴): 범위 하나 = 기출·복습 모드 묶음 */
function rangeGroups() {
  const map = new Map();
  for (const quiz of DATA) {
    const key = quiz.range || quiz.title;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(quiz);
  }
  return map;
}

function openRangeSheet(name) {
  const quizzes = (rangeGroups().get(name)) || [];
  if (!quizzes.length) return;
  const rows = quizzes.map(quiz => {
    const s = quizStats(quiz);
    const isReview = quiz.mode === "review";
    return `
    <div class="mode-row">
      <div class="m-icon">${isReview ? ico("recall") : ico("doc")}</div>
      <div class="m-main">
        <div class="m-name">${isReview ? "복습 모드" : "기출 모드"}</div>
        <div class="m-desc">${isReview
          ? `단권화 키워드 인출·설명 · 소문항 ${s.total}`
          : `기출 프레임 문서형 풀이 · 소문항 ${s.total}`} · 풀어봄 ${s.tried}</div>
      </div>
      <div class="m-acts">
        <a class="btn primary" href="#q/${quiz.id}">풀기</a>
        ${s.weak ? `<a class="btn" href="#q/${quiz.id}/weak">틀린 것만 ${s.weak}</a>` : ""}
      </div>
    </div>`;
  }).join("");
  const o = $(".sheeto");
  o.querySelector(".sheet").innerHTML =
    `<div class="grab"></div>
     <h3>${esc(quizzes[0].subject)} · ${esc(name)}<small>모드를 골라 시작하세요</small></h3>` + rows;
  o.classList.add("show");
}

/* 서랍: 과목(검정 탭) 아래 영역(흰 탭) 파일이 꽂혀 있다 */
let DRAWER_OPEN = null; // 첫 렌더에서 초기화

function subjectGroups() {
  const subs = new Map();
  for (const quiz of DATA) {
    if (!subs.has(quiz.subject)) subs.set(quiz.subject, new Map());
    const rm = subs.get(quiz.subject);
    const key = quiz.range || quiz.title;
    if (!rm.has(key)) rm.set(key, []);
    rm.get(key).push(quiz);
  }
  return subs;
}

function drawerHtml() {
  if (DRAWER_OPEN === null) {
    DRAWER_OPEN = {};
    const first = DATA[0];
    if (first) DRAWER_OPEN[first.subject] = true;
  }
  const TABPOS = ["14%", "42%", "70%"];
  const files = [{ blank: true }, { blank: true }, { blank: true }];
  for (const [subj, ranges] of subjectGroups()) {
    let cards = 0;
    for (const qs of ranges.values()) for (const q of qs)
      cards += q.questions.reduce((a, qq) => a + qq.subs.length, 0);
    files.push({ subject: subj, num: String(cards).padStart(3, "0") });
    if (DRAWER_OPEN[subj]) {
      for (const [name, quizzes] of ranges) {
        let total = 0, weak = 0;
        quizzes.forEach(quiz => { const s = quizStats(quiz); total += s.total; weak += s.weak; });
        files.push({ area: name, num: total, weak, single: quizzes.length === 1 ? quizzes[0].id : "" });
      }
    }
  }
  const n = files.length;
  return `<div class="drawer">` + files.map((f, i) => {
    const depth = n - 1 - i;
    const width = Math.max(70, 100 - depth * 2.6);
    const pos = TABPOS[i % 3];
    if (f.blank) return `<div class="file blank" style="width:${width}%"><div class="fbody"></div></div>`;
    if (f.subject) return `
      <div class="file subject" style="width:${width}%">
        <div class="fbody"></div>
        <button class="ftab" style="left:${pos}" data-act="toggle-subject" data-subj="${esc(f.subject)}">
          <span class="nm">${esc(f.subject)}</span><span class="num">${f.num}</span>
        </button>
      </div>`;
    return `
      <div class="file area" style="width:${width}%">
        <div class="fbody"></div>
        <button class="ftab" style="left:${pos}" data-act="open-range" data-range="${esc(f.area)}" data-single="${esc(f.single)}">
          <span class="num">${f.num}</span><span class="nm">${esc(f.area)}</span>
        </button>
        ${f.weak ? `<span class="weak">다시 ${f.weak}</span>` : ""}
      </div>`;
  }).join("") + `</div>
  <div class="drawer-front"><div class="panel"></div><div class="label">채영의 임용 서랍</div></div>`;
}

function doExport() {
  const blob = new Blob([JSON.stringify(S, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "amgipt-records-" + todayStr() + ".json";
  a.click(); URL.revokeObjectURL(a.href);
  S.lastExport = Date.now(); persist();
}

function totalWeak() {
  return allSubs().filter(x => { const l = latest(x.id); return l && l.r !== "O"; }).length;
}

function renderHome() {
  const recCount = Object.values(S.records).reduce((a, h) => a + h.length, 0);
  const needBackup = recCount > 0 && (!S.lastExport || Date.now() - S.lastExport > 7 * DAY);
  const lastTs = Object.values(S.records).flat().reduce((m, r) => Math.max(m, r.t || 0), 0);
  const staleDays = lastTs ? Math.floor((Date.now() - lastTs) / DAY) : null;

  const qc = queueCounts();
  const doneToday = goalToday();
  const freshToday = Math.min(qc.fresh, NEW_PER_DAY);
  const todayTotal = qc.relearn + qc.review + freshToday;
  const weakN = totalWeak();

  $("#app").innerHTML = `
    <header class="masthead">
      <h1>암기PT</h1>
      <p>임용 암기 트레이너</p>
    </header>
    ${needBackup && SYNC_STATE !== "ok" ? `<div class="banner"><span>기록 ${recCount}건이 이 브라우저에만 있어요.
      ${staleDays !== null && staleDays > 0 ? `마지막 기록 ${staleDays}일 전. ` : ""}백업해 두세요.</span>
      <button class="btn" data-act="export">기록 내보내기</button></div>` : ""}
    <div class="pt-bar">
      <span class="t">오늘의 PT</span>
      <span class="d">${todayTotal
        ? `${todayTotal}장 · 다시 ${qc.relearn} · 복습 ${qc.review} · 신규 ${freshToday}`
        : "오늘 볼 카드를 모두 끝냈어요"}</span>
      <button class="btn" data-act="start-session" ${todayTotal ? "" : "disabled"}>시작</button>
    </div>
    <div class="pt-sub">
      <span>미니 골 ${Math.min(doneToday, 10)}/10장${doneToday >= 10 ? " 달성" : ""}</span>
      <div class="bar"><div class="fill" style="width:${Math.min(100, doneToday * 10)}%"></div></div>
      <span>${S.streakDays ? `스트릭 ${S.streakDays}일` : "오늘부터 시작"}</span>
    </div>
    <div class="navtabs">
      <span class="nt on">서랍</span>
      <a class="nt" href="#wrong">오답${weakN ? ` ${weakN}` : ""}</a>
      ${qc.chronic ? `<button class="nt" data-act="start-chronic">${ico("bolt")} 고질 약점 ${qc.chronic}</button>` : ""}
    </div>
    ${drawerHtml()}
    <div class="sheeto" data-act="close-sheet"><div class="sheet"></div></div>
    <footer class="home-foot">
      <span id="syncfoot">${syncFootText()}</span>
      <span class="spacer"></span>
      <button class="btn ghost" data-act="sync-sheet">동기화</button>
      <button class="btn ghost" data-act="export">내보내기</button>
      <button class="btn ghost" data-act="import">가져오기</button>
      <input type="file" id="importFile" accept="application/json" hidden>
    </footer>`;
}

/* ---------- 집중 인출: 다시 나온 카드는 놓친 포인트만 묻는다 ---------- */
const FULL_OVERRIDE = new Set(); // "전체로 풀기"를 누른 소문항
function focusGroupsFor(id, sub) {
  if (!sub.groups || FULL_OVERRIDE.has(id)) return null;
  const l = latest(id);
  if (!l || l.r === "O" || !l.m || !l.m.length) return null;
  const names = new Set(l.m);
  const g = sub.groups.filter(x => names.has(x.name));
  // AI 재질문이 있으면 전부 놓쳤어도 집중 모드로 (질문 자체가 구체적이라)
  return g.length && (g.length < sub.groups.length || l.rq) ? g : null;
}
function effGroups(subEl, sub) {
  if (subEl.dataset.focus === "1") {
    const g = focusGroupsFor(subEl.dataset.sid, sub);
    if (g) return g;
  }
  return sub.groups;
}

/* ---------- 소문항 블록 (목록·세션 공용) ---------- */
function subBlockHtml(quiz, q, sub, qi, si) {
  const id = subId(quiz, q, sub);
  const fg = sub.type === "essay" ? focusGroupsFor(id, sub) : null;
  let focusHtml = "";
  if (fg) {
    let rqs = (latest(id) || {}).rq;
    if (typeof rqs === "string" && rqs) rqs = [{ q: rqs }]; // 구형(문자열 1개) 호환
    let bodyHtml;
    if (Array.isArray(rqs) && rqs.length) {
      // AI가 지난 채점에서 놓친 것마다 하나씩 만든 재질문 목록
      bodyHtml = `<ol class="focus-qs">${rqs.map(r => `<li>${esc(r.q || "")}</li>`).join("")}</ol>`;
    } else {
      // 재질문이 없으면 폴백: "주제: 내용" 이름은 주제만 물음표로, 없으면 개수만 (스포일러 방지)
      const named = fg.map(g => g.name.includes(":") ? g.name.split(":")[0].trim() + "?" : null).filter(Boolean);
      const blind = fg.length - named.length;
      bodyHtml = `<ul class="focus-cues">${named.map(c => `<li>${esc(c)}</li>`).join("")}
        ${blind ? `<li>힌트 없이 인출할 포인트 ${blind}개</li>` : ""}</ul>`;
    }
    focusHtml = `<div class="focus-bar">
        <span>${ico("bolt")} 집중 인출 · 지난번 놓친 포인트 ${fg.length}개만 물어요</span>
        <button class="linkbtn" data-act="full-sub">전체로 풀기</button>
      </div>` + bodyHtml;
  }
  let inputHtml = "";
  if (sub.type === "term") {
    inputHtml = sub.parts.map((p, pi) => `
      <div class="part-row"><span class="plabel">${esc(p.label)}</span>
      <input class="answer" data-part="${pi}" autocomplete="off" placeholder="용어만" value="${esc(draftGet(id + "#" + pi))}"></div>`).join("");
  } else if (sub.type === "essay") {
    const ph = fg ? "놓쳤던 포인트만 짧게" : (sub.ph || "한 문장으로 써 보세요 (입력 없이 정답만 봐도 돼요)");
    inputHtml = `<div class="ta-wrap">
      <textarea class="answer" placeholder="${esc(ph)}">${esc(draftGet(id))}</textarea>
      ${MIC_OK ? `<button class="micbtn" data-act="mic" title="음성으로 답변 쓰기">${ico("mic")}</button>` : ""}
    </div>`;
  }
  const gradeBtns = sub.type === "self"
    ? `<button class="btn primary" data-act="reveal">정답 보기</button>`
    : `<button class="btn primary" data-act="grade">채점하기</button>
       <button class="btn ghost" data-act="reveal">그냥 정답 보기</button>`;
  return `
  <div class="sub" data-sid="${esc(id)}" data-quiz="${esc(quiz.id)}" data-q="${qi}" data-s="${si}"${fg ? ' data-focus="1"' : ""}>
    ${sub.hideHead
      ? (dotsHtml(id) ? `<div class="sub-head">${dotsHtml(id)}</div>` : "")
      : `<div class="sub-head"><span class="sno">${esc(sub.no)}</span>
        ${sub.points ? `<span class="spts">[${sub.points}점]</span>` : ""}${dotsHtml(id)}</div>`}
    ${sub.prompt ? `<div class="sub-prompt md">${md(sub.prompt)}</div>` : ""}
    ${focusHtml}
    <div class="sub-input">${inputHtml}</div>
    <div class="sub-actions">${gradeBtns}</div>
    <div class="reveal"></div>
  </div>`;
}

/* ---------- 퀴즈 페이지 (전체 보기) ---------- */
function quizCardsHtml(quiz, weakOnly) {
  return quiz.questions.map((q, qi) => {
    const subs = q.subs
      .map((sub, si) => ({ sub, si }))
      .filter(x => !weakOnly || isWeak(subId(quiz, q, x.sub)));
    if (!subs.length) return "";

    const subsHtml = subs.map(({ sub, si }) => subBlockHtml(quiz, q, sub, qi, si)).join("");

    return `
    <section class="q-card">
      <div class="q-head"><span class="qno">${q.no}번 · ${esc(q.title)}</span>
        ${q.points ? `<span class="qpts">[${q.points}점]</span>` : ""}</div>
      <div class="q-frame">${esc(q.frame)}</div>
      ${q.body ? `<div class="q-body md">${md(q.body)}</div>` : ""}
      ${subsHtml}
    </section>`;
  }).join("");
}

function renderQuiz(quizId, weakOnly) {
  const quiz = DATA.find(z => z.id === quizId);
  if (!quiz) { location.hash = ""; return; }

  const qCards = quizCardsHtml(quiz, weakOnly);

  const totalSubs = quiz.questions.reduce((a, q) => a + q.subs.length, 0);
  const doneSubs = quiz.questions.reduce((a, q) =>
    a + q.subs.filter(sub => latest(subId(quiz, q, sub))).length, 0);

  $("#app").innerHTML = `
    <div class="topbar">
      <a class="back" href="#">← 홈</a>
      <span class="ttl">${esc(quiz.title)}${weakOnly ? ' <span class="chip">틀린 것만</span>' : ""}</span>
      <span class="prog" id="prog">기록 ${doneSubs}/${totalSubs}</span>
    </div>
    ${(quiz.rules && quiz.rules.length) ? `<details class="rules"><summary>답안 규칙 (기출 채점 방식)</summary>
      <ul>${quiz.rules.map(r => `<li>${esc(r)}</li>`).join("")}</ul>
    </details>` : ""}
    ${qCards || '<div class="empty">다시 볼 소문항이 없어요. 전부 O!</div>'}`;
  window.scrollTo(0, 0);
}

/* ---------- 오답 모아보기 ---------- */
function renderWrong() {
  const sections = [];
  let count = 0;
  for (const quiz of DATA) {
    const cards = quizCardsHtml(quiz, true);
    if (!cards) continue;
    const s = quizStats(quiz);
    count += s.weak;
    sections.push(
      `<details class="wrong-sec">
        <summary><span class="ws-name">${esc(quiz.subject)} · ${esc(quiz.range || quiz.title)}</span>
          <span class="ws-meta">${quiz.mode === "review" ? "복습" : "기출"} · ${s.weak}개</span></summary>
        ${cards}
      </details>`);
  }
  // 영역이 하나뿐이면 바로 펼쳐둔다
  if (sections.length === 1) sections[0] = sections[0].replace("<details class=\"wrong-sec\">", "<details class=\"wrong-sec\" open>");
  $("#app").innerHTML = `
    <div class="topbar">
      <a class="back" href="#">← 홈</a>
      <span class="ttl">오답 모아보기</span>
      <span class="prog">${count}개</span>
    </div>
    ${sections.join("") || '<div class="empty">아직 오답이 없어요. 최근 판정이 부분이나 몰랐다인 카드가 여기 모여요.</div>'}`;
  window.scrollTo(0, 0);
}

/* ---------- 오늘의 PT 세션 (10카드 라운드, Brainscape·Anki 패턴) ---------- */
let SESSION = null;
const ROUND = 10;

function renderSession() {
  if (!SESSION) SESSION = { queue: buildQueue("today"), idx: 0, round: [], results: { O: 0, T: 0, X: 0 } };
  if (!SESSION.queue.length) { SESSION = null; location.hash = ""; return; }
  if (SESSION.idx >= SESSION.queue.length) return renderCheckpoint(true);
  if (SESSION.round.length >= ROUND) return renderCheckpoint(false);

  const item = SESSION.queue[SESSION.idx];
  const { quiz, q, sub, qi, si, st } = item;
  const lastR = st && st.last ? st.last.r : null;
  $("#app").innerHTML = `
    <div class="topbar">
      <a class="back" href="#" data-act="quit-session">✕ 종료</a>
      <div class="sessbar"><div class="sessbar-fill" style="width:${SESSION.round.length / ROUND * 100}%"></div></div>
      <span class="prog">${SESSION.round.length + 1}/${ROUND} · 남은 ${SESSION.queue.length - SESSION.idx}</span>
    </div>
    <section class="q-card sess-card${lastR ? " last-" + lastR : ""}">
      <div class="sess-meta">
        <span>${esc(quiz.subject)} · ${esc(q.frame)}</span>
        ${st && st.chronic ? `<span class="chronic">${ico("bolt")} 고질 약점</span>` : ""}
        ${lastR
          ? `<span class="lastmark m-${lastR}">지난 판정 ${lastR === "T" ? "△" : lastR}</span>`
          : '<span class="lastmark m-new">처음 보는 카드</span>'}
      </div>
      <div class="q-head"><span class="qno">${esc(q.title)}</span>
        ${sub.hideHead ? "" : `<span class="qpts">${esc(String(sub.no))}</span>`}</div>
      ${q.body ? `<details class="ctx"><summary>지문·자료 펼치기</summary><div class="q-body md">${md(q.body)}</div></details>` : ""}
      ${subBlockHtml(quiz, q, sub, qi, si)}
    </section>`;
  window.scrollTo(0, 0);
}

function renderCheckpoint(finished) {
  // 자동 백업: 마지막 백업이 3일 넘었으면 라운드 끝에 기록 JSON을 조용히 내려받는다
  let autoBackedUp = false;
  const recCount = Object.values(S.records).reduce((a, h) => a + h.length, 0);
  if (recCount && (!S.lastExport || Date.now() - S.lastExport > 3 * DAY)) {
    try { doExport(); autoBackedUp = true; } catch { /* 무시 */ }
  }
  const r = SESSION.results;
  const subs = allSubs();
  const mastered = subs.filter(x => { const l = latest(x.id); return l && l.r === "O"; }).length;
  const pct = subs.length ? Math.round(mastered / subs.length * 100) : 0;
  const left = SESSION.queue.length - SESSION.idx;
  const done = goalToday();
  $("#app").innerHTML = `
    <div class="checkpoint">
      <h2>${finished ? `${ico("check")} 오늘 큐 완주!` : "라운드 완료"}</h2>
      <div class="cp-counts">
        <span class="cp cO">완벽 ${r.O}</span>
        <span class="cp cT">부분 ${r.T}</span>
        <span class="cp cX">몰랐다 ${r.X}</span>
      </div>
      <div class="cp-mastery">
        <div class="cp-lbl">전체 마스터리 (최근 판정이 완벽인 비율)</div>
        <div class="mastery-bar"><div class="mastery-fill" style="width:${pct}%"></div></div>
        <div class="cp-pct">${pct}%</div>
      </div>
      <p class="cp-goal">${done >= 10
        ? `오늘의 미니 골 달성 · 스트릭 ${S.streakDays || 1}일`
        : `오늘 ${done}장 풀었어요. 미니 골까지 ${10 - done}장`}</p>
      ${autoBackedUp ? `<p class="cp-goal">기록 백업 파일을 자동으로 내려받았어요 (다운로드 폴더)</p>` : ""}
      <div class="cp-actions">
        ${finished ? "" : `<button class="btn primary big" data-act="next-round">다음 라운드 (남은 ${left}장)</button>`}
        <button class="btn ghost" data-act="quit-session">오늘은 여기까지</button>
      </div>
    </div>`;
  window.scrollTo(0, 0);
}

/* ---------- AI 채점(의미 판정) ----------
   역할 분담: 판정 결과의 합산(O/△/X)은 언제나 고정 코드(suggestFrom).
   AI는 "문자 일치에 실패한 키워드가 의미상으로는 들어 있는가"라는 해석만 맡는다. */
async function aiJudgeKeywords(topic, model, names, matched, input) {
  let res;
  try {
    res = await fetch(AI_FN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: AI_FN_KEY,
        Authorization: "Bearer " + AI_FN_KEY
      },
      body: JSON.stringify({ type: "grade_keywords", topic, model, names, matched, answer: input })
    });
  } catch {
    throw new Error("서버 연결 안 됨. amgipt-grade 함수 배포와 Verify JWT 끄기를 확인");
  }
  const text = await res.text();
  if (!res.ok) throw new Error("HTTP " + res.status + (res.status === 401 ? " (Verify JWT 끄기 필요)" : ""));
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error("응답 형식 오류"); }
  if (data.error) throw new Error(String(data.error).slice(0, 80));
  return data;
}

async function runAiJudge(subEl, topic, model, groups, input, literalFlags) {
  const statusEl = () => subEl.querySelector(".ai-status");
  try {
    // v3: 전체 요소를 보내 문자 인정분까지 근거를 확인하고, 키워드 밖 결손 + 재질문을 받는다
    const data = await aiJudgeKeywords(
      topic, model,
      groups.map(g => g.name),
      literalFlags.map((f, i) => f ? groups[i].name : null).filter(Boolean),
      input);
    const results = data.results || [];
    const byName = new Map(results.map(r => [r.name, r]));
    const flags = literalFlags.slice();
    const notes = [];
    groups.forEach((g, gi) => {
      const r = byName.get(g.name) || results[gi];
      if (!r) return;
      // 구버전 함수 호환: found(bool)만 있으면 good/missed로 해석
      const verdict = r.verdict || (r.found ? "good" : "missed");
      const chip = subEl.querySelector(`.kw[data-g="${gi}"]`);
      const nm = g.name;
      if (literalFlags[gi]) {
        // 문자로 이미 인정된 요소: 판정은 유지하고 근거만 달아준다
        if (chip && r.evidence) chip.title = "근거: " + r.evidence;
        return;
      }
      if (verdict === "good") {
        flags[gi] = true;
        if (chip) {
          chip.classList.remove("miss");
          chip.classList.add("hit", "ai");
          chip.textContent = "✓ " + nm + " (의미)";
          if (r.evidence) chip.title = "근거: " + r.evidence;
        }
      } else if (verdict === "partial") {
        if (chip) {
          chip.classList.remove("miss");
          chip.classList.add("part");
          chip.textContent = "△ " + nm;
          if (r.note) chip.title = r.note;
        }
        if (r.note) notes.push({ mark: "△", nm, note: r.note });
      } else {
        if (chip && r.note) chip.title = r.note;
        if (r.note) notes.push({ mark: "✗", nm, note: r.note });
      }
    });
    // 키워드 밖 결손: 단권화 원문에는 있는데 채점 요소에도, 답안에도 없는 내용
    for (const gp of (data.gaps || []).slice(0, 3)) {
      if (gp && gp.point) notes.push({ mark: "✗", nm: gp.point + " (키워드 밖)", note: gp.note || "" });
    }
    // AI가 놓친 것마다 하나씩 만든 재질문: 판정 확정 시 기록에 저장되어 다음 집중 인출의 문제 목록이 된다
    const retry = (Array.isArray(data.retry) ? data.retry : [])
      .filter(r => r && r.q).map(r => ({ n: r.target || "", q: r.q }))
      .concat(!Array.isArray(data.retry) && data.retry_question ? [{ n: "", q: data.retry_question }] : []);
    if (retry.length) subEl.dataset.rq = JSON.stringify(retry);
    const s = statusEl();
    if (s) {
      s.classList.add("ai-diag");
      s.innerHTML =
        `<div class="diag-sum">${ico("spark")} <b>AI 진단</b> ${esc(data.summary || "판정을 마쳤어요.")}</div>` +
        notes.map(n => `<div class="dnote"><span class="${n.mark === "△" ? "dm-part" : "dm-miss"}">${n.mark}</span> <b>${esc(n.nm)}</b> ${esc(n.note)}</div>`).join("") +
        (retry.length ? `<div class="dnote next-q"><b>다음 복습 질문</b><ol class="nq-list">${retry.map(r => `<li>${esc(r.q)}</li>`).join("")}</ol></div>` : "");
    }
    if (!subEl.querySelector(".vbtn.chosen")) {
      const newSuggest = suggestFrom(flags);
      subEl.dataset.suggest = newSuggest || "";
      subEl.querySelectorAll(".vbtn").forEach(b =>
        b.classList.toggle("suggest", b.dataset.v === newSuggest));
      const lbl = subEl.querySelector(".vlbl");
      if (lbl && newSuggest) lbl.textContent = `내 판정 (제안: ${vName(newSuggest)}) →`;
    }
  } catch (e) {
    const s = statusEl();
    if (s) s.textContent = "AI 채점 실패(" + (e && e.message ? e.message : "오류") + "). 문자 일치 판정만 반영했어요.";
  }
}

/* ---------- 채점 → 제안 → 본인 확정 ---------- */
function findSub(el) {
  const quiz = DATA.find(z => z.id === el.dataset.quiz);
  const q = quiz.questions[+el.dataset.q];
  return { quiz, q, sub: q.subs[+el.dataset.s], id: el.dataset.sid };
}

function showReveal(subEl, graded) {
  const { sub, id } = findSub(subEl);
  let judgeHtml = "", suggest = null;

  if (graded && sub.type === "term") {
    const inputs = [...subEl.querySelectorAll("input.answer")].map(i => i.value);
    const flags = judgeTerm(inputs, sub.parts);
    suggest = suggestFrom(flags);
    judgeHtml = '<div class="kw-chips">' + sub.parts.map((p, i) => {
      const nm = p.label + ": " + p.accept[0];
      return `<span class="kw ${flags[i] ? "hit" : "miss"}" data-act="kw-toggle" data-name="${esc(nm)}">${flags[i] ? "✓" : "✗"} ${esc(nm)}</span>`;
    }).join("") + "</div>";
  } else if (graded && sub.type === "essay") {
    const input = subEl.querySelector("textarea.answer").value;
    const groups = effGroups(subEl, sub); // 집중 인출이면 놓쳤던 포인트만 채점
    const flags = judgeEssay(input, groups);
    suggest = suggestFrom(flags);
    judgeHtml = '<div class="kw-chips">' + groups.map((g, i) =>
      `<span class="kw ${flags[i] ? "hit" : "miss"}" data-g="${i}" data-act="kw-toggle" data-name="${esc(g.name)}">${flags[i] ? "✓" : "✗"} ${esc(g.name)}</span>`).join("") + "</div>";
    if (aiOn() && norm(input) !== "" && flags.some(f => !f)) {
      judgeHtml += `<div class="ai-status">${ico("spark")} AI가 놓친 키워드의 의미 포함 여부를 판정하는 중…</div>`;
      const { q } = findSub(subEl);
      setTimeout(() => runAiJudge(subEl, q.title, sub.answer, groups, input, flags), 0);
    }
    judgeHtml += '<div class="kw-note">판정이 틀렸으면 칩을 탭해서 ✓↔✗로 고칠 수 있어요.</div>';
  } else if (sub.type === "essay" || sub.type === "term") {
    // 눈풀이: 중립 칩 — 몰랐던 포인트를 탭해서 ✗로 표시하면 누가기록에 쌓인다
    const names = sub.type === "essay"
      ? effGroups(subEl, sub).map(g => g.name)
      : sub.parts.map(p => p.label + ": " + p.accept[0]);
    judgeHtml = '<div class="kw-note">답을 보고, <b>몰랐던 포인트를 탭</b>해서 ✗로 표시하세요. 누가기록에 쌓여요.</div>' +
      '<div class="kw-chips">' + names.map(nm =>
      `<span class="kw" data-act="kw-toggle" data-name="${esc(nm)}">${esc(nm)}</span>`).join("") + "</div>";
  }

  // 누가기록은 스포일러 방지를 위해 채점·정답 확인 후에만 보여준다
  const ml = missLog(id);
  const mlHtml = ml.length ? `<div class="miss-log">${ico("pin")} 누가기록, 이전에 놓친 포인트: ` +
    ml.slice(0, 6).map(([n, c]) => `<b>${esc(n)}</b>${c > 1 ? ` ×${c}` : ""}`).join(" · ") +
    (ml.length > 6 ? " 외" : "") + `</div>` : "";
  subEl.querySelector(".reveal").innerHTML = `
    ${judgeHtml}
    ${mlHtml}
    <div class="model"><span class="lbl">모범답안</span><div class="md">${md(sub.answer)}</div></div>
    ${sub.note ? `<div class="note">${esc(sub.note)}</div>` : ""}
    <div class="verdict-row">
      <span class="vlbl">내 판정${suggest ? ` (제안: ${vName(suggest)})` : ""}</span>
      <div class="vbtns">
      ${[["X", "몰랐다"], ["T", "부분"], ["O", "완벽"]].map(([v, label]) => `
        <button class="vbtn ${v === suggest ? "suggest" : ""}" data-act="verdict" data-v="${v}">
          <span class="vname">${v === "T" ? "△" : v} ${label}</span>
          <span class="ivl">${previewIvl(id, v)}</span>
        </button>`).join("")}
      </div>
      <span class="saved-msg"></span>
    </div>`;
  subEl.dataset.suggest = suggest || "";
}

function onAppClick(e) {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;

  if (act === "export") {
    doExport();
    renderHome();
    return;
  }
  if (act === "import") { $("#importFile").click(); return; }
  if (act === "sync-sheet") { openSyncSheet(); return; }
  if (act === "copy-key") {
    navigator.clipboard.writeText(syncKey()).then(() => { btn.textContent = "복사됨"; });
    return;
  }
  if (act === "link-key") {
    const v = document.getElementById("linkKey").value.trim();
    if (v.length < 12) { alert("동기화 코드가 너무 짧아요."); return; }
    localStorage.setItem(SYNC_KEY_NAME, v);
    $(".sheeto")?.classList.remove("show");
    SYNC_STATE = "wait"; updateSyncFoot();
    pullAndMerge();
    return;
  }
  if (act === "start-session" || act === "start-chronic") {
    SESSION = {
      queue: buildQueue(act === "start-chronic" ? "chronic" : "today"),
      idx: 0, round: [], results: { O: 0, T: 0, X: 0 }
    };
    if (!SESSION.queue.length) { SESSION = null; return; }
    if (location.hash === "#today") renderSession();
    else location.hash = "#today";
    return;
  }
  if (act === "quit-session") {
    SESSION = null;
    if (location.hash && location.hash !== "#") location.hash = "";
    else renderHome();
    return;
  }
  if (act === "next-round") {
    SESSION.round = [];
    SESSION.results = { O: 0, T: 0, X: 0 };
    renderSession();
    return;
  }
  if (act === "toggle-subject") {
    DRAWER_OPEN[btn.dataset.subj] = !DRAWER_OPEN[btn.dataset.subj];
    renderHome();
    return;
  }
  if (act === "open-range") {
    if (btn.dataset.single) { location.hash = "#q/" + btn.dataset.single; return; }
    openRangeSheet(btn.dataset.range);
    return;
  }
  if (act === "close-sheet") {
    if (e.target.closest(".sheet")) return; // 시트 안 클릭은 무시(링크는 그대로 동작)
    $(".sheeto")?.classList.remove("show");
    return;
  }
  if (act === "kw-toggle") {
    // 칩 탭 = 판정 뒤집기(✓↔✗). 눈풀이 모드의 중립 칩은 탭하면 '놓침'으로 표시
    const chip = btn;
    if (chip.classList.contains("miss")) {
      chip.classList.remove("miss"); chip.classList.add("hit");
      chip.textContent = "✓ " + chip.dataset.name;
    } else {
      chip.classList.remove("hit", "ai");
      chip.classList.add("miss");
      chip.textContent = "✗ " + chip.dataset.name;
    }
    const subEl2 = chip.closest(".sub");
    if (subEl2 && !subEl2.querySelector(".vbtn.chosen")) {
      const chips = [...subEl2.querySelectorAll(".kw")];
      const flags = chips.map(c => !c.classList.contains("miss"));
      const s = suggestFrom(flags);
      subEl2.dataset.suggest = s || "";
      subEl2.querySelectorAll(".vbtn").forEach(b => b.classList.toggle("suggest", b.dataset.v === s));
      const lbl = subEl2.querySelector(".vlbl");
      if (lbl && s) lbl.textContent = `내 판정 (제안: ${vName(s)}) →`;
    }
    return;
  }

  const subEl = btn.closest(".sub");
  if (!subEl) return;

  if (act === "mic") { toggleMic(subEl, btn); return; }
  if (act === "full-sub") {
    const { quiz, q, sub } = findSub(subEl);
    FULL_OVERRIDE.add(subEl.dataset.sid);
    stopMic();
    subEl.outerHTML = subBlockHtml(quiz, q, sub, +subEl.dataset.q, +subEl.dataset.s);
    return;
  }
  if (act === "grade") { stopMic(); showReveal(subEl, true); }
  if (act === "reveal") { stopMic(); showReveal(subEl, false); }
  if (act === "verdict") {
    const { quiz, id } = findSub(subEl);
    const missNames = [...subEl.querySelectorAll(".kw.miss")].map(c => c.dataset.name).filter(Boolean);
    record(id, btn.dataset.v, subEl.dataset.suggest || null, missNames, subEl.dataset.rq || "");
    draftClearSub(id);
    subEl.querySelectorAll(".vbtn").forEach(b => b.classList.toggle("chosen", b === btn));
    subEl.querySelector(".saved-msg").textContent = "기록됨";
    const head = subEl.querySelector(".sub-head");
    head.querySelector(".dots")?.remove();
    head.insertAdjacentHTML("beforeend", dotsHtml(id));
    // 세션 모드: 골 카운트 + 다음 카드로 자동 진행
    if (SESSION && location.hash === "#today") {
      if (!subEl.dataset.done) {
        subEl.dataset.done = "1";
        bumpGoal();
        SESSION.results[btn.dataset.v]++;
        SESSION.round.push(btn.dataset.v);
        // 몰랐다 카드는 이번 세션 큐 끝에 다시 들어온다 (같은 세션 재학습)
        if (btn.dataset.v === "X") SESSION.queue.push(SESSION.queue[SESSION.idx]);
        SESSION.idx++;
        setTimeout(renderSession, 700);
      }
      return;
    }
    if (!subEl.dataset.done) { subEl.dataset.done = "1"; bumpGoal(); }
    // 전체 보기 페이지: 진행 표시 갱신
    if (/^#q\//.test(location.hash)) {
      const total = quiz.questions.reduce((a, q) => a + q.subs.length, 0);
      const done = quiz.questions.reduce((a, q) =>
        a + q.subs.filter(sub => latest(subId(quiz, q, sub))).length, 0);
      const prog = $("#prog"); if (prog) prog.textContent = `기록 ${done}/${total}`;
    }
  }
}

function openSyncSheet() {
  const o = $(".sheeto");
  if (!o) return;
  o.querySelector(".sheet").innerHTML = `
    <div class="grab"></div>
    <h3>클라우드 동기화<small>기록이 서버에 자동 백업돼요</small></h3>
    <p class="sync-p">이 기기의 동기화 코드. 다른 기기의 암기PT에 이 코드를 넣으면 기록이 합쳐져요.</p>
    <div class="sync-key"><code>${esc(syncKey())}</code><button class="btn" data-act="copy-key">복사</button></div>
    <p class="sync-p">다른 기기의 코드로 연결하기</p>
    <div class="sync-link"><input id="linkKey" placeholder="amgipt-..." autocomplete="off">
      <button class="btn primary" data-act="link-key">연결</button></div>`;
  o.classList.add("show");
}

function onImportFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  file.text().then(txt => {
    let imported;
    try { imported = JSON.parse(txt); } catch { alert("JSON 파일이 아니에요."); return; }
    if (!imported || typeof imported.records !== "object") { alert("다지기 기록 파일이 아니에요."); return; }
    let added = 0;
    for (const [k, arr] of Object.entries(imported.records)) {
      const cur = S.records[k] || (S.records[k] = []);
      for (const r of arr) {
        if (!cur.some(c => c.t === r.t && c.r === r.r)) { cur.push(r); added++; }
      }
      cur.sort((a, b) => (a.t || 0) - (b.t || 0));
    }
    persist(); renderHome();
    alert(`기록 ${added}건을 합쳤어요.`);
  });
}

/* ---------- 라우터 ---------- */
function render() {
  stopMic();
  if (location.hash === "#today") { renderSession(); return; }
  if (location.hash === "#wrong") { SESSION = null; renderWrong(); return; }
  const m = location.hash.match(/^#q\/([^/]+)(\/weak)?/);
  if (m) renderQuiz(decodeURIComponent(m[1]), !!m[2]);
  else { SESSION = null; renderHome(); }
}
window.addEventListener("hashchange", render);
document.addEventListener("click", onAppClick);
// 답안 초안 자동저장 (입력할 때마다)
document.addEventListener("input", e => {
  const t = e.target;
  if (!t.classList || !t.classList.contains("answer")) return;
  const subEl = t.closest(".sub");
  if (!subEl) return;
  const id = subEl.dataset.sid;
  const key = t.dataset.part !== undefined ? id + "#" + t.dataset.part : id;
  draftSet(key, t.value);
});
document.addEventListener("change", e => { if (e.target.id === "importFile") onImportFile(e); });
// 화면을 벗어날 때 밀린 백업을 바로 올린다
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && pushTimer) pushNow();
});
render();
if (!syncKey()) makeSyncKey();
pullAndMerge();
