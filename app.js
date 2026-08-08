/* 다지기 — 퀴즈 재풀이 + 키워드 판정 제안 + 소문항 단위 기록 (localStorage)
   판정 철학: 자동 판정은 "제안"일 뿐. 기록은 언제나 본인이 O·△·X 버튼을 눌러 확정한다. */
"use strict";

const DATA = window.DAJIGI_DATA || [];
const KEY = "dajigi_v1";
const AI_OFF_NAME = "dajigi_ai_off";
/* AI 채점: 암기PT 전용 Supabase 프로젝트 (온고지신과 완전 분리, Gemini 키는 서버 시크릿) */
const SUPA_URL = "https://fqofdlwnzdoqabcnolbz.supabase.co";
const AI_FN_URL = SUPA_URL + "/functions/v1/amgipt-grade";
const AI_FN_KEY = "sb_publishable_cyPOjYPJ4xuWquF0M-O52g_eY4nQ7F5";
const EMAIL_NAME = "dajigi_email";
const DAY = 24 * 60 * 60 * 1000;

/* ---------- 클라우드 동기화 ----------
   기록이 브라우저에서 지워져도(캐시 삭제, iOS 정리) 안 날아가게 서버에 자동 백업.
   기기마다 무작위 동기화 코드가 생기고, 그 코드가 곧 계정이다. 다른 기기에 코드를 넣으면 기록이 합쳐진다. */
const SYNC_URL = SUPA_URL + "/functions/v1/amgipt-sync";
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
  // 질문 단위 드릴 통계 병합: 틀린 횟수는 큰 쪽, 맞춘 시각은 최근 쪽
  if (remote.qstat && typeof remote.qstat === "object") {
    S.qstat = S.qstat || {};
    for (const [k, v] of Object.entries(remote.qstat)) {
      const cur = S.qstat[k];
      S.qstat[k] = cur
        ? { w: Math.max(cur.w || 0, v.w || 0), ok: Math.max(cur.ok || 0, v.ok || 0) }
        : v;
    }
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
  const em = localStorage.getItem(EMAIL_NAME);
  const st = SYNC_STATE === "fail" ? "서버 연결 안 됨, 이 브라우저에만 저장"
    : em ? `${em} 계정에 보관됨`
    : "로그인하면 계정에 보관돼요";
  return `기록 ${n}건 · ${st}`;
}

/* ---------- 로그인 (이메일+비밀번호, Supabase Auth) ----------
   목적은 세션 유지가 아니라 계정 id를 얻는 것. 로그인하면 기록 보관함 키가 "u-{id}"가 되어
   어느 기기든 같은 계정으로 로그인하면 같은 기록을 본다. 로컬 기록은 첫 로그인 때 계정으로 병합·이관된다. */
