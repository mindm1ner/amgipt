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
  // 내 질문(커스텀) 병합: 카드별로 질문 문구 기준 합집합
  if (remote.myq && typeof remote.myq === "object") {
    S.myq = S.myq || {};
    for (const [sid, arr] of Object.entries(remote.myq)) {
      const cur = S.myq[sid] || (S.myq[sid] = []);
      for (const r of arr) if (r && r.q && !cur.some(c => c.q === r.q)) cur.push(r);
    }
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

/* ---------- 내용 체계표: 표 빈칸형 ----------
   빈칸 하나가 카드 하나다. 표는 보여주는 방식일 뿐이라 판정은 칸마다 따로 매겨진다.
   파일에는 최소한만 담고(no·a·cat·gr) 나머지는 여기서 채운다. */
for (const set of (window.DAJIGI_CT || [])) {
  DATA.push({
    ...set,
    questions: set.questions.map(q => ({
      ...q,
      points: 0,
      frame: "내용 체계표 · " + set.range,
      body: "",
      /* type "term" 은 parts 로 채점한다 (groups 는 essay 용). 표 안에서 풀든
         오늘의 복습에서 한 장씩 나오든 같은 답으로 판정되게 둘 다 채워 둔다 */
      subs: q.subs.map(s => ({
        no: s.no, type: "term", hideHead: true, points: 0, prompt: "",
        answer: s.a,
        parts: [{ label: `${s.cat.replace("⋅", "·")} · ${s.gr}`, accept: [s.a] }],
        ct: { cat: s.cat, gr: s.gr }
      }))
    }))
  });
}

/* ---------- 내용 체계표: 맥락형 ----------
   수업 장면을 주고 그 칸의 내용 요소 하나를 인출한다. 기출 25건의 골격 그대로다.
   카드 구조는 기존 것과 같아서 세션·오답·간격 엔진이 그대로 돈다. */
for (const set of (window.DAJIGI_CTX || [])) {
  DATA.push({
    ...set,
    questions: set.questions.map(q => ({
      ...q,
      points: 1,
      // 출처를 밝힌다. 원문 발췌인지 각색인지 지어낸 장면인지가 구분돼야 한다
      frame: q.src
        ? `${q.adapted ? "기출 각색" : "기출 지문"} · ${q.src}`
        : "수업 맥락 · " + set.range,
      subs: q.subs.map(s => ({
        no: s.no, type: "term", hideHead: true, points: 1,
        prompt: s.ask,
        answer: s.a,
        parts: [{ label: "내용 요소", accept: [s.a] }],
        ct: { cat: s.cat, gr: s.gr, area: s.area }
      }))
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
/* err = 표 빈칸 오답 유형 {t 유형, r 헷갈린 칸 번호, w 내가 쓴 것, n 한 줄 진단}.
   같은 줄에 x로 붙는다. 오답 노트이자 "자주 틀리는 칸만 빈칸"의 재료 */
function record(id, r, auto, miss, rq, err) {
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
    if (err) last.x = err; else if (r === "O" && !err) delete last.x;
  }
  else h.push({ d: todayStr(), r, a: auto || null, t, ...(m ? { m } : {}), ...(q ? { rq: q } : {}), ...(err ? { x: err } : {}) });
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
  for (const quiz of DATA) {
    // 내체표는 과목마다 고른 범주만 카드로 센다
    const cats = quiz.kind === "ct" ? ctCats(quiz.range) : null;
    for (let qi = 0; qi < quiz.questions.length; qi++) {
      const q = quiz.questions[qi];
      for (let si = 0; si < q.subs.length; si++) {
        const sub = q.subs[si];
        if (cats && !cats.has(sub.ct.cat)) continue;
        out.push({ quiz, q, sub, qi, si, id: subId(quiz, q, sub) });
      }
    }
  }
  return out;
}
const NEW_PER_DAY = 10;

/* 범위(scope): 무엇을 도는가. null이면 전부.
   "sj:사회" = 과목 하나 · "ar:사회|정치" = 영역 하나.
   홈이 왼쪽 메뉴로 바뀌면서 세션은 늘 어딘가에서 시작된다 (전 범위 무작위였던 오늘의 PT를 없앴다). */
function rangeOf(quiz) { return quiz.range || quiz.title; }
function inScope(x, scope) {
  if (!scope) return true;
  if (scope.startsWith("sj:")) return x.quiz.subject === scope.slice(3);
  if (scope.startsWith("qz:")) return x.quiz.id === scope.slice(3);
  if (scope.startsWith("ar:")) {
    const i = scope.indexOf("|");
    return x.quiz.subject === scope.slice(3, i) && rangeOf(x.quiz) === scope.slice(i + 1);
  }
  return true;
}
function scopedSubs(scope) {
  return allSubs().filter(x => inScope(x, scope)).map(x => ({ ...x, st: subState(x.id) }));
}
/* 오늘 처음 꺼낸 카드 수. 첫 기록이 오늘이면 오늘 들어온 카드다.
   범위별로 세션을 돌아도 신규 배정은 하루 전체에서 10장이라는 뜻 (범위마다 10장이 아니다). */
function newIntroducedToday() {
  const t = todayStr();
  let n = 0;
  for (const h of Object.values(S.records)) if (h.length && h[0].d === t) n++;
  return n;
}
function newBudget() { return Math.max(0, NEW_PER_DAY - newIntroducedToday()); }

/* ---------- 섞기 ----------
   문서 순서 그대로 내면 앞 카드가 다음 답을 일러 준다. 내체표는 한 칸의 항목들이
   나란히 붙어 있어서 특히 그렇다. 섞은 뒤, 같은 칸(과목·영역·범주)이 잇달아 나오지
   않도록 흩는다. 좌표가 매번 바뀌어야 좌표를 보고 답을 고르게 된다. */
function shuffled(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function cellKey(x) {
  const c = x.sub.ct;
  return c ? [x.quiz.range, c.area || "", c.cat || ""].join("|") : x.quiz.id;
}
function spread(list) {
  const pool = shuffled(list);
  const out = [];
  let last = null;
  while (pool.length) {
    let i = pool.findIndex(x => cellKey(x) !== last);
    if (i < 0) i = 0;                 // 남은 게 전부 같은 칸이면 어쩔 수 없다
    out.push(pool[i]);
    last = cellKey(pool[i]);
    pool.splice(i, 1);
  }
  return out;
}

function buildQueue(mode, scope) {
  const subs = scopedSubs(scope);
  if (mode === "all") return spread(subs);
  if (mode === "chronic") return spread(subs.filter(x => x.st.chronic));
  /* 다시 볼 것 → 복습 → 새 카드 순서는 지키되, 각 묶음 안에서는 섞는다.
     새 카드는 골라 담기 전에 섞어야 늘 앞쪽 것만 나오지 않는다 */
  const relearn = spread(subs.filter(x => x.st.status === "relearn" && x.st.isDue));
  const review = spread(subs.filter(x => x.st.status === "review" && x.st.isDue));
  const fresh = spread(subs.filter(x => x.st.status === "new")).slice(0, newBudget());
  if (mode === "fresh") return fresh;
  if (mode === "weak") return spread(subs.filter(x => x.st.last && x.st.last.r !== "O"));
  return [...relearn, ...review, ...fresh];
}
function queueCounts(scope) {
  const subs = scopedSubs(scope).map(x => x.st);
  return {
    all: subs.length,
    fresh: subs.filter(s => s.status === "new").length,
    relearn: subs.filter(s => s.status === "relearn" && s.isDue).length,
    review: subs.filter(s => s.status === "review" && s.isDue).length,
    chronic: subs.filter(s => s.chronic).length,
    weak: subs.filter(s => s.last && s.last.r !== "O").length
  };
}
/* 그날그날 한 것. 기록에 이미 날짜(d)가 박혀 있어서 묶기만 하면 된다.
   쉰 날은 줄을 만들지 않는다 — 빈칸이 증거로 남지 않게. */
function dailyLog() {
  const by = new Map();
  for (const h of Object.values(S.records)) {
    for (const r of h) {
      const d = r.d || (r.t ? new Date(r.t).toISOString().slice(0, 10) : null);
      if (!d) continue;
      const o = by.get(d) || { n: 0, O: 0, T: 0, X: 0 };
      o.n++; o[r.r === "O" ? "O" : r.r === "X" ? "X" : "T"]++;
      by.set(d, o);
    }
  }
  return [...by.entries()].sort((a, b) => b[0].localeCompare(a[0]));
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
  mic: '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/>',
  pen: '<path d="M4 20l4-1L20 7l-3-3L5 16z"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  due: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>',
  cross: '<circle cx="12" cy="12" r="8.5"/><path d="M15 9l-6 6M9 9l6 6"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  back: '<path d="M15 5l-7 7 7 7"/>'
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
    const kind = quiz.kind || (quiz.mode === "review" ? "review" : "exam");
    const META = {
      ct: ["grid", "표 빈칸형", "표의 내용 요소를 전부 비우고 채운다"],
      ctx: ["recall", "맥락형", "수업 장면을 보고 그 칸의 내용 요소를 쓴다"],
      review: ["recall", "복습 모드", "단권화 키워드 인출·설명"],
      exam: ["doc", "기출 모드", "기출 프레임 문서형 풀이"]
    };
    const [icon, name, desc] = META[kind] || META.exam;
    return `
    <div class="mode-row">
      <div class="m-icon">${ico(icon)}</div>
      <div class="m-main">
        <div class="m-name">${name}</div>
        <div class="m-desc">${desc} · 소문항 ${s.total} · 풀어봄 ${s.tried}</div>
      </div>
      <div class="m-acts">
        ${quiz.kind === "ct"
          ? `<a class="btn primary" href="#q/${quiz.id}">표 풀기</a>`
          : `<button class="btn primary" data-act="start-scope" data-scope="qz:${esc(quiz.id)}" data-mode="all">풀기</button>
             ${s.weak ? `<button class="btn" data-act="start-scope" data-scope="qz:${esc(quiz.id)}" data-mode="weak">틀린 것만 ${s.weak}</button>` : ""}
             <a class="btn ghost" href="#q/${quiz.id}">한 페이지로</a>`}
      </div>
    </div>`;
  }).join("");
  const o = $(".sheeto");
  o.querySelector(".sheet").innerHTML =
    `<div class="grab"></div>
     <h3>${esc(quizzes[0].subject)} · ${esc(name)}<small>모드를 골라 시작하세요</small></h3>` + rows;
  o.classList.add("show");
}

/* 과목 > 영역 묶음. 왼쪽 메뉴가 쓴다 */
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

/* ---------- 홈: 왼쪽 메뉴 + 본문 ----------
   서랍(파일 캐비닛)을 걷어냈다. 파일이 항목 수만큼 세로로 쌓여서 과목이 늘면 무너진다.
   메뉴는 조건을 거는 물건이 아니라 자리를 옮기는 것이라 "지금 뭐가 걸렸지"를 신경 쓸 필요가 없다.
   좁은 화면에서는 메뉴가 첫 화면이 되고 고르면 본문으로 넘어간다 (HOME_VIEW). */
let HOME_SEL = "st:today";
let HOME_VIEW = "menu"; // 좁은 화면에서만 쓰인다

function menuItem(sel, icon, name, count, hot) {
  const on = HOME_SEL === sel;
  return `<button class="mi${on ? " on" : ""}" data-act="home-go" data-sel="${esc(sel)}"
      ${on ? 'aria-current="true"' : ""}>
    ${icon ? ico(icon) : ""}<span class="mnm">${esc(name)}</span>
    ${count ? `<span class="${hot ? "mdue" : "mct"}">${count}</span>` : ""}</button>`;
}

function homeMenuHtml() {
  const qc = queueCounts();
  const due = qc.relearn + qc.review;
  const subj = subjectGroups();
  return `
    <div class="sbrand"><h1>암기PT</h1><p>임용 암기 트레이너</p></div>
    <div class="sgroup"><div class="slabel">상태</div>
      ${menuItem("st:today", "due", "오늘의 복습", due, true)}
      ${menuItem("st:weak", "cross", "틀린 것", qc.weak)}
      ${menuItem("st:fresh", "plus", "아직 안 함", qc.fresh)}
    </div>
    <div class="sgroup"><div class="slabel">과목</div>
      ${[...subj.keys()].map(s => {
        const c = queueCounts("sj:" + s);
        return menuItem("sj:" + s, "", s, c.relearn + c.review || c.all, !!(c.relearn + c.review));
      }).join("")}
    </div>
    <div class="sgroup"><div class="slabel">기록</div>
      ${qc.chronic ? menuItem("st:chronic", "bolt", "고질 약점", qc.chronic) : ""}
      ${menuItem("st:log", "chart", "기록", 0)}
    </div>`;
}

function rowsHtml(list) {
  if (!list.length) return `<p class="mt-empty">여기는 비어 있어요.</p>`;
  return list.map(x => {
    /* 기출 문항은 한 문항에 소문항이 여럿이라 제목만 쓰면 같은 줄이 반복돼 보인다 */
    const base = esc(x.sub.title || x.q.title || "카드");
    const nm = x.q.subs.length > 1 ? `${base} <span class="sn">${esc(x.sub.no)}</span>` : base;
    const v = x.st.last ? x.st.last.r : null;
    return `<div class="mrow">
      <span class="nm">${nm}<span class="tag">${esc(x.quiz.subject)} · ${esc(rangeOf(x.quiz))}</span></span>
      ${v ? `<span class="vd ${v === "O" ? "o" : v === "X" ? "x" : "t"}">${v === "T" ? "△" : v}</span>` : ""}
    </div>`;
  }).join("");
}

function homeMainHtml() {
  const sel = HOME_SEL;

  if (sel === "st:log") {
    const log = dailyLog();
    const total = log.reduce((t, [, o]) => t + o.n, 0);
    const wk = log.slice(0, 7).reduce((t, [, o]) => t + o.n, 0);
    return `<div class="mhead"><div><h2>기록</h2>
        <p>한 날만 쌓여요. 쉰 날은 줄을 만들지 않아요</p></div></div>
      <div class="mstat">
        <div><b>${wk}</b><span>최근 7일</span></div>
        <div><b>${total}</b><span>누적</span></div>
        <div><b>${log.length}</b><span>기록이 있는 날</span></div>
      </div>
      ${log.length ? log.map(([d, o]) => {
        const t = o.n || 1;
        const [, mo, dy] = d.split("-");
        return `<div class="mrow"><span class="nm">${+mo}월 ${+dy}일${
            d === todayStr() ? `<span class="tag">오늘</span>` : ""}</span>
          <span class="mix" role="img" aria-label="O ${o.O}, 부분 ${o.T}, 모름 ${o.X}">
            <i class="o" style="flex:${o.O}"></i><i class="t" style="flex:${o.T}"></i><i class="x" style="flex:${o.X}"></i></span>
          <span class="cnt">${o.n}장</span></div>`;
      }).join("") : `<p class="mt-empty">아직 기록이 없어요. 카드를 한 장 풀면 여기 남아요.</p>`}`;
  }

  /* 과목: 영역 목록 */
  if (sel.startsWith("sj:")) {
    const s = sel.slice(3);
    const ranges = subjectGroups().get(s) || new Map();
    const c = queueCounts(sel);
    return `<div class="mhead"><div><h2>${esc(s)}</h2>
        <p>영역 ${ranges.size} · 카드 ${c.all}장</p></div>
        ${c.relearn + c.review ? `<button class="btn primary" data-act="start-scope" data-scope="${esc(sel)}">복습 ${c.relearn + c.review}장</button>` : ""}</div>
      ${[...ranges.entries()].map(([name, quizzes]) => {
        /* 카드 수는 범위 밖 칸을 뺀 실제 수로 센다 (내체표는 과목마다 범주를 고른다) */
        const rc = queueCounts("ar:" + s + "|" + name);
        return `<button class="mrow click" data-act="open-range" data-range="${esc(name)}"
            data-single="${quizzes.length === 1 ? esc(quizzes[0].id) : ""}">
          <span class="nm">${esc(name)}</span>
          <span class="cnt">${rc.all}장</span>
          ${rc.weak ? `<span class="bdg warn">다시 ${rc.weak}</span>` : ""}
          ${rc.relearn + rc.review ? `<span class="bdg">${rc.relearn + rc.review}</span>` : ""}
        </button>`;
      }).join("")}`;
  }

  /* 상태 화면 */
  const k = sel.slice(3);
  const qc = queueCounts();
  if (k === "today") {
    const q = buildQueue("today");
    const n = qc.relearn + qc.review;
    const fr = q.length - n;
    const line = n
      ? `복습 ${n}장${fr > 0 ? ` · 새 카드 ${fr}장` : ""}`
      : fr > 0 ? `복습할 건 다 끝냈어요. 새 카드 ${fr}장이 기다려요`
      : "오늘 볼 카드를 다 끝냈어요";
    return `<div class="mhead"><div><h2>오늘의 복습</h2>
        <p>${line}</p></div>
        ${q.length ? `<button class="btn primary" data-act="start-scope" data-scope="">${q.length}장 시작</button>` : ""}</div>
      ${rowsHtml(q.slice(0, 30))}
      ${q.length > 30 ? `<p class="mt-more">아래로 ${q.length - 30}장 더</p>` : ""}`;
  }
  if (k === "fresh") {
    const list = scopedSubs().filter(x => x.st.status === "new");
    const b = newBudget();
    return `<div class="mhead"><div><h2>아직 안 함</h2>
        <p>${list.length}장 · 오늘 더 꺼낼 수 있는 건 ${b}장</p></div>
        ${b && list.length ? `<button class="btn primary" data-act="start-scope" data-scope="" data-mode="fresh">${Math.min(b, list.length)}장 시작</button>` : ""}</div>
      ${rowsHtml(list.slice(0, 30))}
      ${list.length > 30 ? `<p class="mt-more">아래로 ${list.length - 30}장 더</p>` : ""}`;
  }
  if (k === "weak") {
    const list = scopedSubs().filter(x => x.st.last && x.st.last.r !== "O");
    return `<div class="mhead"><div><h2>틀린 것</h2><p>${list.length}장</p></div>
        ${list.length ? `<a class="btn" href="#wrong">오답 뽀개기</a>` : ""}</div>
      ${rowsHtml(list.slice(0, 30))}
      ${list.length > 30 ? `<p class="mt-more">아래로 ${list.length - 30}장 더</p>` : ""}`;
  }
  if (k === "chronic") {
    const list = scopedSubs().filter(x => x.st.chronic);
    return `<div class="mhead"><div><h2>고질 약점</h2><p>두 번 잇달아 몰랐던 카드 ${list.length}장</p></div>
        ${list.length ? `<button class="btn primary" data-act="start-chronic">${list.length}장 시작</button>` : ""}</div>
      ${rowsHtml(list)}`;
  }
  return "";
}

function renderHome() {
  const recCount = Object.values(S.records).reduce((a, h) => a + h.length, 0);
  const needBackup = recCount > 0 && (!S.lastExport || Date.now() - S.lastExport > 7 * DAY);
  const lastTs = Object.values(S.records).flat().reduce((m, r) => Math.max(m, r.t || 0), 0);
  const staleDays = lastTs ? Math.floor((Date.now() - lastTs) / DAY) : null;

  $("#app").innerHTML = `
    ${needBackup && SYNC_STATE !== "ok" ? `<div class="banner"><span>기록 ${recCount}건이 이 브라우저에만 있어요.
      ${staleDays !== null && staleDays > 0 ? `마지막 기록 ${staleDays}일 전. ` : ""}백업해 두세요.</span>
      <button class="btn" data-act="export">기록 내보내기</button></div>` : ""}
    <div class="home" data-view="${HOME_VIEW}">
      <aside class="side">${homeMenuHtml()}</aside>
      <div class="mainpane">
        <button class="backrow" data-act="home-back">${ico("back")}메뉴</button>
        ${homeMainHtml()}
      </div>
    </div>
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
  const gradeBtns = (sub.type === "self"
    ? `<button class="btn primary" data-act="reveal">정답 보기</button>`
    : `<button class="btn primary" data-act="grade">채점하기</button>
       <button class="btn ghost" data-act="reveal">그냥 정답 보기</button>`) +
    `<button class="btn ghost" data-act="q-add-card" title="이 카드에 내 질문 추가">${ico("plus")} 질문</button>`;
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

/* ---------- 내용 체계표: 표에 빈칸을 뚫는다 ----------
   빈칸 하나가 카드 하나다. 자동 채점은 제안이고, 칸을 눌러 판정을 바꿀 수 있다.
   합산과 저장은 고정 코드가 한다. */
const CT_CAT_KO = { "지식⋅이해": "지식·이해", "과정⋅기능": "과정·기능", "가치⋅태도": "가치·태도" };
const CT_CATS = ["지식⋅이해", "과정⋅기능", "가치⋅태도"];
/* 과목마다 외울 범주가 다르다. 영어는 과정·기능만 본다.
   고른 범주만 빈칸이 되고, 나머지는 원문을 펴 둔 채 배경으로 남는다.
   범위 밖 칸은 오늘의 복습에도 안 나온다 (allSubs 에서 걸러진다). */
const CT_SCOPE_DEFAULT = { "영어": ["과정⋅기능"] };
function ctCats(subject) {
  const saved = S.ctScope && S.ctScope[subject];
  const list = saved || CT_SCOPE_DEFAULT[subject] || CT_CATS;
  return new Set(list);
}
function setCtCats(subject, set) {
  S.ctScope = S.ctScope || {};
  S.ctScope[subject] = [...set];
  persist();
}
function ctCatCount(quiz, cat) {
  return quiz.questions.reduce((t, q) => t + q.subs.filter(s => s.ct.cat === cat).length, 0);
}

function ctScopeHtml(quiz) {
  const on = ctCats(quiz.range);
  return `<div class="ctscope">
    <div class="cs-head"><b>무엇을 외울까</b><span>고른 범주만 빈칸이 돼요. 이 과목에 저장돼요</span></div>
    <div class="cs-row">${CT_CATS.map(c => {
      const n = ctCatCount(quiz, c);
      if (!n) return "";
      return `<button class="ck" data-act="ct-cat" data-cat="${esc(c)}"
        aria-pressed="${on.has(c)}">${esc(CT_CAT_KO[c])}<span class="n">${n}</span></button>`;
    }).join("")}</div>
  </div>`;
}

function ctTableHtml(quiz, q, qi) {
  const byNo = new Map(q.subs.map((s, si) => [s.no, { s, si }]));
  const cols = q.ct.cols;
  const cats = ctCats(quiz.range);
  const blank = (no) => {
    const e = byNo.get(no); if (!e) return "";
    // 범위 밖 범주는 문제가 아니라 배경이다. 원문을 그대로 펴 둔다
    if (!cats.has(e.s.ct.cat)) return `<div class="ctoff">${esc(e.s.answer)}</div>`;
    const id = subId(quiz, q, e.s);
    const l = latest(id);
    return `<div class="ctb" data-sid="${esc(id)}" data-ans="${esc(e.s.answer)}">
      <input type="text" class="ctin" aria-label="내용 요소 빈칸" autocomplete="off" spellcheck="false">
      <button class="ctmark" data-act="ct-mark" aria-label="판정 바꾸기"
        >${l ? (l.r === "O" ? "O" : l.r === "X" ? "X" : "△") : ""}</button>
      <span class="ctans"></span></div>`;
  };
  /* 지식·이해 아래 하위 구분이 없는 과목이 있다 (음악·미술 등). 그 표에선 열을 아예 뺀다 */
  const hasSub = q.ct.rows.some(r => r.sub);
  const rows = q.ct.rows.map(r => {
    const cells = r.cells.map(c =>
      `<td colspan="${c.span}">${c.ids.map(blank).join("")}</td>`).join("");
    return `<tr><th class="ctcat">${esc(CT_CAT_KO[r.cat] || r.cat)}</th>
      ${hasSub ? `<th class="ctsub">${esc(r.sub || "")}</th>` : ""}${cells}</tr>`;
  }).join("");
  return `
    <section class="q-card ct-card" data-qi="${qi}">
      <div class="q-head"><span class="qno">${esc(q.title)}</span>
        <span class="qpts">빈칸 ${q.subs.length}</span></div>
      <div class="q-frame">${esc(q.frame)}</div>
      ${q.ct.ideas.length ? `<details class="ct-ideas"><summary>핵심 아이디어 ${q.ct.ideas.length}</summary>
        <ul>${q.ct.ideas.map(i => `<li>${esc(i)}</li>`).join("")}</ul></details>` : ""}
      <div class="ct-scroll"><table class="ctt">
        <thead><tr><th></th>${hasSub ? "<th></th>" : ""}
          ${cols.map(c => `<th>${esc(c.label)}</th>`).join("")}</tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div class="ct-acts">
        <button class="btn primary" data-act="ct-grade">채점하기</button>
        <button class="btn ghost" data-act="ct-reveal">그냥 정답 보기</button>
        <span class="ct-score"></span>
        <span class="ct-tip">엔터는 아래 칸, 방향키는 상하좌우</span>
      </div>
    </section>`;
}

/* ---------- 표 빈칸 사이 이동 (엔터 = 아래 칸, 방향키 = 상하좌우) ----------
   colspan·한 칸에 빈칸 여러 개가 섞여 있어 표 모델로는 위치가 안 잡힌다.
   그래서 화면에 그려진 좌표로 "보이는 대로" 옆 칸을 찾는다. */
function ctNext(from, dir) {
  const card = from.closest(".ct-card");
  if (!card) return null;
  const all = [...card.querySelectorAll("input.ctin")];
  if (all.length < 2) return null;
  const r0 = from.getBoundingClientRect();
  const vert = dir === "up" || dir === "down";
  const cands = [];
  for (const el of all) {
    if (el === from) continue;
    const r = el.getBoundingClientRect();
    /* 칸마다 너비가 달라 중심점으로 재면 같은 열이 옆 열로 잡힌다. 그래서 가장자리로 잰다.
       main = 가려는 쪽으로 벌어진 틈, cross = 줄(열)이 어긋난 정도 */
    const main = dir === "down" ? r.top - r0.bottom
      : dir === "up" ? r0.top - r.bottom
      : dir === "right" ? r.left - r0.right
      : r0.left - r.right;
    const cross = vert ? Math.abs(r.left - r0.left) : Math.abs(r.top - r0.top);
    if (main > -2) cands.push({ el, main, cross });   // 겹치는 칸(같은 줄)은 후보가 아니다
  }
  if (!cands.length) {
    // 맨 아래에서 엔터를 치면 오른쪽 열 맨 위로 넘어간다 (열 단위로 채워 나가게)
    if (dir !== "down") return null;
    const right = all.map(el => ({ el, r: el.getBoundingClientRect() }))
      .filter(o => o.r.left > r0.left + 6);
    if (!right.length) return null;
    const minX = Math.min(...right.map(o => o.r.left));
    return right.filter(o => o.r.left <= minX + 6)
      .reduce((a, b) => (b.r.top < a.r.top ? b : a)).el;
  }
  // 가장 가까운 한 줄을 먼저 고르고, 그 줄 안에서 열이 제일 잘 맞는 칸으로 간다
  const minMain = Math.min(...cands.map(c => c.main));
  const tol = vert ? Math.max(10, from.offsetHeight * 0.9)
                   : Math.max(10, from.offsetWidth * 0.4);
  return cands.filter(c => c.main <= minMain + tol)
    .reduce((a, b) => (b.cross < a.cross ? b : a)).el;
}
function ctMove(from, dir) {
  const el = ctNext(from, dir);
  if (!el) return;
  el.focus();
  const at = dir === "right" ? 0 : el.value.length;   // 오른쪽으로 넘어갈 땐 글 맨 앞에 커서
  try { el.setSelectionRange(at, at); } catch (_) {}
}

/* ---------- 표 빈칸 오답 유형 진단 ----------
   표의 오답은 서술형과 갈래가 다르다. 말이 미묘하게 어긋난 것과,
   내용은 아는데 **자리**를 잘못 짚은 것(학년군·영역 바꿔 쓰기)이 갈려야 한다.
   자리 바꿈은 글자가 똑같으므로 고정 코드가 먼저 확실히 잡고, 해석만 AI에 맡긴다. */
const CT_ERR_KO = {
  ok_form: "표기 차이", partial: "일부만", grade: "학년군 바뀜", area: "영역 바뀜",
  mix: "두 칸 섞임", confuse: "다른 개념", other: "다른 내용", blank: "안 씀"
};

function ctCardCtx(card) {
  const quiz = DATA.find(d => d.id === decodeURIComponent(location.hash.replace(/^#q\//, "").split("/")[0]));
  if (!quiz) return null;
  const q = quiz.questions[+card.dataset.qi];
  if (!q || !q.ct) return null;
  const area = new Map();   // 칸 번호 → 행 이름(영역). 행에만 있고 칸에는 없다
  q.ct.rows.forEach(r => r.cells.forEach(c => c.ids.forEach(id => area.set(id, r.sub || ""))));
  return { quiz, q, area };
}
function ctWhere(s, area) {
  const a = area && area.get(s.no);
  return `${(s.ct.cat || "").replace("⋅", "·")} · ${a ? a + " · " : ""}${s.ct.gr}`;
}

/* 쓴 답이 이 표의 다른 칸 정답과 글자 그대로 같은가 (자리 바꿔 넣기) */
function ctMisplaced(q, sub, val) {
  const n = norm(val);
  if (!n) return null;
  const other = q.subs.find(s => s.no !== sub.no && norm(s.answer) === n);
  if (!other) return null;
  return { t: (other.ct.cat === sub.ct.cat && other.ct.gr !== sub.ct.gr) ? "grade" : "area", ref: other.no, other };
}

function ctNoteEl(b, type, text) {
  let el = b.querySelector(".ctnote");
  if (!el) { el = document.createElement("div"); el.className = "ctnote"; b.appendChild(el); }
  el.innerHTML = `<span class="cttag t-${esc(type)}">${esc(CT_ERR_KO[type] || type)}</span>${text ? " " + esc(text) : ""}`;
}
function ctDiagBox(card) {
  let el = card.querySelector(".ct-diag");
  if (!el) { el = document.createElement("div"); el.className = "ct-diag"; card.appendChild(el); }
  return el;
}
function ctRescore(card) {
  const marks = [...card.querySelectorAll(".ctmark")];
  const okN = marks.filter(m => m.textContent.trim() === "O").length;
  card.querySelector(".ct-score").textContent = `${marks.length}칸 중 ${okN}칸`;
}

async function aiJudgeTable(topic, cells, asked) {
  let res;
  try {
    res = await fetch(AI_FN_URL, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: AI_FN_KEY, Authorization: "Bearer " + AI_FN_KEY },
      body: JSON.stringify({ type: "grade_table", topic, cells, asked })
    });
  } catch { throw new Error("서버 연결 안 됨"); }
  const text = await res.text();
  if (!res.ok) throw new Error("HTTP " + res.status + (res.status === 400 ? " (함수가 옛 버전. grade_table 배포 필요)" : ""));
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("응답 형식 오류"); }
  if (data.error) throw new Error(String(data.error).slice(0, 80));
  return data;
}

async function ctDiagnose(card) {
  const ctx = ctCardCtx(card);
  if (!ctx) return;
  const { quiz, q, area } = ctx;
  const byNo = new Map(q.subs.map(s => [s.no, s]));
  const wrong = [];
  card.querySelectorAll(".ctb.miss").forEach(b => {
    const no = String(b.dataset.sid).split("|").pop();
    const sub = byNo.get(no);
    if (!sub) return;
    const val = b.querySelector(".ctin").value.trim();
    wrong.push({ b, no, sub, val, mis: ctMisplaced(q, sub, val) });
  });
  if (!wrong.length) return;

  /* 1) 고정 코드가 확실히 아는 것부터 (AI가 꺼져 있어도, 실패해도 남는다) */
  for (const w of wrong) {
    if (!w.val) { ctSaveErr(w, { t: "blank", w: "", n: "" }); continue; }
    if (!w.mis) continue;
    const note = `${ctWhere(w.mis.other, area)} 칸의 내용이에요`;
    ctNoteEl(w.b, w.mis.t, note);
    ctSaveErr(w, { t: w.mis.t, r: w.mis.ref, w: w.val, n: note });
  }

  const box = ctDiagBox(card);
  const asked = wrong.filter(w => w.val);
  if (!asked.length) { box.remove(); return; }
  if (!aiOn()) { box.innerHTML = `<div class="cd-sum">AI 진단이 꺼져 있어요. 자리를 바꿔 쓴 것만 표시했어요</div>`; return; }

  /* 2) 나머지 해석은 AI. 표 전체를 같이 보내야 "어느 칸의 내용인지"를 짚을 수 있다 */
  box.innerHTML = `<div class="cd-sum">${ico("spark")} 오답을 보는 중</div>`;
  try {
    const data = await aiJudgeTable(
      `${quiz.range} · ${q.title}`,
      q.subs.map(s => ({ no: s.no, cat: (s.ct.cat || "").replace("⋅", "·"), area: area.get(s.no) || "", gr: s.ct.gr, ans: s.answer })),
      asked.map(w => ({ no: w.no, val: w.val, hint: w.mis ? `${w.mis.ref}번 칸의 정답과 글자가 같음` : "" }))
    );
    const byId = new Map(wrong.map(w => [w.no, w]));
    const lines = [];
    for (const it of (data.items || [])) {
      const w = byId.get(String(it.no));
      if (!w) continue;
      const type = CT_ERR_KO[it.type] ? it.type : "other";
      const note = (it.note || "").trim();
      ctNoteEl(w.b, type, note);
      /* 판정 제안은 AI, 합산·저장은 고정 코드 (칸을 눌러 언제든 바꿀 수 있다) */
      const r = it.verdict === "good" ? "O" : it.verdict === "partial" ? "T" : "X";
      const mark = r === "O" ? "O" : r === "T" ? "△" : "X";
      w.b.querySelector(".ctmark").textContent = mark;
      w.b.classList.toggle("hit", r === "O");
      w.b.classList.toggle("miss", r !== "O");
      ctSaveErr(w, { t: type, r: String(it.ref || ""), w: w.val, n: note }, r);
      lines.push({ ans: w.sub.answer, val: w.val, type, note, where: ctWhere(w.sub, area) });
    }
    ctRescore(card);
    box.innerHTML =
      `<div class="cd-sum">${ico("spark")} <b>AI 오답 노트</b> ${esc(data.summary || "")}</div>` +
      (lines.length ? `<ul class="cd-list">${lines.map(l => `<li>
        <span class="cttag t-${esc(l.type)}">${esc(CT_ERR_KO[l.type])}</span>
        <b>${esc(l.ans)}</b> <span class="cd-where">${esc(l.where)}</span>
        <div class="cd-mine">내가 쓴 것: ${esc(l.val)}${l.note ? " · " + esc(l.note) : ""}</div></li>`).join("")}</ul>` : "");
  } catch (e) {
    box.innerHTML = `<div class="cd-sum">AI 진단 실패(${esc(e && e.message ? e.message : "오류")}). 자리를 바꿔 쓴 것만 표시했어요</div>`;
  }
}

/* 오답 유형을 기록에 남긴다. 이 기록이 오답 노트이자, 나중에 "자주 틀리는 칸만 빈칸" 의 재료다 */
function ctSaveErr(w, err, r) {
  record(w.b.dataset.sid, r || "X", null, r === "O" ? null : [w.sub.answer], "", err);
}

/* ---------- 퀴즈 페이지 (전체 보기) ---------- */
function quizCardsHtml(quiz, weakOnly, pred) {
  if (quiz.kind === "ct") {
    return quiz.questions.map((q, qi) => {
      if (!weakOnly && !pred) return ctTableHtml(quiz, q, qi);
      const keep = q.subs.filter(s => {
        const id = subId(quiz, q, s);
        return (!weakOnly || isWeak(id)) && (!pred || pred(id));
      });
      if (!keep.length) return "";
      return ctTableHtml(quiz, { ...q, subs: keep }, qi);
    }).join("");
  }
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
    ${quiz.kind === "ct" ? ctScopeHtml(quiz) : ""}
    ${(quiz.rules && quiz.rules.length) ? `<details class="rules"><summary>답안 규칙 (기출 채점 방식)</summary>
      <ul>${quiz.rules.map(r => `<li>${esc(r)}</li>`).join("")}</ul>
    </details>` : ""}
    ${qCards || '<div class="empty">다시 볼 소문항이 없어요. 전부 O!</div>'}`;
  window.scrollTo(0, 0);
}

/* ---------- 오답 모아보기 ---------- */
let WRONG_FILTER = "all"; // all | 1 | 2 | 3(=3번 이상), 질문 단위 틀린 횟수 기준
function wrongTimes(id) { return history(id).filter(r => r.r !== "O").length; }
function wfMatchN(n) {
  if (WRONG_FILTER === "all") return true;
  return WRONG_FILTER === "3" ? n >= 3 : n === +WRONG_FILTER;
}
/* 질문 단위 목록: 오답 브라우징·뽀개기의 공통 원천.
   cnt = 태어난 계기(세션 틀림) + 뽀개기 다시 쌓기 횟수, ok = 뽀개기에서 맞춘 분류 */
function myqOf(sid) { return (S.myq && S.myq[sid]) || []; }
function questionEntries(quizId) {
  const out = [];
  for (const x of allSubs()) {
    if (quizId && x.quiz.id !== quizId) continue;
    const my = myqOf(x.id);
    const weak = isWeak(x.id);
    if (!weak && !my.length) continue; // 오답이거나 내 질문이 있는 카드만
    const l = latest(x.id);
    let rqs = l && l.rq;
    if (typeof rqs === "string" && rqs) rqs = [{ q: rqs }];
    const push = (it, seed) => {
      it.key = crushKey(it);
      it.seed = seed; // 태어난 계기의 틀림 횟수 (드릴 틀림은 qstat.w에 쌓임)
      const st = qstat(it.key);
      it.cnt = st.w + seed;
      it.ok = !!st.ok;
      out.push(it);
    };
    if (weak) {
      if (Array.isArray(rqs) && rqs.length) {
        for (const r of rqs) push({ src: "rq", sid: x.id, title: x.q.title, q: r.q || "", n: r.n || "", k: Array.isArray(r.k) ? r.k : [], model: x.sub.answer }, 1);
      } else {
        push({ src: "full", sid: x.id, title: x.q.title, q: x.q.title + " 전체 인출", n: "", k: [], groups: x.sub.groups || null, model: x.sub.answer }, Math.max(1, wrongTimes(x.id)));
      }
    }
    for (const r of my) push({ src: "my", sid: x.id, title: x.q.title, q: r.q || "", n: "", k: Array.isArray(r.k) ? r.k : [], model: x.sub.answer }, 0);
  }
  return out;
}
function qaAnswerHtml(it) {
  // 항목별 한 줄씩: 그룹 카드면 그룹 이름 목록, 재질문이면 대상+키워드
  const lines = [];
  if (it.n) lines.push(it.n);
  if (it.k && it.k.length) lines.push(it.k.join(" · "));
  if (!lines.length && it.groups) for (const g of it.groups) lines.push(g.name);
  if (!lines.length) lines.push((it.model || "").split("\n")[0].slice(0, 90));
  return lines.length > 1
    ? lines.map(l => `<div>· ${esc(l)}</div>`).join("")
    : esc(lines[0]);
}
function renderWrong() {
  const allEnts = questionEntries(null);
  const dist = { 1: 0, 2: 0, 3: 0 };
  for (const it of allEnts) dist[it.cnt >= 3 ? 3 : it.cnt] = (dist[it.cnt >= 3 ? 3 : it.cnt] || 0) + 1;
  const filters = [["all", `전체 ${allEnts.length}`], ["1", `1번 ${dist[1] || 0}`], ["2", `2번 ${dist[2] || 0}`], ["3", `3번+ ${dist[3] || 0}`]];

  const qaRow = it => `
    <tr class="${it.ok ? "qdone" : ""}" data-sid="${esc(it.sid)}" data-src="${esc(it.src)}"${it.src === "full" ? "" : ` data-oq="${esc(it.q)}"`}>
      <td class="qa-c"><input type="checkbox" class="qsel" data-key="${esc(it.key)}"></td>
      <td class="qa-q">${it.ok ? "✓ " : ""}${esc(it.q)}
        ${it.cnt ? `<span class="wl-qn">${it.cnt}회 틀림</span>` : ""}
        ${it.src === "my" ? `<span class="chip">내 질문</span>` : ""}</td>
      <td class="qa-a"><span class="veil" data-act="qa-toggle">${qaAnswerHtml(it)}</span></td>
      <td class="qa-x">${it.src === "full" ? "" : `<button class="ibtn" data-act="q-edit" title="질문·답 수정">${ico("pen")}</button>
        <button class="ibtn" data-act="q-del" title="질문 삭제">${ico("x")}</button>`}</td>
    </tr>`;

  const sections = [];
  let count = 0;
  for (const quiz of DATA) {
    const ents = questionEntries(quiz.id).filter(it => wfMatchN(it.cnt));
    if (!ents.length) continue;
    count += ents.length;
    // 카드별로 묶어 질문|답 표로
    const byCard = new Map();
    for (const it of ents) {
      if (!byCard.has(it.sid)) byCard.set(it.sid, { title: it.title, list: [] });
      byCard.get(it.sid).list.push(it);
    }
    const rows = [...byCard.entries()].map(([sid, c]) => `
      <div class="wl-card" data-sid="${esc(sid)}">
        <div class="wl-head"><span class="wl-t">${esc(c.title)}</span>
          <button class="ibtn" data-act="q-add" title="질문 추가">${ico("plus")}</button></div>
        <table class="qa"><tbody>${c.list.map(qaRow).join("")}</tbody></table>
      </div>`);
    const cc = crushCounts(quiz.id);
    const sv = loadCrush();
    const resume = sv && sv.quiz === quiz.id;
    sections.push(
      `<details class="wrong-sec">
        <summary><span class="ws-name">${esc(quiz.subject)} · ${esc(quiz.range || quiz.title)}</span>
          <span class="ws-meta">${quiz.mode === "review" ? "복습" : "기출"} · ${ents.length}개</span></summary>
        <div class="ws-body">
          <div class="wl-btns">
            ${resume ? `<button class="btn primary" data-act="crush-resume">${ico("bolt")} 이어서 뽀개기 (남은 ${sv.pile.length})</button>
                        <button class="btn ghost" data-act="crush-start" data-quiz="${esc(quiz.id)}">처음부터</button>`
              : cc.rem ? `<button class="btn primary" data-act="crush-start" data-quiz="${esc(quiz.id)}">${ico("bolt")} 오답 뽀개기 시작 (${cc.rem})</button>` : ""}
            <button class="btn ghost" data-act="crush-selected" data-quiz="${esc(quiz.id)}">체크한 것만 뽀개기</button>
            ${cc.all > cc.rem ? `<button class="btn ghost" data-act="crush-start" data-quiz="${esc(quiz.id)}" data-all="1">맞춘 ${cc.all - cc.rem}개 포함해 시작</button>` : ""}
          </div>
          <div class="wl-hint">답 칸은 가려져 있어요. 커서를 대거나 탭하면 보여요.</div>
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
  return questionEntries(quizId).filter(it => wfMatchN(it.cnt) && (includeMastered || !it.ok));
}
function crushCounts(quizId) {
  const all = buildCrushItems(quizId, true);
  return { all: all.length, rem: all.filter(it => !it.ok).length };
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
        ${(() => {
          const n = qstat(crushKey(it)).w + (typeof it.seed === "number" ? it.seed : 1);
          return n ? `<span class="lastmark m-X">이 질문 ${n}회 틀림</span>` : `<span class="lastmark m-new">내 질문</span>`;
        })()}</div>
      <div class="q-head"><span class="qno">${esc(it.q)}</span></div>
      ${inner}
    </section>`;
  const ta = document.getElementById("crushTa");
  if (ta) ta.focus();
  window.scrollTo(0, 0);
}

/* ---------- 세션 (한 장씩, 10카드 라운드. Brainscape·Anki 패턴) ---------- */
let SESSION = null;
const ROUND = 10;

function startSession(mode, scope) {
  const queue = buildQueue(mode, scope);
  if (!queue.length) return false;
  SESSION = { queue, scope: scope || null, mode, idx: 0, round: [], results: { O: 0, T: 0, X: 0 }, wrong: new Set() };
  if (location.hash === "#today") renderSession();
  else location.hash = "#today";
  return true;
}

function renderSession() {
  /* 새로고침으로 SESSION을 잃으면 범위 없이 복습 전체로 되살린다 */
  if (!SESSION) SESSION = { queue: buildQueue("today"), scope: null, mode: "today", idx: 0, round: [], results: { O: 0, T: 0, X: 0 }, wrong: new Set() };
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
      ${q.body ? `<details class="ctx" open><summary>지문·자료</summary><div class="q-body md">${md(q.body)}</div></details>` : ""}
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
  const wrongN = SESSION.wrong ? SESSION.wrong.size : 0;
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
      ${finished && wrongN ? `<p class="cp-goal">틀린 ${wrongN}장은 놓친 것만 다시 물어요</p>` : ""}
      <div class="cp-actions">
        ${finished ? "" : `<button class="btn primary big" data-act="next-round">다음 라운드 (남은 ${left}장)</button>`}
        ${finished && wrongN ? `<button class="btn primary big" data-act="retry-wrong">틀린 것 ${wrongN}장 다시</button>` : ""}
        <button class="btn ghost" data-act="quit-session">오늘은 여기까지</button>
      </div>
    </div>`;
  window.scrollTo(0, 0);
}

/* ---------- AI 채점(의미 판정) ----------
   역할 분담: 판정 결과의 합산(O/△/X)은 언제나 고정 코드(suggestFrom).
   AI는 "문자 일치에 실패한 키워드가 의미상으로는 들어 있는가"라는 해석만 맡는다. */
async function aiJudgeKeywords(topic, model, names, matched, input, question) {
  let res;
  try {
    res = await fetch(AI_FN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: AI_FN_KEY,
        Authorization: "Bearer " + AI_FN_KEY
      },
      body: JSON.stringify({ type: "grade_keywords", topic, model, names, matched, answer: input, ...(question ? { question } : {}) })
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
  if (act === "start-session" || act === "start-chronic" || act === "start-scope") {
    const scope = act === "start-scope" ? (btn.dataset.scope || null) : null;
    const mode = act === "start-chronic" ? "chronic" : (btn.dataset.mode || "today");
    startSession(mode, scope);
    return;
  }
  if (act === "retry-wrong") {
    /* 한 바퀴 돌고 그날 틀린 것만 다시. 판정이 O가 아니라서 집중 인출이 걸린다.
       AI가 만든 재질문(rq)이 있으면 놓친 요소만 다시 묻는다 */
    const ids = SESSION ? [...SESSION.wrong] : [];
    if (!ids.length) return;
    const q = allSubs().filter(x => ids.includes(x.id)).map(x => ({ ...x, st: subState(x.id) }));
    SESSION = { queue: q, scope: null, mode: "retry", idx: 0, round: [], results: { O: 0, T: 0, X: 0 }, wrong: new Set() };
    renderSession();
    return;
  }
  if (act === "home-go") {
    HOME_SEL = btn.dataset.sel;
    HOME_VIEW = "detail";
    renderHome();
    return;
  }
  if (act === "home-back") { HOME_VIEW = "menu"; renderHome(); return; }
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
      aiJudgeKeywords(it.title, it.model || "", [it.n || it.q], [], val, it.q).then(d => {
        if (!CRUSH || CRUSH.pile[0] !== snap) return; // 그새 종료·이동했으면 무시
        const r = (d.results || [])[0];
        const verdict = r ? (r.verdict || (r.found ? "good" : "missed")) : "missed";
        CRUSH.checking = false;
        if (verdict === "good") crushPass(snap);
        else { CRUSH.reveal = true; CRUSH.aiNote = (r && r.note) || ""; }
        renderCrush();
      }).catch(err => {
        if (!CRUSH || CRUSH.pile[0] !== snap) return;
        CRUSH.checking = false; CRUSH.reveal = true;
        CRUSH.aiNote = "AI 판정 실패(" + (err && err.message ? err.message : "오류") + "). 직접 판정해 주세요.";
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
  if (act === "crush-selected") {
    e.preventDefault();
    const sec = btn.closest(".ws-body");
    const keys = new Set([...sec.querySelectorAll(".qsel:checked")].map(c => c.dataset.key));
    if (!keys.size) { alert("먼저 질문 왼쪽의 체크박스를 선택해 주세요."); return; }
    const items = buildCrushItems(btn.dataset.quiz, true).filter(it => keys.has(it.key));
    if (!items.length) return;
    CRUSH = { quiz: btn.dataset.quiz, pile: items, total: items.length, done: 0, reveal: false, lastVal: "", aiNote: "", chips: null };
    saveCrush();
    location.hash = "#crush";
    return;
  }
  if (act === "qa-toggle") { btn.classList.toggle("show"); return; }
  /* 오답 질문 편집: 기록(latest.rq)을 직접 고친다. 편집 내용도 계정 동기화에 실린다 */
  if (act === "q-edit" || act === "q-add") {
    const isAdd = act === "q-add";
    let sid, q = "", kstr = "", src = "my"; // 새 질문은 언제나 내 질문으로
    if (isAdd) sid = btn.closest(".wl-card").dataset.sid;
    else {
      const row = btn.closest("tr");
      sid = row.dataset.sid; q = row.dataset.oq || ""; src = row.dataset.src || "rq";
      let r;
      if (src === "my") r = myqOf(sid).find(x => (x.q || "") === q);
      else { const l = latest(sid); r = (Array.isArray(l && l.rq) ? l.rq : []).find(x => (x.q || "") === q); }
      kstr = r && Array.isArray(r.k) ? r.k.join(" · ") : "";
    }
    const editor = `<tr class="q-editrow" data-sid="${esc(sid)}" data-oq="${esc(isAdd ? "" : q)}" data-src="${esc(src)}">
      <td class="qa-c"></td>
      <td colspan="3">
        <textarea class="qe-q" placeholder="질문">${esc(q)}</textarea>
        <input class="qe-k" placeholder="정답 키워드 (· 또는 쉼표로 구분, 같은 뜻 표기 여러 개 가능)" value="${esc(kstr)}">
        <div class="qe-btns">
          <button class="btn ghost" data-act="q-cancel">취소</button>
          <button class="btn primary" data-act="q-save">저장</button>
        </div>
      </td></tr>`;
    if (isAdd) btn.closest(".wl-card").querySelector("tbody").insertAdjacentHTML("beforeend", editor);
    else btn.closest("tr").outerHTML = editor;
    return;
  }
  if (act === "q-cancel") { renderWrong(); return; }
  if (act === "q-save") {
    const row = btn.closest("tr");
    const sid = row.dataset.sid, oq = row.dataset.oq, src = row.dataset.src;
    const q = row.querySelector(".qe-q").value.trim();
    const k = row.querySelector(".qe-k").value.split(/[·,;|/]/).map(s => s.trim()).filter(s => s.replace(/\s/g, "").length >= 2);
    if (!q) { alert("질문을 입력해 주세요."); return; }
    if (src === "my") {
      S.myq = S.myq || {};
      const arr = S.myq[sid] || (S.myq[sid] = []);
      if (oq) {
        const i = arr.findIndex(x => (x.q || "") === oq);
        if (i >= 0) arr[i] = { q, k };
      } else arr.push({ q, k });
    } else {
      const l = latest(sid);
      if (!l) return;
      if (typeof l.rq === "string") l.rq = l.rq ? [{ q: l.rq, n: "", k: [] }] : [];
      if (!Array.isArray(l.rq)) l.rq = [];
      const i = l.rq.findIndex(x => (x.q || "") === oq);
      if (i >= 0) l.rq[i] = { n: l.rq[i].n || "", q, k };
    }
    if (oq && oq !== q) { // 질문 문구가 바뀌면 질문 통계도 따라간다
      const okey = sid + "|" + oq, nkey = sid + "|" + q;
      if (QSTAT[okey]) { QSTAT[nkey] = QSTAT[okey]; delete QSTAT[okey]; }
    }
    saveQstat();
    renderWrong();
    return;
  }
  if (act === "q-del") {
    const row = btn.closest("tr");
    const sid = row.dataset.sid, oq = row.dataset.oq, src = row.dataset.src;
    if (!confirm("이 질문을 삭제할까요?")) return;
    if (src === "my") {
      const arr = (S.myq && S.myq[sid]) || [];
      const i = arr.findIndex(x => (x.q || "") === oq);
      if (i >= 0) arr.splice(i, 1);
      if (!arr.length && S.myq) delete S.myq[sid];
    } else {
      const l = latest(sid);
      if (l && Array.isArray(l.rq)) {
        const i = l.rq.findIndex(x => (x.q || "") === oq);
        if (i >= 0) l.rq.splice(i, 1);
        if (!l.rq.length) delete l.rq;
      }
    }
    delete QSTAT[sid + "|" + oq];
    saveQstat();
    renderWrong();
    return;
  }
  if (act === "crush-resume") { CRUSH = loadCrush(); if (CRUSH) location.hash = "#crush"; return; }
  if (act === "crush-quit") { CRUSH = null; return; /* 진행 상태는 저장돼 있고 href="#wrong"가 라우팅 */ }
  if (act === "ct-cat") {
    const quiz = DATA.find(d => d.id === decodeURIComponent(location.hash.replace(/^#q\//, "").split("/")[0]));
    if (!quiz) return;
    const set = ctCats(quiz.range);
    const c = btn.dataset.cat;
    set.has(c) ? set.delete(c) : set.add(c);
    if (!set.size) return;   // 하나는 켜 둔다. 다 끄면 풀 게 없다
    setCtCats(quiz.range, set);
    renderQuiz(quiz.id, false);
    return;
  }
  if (act === "ct-grade" || act === "ct-reveal") {
    const card = btn.closest(".ct-card");
    const reveal = act === "ct-reveal";
    let ok = 0, all = 0;
    card.querySelectorAll(".ctb").forEach(b => {
      const inp = b.querySelector(".ctin");
      const ans = b.dataset.ans;
      const hit = norm(inp.value) !== "" && norm(inp.value) === norm(ans);
      all++;
      if (hit) ok++;
      b.classList.toggle("hit", hit);
      b.classList.toggle("miss", !hit);
      b.querySelector(".ctmark").textContent = hit ? "O" : "X";
      // 틀렸거나 그냥 보기면 원문을 옆에 편다
      b.querySelector(".ctans").textContent = (!hit || reveal) ? ans : "";
      inp.readOnly = true;
      /* 자동 판정은 제안이다. 합산·저장은 고정 코드가 하고, 칸을 눌러 바꿀 수 있다 */
      if (!reveal) {
        record(b.dataset.sid, hit ? "O" : "X", hit ? "O" : "X", hit ? null : [ans], "");
        bumpGoal();   // 빈칸 하나가 카드 하나이므로 칸마다 센다
      }
    });
    card.classList.add("graded");
    card.querySelector(".ct-score").textContent =
      reveal ? `빈칸 ${all}개` : `${all}칸 중 ${ok}칸${ok === all ? " · 다 맞혔어요" : ""}`;
    if (!reveal) {
      persist();
      ctDiagnose(card);   // 오답 유형 진단: 고정 코드로 자리 바꿈부터, 그다음 AI
    }
    return;
  }
  if (act === "ct-mark") {
    /* 칸 판정 고치기: 모름 → 부분 → 완벽 → 모름. 채점 전에는 누를 게 없다 */
    const b = btn.closest(".ctb");
    if (!b.closest(".ct-card").classList.contains("graded")) return;
    const cur = btn.textContent.trim();
    const next = cur === "X" ? "△" : cur === "△" ? "O" : "X";
    btn.textContent = next;
    b.classList.toggle("hit", next === "O");
    b.classList.toggle("miss", next !== "O");
    if (next !== "O") b.querySelector(".ctans").textContent = b.dataset.ans;
    record(b.dataset.sid, next === "△" ? "T" : next, null, next === "O" ? null : [b.dataset.ans], "");
    persist(); schedulePush();
    const card = b.closest(".ct-card");
    const marks = [...card.querySelectorAll(".ctmark")];
    const okN = marks.filter(m => m.textContent.trim() === "O").length;
    card.querySelector(".ct-score").textContent = `${marks.length}칸 중 ${okN}칸`;
    return;
  }
  if (act === "open-range") {
    /* 영역 하나에 모드가 하나뿐이면 바로 한 장씩 풀기로 들어간다.
       기출·복습 두 벌이면 어느 쪽인지 골라야 하니 시트를 연다. */
    if (btn.dataset.single) {
      const z = DATA.find(d => d.id === btn.dataset.single);
      /* 내용 체계표는 표를 통째로 보고 빈칸을 채우는 화면으로 간다.
         한 장씩 넘기면 표에서 어느 칸이었는지가 사라진다 */
      if (z && z.kind === "ct") { location.hash = "#q/" + z.id; return; }
      startSession("all", "qz:" + btn.dataset.single);
      return;
    }
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
  /* 어느 카드에서든 내 질문 추가 (오답 여부 무관, S.myq에 저장 → 오답 탭에서 관리·뽀개기) */
  if (act === "q-add-card") {
    if (subEl.querySelector(".q-editbox")) return;
    subEl.querySelector(".sub-actions").insertAdjacentHTML("beforebegin", `<div class="q-editbox">
      <textarea class="qe-q" placeholder="질문"></textarea>
      <input class="qe-k" placeholder="정답 키워드 (· 또는 쉼표로 구분, 같은 뜻 표기 여러 개 가능)">
      <div class="qe-btns"><button class="btn ghost" data-act="q-cancel-card">취소</button>
        <button class="btn primary" data-act="q-save-card">저장</button></div></div>`);
    subEl.querySelector(".q-editbox .qe-q").focus();
    return;
  }
  if (act === "q-cancel-card") { subEl.querySelector(".q-editbox")?.remove(); return; }
  if (act === "q-save-card") {
    const box = subEl.querySelector(".q-editbox");
    const q = box.querySelector(".qe-q").value.trim();
    const k = box.querySelector(".qe-k").value.split(/[·,;|/]/).map(s => s.trim()).filter(s => s.replace(/\s/g, "").length >= 2);
    if (!q) { alert("질문을 입력해 주세요."); return; }
    S.myq = S.myq || {};
    (S.myq[subEl.dataset.sid] = S.myq[subEl.dataset.sid] || []).push({ q, k });
    persist();
    box.outerHTML = `<div class="kw-note">내 질문으로 저장했어요. 오답 탭에서 관리와 뽀개기가 돼요.</div>`;
    return;
  }
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
    const saved = subEl.querySelector(".saved-msg");
    if (saved) saved.textContent = "기록됨";
    /* hideHead 카드(단권화)는 기록이 없으면 .sub-head 자체가 없다.
       여기서 만들지 않으면 첫 판정에서 예외가 나고 세션이 다음 카드로 못 넘어간다 */
    let head = subEl.querySelector(".sub-head");
    if (!head) {
      head = document.createElement("div");
      head.className = "sub-head";
      subEl.prepend(head);
    }
    head.querySelector(".dots")?.remove();
    head.insertAdjacentHTML("beforeend", dotsHtml(id));
    // 세션 모드: 골 카운트 + 다음 카드로 자동 진행
    if (SESSION && location.hash === "#today") {
      if (!subEl.dataset.done) {
        subEl.dataset.done = "1";
        bumpGoal();
        SESSION.results[btn.dataset.v]++;
        SESSION.round.push(btn.dataset.v);
        // 그날 틀린 것은 한 바퀴 끝에 재질문으로 다시 묻는다
        if (btn.dataset.v !== "O") (SESSION.wrong = SESSION.wrong || new Set()).add(id);
        else SESSION.wrong?.delete(id);
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
  /* 홈은 2단이라 720px로는 본문이 500px밖에 안 남는다. 읽기 화면(퀴즈·세션)은 720px가 맞다 */
  document.body.dataset.screen = (!location.hash || location.hash === "#") ? "home" : "read";
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
// 표 빈칸 키보드 이동 (한글 조합 중에는 입력기에 양보한다)
document.addEventListener("keydown", e => {
  const t = e.target;
  if (!t.classList || !t.classList.contains("ctin")) return;
  if (e.isComposing || e.keyCode === 229 || e.altKey || e.ctrlKey || e.metaKey) return;
  let dir = null;
  if (e.key === "Enter") dir = e.shiftKey ? "up" : "down";
  else if (e.key === "ArrowDown") dir = "down";
  else if (e.key === "ArrowUp") dir = "up";
  else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
    // 좌우는 글자 사이를 오가야 하니, 커서가 끝에 닿았을 때만 옆 칸으로 넘긴다
    const s = t.selectionStart, n = t.selectionEnd;
    if (s !== n) return;
    if (e.key === "ArrowRight" && s === t.value.length) dir = "right";
    else if (e.key === "ArrowLeft" && s === 0) dir = "left";
  }
  if (!dir) return;
  e.preventDefault();
  ctMove(t, dir);
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