const AUTH_ERR = {
  invalid_credentials: "이메일 또는 비밀번호가 달라요.",
  user_already_exists: "이미 가입된 이메일이에요. 로그인해 주세요.",
  email_exists: "이미 가입된 이메일이에요. 로그인해 주세요.",
  email_not_confirmed: "메일함의 확인 링크를 먼저 눌러주세요.",
  weak_password: "비밀번호는 6자 이상으로 해주세요.",
  over_email_send_rate_limit: "메일 발송이 잠시 제한됐어요. 조금 뒤에 다시."
};
async function authPassword(mode, email, password) {
  const url = mode === "signup"
    ? SUPA_URL + "/auth/v1/signup"
    : SUPA_URL + "/auth/v1/token?grant_type=password";
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: AI_FN_KEY },
    body: JSON.stringify({ email, password })
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(AUTH_ERR[d.error_code] || d.msg || d.error_description || ("오류 " + res.status));
  return d; // 로그인: {access_token, user} / 가입: 세션 포함 또는 확인 메일 대기
}
function adoptAccount(user) {
  localStorage.setItem(SYNC_KEY_NAME, "u-" + user.id);
  if (user.email) localStorage.setItem(EMAIL_NAME, user.email);
  SYNC_STATE = "wait";
  pullAndMerge(); // 계정 기록과 병합 후 로컬 원본 전체를 계정으로 올린다 = 이관
}
async function handleAuthReturn() {
  const m = location.hash.match(/access_token=([^&]+)/);
  if (!m) return;
  const token = decodeURIComponent(m[1]);
  history.replaceState(null, "", location.pathname); // 주소창의 토큰 제거
  try {
    const r = await fetch(SUPA_URL + "/auth/v1/user", {
      headers: { apikey: AI_FN_KEY, Authorization: "Bearer " + token }
    });
    const u = await r.json();
    if (u && u.id) {
      localStorage.setItem(SYNC_KEY_NAME, "u-" + u.id);
      if (u.email) localStorage.setItem(EMAIL_NAME, u.email);
    }
  } catch { /* 실패해도 기존 키로 계속 */ }
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
  // AI 재질문 목록(JSON 문자열로 전달됨): 다음 집중 인출의 문제 목록이자 채점 그룹으로 쓴다
  let q;
  if (r !== "O" && rq) { try { q = JSON.parse(rq); } catch { q = rq; } }
  if (Array.isArray(q) && !q.length) q = undefined;
  // 새 재질문이 없는데 여전히 못 맞혔으면(예: AI 꺼짐·눈풀이) 기존 질문 목록을 이어간다
  if (!q && r !== "O" && last && last.rq) q = last.rq;
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
  // 질문별 답변 칸이 여러 개일 수 있으니, 버튼이 붙은 칸을 우선한다
  const ta = (btn.closest(".ta-wrap") || subEl).querySelector("textarea.answer");
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
      ${localStorage.getItem(EMAIL_NAME)
        ? `<button class="btn ghost" data-act="logout">로그아웃</button>`
        : `<button class="btn" data-act="login-sheet">로그인</button>`}
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
  if (!l || l.r === "O") return null;
  // 재질문에 채점 키워드(k)가 붙어 있으면 그것이 곧 집중 인출의 채점 그룹 (키워드 밖 결손·부분 판정까지 커버)
  if (Array.isArray(l.rq)) {
    const withK = l.rq.filter(r => r && Array.isArray(r.k) && r.k.length);
    if (withK.length) return withK.map(r => ({ name: r.n || (r.q || "").slice(0, 24), variants: r.k }));
  }
  // 폴백(구형 기록): 놓친 원래 키워드 그룹의 부분집합
  if (!l.m || !l.m.length) return null;
  const names = new Set(l.m);
  const g = sub.groups.filter(x => names.has(x.name));
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
  let fqMode = false; // 질문별 답변 칸 모드 (본문 입력칸은 숨긴다)
  if (fg) {
    let rqs = (latest(id) || {}).rq;
    if (typeof rqs === "string" && rqs) rqs = [{ q: rqs }]; // 구형(문자열 1개) 호환
    let bodyHtml;
    if (Array.isArray(rqs) && rqs.length) {
      // AI가 놓친 것마다 하나씩 만든 재질문: 질문마다 답변 칸을 붙인다
      fqMode = true;
      bodyHtml = `<ol class="focus-qs">${rqs.map((r, i) => `
        <li>
          <div class="fq-q">${esc(r.q || "")}</div>
          <div class="ta-wrap">
            <textarea class="answer" data-fq="${i}" placeholder="이 질문만 짧게">${esc(draftGet(id + "#fq" + i))}</textarea>
            ${MIC_OK ? `<button class="micbtn" data-act="mic" title="음성으로 답변 쓰기">${ico("mic")}</button>` : ""}
          </div>
        </li>`).join("")}</ol>`;
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
  } else if (sub.type === "essay" && !fqMode) {
    const ph = fg ? "놓쳤던 포인트만 짧게" : (sub.ph || "한 문장으로 써 보세요 (입력 없이 정답만 봐도 돼요)");
    inputHtml = `<div class="ta-wrap">
      <textarea class="answer" placeholder="${esc(ph)}">${esc(draftGet(id))}</textarea>
      ${MIC_OK ? `<button class="micbtn" data-act="mic" title="음성으로 답변 쓰기">${ico("mic")}</button>` : ""}
    </div>`;
  }
  // 재학습 모드: 2연속 몰랐던 카드는 인출 전에 정답을 먼저 읽고, 가린 뒤에 쓴다 (실패 반복 대신 재입력)
  let relearnHtml = "";
  if (sub.type === "essay" && subState(id).chronic) {
    relearnHtml = `<div class="relearn">
      <div class="rl-head">${ico("recall")} 두 번 연속 몰랐던 카드. 먼저 정답을 다시 읽고, 가린 다음 인출해요.</div>
      <div class="rl-model md">${md(sub.answer)}</div>
      <button class="btn primary" data-act="hide-relearn">다 읽었다, 가리고 인출</button>
    </div>`;
  }
  const gradeBtns = sub.type === "self"
    ? `<button class="btn primary" data-act="reveal">정답 보기</button>`
    : `<button class="btn primary" data-act="grade">채점하기</button>
       <button class="btn ghost" data-act="reveal">그냥 정답 보기</button>`;
  return `
  <div class="sub${relearnHtml ? " relearning" : ""}" data-sid="${esc(id)}" data-quiz="${esc(quiz.id)}" data-q="${qi}" data-s="${si}"${fg ? ' data-focus="1"' : ""}>
    ${sub.hideHead
      ? (dotsHtml(id) ? `<div class="sub-head">${dotsHtml(id)}</div>` : "")
      : `<div class="sub-head"><span class="sno">${esc(sub.no)}</span>
        ${sub.points ? `<span class="spts">[${sub.points}점]</span>` : ""}${dotsHtml(id)}</div>`}
    ${sub.prompt ? `<div class="sub-prompt md">${md(sub.prompt)}</div>` : ""}
    ${focusHtml}
    ${relearnHtml}
    <div class="sub-input">${inputHtml}</div>
    <div class="sub-actions">${gradeBtns}</div>
    <div class="reveal"></div>
  </div>`;
}

/* ---------- 퀴즈 페이지 (전체 보기) ---------- */
function quizCardsHtml(quiz, weakOnly, pred) {
  return quiz.questions.map((q, qi) => {
    const subs = q.subs
      .map((sub, si) => ({ sub, si }))
      .filter(x => {
        const id = subId(quiz, q, x.sub);
        return (!weakOnly || isWeak(id)) && (!pred || pred(id));
      });
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
let WRONG_FILTER = "all"; // all | 1 | 2 | 3(=3번 이상)
function wrongTimes(id) { return history(id).filter(r => r.r !== "O").length; }
function wfMatch(id) {
  if (WRONG_FILTER === "all") return true;
  const n = wrongTimes(id);
  return WRONG_FILTER === "3" ? n >= 3 : n === +WRONG_FILTER;
}
function renderWrong() {
  // 틀린 횟수 분포 (필터 배지용)
  const weakIds = allSubs().map(x => x.id).filter(isWeak);
  const dist = { 1: 0, 2: 0, 3: 0 };
  for (const id of weakIds) {
    const n = wrongTimes(id);
    dist[n >= 3 ? 3 : n] = (dist[n >= 3 ? 3 : n] || 0) + 1;
  }
  const filters = [["all", `전체 ${weakIds.length}`], ["1", `1번 ${dist[1] || 0}`], ["2", `2번 ${dist[2] || 0}`], ["3", `3번+ ${dist[3] || 0}`]];

  const sections = [];
  let count = 0;
  for (const quiz of DATA) {
    // 브라우징은 질문 목록만 (풀이는 뽀개기에서)
    const rows = [];
    quiz.questions.forEach(q => q.subs.forEach(sub => {
      const id = subId(quiz, q, sub);
      if (!isWeak(id) || !wfMatch(id)) return;
      const l = latest(id);
      let rqs = l && l.rq;
      if (typeof rqs === "string" && rqs) rqs = [{ q: rqs }];
      // 질문별 틀린 횟수 = 태어난 계기(세션에서 1회 틀림) + 뽀개기에서 다시 쌓기 횟수
      const qLine = (qtext, seed) => {
        const st = qstat(id + "|" + qtext);
        return `<li class="${st.ok ? "qdone" : ""}">${st.ok ? "✓ " : ""}${esc(qtext)}
          <span class="wl-qn">${st.w + seed}회 틀림</span></li>`;
      };
      rows.push(`<div class="wl-card">
        <div class="wl-head"><span class="wl-t">${esc(q.title)}${sub.hideHead ? "" : " · " + esc(String(sub.no))}</span></div>
        ${Array.isArray(rqs) && rqs.length
          ? `<ol class="wl-qs">${rqs.map(r => qLine(r.q || "", 1)).join("")}</ol>`
          : `<ol class="wl-qs">${qLine(q.title + " 전체 인출", wrongTimes(id))}</ol>`}
      </div>`);
    }));
    if (!rows.length) continue;
    count += rows.length;
    sections.push(
      `<details class="wrong-sec">
        <summary><span class="ws-name">${esc(quiz.subject)} · ${esc(quiz.range || quiz.title)}</span>
          <span class="ws-meta">${quiz.mode === "review" ? "복습" : "기출"} · ${rows.length}개</span></summary>
        <div class="ws-body">
          ${(() => {
            const cc = crushCounts(quiz.id);
            const sv = loadCrush();
            const resume = sv && sv.quiz === quiz.id;
            return `<div class="wl-btns">
              ${resume ? `<button class="btn primary" data-act="crush-resume">${ico("bolt")} 이어서 뽀개기 (남은 ${sv.pile.length})</button>
                          <button class="btn ghost" data-act="crush-start" data-quiz="${esc(quiz.id)}">처음부터</button>`
                : cc.rem ? `<button class="btn primary" data-act="crush-start" data-quiz="${esc(quiz.id)}">${ico("bolt")} 오답 뽀개기 시작 (${cc.rem})</button>` : ""}
              ${cc.all > cc.rem ? `<button class="btn ghost" data-act="crush-start" data-quiz="${esc(quiz.id)}" data-all="1">맞춘 ${cc.all - cc.rem}개 포함해 시작</button>` : ""}
            </div>`;
          })()}
          ${rows.join("")}
        </div>
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
    <div class="wfilter">${filters.map(([f, label]) =>
      `<button class="nt${WRONG_FILTER === f ? " on" : ""}" data-act="wrong-filter" data-f="${f}">${label}</button>`).join("")}</div>
    ${sections.join("") || '<div class="empty">여기 해당하는 오답이 없어요.</div>'}`;
  window.scrollTo(0, 0);
}

/* ---------- 오답 뽀개기 (퀴즐렛식 드릴: 한 질문씩, 틀리면 더미 맨 뒤로, 다 맞출 때까지) ----------
   맞춘 질문은 분류되어(dajigi_crush_done) 다음 뽀개기에서 빠진다. "맞춘 것 포함"으로 다시 소환 가능.
   진행 중 상태는 저장되어(dajigi_crush) 나갔다 와도 이어서 한다. */
let CRUSH = null;
/* 질문 단위 통계: { 키: { w: 틀린 횟수, ok: 마지막으로 맞춘 시각(0이면 미분류) } }
   기록 저장소(S) 안에 두어 계정 동기화에 같이 실린다. */
let QSTAT = (S.qstat && typeof S.qstat === "object") ? S.qstat : {};
S.qstat = QSTAT;
function crushKey(it) { return it.sid + "|" + (it.q || "full"); }
function qstat(key) { return QSTAT[key] || { w: 0, ok: 0 }; }
function saveQstat() { S.qstat = QSTAT; persist(); }
function saveCrush() {
  if (CRUSH && CRUSH.pile.length) {
    localStorage.setItem("dajigi_crush", JSON.stringify({ quiz: CRUSH.quiz, pile: CRUSH.pile, done: CRUSH.done, total: CRUSH.total }));
  } else localStorage.removeItem("dajigi_crush");
}
function loadCrush() {
  try {
    const s = JSON.parse(localStorage.getItem("dajigi_crush"));
    if (s && Array.isArray(s.pile) && s.pile.length)
      return { ...s, reveal: false, checking: false, lastVal: "", aiNote: "", chips: null };
  } catch { /* 무시 */ }
  return null;
}
function buildCrushItems(quizId, includeMastered) {
  const items = [];
  for (const x of allSubs()) {
    if (x.quiz.id !== quizId || !isWeak(x.id) || !wfMatch(x.id)) continue;
    const l = latest(x.id);
    let rqs = l && l.rq;
    if (typeof rqs === "string" && rqs) rqs = [{ q: rqs }];
    if (Array.isArray(rqs) && rqs.length) {
      for (const r of rqs) items.push({ sid: x.id, title: x.q.title, q: r.q || "", n: r.n || "", k: Array.isArray(r.k) ? r.k : [], model: x.sub.answer });
    } else {
      // AI 질문이 없는 오답: 카드 전체 인출 — 원래 카드처럼 키워드 그룹 전체를 문자+AI로 판정
      items.push({ sid: x.id, title: x.q.title, q: x.q.title + " 전체 인출", n: "", k: [], groups: x.sub.groups || null, model: x.sub.answer });
    }
  }
  return includeMastered ? items : items.filter(it => !qstat(crushKey(it)).ok);
}
function crushCounts(quizId) {
  const all = buildCrushItems(quizId, true);
  const rem = all.filter(it => !qstat(crushKey(it)).ok);
  return { all: all.length, rem: rem.length };
}
function crushPass(it) {
  const key = crushKey(it);
  QSTAT[key] = { ...qstat(key), ok: Date.now() }; // 맞춘 것으로 분류 (틀린 횟수는 보존)
  saveQstat();
  CRUSH.done++; CRUSH.pile.shift();
  CRUSH.reveal = false; CRUSH.aiNote = ""; CRUSH.chips = null;
  saveCrush();
}
function crushWrong(it) {
  const key = crushKey(it);
  const st = qstat(key);
  QSTAT[key] = { w: st.w + 1, ok: 0 }; // 틀린 횟수 +1, 맞춘 분류는 해제
  saveQstat();
}
function renderCrush() {
  if (!CRUSH) { location.hash = "#wrong"; return; }
  if (!CRUSH.pile.length) {
    $("#app").innerHTML = `
      <div class="checkpoint">
        <h2>${ico("check")} 오답 뽀개기 완료</h2>
        <p class="cp-goal">${CRUSH.total}문제를 전부 맞혔어요. 맞춘 질문은 분류되어 다음 뽀개기에서 빠져요 ("맞춘 것 포함"으로 다시 소환 가능).</p>
        <p class="cp-goal">뽀개기는 연습이라 카드의 판정 기록은 그대로예요. 세션이나 카드 채점에서 확정하면 오답에서 빠져요.</p>
        <div class="cp-actions"><a class="btn primary big" href="#wrong" data-act="crush-quit">오답으로 돌아가기</a></div>
      </div>`;
    window.scrollTo(0, 0);
    return;
  }
  const it = CRUSH.pile[0];
  let inner;
  if (CRUSH.checking) {
    inner = `<div class="crush-mine">내 답: ${esc(CRUSH.lastVal)}</div>
       <div class="ai-status">${ico("spark")} AI가 의미 포함 여부를 판정하는 중…</div>`;
  } else if (CRUSH.reveal) {
    inner = `${CRUSH.lastVal ? `<div class="crush-mine">내 답: ${esc(CRUSH.lastVal)}</div>` : ""}
       ${CRUSH.chips ? `<div class="kw-chips">${CRUSH.chips.map(c =>
         `<span class="kw ${c.ok ? "hit" : "miss"}" ${c.note ? `title="${esc(c.note)}"` : ""}>${c.ok ? "✓" : "✗"} ${esc(c.name)}</span>`).join("")}</div>` : ""}
       ${CRUSH.chips ? CRUSH.chips.filter(c => !c.ok && c.note).map(c =>
         `<div class="dnote"><span class="dm-miss">✗</span> <b>${esc(c.name)}</b> ${esc(c.note)}</div>`).join("") : ""}
       ${CRUSH.aiNote ? `<div class="dnote"><span class="dm-miss">✗</span> ${esc(CRUSH.aiNote)}</div>` : ""}
       <div class="crush-ans">${it.k.length
         ? `<span class="lbl">정답</span> ${it.n ? `<b>${esc(it.n)}</b> · ` : ""}${it.k.map(esc).join(" · ")}`
         : `<div class="model"><span class="lbl">모범답안</span><div class="md">${md(it.model || "")}</div></div>`}</div>
       <div class="sub-actions">
         <button class="btn" data-act="crush-ok">맞은 걸로</button>
         <button class="btn primary" data-act="crush-again">틀림, 다시 쌓기</button>
       </div>`;
  } else {
    inner = `<div class="ta-wrap">
         <textarea class="answer" id="crushTa" placeholder="답하고 확인"></textarea>
         ${MIC_OK ? `<button class="micbtn" data-act="mic" title="음성으로 답변 쓰기">${ico("mic")}</button>` : ""}
       </div>
       <div class="sub-actions"><button class="btn primary" data-act="crush-check">확인</button></div>`;
  }
  $("#app").innerHTML = `
    <div class="topbar">
      <a class="back" href="#wrong" data-act="crush-quit">✕ 종료</a>
      <div class="sessbar"><div class="sessbar-fill" style="width:${CRUSH.done / CRUSH.total * 100}%"></div></div>
      <span class="prog">맞춘 ${CRUSH.done}/${CRUSH.total} · 남은 ${CRUSH.pile.length}</span>
    </div>
    <section class="q-card sess-card sub crush">
      <div class="sess-meta"><span>${esc(it.title)}</span>
        <span class="lastmark m-X">이 질문 ${qstat(crushKey(it)).w + (it.groups ? wrongTimes(it.sid) : 1)}회 틀림</span></div>
      <div class="q-head"><span class="qno">${esc(it.q)}</span></div>
      ${inner}
    </section>`;
  const ta = document.getElementById("crushTa");
  if (ta) ta.focus();
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
    // AI가 놓친 것마다 하나씩 만든 재질문 + 그 질문의 채점 키워드: 판정 확정 시 기록에 저장되어
    // 다음 집중 인출의 문제 목록이자 채점 그룹이 된다
    const retry = (Array.isArray(data.retry) ? data.retry : [])
      .filter(r => r && r.q).map(r => ({
        n: r.target || "",
        q: r.q,
        k: Array.isArray(r.kw) ? r.kw.filter(x => typeof x === "string" && x.trim()).slice(0, 6) : []
      }))
      .concat(!Array.isArray(data.retry) && data.retry_question ? [{ n: "", q: data.retry_question, k: [] }] : []);
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
    // 질문별 답변 칸 모드: 각 답변을 그 질문의 키워드로만 1:1 채점
    const fqEls = [...subEl.querySelectorAll("textarea.answer[data-fq]")];
    let input, groups, flags;
    if (fqEls.length) {
      const l = latest(id);
      const rqs = Array.isArray(l && l.rq) ? l.rq : [];
      groups = rqs.map((r, i) => ({
        name: r.n || "질문 " + (i + 1),
        variants: (Array.isArray(r.k) && r.k.length) ? r.k : []
      }));
      flags = groups.map((g, i) =>
        g.variants.length ? judgeEssay(fqEls[i] ? fqEls[i].value : "", [g])[0] : false);
      // 전부 빈칸이면 AI 판정도 건너뛴다 (input이 빈 문자열이면 아래 조건이 걸러줌)
      input = fqEls.some(t => norm(t.value) !== "")
        ? fqEls.map((t, i) => `${i + 1}) ${t.value.trim() || "(무응답)"}`).join("\n")
        : "";
    } else {
      input = subEl.querySelector("textarea.answer").value;
      groups = effGroups(subEl, sub); // 집중 인출이면 놓쳤던 포인트만 채점
      flags = judgeEssay(input, groups);
    }
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
  if (act === "login-sheet") { openLoginSheet(); return; }
  if (act === "login-submit") { doAuth("login", btn); return; }
  if (act === "signup-submit") { doAuth("signup", btn); return; }
  if (act === "logout") {
    localStorage.removeItem(EMAIL_NAME);
    makeSyncKey(); // 익명 키로 복귀 (기록은 이 기기에 그대로, 계정 보관함도 서버에 남음)
    SYNC_STATE = "wait";
    $(".sheeto")?.classList.remove("show");
    renderHome();
    pushNow();
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
  if (act === "wrong-filter") { WRONG_FILTER = btn.dataset.f; renderWrong(); return; }
  if (act === "crush-start") {
    e.preventDefault();
    const items = buildCrushItems(btn.dataset.quiz, btn.dataset.all === "1");
    if (!items.length) return;
    CRUSH = { quiz: btn.dataset.quiz, pile: items, total: items.length, done: 0, reveal: false, lastVal: "", aiNote: "", chips: null };
    saveCrush();
    location.hash = "#crush";
    return;
  }
  if (act === "crush-check") {
    stopMic();
    const it = CRUSH.pile[0];
    const ta = document.getElementById("crushTa");
    const val = ta ? ta.value : "";
    CRUSH.chips = null;
    if (it.groups) {
      // 전체 인출 카드: 원래 카드 채점과 동일하게 그룹 전체 판정
      const flags = judgeEssay(val, it.groups);
      const finish = (fl, notes) => {
        CRUSH.checking = false;
        if (fl.every(Boolean)) crushPass(it);
        else {
          CRUSH.reveal = true;
          CRUSH.chips = it.groups.map((g, i) => ({ name: g.name, ok: fl[i], note: (notes && notes[i]) || "" }));
        }
        renderCrush();
      };
      CRUSH.lastVal = val.trim();
      if (flags.every(Boolean)) { finish(flags); return; }
      if (aiOn() && norm(val) !== "") {
        CRUSH.checking = true;
        const snap = it;
        aiJudgeKeywords(it.title, it.model || "", it.groups.map(g => g.name),
          flags.map((f, i) => f ? it.groups[i].name : null).filter(Boolean), val).then(d => {
          if (!CRUSH || CRUSH.pile[0] !== snap) return;
          const byName = new Map((d.results || []).map(r => [r.name, r]));
          const fl = flags.slice();
          const notes = [];
          it.groups.forEach((g, i) => {
            const r = byName.get(g.name);
            if (!r || fl[i]) return;
            const verdict = r.verdict || (r.found ? "good" : "missed");
            if (verdict === "good") fl[i] = true;
            else if (r.note) notes[i] = r.note;
          });
          finish(fl, notes);
        }).catch(() => { if (CRUSH && CRUSH.pile[0] === snap) finish(flags); });
        renderCrush();
        return;
      }
      finish(flags);
      return;
    }
    const hit = it.k.some(v => norm(v) !== "" && norm(val).includes(norm(v)));
    if (hit) crushPass(it);
    else if (aiOn() && norm(val) !== "") { // 키워드가 없는 구형 재질문도 질문+모범답안만으로 AI 판정
      // 문자로는 못 찾음 → AI가 의미 포함 여부를 판정 (맞으면 자동 통과)
      CRUSH.checking = true; CRUSH.lastVal = val.trim();
      const snap = it;
      aiJudgeKeywords(it.title, it.model || "", [it.n || it.q], [], val).then(d => {
        if (!CRUSH || CRUSH.pile[0] !== snap) return; // 그새 종료·이동했으면 무시
        const r = (d.results || [])[0];
        const verdict = r ? (r.verdict || (r.found ? "good" : "missed")) : "missed";
        CRUSH.checking = false;
        if (verdict === "good") crushPass(snap);
        else { CRUSH.reveal = true; CRUSH.aiNote = (r && r.note) || ""; }
        renderCrush();
      }).catch(() => {
        if (!CRUSH || CRUSH.pile[0] !== snap) return;
        CRUSH.checking = false; CRUSH.reveal = true; CRUSH.aiNote = "";
        renderCrush();
      });
    }
    else { CRUSH.reveal = true; CRUSH.lastVal = val.trim(); CRUSH.aiNote = ""; }
    renderCrush();
    return;
  }
  if (act === "crush-ok") { crushPass(CRUSH.pile[0]); renderCrush(); return; }
  if (act === "crush-again") {
    crushWrong(CRUSH.pile[0]); // 질문 단위 틀린 횟수 +1
    CRUSH.pile.push(CRUSH.pile.shift());
    CRUSH.reveal = false; CRUSH.aiNote = ""; CRUSH.chips = null;
    saveCrush();
    renderCrush();
    return;
  }
  if (act === "crush-resume") { CRUSH = loadCrush(); if (CRUSH) location.hash = "#crush"; return; }
  if (act === "crush-quit") { CRUSH = null; return; /* 진행 상태는 저장돼 있고 href="#wrong"가 라우팅 */ }
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
  if (act === "hide-relearn") {
    subEl.querySelector(".relearn")?.remove();
    subEl.classList.remove("relearning");
    subEl.querySelector("textarea.answer")?.focus();
    return;
  }
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

function openLoginSheet() {
  const o = $(".sheeto");
  if (!o) return;
  o.querySelector(".sheet").innerHTML = `
    <div class="grab"></div>
    <h3>로그인<small>기록이 계정에 보관돼요. 어느 기기든 로그인하면 이어져요</small></h3>
    <div class="login-form">
      <input id="loginEmail" type="email" placeholder="이메일" autocomplete="email">
      <input id="loginPw" type="password" placeholder="비밀번호 (6자 이상)" autocomplete="current-password">
      <div class="login-btns">
        <button class="btn ghost" data-act="signup-submit">가입하기</button>
        <button class="btn primary" data-act="login-submit">로그인</button>
      </div>
      <p class="sync-p" id="loginMsg"></p>
    </div>`;
  o.classList.add("show");
}
async function doAuth(mode, btn) {
  const em = document.getElementById("loginEmail").value.trim();
  const pw = document.getElementById("loginPw").value;
  const msg = document.getElementById("loginMsg");
  const say = t => { if (msg) msg.textContent = t; };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) { say("이메일 주소를 확인해 주세요."); return; }
  if (pw.length < 6) { say("비밀번호는 6자 이상이에요."); return; }
  btn.disabled = true;
  try {
    const d = await authPassword(mode, em, pw);
    const user = d.user || d;
    if (d.access_token && user && user.id) {
      adoptAccount(user);
      $(".sheeto")?.classList.remove("show");
      renderHome();
    } else {
      // 이메일 확인이 켜져 있는 경우: 확인 메일의 링크를 누르면 돌아와서 자동 로그인된다
      say("확인 메일을 보냈어요. 메일의 링크를 누르면 로그인돼요.");
    }
  } catch (e) {
    say(e.message || "실패했어요. 다시 시도해 주세요.");
  }
  btn.disabled = false;
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
  if (location.hash === "#crush") {
    if (!CRUSH) CRUSH = loadCrush(); // 나갔다 돌아와도 이어서
    if (CRUSH) renderCrush(); else location.hash = "#wrong";
    return;
  }
  if (location.hash === "#wrong") { SESSION = null; CRUSH = null; renderWrong(); return; }
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
  if (!id) return; // 뽀개기 드릴 입력칸은 초안 저장 안 함
  const key = t.dataset.part !== undefined ? id + "#" + t.dataset.part
    : t.dataset.fq !== undefined ? id + "#fq" + t.dataset.fq : id;
  draftSet(key, t.value);
});
document.addEventListener("change", e => { if (e.target.id === "importFile") onImportFile(e); });
// 화면을 벗어날 때 밀린 백업을 바로 올린다
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && pushTimer) pushNow();
});
(async () => {
  await handleAuthReturn(); // 매직링크로 돌아온 경우 계정 키로 교체
  render();
  if (!syncKey()) makeSyncKey();
  pullAndMerge();
})();
