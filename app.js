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
  /* 원문 모드에서 뚫어 둔 빈칸 병합: 좌표(세트·문서·줄·시작)가 같으면 같은 자리다.
     합집합으로 둔다 — 한쪽에서 지운 것을 여기서 알 길이 없어서, 지움을 따라가면
     다른 기기에서 어제 뚫은 것까지 같이 날아간다. 되살아나면 다시 지우는 쪽이 싸다 */
  if (Array.isArray(remote.won)) {
    const L = (S.won = S.won || []);
    /* 열쇠는 글자에서 나온다(dk·k). 옛 기기가 보내온 자리 열쇠도 받아 두면 wonMigrate 가 옮긴다 */
    const key = b => b.k ? (b.q + "|" + b.dk + "|" + b.k) : (b.q + "|" + b.d + "|" + b.i + "|" + b.s);
    const have = new Set(L.map(key));
    for (const b of remote.won) {
      if (!b || typeof b.s !== "number" || have.has(key(b))) continue;
      have.add(key(b));
      L.push(b);
      added++;
    }
    if (typeof wonBuild === "function") wonBuild();   // 새로 온 빈칸을 카드로 올린다
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
  /* 다른 기기에서 뚫은 빈칸이 딸려 왔을 수 있다. 카드로 올리고 화면도 다시 그린다 */
  wonBuild();
  if (!location.hash || location.hash === "#") renderHome();
  else if (/^#q\/won-/.test(location.hash)) render();
  else updateSyncFoot();
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

/* ---------- 표 빈칸형 (내용 체계표 · 총론 · 창의적 체험활동) ----------
   빈칸 하나가 카드 하나다. 표는 보여주는 방식일 뿐이라 판정은 칸마다 따로 매겨진다.
   파일에는 최소한만 담고(no·a·cat·gr) 나머지는 여기서 채운다.

   내체표는 범주가 지식·이해/과정·기능/가치·태도 셋이지만, 총론·창체는 조항 글이라
   범주가 다르다(용어·숫자·조항). 그래서 범주 목록은 파일이 `cats` 로 들고 온다. */
for (const set of (window.DAJIGI_CT || [])) {
  DATA.push({
    ...set,
    questions: set.questions.map(q => ({
      ...q,
      points: 0,
      frame: q.frame || set.frame || "내용 체계표 · " + set.range,
      body: "",
      /* type "term" 은 parts 로 채점한다 (groups 는 essay 용). 표 안에서 풀든
         오늘의 복습에서 한 장씩 나오든 같은 답으로 판정되게 둘 다 채워 둔다 */
      subs: q.subs.map(s => ({
        no: s.no, type: "term", hideHead: true, points: 0, prompt: "",
        answer: s.a,
        parts: [{ label: [s.cat.replace("⋅", "·"), s.gr].filter(Boolean).join(" · "),
                  accept: [s.a] }],
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
/* val = 그때 내가 쓴 답. 예전에는 판정과 놓친 것만 남겨서, 기록을 나중에 열어도
   "무엇을 어떻게 틀렸는지"를 되짚을 수가 없었다. 길면 잘라 담는다(저장소가 브라우저다) */
function record(id, r, auto, miss, rq, err, val) {
  const h = S.records[id] || (S.records[id] = []);
  const v = typeof val === "string" && val.trim() ? val.trim().slice(0, 500) : undefined;
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
    if (v) last.v = v;
  }
  else h.push({ d: todayStr(), r, a: auto || null, t, ...(m ? { m } : {}), ...(q ? { rq: q } : {}), ...(err ? { x: err } : {}), ...(v ? { v } : {}) });
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
  /* 날짜가 없는 기록(옛 백업을 가져왔을 때)이 하나만 섞여도 toISOString 이 던져서
     홈이 통째로 안 그려진다. 그런 줄은 오늘 것으로 치고 넘어간다 */
  if (isNaN(t.getTime())) return addDays(todayStr(), n);
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
    const cats = quiz.kind === "ct" ? ctCats(quiz) : null;
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
  /* 다시 볼 것 → 복습 순서는 지키되, 각 묶음 안에서는 섞는다.

     ⭐ 오늘의 복습은 **복습만** 다룬다. 새 카드는 여기에 섞지 않는다.
     복습이 밀린 날에도 새 카드가 따라 들어오면 오늘 할 양이 예측이 안 되고,
     "복습 다 했다"는 매듭이 안 지어진다. 새 카드는 '아직 안 함'에서 따로 꺼낸다
     (그쪽은 mode "fresh" 로 들어오고 하루 배정량 newBudget() 을 그대로 쓴다) */
  const relearn = spread(subs.filter(x => x.st.status === "relearn" && x.st.isDue));
  const review = spread(subs.filter(x => x.st.status === "review" && x.st.isDue));
  if (mode === "fresh") {
    return spread(subs.filter(x => x.st.status === "new")).slice(0, newBudget());
  }
  if (mode === "weak") return spread(subs.filter(x => x.st.last && x.st.last.r !== "O"));
  return [...relearn, ...review];
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
/* 기록 id -> 그 카드. id 는 `묶음|문항|빈칸` 이고 묶음 id 에는 | 가 없다 */
function cardOf(id) {
  const bits = String(id).split("|");
  const quiz = DATA.find(z => z.id === bits[0]);
  if (!quiz) return null;
  const q = (quiz.questions || []).find(x => String(x.no) === bits[1]);
  if (!q) return null;
  const sub = (q.subs || []).find(x => String(x.no) === bits[2]);
  return sub ? { quiz, q, sub } : null;
}

/* 그날 남은 줄만 모은다. 한 카드를 여러 번 풀었으면 그 날짜의 줄이 여러 개다 */
function dayRows(day) {
  const out = [];
  for (const [id, h] of Object.entries(S.records)) {
    for (const r of h) {
      const d = r.d || (r.t ? new Date(r.t).toISOString().slice(0, 10) : null);
      if (d === day) out.push({ id, r, card: cardOf(id) });
    }
  }
  return out.sort((a, b) => (a.r.t || 0) - (b.r.t || 0));
}

function vTag(r) {
  const k = r === "O" ? "o" : r === "X" ? "x" : "t";
  return `<span class="dv dv-${k}">${r === "O" ? "O" : r === "X" ? "X" : "△"}</span>`;
}

function dayLogHtml(day) {
  const rows = dayRows(day);
  const [, mo, dy] = day.split("-");
  const n = { O: 0, T: 0, X: 0 };
  rows.forEach(x => n[x.r.r === "O" ? "O" : x.r.r === "X" ? "X" : "T"]++);

  /* 과목 · 범위로 묶는다. 하루에 여러 과목을 건드리므로 안 묶으면 뒤섞여 읽힌다 */
  const groups = new Map();
  for (const x of rows) {
    /* 같은 영역이라도 표 빈칸형과 원문 모드는 따로 묶는다. 범위 이름이 같아서
       안 가르면 한 덩어리로 보인다 */
    const mode = x.card && x.card.quiz.kind === "won" ? " (원문)" : "";
    const key = x.card ? x.card.quiz.subject + " · " + (x.card.quiz.range || x.card.quiz.title) + mode
                       : "찾을 수 없는 카드";
    (groups.get(key) || groups.set(key, []).get(key)).push(x);
  }

  /* 맞힌 것까지 다 펼치면 정작 볼 것(틀린 줄)이 묻힌다. 틀린 것만 펴 두고
     맞힌 것은 접어 둔다. 접힘은 details 라 눌러서 펼 수 있다 */
  const body = [...groups.entries()].map(([key, list]) => {
    const bad = list.filter(x => x.r.r !== "O");
    const ok = list.filter(x => x.r.r === "O");
    /* 내체표 묶음이면 그 과목 표로 건너뛴다. 이 날 틀린 자리가 표 어디였는지는 표에서만 보인다 */
    const ct = list.find(x => x.card && x.card.quiz.kind === "ct");
    return `
    <div class="dgrp"><div class="dgrp-h">${esc(key)}<span>${
      bad.length ? `틀림 ${bad.length} · ` : ""}맞음 ${ok.length}${
      ct ? ` <button class="dgrp-map" data-act="home-go"
        data-sel="ctmap:${esc(ct.card.quiz.id)}">표로 보기</button>` : ""}</span></div>
    ${rowsOf(bad)}
    ${ok.length ? `<details class="dok"><summary>맞힌 것 ${ok.length}장</summary>
      ${rowsOf(ok)}</details>` : ""}</div>`;
  }).join("");

  return `<div class="mhead"><div>
      <button class="btn ghost sm" data-act="home-go" data-sel="st:log">${ico("back")} 기록</button>
      <h2>${+mo}월 ${+dy}일${day === todayStr() ? " (오늘)" : ""}</h2>
      <p>맞음 ${n.O} · 부분 ${n.T} · 모름 ${n.X}</p></div></div>
    ${rows.length ? body : `<p class="mt-empty">이 날은 기록이 없어요.</p>`}`;
}

/* 기록 한 줄들 */
function rowsOf(list) {
  return list.map(x => {
      const c = x.card, r = x.r;
      const name = c ? (c.sub.answer || c.sub.prompt || c.q.title) : x.id;
      const cue = c ? ((c.sub.ct && c.sub.ct.gr) || c.q.title || "") : "";
      const wrong = r.r !== "O";
      /* 표 빈칸은 놓친 것이 곧 정답이라 카드 이름과 같은 말이 두 번 찍힌다. 겹치면 뺀다 */
      const miss = (r.m || []).filter(m => String(m) !== String(name));
      return `<div class="drow${wrong ? " bad" : ""}">
        <div class="drow-h">${vTag(r.r)}<b>${esc(String(name).slice(0, 90))}</b></div>
        ${cue ? `<div class="dcue">${esc(String(cue).slice(0, 90))}</div>` : ""}
        ${r.v ? `<div class="dmine"><span>내가 쓴 답</span>${esc(r.v)}</div>` : ""}
        ${wrong && miss.length ? `<div class="dmiss"><span>놓친 것</span>${
          miss.map(m => esc(String(m))).join(", ")}</div>` : ""}
        ${r.x && r.x.t ? `<div class="dnote2"><span class="cttag t-${esc(r.x.t)}"
          >${esc(CT_ERR_KO[r.x.t] || r.x.t)}</span>${esc(r.x.n || "")}</div>` : ""}
      </div>`;
  }).join("");
}

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

/* 지금 돌고 있는 빌드. 배포 스크립트가 index.html 의 ?v=dev 를 타임스탬프로 바꾼다.
   화면에 찍어 두지 않으면 "고쳤는데 그대로다"가 옛 파일 탓인지 코드 탓인지 가릴 수가 없다.
   실제로 그 때문에 두 번 헛돌았다 (2026-08-17) */
function buildStamp() {
  const src = (document.currentScript && document.currentScript.src) ||
    [...document.scripts].map(s => s.src).find(s => /app\.js/.test(s)) || "";
  const m = src.match(/[?&]v=([^&]+)/);
  const v = m ? decodeURIComponent(m[1]) : "";
  if (!v || v === "dev") return "개발본";
  return v.length >= 12
    ? `${v.slice(4, 6)}/${v.slice(6, 8)} ${v.slice(8, 10)}:${v.slice(10, 12)} 판`
    : v;
}

/* ---------- 판정(고정 코드) ---------- */
function norm(s) {
  return (s || "").toLowerCase()
    .replace(/[\s·⋅ㆍ‧.,()\[\]{}<>『』「」“”‘’"'\-–—_\/\\?!:;~`^*|]/g, "");
}
/* 두 글자열이 얼마나 겹치나 (2-그램 다이스, 0~1). 한 묶음에 못 채운 요소가 여럿일 때
   쓴 것과 가장 닮은 요소를 짝지어, "무엇을 못 썼는지"가 어긋나지 않게 하려고 쓴다 */
function sim2(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const gram = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i + 2); m.set(k, (m.get(k) || 0) + 1); }
    return m;
  };
  const A = gram(a), B = gram(b);
  let hit = 0;
  for (const [k, n] of A) if (B.has(k)) hit += Math.min(n, B.get(k));
  const tot = (a.length - 1) + (b.length - 1);
  return tot > 0 ? (2 * hit) / tot : 0;
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
      won: ["doc", "원문 모드", "원문을 띄워 두고 외울 자리를 직접 뚫는다"],
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
        ${quiz.kind === "won"
          ? `<a class="btn primary" href="#q/${quiz.id}">원문 열기</a>`
          : quiz.kind === "ct"
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
    <div class="sbrand"><h1>암기PT</h1><p>임용 암기 트레이너 · ${esc(buildStamp())}</p></div>
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
    /* 원문 모드의 sub.no 는 글자 해시라 사람이 읽을 것이 못 된다. 보여 줄 번호는 따로 둔다 */
    const sn = x.sub.sn || x.sub.no;
    const nm = x.q.subs.length > 1 ? `${base} <span class="sn">${esc(sn)}</span>` : base;
    const v = x.st.last ? x.st.last.r : null;
    return `<div class="mrow">
      <span class="nm">${nm}<span class="tag">${esc(x.quiz.subject)} · ${esc(rangeOf(x.quiz))}</span></span>
      ${v ? `<span class="vd ${v === "O" ? "o" : v === "X" ? "x" : "t"}">${v === "T" ? "△" : v}</span>` : ""}
    </div>`;
  }).join("");
}

/* 기록이 쌓인 내체표 묶음. 기록 탭 위에 과목 칩으로 놓아 표를 바로 연다.
   날짜 목록은 "그날 무엇을 했나"만 답하고 "어느 자리가 약한가"는 답하지 못한다.
   내체표 오답은 자리를 틀린 것이라 그 답이 필요하고, 답할 수 있는 형태는 표뿐이다 */
function ctLogSubjects() {
  const out = [];
  for (const quiz of DATA) {
    if (quiz.kind !== "ct") continue;
    let n = 0, hot = 0;
    for (const q of quiz.questions) for (const s of q.subs) {
      const { w, lv } = ctHeat(subId(quiz, q, s));
      if (w) n++;
      if (lv) hot++;
    }
    if (n) out.push({ quiz, n, hot });
  }
  return out.sort((a, b) => b.hot - a.hot || b.n - a.n);
}

function homeMainHtml() {
  const sel = HOME_SEL;

  /* 기록 탭 안에서 여는 표. 화면을 옮기지 않고 기록 자리에서 펼친다 */
  if (sel.startsWith("ctmap:")) {
    const quiz = DATA.find(z => z.id === sel.slice(6));
    if (!quiz) return `<p class="mt-empty">표를 찾을 수 없어요.</p>`;
    return `<div class="mhead"><div>
        <button class="btn ghost sm" data-act="home-go" data-sel="st:log">${ico("back")} 기록</button>
        <h2>${esc(quiz.range || quiz.title)} 표</h2>
        <p>틀린 자리에 형광펜이 쌓여요. 칸을 누르면 그때 쓴 답이 나와요</p></div></div>
      ${ctHeatHtml(quiz)}`;
  }

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
      ${(() => {
        const cts = ctLogSubjects();
        if (!cts.length) return "";
        return `<div class="ctmapbar">
          <div class="cs-head"><b>내체표, 표로 보기</b>
            <span>틀린 자리에 형광펜이 쌓여요</span></div>
          <div class="cs-row">${cts.map(c => `<button class="ck" data-act="home-go"
            data-sel="ctmap:${esc(c.quiz.id)}">${esc(c.quiz.range || c.quiz.title)}${
            c.hot ? `<span class="n hot">${c.hot}</span>` : `<span class="n">자국 ${c.n}</span>`}</button>`).join("")}</div>
        </div>`;
      })()}
      ${log.length ? log.map(([d, o]) => {
        const t = o.n || 1;
        const [, mo, dy] = d.split("-");
        return `<button class="mrow click" data-act="home-go" data-sel="day:${d}"
          ><span class="nm">${+mo}월 ${+dy}일${
            d === todayStr() ? `<span class="tag">오늘</span>` : ""}</span>
          <span class="mix" role="img" aria-label="O ${o.O}, 부분 ${o.T}, 모름 ${o.X}">
            <i class="o" style="flex:${o.O}"></i><i class="t" style="flex:${o.T}"></i><i class="x" style="flex:${o.X}"></i></span>
          <span class="cnt">${o.n}장</span></button>`;
      }).join("") : `<p class="mt-empty">아직 기록이 없어요. 카드를 한 장 풀면 여기 남아요.</p>`}`;
  }

  /* 하루치 상세: 그날 무엇을 풀었고, 무엇이라 썼고, 어디서 틀렸는지 */
  if (sel.startsWith("day:")) return dayLogHtml(sel.slice(4));

  /* 과목: 영역 목록 */
  if (sel.startsWith("sj:")) {
    const s = sel.slice(3);
    const ranges = subjectGroups().get(s) || new Map();
    const c = queueCounts(sel);
    const allWon = [...ranges.values()].every(qs => qs.every(q => q.kind === "won"));
    return `<div class="mhead"><div><h2>${esc(s)}</h2>
        <p>${allWon && !c.all
          ? "과목 " + ranges.size + " · 원문에서 외울 자리를 드래그하면 카드가 돼요"
          : "영역 " + ranges.size + " · 카드 " + c.all + "장"}</p></div>
        ${c.relearn + c.review ? `<button class="btn primary" data-act="start-scope" data-scope="${esc(sel)}">복습 ${c.relearn + c.review}장</button>` : ""}</div>
      ${[...ranges.entries()].map(([name, quizzes]) => {
        /* 카드 수는 범위 밖 칸을 뺀 실제 수로 센다 (내체표는 과목마다 범주를 고른다) */
        const rc = queueCounts("ar:" + s + "|" + name);
        /* 원문은 빈칸을 아직 안 뚫었으면 카드가 0장이다. "0장"만 열세 줄 늘어서면
           자료가 안 들어온 것처럼 보이므로, 그때는 몇 쪽짜리 원문인지를 보여 준다 */
        const won = !rc.all && quizzes.every(q => q.kind === "won");
        const pages = won ? quizzes.reduce((a, q) => a + (q.docs ? q.docs.length : 0), 0) : 0;
        return `<button class="mrow click" data-act="open-range" data-range="${esc(name)}"
            data-single="${quizzes.length === 1 ? esc(quizzes[0].id) : ""}">
          <span class="nm">${esc(name)}</span>
          <span class="cnt">${won ? "원문 " + pages + "쪽" : rc.all + "장"}</span>
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
    const line = q.length
      ? `다시 볼 것 ${qc.relearn}장 · 복습 ${qc.review}장`
      : "오늘 복습할 카드를 다 끝냈어요";
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
   범위 밖 칸은 오늘의 복습에도 안 나온다 (allSubs 에서 걸러진다).

   총론·창체는 표가 아니라 조항 글이라 범주가 아예 다르다(용어·숫자·조항).
   그래서 범주 목록은 자료가 `cats` 로 들고 오고, 없으면 내체표의 셋을 쓴다. */
const CT_SCOPE_DEFAULT = { "영어": ["과정⋅기능"] };
function ctAllCats(quiz) { return (quiz && quiz.cats) || CT_CATS; }
function ctCats(quiz) {
  const key = quiz.range;
  const saved = S.ctScope && S.ctScope[key];
  const list = saved || CT_SCOPE_DEFAULT[key] || ctAllCats(quiz);
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
  const on = ctCats(quiz);
  return `<div class="ctscope">
    <div class="cs-head"><b>무엇을 외울까</b><span>고른 범주만 빈칸이 돼요. 이 과목에 저장돼요</span></div>
    <div class="cs-row">${ctAllCats(quiz).map(c => {
      const n = ctCatCount(quiz, c);
      if (!n) return "";
      return `<button class="ck" data-act="ct-cat" data-cat="${esc(c)}"
        aria-pressed="${on.has(c)}">${esc(CT_CAT_KO[c] || c)}<span class="n">${n}</span></button>`;
    }).join("")}</div>
  </div>`;
}

function ctTableHtml(quiz, q, qi) {
  const byNo = new Map(q.subs.map((s, si) => [s.no, { s, si }]));
  const cols = q.ct.cols;
  const cats = ctCats(quiz);
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
      ${q.ct.ideas.length ? `<details class="ct-ideas"><summary>${esc(q.ct.ideaLabel || "핵심 아이디어")} ${q.ct.ideas.length}</summary>
        <ul>${q.ct.ideas.map(i => `<li>${esc(i)}</li>`).join("")}</ul></details>` : ""}
      <div class="ct-scroll"><table class="ctt${q.ct.cueWide ? " ctt-cue" : ""}">
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

/* ---------- 표로 보기 (누적 약점) ----------
   기록을 세로 목록으로만 보면 내체표 오답의 절반이 안 보인다. 대표 실점이 학년군 바뀜·영역
   바뀜, 곧 **자리**를 틀린 것인데 목록에는 자리가 없어서다. 그래서 원래 표에 오답을 도로 얹는다.

   새 데이터는 없다. 틀린 횟수는 기록을 세면 나오고, 그때 쓴 답(v)과 오답 유형·혼동한 칸(x)은
   이미 줄마다 붙어 있다.
   ⚠️ 여기서 AI를 다시 부르지 않는다. 볼 때마다 진단이 달라지면 "같은 답이면 언제나 같은 판정"이
   깨진다. 저장된 진단을 꺼내 보여주기만 한다 (그래서 비용 0, 오프라인에서도 열린다). */

/* 칠할지 말지 = 지금도 약점인가, 얼마나 진할지 = 누적 오답 수.
   누적 하나로만 칠하면 오래 푼 칸이 무조건 진해져서 "많이 푼 표"가 "약한 표"로 읽힌다.
   이미 맞히고 있는 칸은 색을 빼고 자국만 남긴다 */
function ctHeat(id) {
  const h = history(id);
  const w = h.filter(r => r.r !== "O").length;
  return { w, tried: h.length > 0, lv: (w && isWeak(id)) ? Math.min(w, 3) : 0 };
}
/* 칸 번호 -> 영역. ctCardCtx 와 같은 표지만 저쪽은 주소창을 읽어서 쓸 수 없다 */
function ctAreaMap(q) {
  const a = new Map();
  if (q.ct) q.ct.rows.forEach(r => r.cells.forEach(c => c.ids.forEach(id => a.set(id, r.sub || q.title || ""))));
  return a;
}
/* 받침 있으면 "과", 없으면 "와" */
function gwa(s) {
  const t = String(s || "").trim();
  if (!t) return "와";
  const c = t.charCodeAt(t.length - 1);
  return (c >= 0xAC00 && c <= 0xD7A3 && (c - 0xAC00) % 28 > 0) ? "과" : "와";
}

function ctHeatTableHtml(quiz, q, qi) {
  const byNo = new Map(q.subs.map(s => [s.no, s]));
  const cats = ctCats(quiz);
  let wrongN = 0, hotN = 0;
  const cell = (no) => {
    const s = byNo.get(no);
    if (!s) return "";
    if (!cats.has(s.ct.cat)) return `<div class="ctoff">${esc(s.answer)}</div>`;
    const id = subId(quiz, q, s);
    const { w, tried, lv } = ctHeat(id);
    if (lv) hotN++;
    if (w) wrongN++;
    const cls = lv ? " h" + lv : w ? " healed" : tried ? "" : " fresh";
    /* 횟수는 상시 표시. hover 툴팁은 폰에 없어서 그것만 믿으면 모바일에서 안 보인다 */
    const tip = !tried ? "아직 안 푼 칸" : !w ? "틀린 적 없어요"
      : `${w}번 틀렸어요${lv ? "" : " (지금은 맞히는 중)"}`;
    return `<button type="button" class="hcell${cls}" data-act="heat-cell"
      data-sid="${esc(id)}" data-no="${esc(no)}" title="${esc(tip)}">${esc(s.answer)}${
      w ? `<span class="hn">${w}</span>` : ""}</button>`;
  };
  const hasSub = q.ct.rows.some(r => r.sub);
  const rows = q.ct.rows.map(r => {
    const cells = r.cells.map(c => `<td colspan="${c.span}">${c.ids.map(cell).join("")}</td>`).join("");
    return `<tr><th class="ctcat">${esc(CT_CAT_KO[r.cat] || r.cat)}</th>
      ${hasSub ? `<th class="ctsub">${esc(r.sub || "")}</th>` : ""}${cells}</tr>`;
  }).join("");
  const table = `<div class="ct-scroll"><table class="ctt${q.ct.cueWide ? " ctt-cue" : ""}">
      <thead><tr><th></th>${hasSub ? "<th></th>" : ""}
        ${q.ct.cols.map(c => `<th>${esc(c.label)}</th>`).join("")}</tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  /* 깨끗한 표까지 다 펴 두면 정작 볼 표를 찾느라 스크롤을 한참 내린다. 접어 둔다 */
  const body = wrongN
    ? table + `<div class="heat-detail"></div>`
    : `<details class="hclean"><summary>틀린 칸이 없어요 · 표 펼치기</summary>
        ${table}<div class="heat-detail"></div></details>`;
  /* data-quiz: 기록 탭 안에서도 열리므로 주소창(#q/...)을 못 믿는다. 표가 제 묶음을 들고 있게 한다 */
  return `<section class="q-card ct-heat" data-qi="${qi}" data-quiz="${esc(quiz.id)}">
      <div class="q-head"><span class="qno">${esc(q.title)}</span>
        <span class="qpts">${hotN ? `붉은 칸 ${hotN}` : wrongN ? `자국 ${wrongN}` : "깨끗"}</span></div>
      ${body}</section>`;
}

function ctHeatHtml(quiz) {
  return `<div class="heat-lgd">
      <span><i class="h1"></i>1번</span><span><i class="h2"></i>2번</span>
      <span><i class="h3"></i>3번 이상 틀린 칸</span>
      <span class="hl-note">지금 맞히는 칸은 색을 뺐어요. 칸을 누르면 그때 쓴 답이 나와요</span>
    </div>${quiz.questions.map((q, qi) => ctHeatTableHtml(quiz, q, qi)).join("")}`;
}

/* 칸 하나의 시도 이력. 오래된 것이 아래로 가게 뒤집는다 (최근이 먼저 읽혀야 한다) */
function ctHeatDetailHtml(quiz, q, sub, id) {
  const area = ctAreaMap(q);
  const byNo = new Map(q.subs.map(s => [s.no, s]));
  const h = history(id);
  const head = `<div class="hd-head">
      <div><b class="hd-ans">${esc(sub.answer)}</b>
        <span class="hd-where">${esc(ctWhere(sub, area))}</span></div>
      <button class="hd-close" data-act="heat-close" aria-label="닫기">✕</button></div>`;
  if (!h.length) return head + `<p class="hd-none">아직 안 푼 칸이에요.</p>`;
  const rows = h.slice().reverse().map(r => {
    const [, mo, dy] = String(r.d || "").split("-");
    const mine = r.v || (r.x && r.x.w) || "";
    const ref = r.x && r.x.r ? byNo.get(ctNo(r.x.r)) : null;
    return `<li>
      <span class="hd-d">${mo ? `${+mo}/${+dy}` : ""}</span>
      <div>
        <div class="hd-r">${vTag(r.r)}${mine
          ? `<span class="hd-mine">${esc(mine)}</span>`
          : `<span class="hd-mine none">안 씀</span>`}</div>
        ${r.x && r.x.t ? `<div class="hd-x"><span class="cttag t-${esc(r.x.t)}"
          >${esc(CT_ERR_KO[r.x.t] || r.x.t)}</span>${esc(r.x.n || "")}</div>` : ""}
        ${ref && ref.no !== sub.no ? `<div class="hd-link">↖ ${esc(ctWhere(ref, area))} 칸의
          <b>${esc(ref.answer)}</b>${gwa(ref.answer)} 혼동</div>` : ""}
      </div></li>`;
  }).join("");
  const w = h.filter(r => r.r !== "O").length;
  return head + `<p class="hd-sum">${h.length}번 풀어서 ${w}번 틀렸어요</p>
    <ul class="hd-tl">${rows}</ul>`;
}

/* ---------- 표 빈칸 사이 이동 (엔터 = 아래 칸, 방향키 = 상하좌우) ----------
   colspan·한 칸에 빈칸 여러 개가 섞여 있어 표 모델로는 위치가 안 잡힌다.
   그래서 화면에 그려진 좌표로 "보이는 대로" 옆 칸을 찾는다. */
function ctNext(from, dir) {
  const card = from.closest(".ct-card");
  if (!card) return null;
  const all = [...card.querySelectorAll("input.ctin")];
  if (all.length < 2) return null;
  /* ⚠️ 원문 모드는 표가 아니라 흐르는 글이다. 빈칸이 문장 안에 박혀 있어서 줄바꿈 위치가
     화면 너비와 글자 수에 따라 달라진다. 좌표로 "위/아래 칸"을 재면 같은 열이라는 것이
     없으므로 누를 때마다 엉뚱한 데로 튄다. 글에서는 읽는 순서가 곧 칸 순서다 */
  if (card.classList.contains("won-card")) {
    const i = all.indexOf(from);
    return all[i + ((dir === "down" || dir === "right") ? 1 : -1)] || null;
  }
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

/* ---------- 원문 모드 ----------
   표 빈칸형은 내가 미리 정한 자리만 빈칸이다. 원문 모드는 조항 원문을 통째로 띄워 두고
   드래그한 자리를 빈칸으로 삼는다. "여기도 외워야겠다" 싶을 때 자료를 다시 만들지 않고
   그 자리에서 뚫는다.

   빈칸의 열쇠는 (문서 번호, 줄 번호, 시작 글자 위치)다. 원문은 고시본이라 안 바뀌므로
   이 좌표가 안정적이고, 그래서 뚫은 자리의 복습 기록이 흔들리지 않는다.

   화면은 표 빈칸형의 것을 그대로 쓴다(.ct-card · .ctb · .ctin · .ctmark · .ctans).
   그래야 채점·판정 바꾸기·기록·AI 진단이 새 코드 없이 그대로 돈다. */
const WON = window.DAJIGI_WON || [];
let WON_EDIT = false;   // 빈칸 정하기 모드인가

/* ---------- 빈칸의 이름표 (여기가 제일 조심할 자리) ----------
   빈칸의 열쇠를 "몇 번째 문서 · 몇 번째 줄 · 몇 번째 글자"로 잡으면, 원문 자료를 다시 만들어
   문단 하나가 늘거나 오탈자 하나가 고쳐지는 순간 그 뒤 빈칸이 전부 한 칸씩 밀린다. 밀리면
   어제 맞힌 기록이 엉뚱한 자리에 붙고, 자리를 못 찾은 기록은 사라진다. 총론은 고시본이라
   안 바뀌어서 그냥 뒀지만 성취기준·안내서는 도달점에서 계속 다시 만든다.

   그래서 열쇠를 자리가 아니라 **글자**에서 뽑는다.
       dk  문서 이름표 — 빌드가 붙여 준 key (없으면 문서 제목의 해시)
       k   빈칸 이름표 — 줄 해시 : 답 해시 : 그 줄에서 같은 답의 몇 번째
   줄이 위아래로 밀려도, 문서 차례가 바뀌어도 열쇠는 그대로다. 줄 글자 자체가 고쳐지면
   답 글자로 다시 찾아 붙이고(재정착), 그것도 안 되면 기록을 지우지 않고 떼어 둔다. */

/* FNV-1a 32비트. build_dodal_won.py 의 fnv 와 같은 값이 나와야 한다 */
function hash8(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i) & 0xffff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
function wonNorm(x) { return (x || "").replace(/\s+/g, " ").trim(); }
function wonDocKey(doc) { return doc.key || "t" + hash8(wonNorm(doc.title || "")); }

/* 답이 몇 번째로 나온 것인지 센다.
   ⚠️ 한 줄 안에서만 세면 모자란다. 글자가 똑같은 줄이 한 문서에 여럿인 자료가 있어서
   (창체 '2. 영역과 활동'은 같은 꼴의 줄이 열여섯 개다), 줄 안에서만 세면 두 빈칸이
   같은 열쇠를 받아 기록이 한 곳에 섞인다. 그래서 **같은 글자의 줄들을 하나로 이어 놓고**
   그 안에서 몇 번째인지 센다. 줄 차례가 밀려도 이 수는 그대로다. */
function wonOccIn(line, at, ans) {
  let occ = 0, from = 0, p;
  while ((p = line.indexOf(ans, from)) >= 0 && p < at) { occ++; from = p + 1; }
  return occ;
}
function wonCountIn(line, ans) {
  return ans ? wonOccIn(line, line.length + 1, ans) : 0;
}
function wonKey(doc, i, a, b) {
  const line = doc.lines[i] || "";
  const ans = line.slice(a, b);
  const lh = hash8(wonNorm(line));
  let occ = wonOccIn(line, a, ans);
  for (let j = 0; j < i; j++) {
    if (hash8(wonNorm(doc.lines[j])) === lh) occ += wonCountIn(doc.lines[j], ans);
  }
  return lh + ":" + hash8(wonNorm(ans)) + ":" + occ;
}
/* 열쇠가 가리키는 자리를 지금 원문에서 찾는다. 없으면 null */
function wonFind(doc, lh, ans, nth) {
  if (!ans) return null;
  let seen = 0;
  for (let i = 0; i < doc.lines.length; i++) {
    const line = doc.lines[i];
    if (hash8(wonNorm(line)) !== lh) continue;
    let from = 0, p;
    while ((p = line.indexOf(ans, from)) >= 0) {
      if (seen === nth) return { i: i, s: p };
      seen++;
      from = p + 1;
    }
  }
  return null;
}
function wonSid(quizId, b) { return quizId + "|" + b.dk + "|" + b.k; }

/* 두 줄이 얼마나 닮았나(0~1). 자료가 손질돼 낱말 몇 개가 바뀌었을 때,
   같은 답이 든 여러 줄 가운데 옛 줄을 고르는 데만 쓴다 */
function wonSim(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const n = Math.min(a.length, b.length);
  let head = 0;
  while (head < n && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < n - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return (head + tail) / Math.max(a.length, b.length);
}

/* 기록을 옛 열쇠에서 새 열쇠로 옮긴다. 덮어쓰지 않고 합친다 — 양쪽에 쌓여 있을 수 있어서.
   복습 기록(records)·내 질문(myq)·드릴 통계(qstat)를 같이 데려간다 */
function wonMoveRecords(from, to) {
  if (from === to) return 0;
  let moved = 0;
  const src = S.records[from];
  if (src && src.length) {
    const dst = S.records[to] || (S.records[to] = []);
    for (const r of src) if (!dst.some(c => c.t === r.t && c.r === r.r)) dst.push(r);
    dst.sort((x, y) => (x.t || 0) - (y.t || 0));
    moved = src.length;
  }
  delete S.records[from];
  if (S.myq && S.myq[from]) {
    const dst = S.myq[to] || (S.myq[to] = []);
    for (const r of S.myq[from]) if (r && r.q && !dst.some(c => c.q === r.q)) dst.push(r);
    delete S.myq[from];
  }
  if (S.qstat) {
    for (const k of Object.keys(S.qstat)) {
      if (k !== from && !k.startsWith(from + "|")) continue;
      const nk = to + k.slice(from.length);
      const cur = S.qstat[nk], v = S.qstat[k];
      S.qstat[nk] = cur
        ? { w: Math.max(cur.w || 0, v.w || 0), ok: Math.max(cur.ok || 0, v.ok || 0) }
        : v;
      delete S.qstat[k];
    }
  }
  return moved;
}

/* 옛 빈칸(자리로 잡아 둔 것)에 이름표를 달아 준다. 총론 원문에 뚫어 둔 것들이고,
   다른 기기에서 옛 모양으로 올라온 것도 여기로 들어온다. 기록도 새 열쇠로 옮긴다 */
function wonMigrate() {
  let done = 0;
  for (const b of wonList()) {
    if (b.k) continue;
    const set = WON.find(x => x.id === b.q);
    const doc = set && set.docs.find(d => d.no === b.d);
    if (!doc || !doc.lines[b.i]) {
      /* 자료가 사라진 빈칸. 기록은 그대로 두고 떼어 둔 것으로만 표시한다 */
      b.dk = "d" + b.d;
      b.k = "lost:" + hash8(String(b.d) + ":" + b.i + ":" + b.s) + ":0";
      b.o = 1;
      done++;
      continue;
    }
    const line = doc.lines[b.i];
    const e = typeof b.e === "number" ? b.e : b.s;
    b.a = line.slice(b.s, e);
    b.ln = line.slice(0, 200);
    b.dt = doc.title;
    b.dk = wonDocKey(doc);
    b.k = wonKey(doc, b.i, b.s, e);
    wonMoveRecords(b.q + "|" + b.d + "|" + b.i + "_" + b.s, wonSid(b.q, b));
    done++;
  }
  return done;
}

/* 저장된 빈칸을 지금 실린 원문에 다시 붙인다. 자료를 새로 빌드한 뒤에도 기록이 따라오게 하는 자리.
     1) 줄 해시가 그대로면 그 줄 — 줄 차례가 밀렸어도 바로 찾는다
     2) 줄 글자가 고쳐졌으면, 답이 든 줄 가운데 옛 줄과 가장 닮은 줄로 옮기고 열쇠를 새로 준다
     3) 그래도 못 찾으면 떼어 둔다(o:1). **기록은 어떤 경우에도 지우지 않는다** */
let WON_LOST = 0;
function wonReanchor() {
  let changed = wonMigrate() > 0;
  let moved = 0, lost = 0;
  for (const b of wonList()) {
    const set = WON.find(x => x.id === b.q);
    const doc = set && (set.docs.find(d => wonDocKey(d) === b.dk)
      || set.docs.find(d => wonNorm(d.title) === wonNorm(b.dt || "\u0000")));
    if (!doc) {
      if (!b.o) { b.o = 1; changed = true; }
      lost++;
      continue;
    }
    const dk = wonDocKey(doc);
    if (dk !== b.dk) {           // 문서 제목으로 다시 찾은 경우
      wonMoveRecords(wonSid(b.q, b), b.q + "|" + dk + "|" + b.k);
      b.dk = dk;
      changed = true;
    }
    const parts = String(b.k).split(":");
    const lh = parts[0], nth = +(parts[2] || 0);
    const ans = b.a || "";
    // 1) 줄 글자가 그대로면 바로 찾는다 (줄 차례가 밀려도 걸린다)
    let hit = wonFind(doc, lh, ans, nth);
    // 2) 줄이 손질됐으면 답이 든 줄 가운데 옛 줄과 가장 닮은 줄로 옮긴다
    if (!hit && ans) {
      /* 닮은 정도가 이만큼은 돼야 "같은 줄이 손질된 것"으로 본다.
         이 문턱이 없으면, 원래 줄이 통째로 사라졌을 때 같은 낱말이 든 엉뚱한 줄
         (예: 성취기준의 낱말을 해설 문장에서)로 빈칸이 옮겨 가 문맥이 뒤바뀐다.
         못 찾으면 떼어 두기만 한다 — 기록은 어차피 그 열쇠에 그대로 남는다 */
      let best = -1, score = 0.4;
      for (let i = 0; i < doc.lines.length; i++) {
        if (doc.lines[i].indexOf(ans) < 0) continue;
        if (wonList().some(x => x !== b && !x.o && x.q === b.q && x.dk === b.dk
          && x.i === i && x.a === ans)) continue;   // 이미 다른 빈칸이 앉은 자리는 비켜 간다
        const sc = wonSim(wonNorm(doc.lines[i]), wonNorm(b.ln || ans));
        if (sc > score) { score = sc; best = i; }
      }
      if (best >= 0) hit = { i: best, s: doc.lines[best].indexOf(ans) };
    }
    if (!hit) {
      if (!b.o) { b.o = 1; changed = true; }
      lost++;
      continue;
    }
    const line = doc.lines[hit.i];
    const nk = wonKey(doc, hit.i, hit.s, hit.s + ans.length);
    if (nk !== b.k) {
      wonMoveRecords(wonSid(b.q, b), b.q + "|" + b.dk + "|" + nk);
      b.k = nk;
      moved++;
      changed = true;
    }
    if (b.i !== hit.i || b.s !== hit.s) {
      b.i = hit.i; b.s = hit.s; b.e = hit.s + ans.length;
      changed = true;
    }
    if (b.o) { delete b.o; changed = true; }
    if (b.ln !== line.slice(0, 200)) { b.ln = line.slice(0, 200); changed = true; }
    if (b.dt !== doc.title) { b.dt = doc.title; changed = true; }
  }
  WON_LOST = lost;
  if (changed) persist();
  return { moved: moved, lost: lost };
}

/* 드래그로 뚫은 자리는 화면이 곧바로 다시 그려져서 무엇이 바뀌었는지 놓치기 쉽다.
   그래서 무엇을 뚫었는지 한 줄로 알려 준다 */
let TOAST_T = 0;
function toast(msg) {
  let el = document.querySelector(".toast");
  if (!el) { el = document.createElement("div"); el.className = "toast"; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(TOAST_T);
  TOAST_T = setTimeout(() => el.classList.remove("show"), 1800);
}

function wonList() { return (S.won = S.won || []); }
function wonDoc(set, dk) { return set.docs.find(x => wonDocKey(x) === dk); }

/* 원문 묶음 → 복습 엔진이 아는 모양. 빈칸 하나가 카드 하나다 */
function wonBuild() {
  wonReanchor();
  for (let k = DATA.length - 1; k >= 0; k--) if (DATA[k].kind === "won") DATA.splice(k, 1);
  for (const set of WON) {
    /* 떼어 둔 빈칸(o)은 카드로 올리지 않는다. 기록은 남아 있고 원문 화면에서 따로 안내한다 */
    const mine = wonList().filter(b => b.q === set.id && !b.o);
    DATA.push({
      id: set.id, subject: set.subject, range: set.range, title: set.title,
      scope: set.scope, kind: "won", mode: "won", rules: null, docs: set.docs,
      base: "원문에서 드래그한 자리가 빈칸이 된다. 빈칸 하나가 카드 하나",
      questions: set.docs.map(doc => {
        const dk = wonDocKey(doc);
        return {
          /* 문항 번호가 곧 기록 열쇠의 가운데 토막이다. 자리(doc.no)가 아니라 이름표를 쓴다 */
          no: dk, dno: doc.no, title: doc.title, points: 0, body: "",
          frame: set.subject + " 원문 · " + doc.title,
          subs: mine.filter(b => b.dk === dk)
            .sort((a, b) => a.i - b.i || a.s - b.s)
            .map((b, bi) => {
              const line = doc.lines[b.i] || "";
              const ans = line.slice(b.s, b.e);
              return {
                no: b.k, sn: String(bi + 1), type: "term", hideHead: true, points: 0,
                /* 오늘의 복습에서 한 장씩 나올 때는 그 조항을 통째로 보여 주고
                   뚫은 자리만 밑줄로 남긴다. 앞뒤 문맥이 곧 단서다 */
                prompt: line.slice(0, b.s) + "＿＿＿＿" + line.slice(b.e),
                answer: ans, parts: [{ label: "원문", accept: [ans] }],
                won: b
              };
            })
        };
      })
    });
  }
}

/* 선택 영역 → 줄 안에서의 글자 위치. 표시용 <mark>가 섞여 있어도
   글자 수는 원문과 같으므로 텍스트 노드를 훑어 세면 된다 */
function wonOffset(p, node, off) {
  const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  let n = 0, cur;
  while ((cur = w.nextNode())) {
    if (cur === node) return n + off;
    n += cur.nodeValue.length;
  }
  return -1;
}

function wonPick() {
  if (!WON_EDIT) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return;
  const p = sel.anchorNode && sel.anchorNode.parentElement
    && sel.anchorNode.parentElement.closest(".wl");
  const p2 = sel.focusNode && sel.focusNode.parentElement
    && sel.focusNode.parentElement.closest(".wl");
  if (!p || p !== p2) { sel.removeAllRanges(); return; }   // 두 줄에 걸치면 안 받는다

  const card = p.closest(".ct-card");
  const quiz = DATA.find(z => z.id === card.dataset.won);
  const dk = card.dataset.dk, i = +p.dataset.i;
  const doc = wonDoc(quiz, dk);
  const line = doc.lines[i] || "";

  let a = wonOffset(p, sel.anchorNode, sel.anchorOffset);
  let b = wonOffset(p, sel.focusNode, sel.focusOffset);
  if (a < 0 || b < 0) { sel.removeAllRanges(); return; }
  if (a > b) { const t = a; a = b; b = t; }
  /* 양끝 공백은 빼 준다. 드래그가 한 칸 넘치는 일이 잦다 */
  while (a < b && /\s/.test(line[a])) a++;
  while (b > a && /\s/.test(line[b - 1])) b--;
  sel.removeAllRanges();
  if (b - a < 1) return;

  const mine = wonList().filter(x => x.q === quiz.id && x.dk === dk && x.i === i && !x.o);
  if (mine.some(x => a < x.e && x.s < b)) { toast("이미 뚫은 자리와 겹쳐요"); return; }

  const nb = {
    q: quiz.id, dk: dk, k: wonKey(doc, i, a, b), a: line.slice(a, b),
    ln: line.slice(0, 200), dt: doc.title, i: i, s: a, e: b
  };
  /* 떼어 둔 같은 자리가 있으면 그것을 되살린다(기록이 이미 그 열쇠에 붙어 있다) */
  const L = wonList();
  const back = L.findIndex(x => x.o && x.q === nb.q && x.dk === nb.dk && x.k === nb.k);
  if (back >= 0) L.splice(back, 1);
  L.push(nb);
  persist();
  wonBuild();
  renderQuiz(quiz.id, false);
  /* 열쇠가 글자에서 나오므로, 지웠다 다시 뚫은 자리는 지난 기록이 그대로 이어진다 */
  const back2 = history(wonSid(quiz.id, nb)).length;
  toast("빈칸 추가: " + nb.a + (back2 ? " (지난 기록 " + back2 + "건 이어받음)" : ""));
}

function wonDrop(card, i, s) {
  const quiz = DATA.find(z => z.id === card.dataset.won);
  const dk = card.dataset.dk;
  const L = wonList();
  const k = L.findIndex(x => x.q === quiz.id && x.dk === dk && x.i === i && x.s === s && !x.o);
  if (k < 0) return;
  /* ⭐ 기록은 지우지 않는다. 외울 범위는 공부하면서 계속 손보게 되는데, 뺄 때마다 기록을
     지우면 예전에 맞히고 틀린 내역이 그때그때 날아간다. 열쇠가 글자에서 나오므로
     같은 자리를 다시 뚫으면 그 기록이 그대로 이어진다 */
  const n = history(wonSid(quiz.id, L[k])).length;
  L.splice(k, 1);
  persist();
  wonBuild();
  renderQuiz(quiz.id, false);
  toast(n ? "빈칸을 뺐어요. 기록 " + n + "건은 남겨 둡니다" : "빈칸을 뺐어요");
}

/* 줄 하나를 그린다. 빈칸은 정하기 모드면 표시, 풀기 모드면 입력칸 */
function wonLineHtml(quiz, doc, i, blanks, pred) {
  const line = doc.lines[i] || "";
  /* 이름표(성취기준 코드·해설·고려)와 소제목. ⚠️ 이름표는 CSS ::before 로 그린다 —
     글자를 <span> 으로 넣으면 드래그 자리를 셀 때 그 글자까지 세어 빈칸이 밀린다 */
  const m = (doc.meta && doc.meta[i]) || null;
  const cls = "wl" + (m && m.h ? " wh" : "");
  const lab = m && m.l ? ` data-lab="${esc(m.l)}"` : "";
  const mine = blanks.filter(b => b.i === i).sort((a, b) => a.s - b.s);
  if (!mine.length) return `<p class="${cls}" data-i="${i}"${lab}>${esc(line)}</p>`;

  let out = "", at = 0;
  for (const b of mine) {
    out += esc(line.slice(at, b.s));
    const ans = line.slice(b.s, b.e);
    const id = wonSid(quiz.id, b);
    if (WON_EDIT) {
      out += `<mark class="wb" data-act="won-drop" data-i="${i}" data-s="${b.s}"
        title="누르면 빈칸을 없애요">${esc(ans)}</mark>`;
    } else if (pred && !pred(id)) {
      out += `<span class="wskip">${esc(ans)}</span>`;   // 이번에 안 볼 칸은 원문 그대로
    } else {
      const l = latest(id);
      out += `<span class="ctb wib" data-sid="${esc(id)}" data-ans="${esc(ans)}"
        ><input type="text" class="ctin" aria-label="원문 빈칸" autocomplete="off"
          spellcheck="false" size="${Math.max(4, Math.min(22, ans.length + 2))}"
        ><button class="ctmark" data-act="ct-mark" aria-label="판정 바꾸기"
          >${l ? (l.r === "O" ? "O" : l.r === "X" ? "X" : "△") : ""}</button
        ><span class="ctans"></span></span>`;
    }
    at = b.e;
  }
  out += esc(line.slice(at));
  return `<p class="${cls}" data-i="${i}"${lab}>${out}</p>`;
}

function wonCardHtml(quiz, doc, qi, pred) {
  const dk = wonDocKey(doc);
  const blanks = wonList().filter(b => b.q === quiz.id && b.dk === dk && !b.o);
  const shown = pred ? blanks.filter(b => pred(wonSid(quiz.id, b))) : blanks;
  if (pred && !shown.length) return "";
  const body = doc.lines.map((_, i) => wonLineHtml(quiz, doc, i, blanks, pred)).join("");
  return `
    <section class="q-card ct-card won-card" data-qi="${qi}" data-won="${esc(quiz.id)}"
      data-dk="${esc(dk)}">
      <div class="q-head"><span class="qno">${esc(doc.title)}</span>
        <span class="qpts">빈칸 ${blanks.length}</span></div>
      <div class="won-body">${body}</div>
      ${blanks.length ? `<div class="ct-acts">
        ${WON_EDIT ? `<span class="ct-tip">노란 자리를 누르면 빈칸이 없어져요</span>`
          : `<button class="btn primary" data-act="ct-grade">채점하기</button>
             <button class="btn ghost" data-act="ct-reveal">그냥 정답 보기</button>
             <span class="ct-score"></span>`}
      </div>` : ""}`.concat(`</section>`);
}

function wonHtml(quiz, weakOnly, pred) {
  const all = wonList().filter(b => b.q === quiz.id);
  const n = all.filter(b => !b.o).length;
  /* 원문이 바뀌어 자리를 못 찾은 빈칸. 기록은 그대로 있으니 버리지 말고 알려만 준다 */
  const lost = all.filter(b => b.o);
  const filter = (weakOnly || pred)
    ? (id => (!weakOnly || isWeak(id)) && (!pred || pred(id)))
    : null;
  const head = `
    <div class="ctscope wonbar">
      <div class="cs-head"><b>원문 모드</b>
        <span>원문에서 외울 자리를 드래그하면 빈칸이 돼요. 뚫은 자리 ${n}곳</span></div>
      <div class="cs-row">
        <button class="ck" data-act="won-edit" aria-pressed="${WON_EDIT}">빈칸 정하기</button>
        ${WON_EDIT && n ? `<button class="ck danger" data-act="won-clear">이 원문 빈칸 모두 빼기</button>` : ""}
      </div>
      ${lost.length ? `<div class="wlost">
        <b>자리를 못 찾은 빈칸 ${lost.length}곳</b>
        <p>원문 자료가 바뀌어 이 낱말이 지금 글에 없어요. 복습 기록은 지우지 않고 두었어요.
           같은 낱말을 다시 드래그하면 그 기록이 이어집니다.</p>
        <ul>${lost.slice(0, 12).map(b => `<li>${esc(b.a || "?")}
          <span class="wlost-d">${esc(b.dt || "")}</span>
          <span class="wlost-n">기록 ${history(wonSid(quiz.id, b)).length}건</span></li>`).join("")}
          ${lost.length > 12 ? `<li>그 밖에 ${lost.length - 12}곳</li>` : ""}</ul>
      </div>` : ""}
    </div>`;
  const cards = quiz.questions.map((q, qi) => {
    const doc = wonDoc(quiz, q.no);
    return doc ? wonCardHtml(quiz, doc, qi, filter) : "";
  }).join("");
  /* 원문은 빈칸이 없어도 늘 보인다. 여기가 비는 건 오답만 골라 볼 때뿐이다 */
  return head + (cards || `<p class="mt-empty">${filter
    ? "이 원문에는 다시 볼 칸이 없어요."
    : "아직 뚫은 빈칸이 없어요. '빈칸 정하기'를 켜고 외울 자리를 드래그하세요."}</p>`);
}

/* ---------- 표 빈칸 오답 유형 진단 ----------
   표의 오답은 서술형과 갈래가 다르다. 말이 미묘하게 어긋난 것과,
   내용은 아는데 **자리**를 잘못 짚은 것(학년군·영역 바꿔 쓰기)이 갈려야 한다.
   자리 바꿈은 글자가 똑같으므로 고정 코드가 먼저 확실히 잡고, 해석만 AI에 맡긴다. */
const CT_ERR_KO = {
  ok_form: "표기 차이", partial: "일부만", grade: "학년군 바뀜", area: "영역 바뀜",
  mix: "두 칸 섞임", confuse: "다른 개념", other: "다른 내용", blank: "안 씀",
  /* 원문 모드 전용. 조항 글에는 범주·학년군이 없어 "영역 바뀜"이라 부를 수 없다 */
  spot: "다른 자리"
};
/* AI가 칸 번호를 "1"로도 "1번"으로도 "1,4"로도 돌려준다. 맨 앞 숫자만 뽑아서 맞춘다 —
   글자 그대로 대조하면 그 칸의 진단이 조용히 사라지고,
   숫자를 전부 이으면 "1,4"가 14번 칸이 되어 엉뚱한 칸을 가리킨다 */
/* ⚠️ 원문 빈칸의 번호는 숫자 하나가 아니라 "줄_글자"(3_23)다. 여기서 숫자만 뽑으면
   같은 줄의 빈칸이 전부 "3" 한 번호로 뭉쳐서, 진단이 조용히 엉뚱한 칸에 붙는다 */
function ctNo(x) {
  const s = String(x == null ? "" : x);
  const w = s.match(/\d+_\d+/);
  if (w) return w[0];
  const m = s.match(/\d+/);
  return m ? m[0] : "";
}

function ctCardCtx(card) {
  const quiz = DATA.find(d => d.id === decodeURIComponent(location.hash.replace(/^#q\//, "").split("/")[0]));
  if (!quiz) return null;
  const q = quiz.questions[+card.dataset.qi];
  if (!q) return null;
  /* 원문 모드는 표가 아니라 조항 글이다. 칸이 놓인 줄이 곧 단서라 그걸 영역으로 쓴다 */
  if (quiz.kind === "won") {
    const a = new Map();
    q.subs.forEach(x => a.set(x.no, (x.prompt || "").slice(0, 40)));
    return { quiz, q, area: a };
  }
  if (!q.ct) return null;
  /* 칸 번호 → 영역. 표 문항 하나가 영역 하나라 기본은 q.title,
     그 아래 한 겹 더 갈리는 과목(영어)만 행의 sub를 쓴다 */
  const area = new Map();
  q.ct.rows.forEach(r => r.cells.forEach(c => c.ids.forEach(id => area.set(id, r.sub || q.title || ""))));
  return { quiz, q, area };
}
/* 같은 [범주 · 영역 · 학년군] 묶음 열쇠. 이 안의 내용 요소는 나열이라 순서가 없다.
   ⚠️ 화면의 <td>로 묶으면 안 된다. 같은 범주가 여러 행으로 쪼개진 표가 있다
   (음악 연주의 지식⋅이해는 행 라벨 없이 3행). 그래서 라벨로 묶는다.
   원문 모드(조항)는 낱말 자리가 곧 문장이라 묶지 않는다 */
function ctGroupKey(ctx, no) {
  /* 내체표만 묶는다. 총론·창체도 kind가 "ct"지만 범주·영역·학년군 자리에 조항 이름이나
     교과명이 들어가 세 값이 같아져 버린다. 시수표는 3~4학년과 5~6학년이 둘 다 408처럼
     같은 값을 갖는 칸이 있어서, 묶으면 한 번 써도 다른 칸이 오답이 된다 */
  if (!ctx || ctx.quiz.kind !== "ct" || ctx.quiz.subject !== "내체표") return null;
  const s = (ctx.q.subs || []).find(x => x.no === no);
  if (!s || !s.ct) return null;
  return `${s.ct.cat}|${ctx.area.get(no) || ""}|${s.ct.gr}`;
}

function ctWhere(s, area) {
  const a = area && area.get(s.no);
  /* 원문 모드 빈칸에는 범주·학년군이 없다(조항 글에서 드래그한 자리라서).
     그 자리를 가리키는 단서는 빈칸이 놓인 글줄뿐이다 */
  if (!s.ct) return a || "원문";
  return `${(s.ct.cat || "").replace("⋅", "·")} · ${a ? a + " · " : ""}${s.ct.gr}`;
}

/* 쓴 답이 이 표의 다른 칸 정답과 글자 그대로 같은가 (자리 바꿔 넣기).
   skip: 같은 칸 묶음(같은 범주 · 영역 · 학년군)의 빈칸 번호. 그 안에서는 순서가
   없어서 채점이 이미 인정했으므로, 자리를 바꿔 썼다고 짚으면 안 된다 */
function ctMisplaced(q, sub, val, skip) {
  const n = norm(val);
  if (!n) return null;
  const other = q.subs.find(s =>
    s.no !== sub.no && !(skip && skip.has(s.no)) && norm(s.answer) === n);
  if (!other) return null;
  /* 원문 모드는 범주·학년군이 없어 자리 종류를 가를 수 없다. 같은 낱말을 다른 자리에
     썼다는 것까지만 말한다 (같은 조항에서 같은 낱말을 여러 곳에 뚫는 일이 흔하다) */
  if (!other.ct || !sub.ct) return { t: "spot", ref: other.no, other };
  return { t: (other.ct.cat === sub.ct.cat && other.ct.gr !== sub.ct.gr) ? "grade" : "area", ref: other.no, other };
}

function ctNoteEl(b, type, text, where) {
  let el = b.querySelector(".ctnote");
  if (!el) { el = document.createElement("div"); el.className = "ctnote"; b.appendChild(el); }
  el.innerHTML = `<span class="cttag t-${esc(type)}">${esc(CT_ERR_KO[type] || type)}</span>${text ? " " + esc(text) : ""}` +
    (where ? `<span class="ctwhere">${esc(where)}</span>` : "");
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

/* material: "표"(내체표) 또는 "조항"(총론·창의적 체험활동).
   내체표는 학년군·영역을 바꿔 쓰는 것이 대표 실점이지만, 총론·창체는 학년군 칸이
   아예 없고 "뜻은 맞는데 원문 낱말이 아닌 것"이 대표 실점이라 진단 지침이 다르다.
   함수가 옛 버전이면 이 값을 무시하고 예전대로 돈다.
   order: "free" 는 표 빈칸형에서만 켠다. 같은 칸 안 내용 요소는 나열이라 순서가
   없어서다. 맥락형은 장면 하나가 내용 요소 하나를 가리키므로 켜면 안 된다 */
async function aiJudgeTable(topic, cells, asked, material, freeOrder) {
  let res;
  try {
    res = await fetch(AI_FN_URL, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: AI_FN_KEY, Authorization: "Bearer " + AI_FN_KEY },
      body: JSON.stringify({ type: "grade_table", topic, cells, asked, material, order: freeOrder ? "free" : "fixed" })
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
    /* 같은 묶음(범주 · 영역 · 학년군)의 빈칸 번호. 채점이 이미 순서를 봐준 자리라
       자리 바꿈으로 짚지 않는다 */
    const gk = ctGroupKey(ctx, no);
    const sibs = gk
      ? new Set(q.subs.filter(x => ctGroupKey(ctx, x.no) === gk).map(x => x.no))
      : null;
    /* 채점이 묶음 안에서 정답 자리를 다시 나눈 결과. 이 칸이 실제로 책임질 정답이다 */
    const eff = b.dataset.eff || sub.answer;
    wrong.push({ b, no, sub, val, eff, mis: ctMisplaced(q, sub, val, sibs) });
  });
  if (!wrong.length) return;

  /* 1) 고정 코드가 확실히 아는 것부터 (AI가 꺼져 있어도, 실패해도 남는다) */
  for (const w of wrong) {
    if (!w.val) { ctSaveErr(w, { t: "blank", w: "", n: "" }); continue; }
    if (!w.mis) continue;
    /* 원문은 자리 이름이 없고 area 가 글줄 토막이라, 그걸 넣으면 문장이 중간에 잘린 채 붙는다 */
    const note = w.sub.ct
      ? `${ctWhere(w.mis.other, area)} 칸의 내용이에요`
      : `이 원문 다른 자리에 들어갈 말이에요`;
    ctNoteEl(w.b, w.mis.t, note);
    ctSaveErr(w, { t: w.mis.t, r: w.mis.ref, w: w.val, n: note });
  }

  const box = ctDiagBox(card);
  const asked = wrong.filter(w => w.val);
  if (!asked.length) { box.remove(); return; }
  if (!aiOn()) { box.innerHTML = `<div class="cd-sum">AI 진단이 꺼져 있어요. 자리를 바꿔 쓴 것만 표시했어요</div>`; return; }

  /* 2) 나머지 해석은 AI. 표 전체를 같이 보내야 "어느 칸의 내용인지"를 짚을 수 있다.
     ⚠️ 정답은 채점이 묶음 안에서 다시 나눈 것(eff)으로 보낸다. 원래 자리 그대로 보내면
     이미 옆 칸에서 맞힌 요소를 "이게 정답이에요"라고 말한다. 묶음 안 자리바꿈이라
     라벨은 그대로여서 다른 칸을 짚는 판정(grade·area)에는 영향이 없다 */
  const effByNo = new Map();
  card.querySelectorAll(".ctb").forEach(x => {
    if (x.dataset.eff) effByNo.set(String(x.dataset.sid).split("|").pop(), x.dataset.eff);
  });
  box.innerHTML = `<div class="cd-sum">${ico("spark")} 오답을 보는 중</div>`;
  try {
    const data = await aiJudgeTable(
      `${quiz.range} · ${q.title}`,
      /* 원문 모드 빈칸에는 ct(범주·학년군)가 없다. 없는 채로 보낸다 —
         여기서 s.ct 를 그냥 읽으면 진단이 통째로 실패한다 */
      q.subs.map(s => ({ no: s.no, cat: ((s.ct && s.ct.cat) || "").replace("⋅", "·"),
                        area: area.get(s.no) || "", gr: (s.ct && s.ct.gr) || "",
                        ans: effByNo.get(s.no) || s.answer })),
      asked.map(w => ({ no: w.no, val: w.val, hint: w.mis ? `${w.mis.ref}번 칸의 정답과 글자가 같음` : "" })),
      quiz.subject === "내체표" ? "표" : "조항",
      quiz.subject === "내체표"   // 같은 칸 안에서는 순서 무관 (표 빈칸형만)
    );
    const byId = new Map(wrong.map(w => [ctNo(w.no), w]));
    let n = 0;
    for (const it of (data.items || [])) {
      const w = byId.get(ctNo(it.no));
      if (!w) continue;
      let type = CT_ERR_KO[it.type] ? it.type : "other";
      /* 원문에는 영역·학년군이 없다. AI가 그 이름으로 불러도 "다른 자리"로 바꿔 적는다 */
      if (!w.sub.ct && (type === "area" || type === "grade")) type = "spot";
      let note = (it.note || "").trim();
      /* 원문에서는 AI가 칸을 "2_70번 칸"처럼 내부 좌표로 부른다(줄_글자).
         읽는 사람에게는 뜻이 없는 숫자라 그 자리의 원문 낱말로 바꿔 적는다 */
      if (!w.sub.ct) note = note.replace(/(\d+_\d+)\s*번?\s*칸/g,
        (m, id) => { const s = byNo.get(id); return s ? `‘${s.answer}’ 자리` : "다른 자리"; });
      /* 진단은 그 칸 밑에 붙인다. 카드 아래 목록으로 몰아 두면 어느 칸 얘기인지
         눈으로 되짚어야 하고, 표가 길면 아예 화면 밖으로 나간다 */
      /* 원문은 빈칸이 글 안에 박혀 있어 자리 표시가 필요 없다 (오히려 글줄이 두 번 찍힌다) */
      ctNoteEl(w.b, type, note, w.sub.ct ? ctWhere(w.sub, area) : "");
      /* 판정 제안은 AI, 합산·저장은 고정 코드 (칸을 눌러 언제든 바꿀 수 있다) */
      const r = it.verdict === "good" ? "O" : it.verdict === "partial" ? "T" : "X";
      const mark = r === "O" ? "O" : r === "T" ? "△" : "X";
      w.b.querySelector(".ctmark").textContent = mark;
      w.b.classList.toggle("hit", r === "O");
      w.b.classList.toggle("miss", r !== "O");
      ctSaveErr(w, { t: type, r: ctNo(it.ref), w: w.val, n: note }, r);
      n++;
    }
    ctRescore(card);
    /* 아래에는 총평만 남긴다. 칸마다의 진단은 그 칸 밑에 이미 있다 */
    box.innerHTML = `<div class="cd-sum">${ico("spark")} <b>AI 오답 노트</b>
      ${esc(data.summary || "")}</div>` +
      (n ? `<div class="cd-hint">칸마다의 진단은 그 칸 아래에 있어요</div>` : "");
  } catch (e) {
    box.innerHTML = `<div class="cd-sum">AI 진단 실패(${esc(e && e.message ? e.message : "오류")}). 자리를 바꿔 쓴 것만 표시했어요</div>`;
  }
}

/* 오답 유형을 기록에 남긴다. 이 기록이 오답 노트이자, 나중에 "자주 틀리는 칸만 빈칸" 의 재료다 */
function ctSaveErr(w, err, r) {
  record(w.b.dataset.sid, r || "X", null, r === "O" ? null : [w.eff || w.sub.answer], "", err, w.val);
}

/* ---------- 맥락형 오답 유형 진단 ----------
   맥락형은 표를 안 보여주고 수업 장면 하나만 준다. 그래서 내가 쓴 답이 사실 **옆 칸의 내용**
   이었다는 것을 본인은 알 방법이 없다. 표 빈칸형과 같은 갈래로 짚어 주되, 대조할 표를
   같은 과목 내체표(ct-{과목})에서 끌어온다. 유형·화면·기록은 표 빈칸형과 똑같이 쓴다. */
function ctxCells(range) {
  const ct = DATA.find(z => z.kind === "ct" && z.range === range);
  if (!ct) return null;
  const out = [];
  for (const q of ct.questions) {
    /* 영역은 표 **문항 하나 = 영역 하나**로 잡혀 있다 (q.title). rows의 sub는 그 아래
       한 겹 더 갈리는 과목(영어)에서만 채워진다. 맥락형의 area 값과 맞는 쪽은 q.title */
    const sub2 = new Map();
    ((q.ct && q.ct.rows) || []).forEach(r =>
      r.cells.forEach(c => c.ids.forEach(id => { if (r.sub) sub2.set(id, r.sub); })));
    for (const s of q.subs) {
      out.push({
        no: String(out.length + 1),               // 표 밖에서 쓰는 번호라 이어서 새로 매긴다
        cat: (s.ct.cat || "").replace("⋅", "·"),
        area: q.title || "",
        sub2: sub2.get(s.no) || "",
        gr: s.ct.gr || "",
        ans: s.answer
      });
    }
  }
  return out;
}
function ctxWhere(c) {
  return `${c.cat}${c.area ? " · " + c.area : ""}${c.sub2 ? " · " + c.sub2 : ""} · ${c.gr}`;
}
function ctxMe(sub) {
  return { cat: (sub.ct.cat || "").replace("⋅", "·"), area: sub.ct.area || "", gr: sub.ct.gr || "" };
}
function ctxSame(c, me) { return c.cat === me.cat && c.area === me.area && c.gr === me.gr; }

/* 쓴 답이 내체표 **다른 칸**의 정답과 글자 그대로 같은가 (자리 바꿔 넣기).
   같은 글자가 표 안에 여러 번 나오는 과목이 있어서(영어·음악 11건), 자기 답과 같으면
   먼저 물러나고, 후보가 여럿이면 학년군만 어긋난 칸을 앞세운다 */
function ctxMisplaced(cells, sub, val) {
  const n = norm(val);
  if (!n || n === norm(sub.answer)) return null;
  const me = ctxMe(sub);
  const hits = cells.filter(c => norm(c.ans) === n && !ctxSame(c, me));
  if (!hits.length) return null;
  const hit = hits.find(c => c.cat === me.cat && c.area === me.area) || hits[0];
  return { t: (hit.cat === me.cat && hit.area === me.area) ? "grade" : "area", cell: hit };
}

async function ctxDiagnose(subEl, quiz, q, sub, val) {
  if (!sub || !sub.ct) return;
  const cells = ctxCells(quiz.range);
  if (!cells || !cells.length) return;
  const rev = subEl.querySelector(".reveal");
  if (!rev) return;
  const box = document.createElement("div");
  box.className = "ct-diag";
  const chips = rev.querySelector(".kw-chips");
  if (chips) chips.after(box); else rev.prepend(box);

  const setErr = (err) => { subEl.dataset.cterr = JSON.stringify(err); };

  if (!norm(val)) {
    box.innerHTML = `<div class="cd-sum"><span class="cttag t-blank">${CT_ERR_KO.blank}</span></div>`;
    setErr({ t: "blank", w: "", n: "" });
    return;
  }

  /* 1) 고정 코드가 확실히 아는 것부터 (AI가 꺼져 있어도, 실패해도 남는다) */
  const mis = ctxMisplaced(cells, sub, val);
  if (mis) {
    const note = `${ctxWhere(mis.cell)} 칸의 내용이에요`;
    box.innerHTML = `<div class="cd-sum"><span class="cttag t-${mis.t}">${CT_ERR_KO[mis.t]}</span>${esc(note)}</div>`;
    setErr({ t: mis.t, r: mis.cell.no, w: val, n: note });
  }
  if (!aiOn()) { if (!mis) box.remove(); return; }

  /* 2) 해석은 AI. 표 전체는 너무 크니 같은 범주만 보내되, 자리 바꿔 쓴 칸은 꼭 끼워 넣는다 */
  const me = ctxMe(sub);
  let send = cells.filter(c => c.cat === me.cat);
  if (mis && !send.some(c => c.no === mis.cell.no)) send = send.concat([mis.cell]);
  let target = send.find(c => ctxSame(c, me) && norm(c.ans) === norm(sub.answer));
  if (!target) {   // 내체표에 없는 칸이면(데이터 어긋남) 이 문항의 정답을 칸으로 얹는다
    target = { no: String(cells.length + 1), cat: me.cat, area: me.area, gr: me.gr, ans: sub.answer };
    send = send.concat([target]);
  }
  send = send.slice(0, 70);

  box.innerHTML += `<div class="cd-sum">${ico("spark")} 오답을 보는 중</div>`;
  try {
    const data = await aiJudgeTable(
      `${quiz.range} · ${q.title}`, send,
      [{ no: target.no, val, hint: mis ? `${ctxWhere(mis.cell)} 칸의 정답과 글자가 같음` : "" }]
    );
    const it = (data.items || [])[0];
    if (!it) throw new Error("응답이 비었어요");
    const type = CT_ERR_KO[it.type] ? it.type : "other";
    const note = (it.note || "").trim();
    const refCell = ctNo(it.ref) ? send.find(c => ctNo(c.no) === ctNo(it.ref)) : null;
    box.innerHTML =
      `<div class="cd-sum">${ico("spark")} <b>AI 오답 노트</b> ${esc(data.summary || "")}</div>` +
      `<ul class="cd-list"><li>
        <span class="cttag t-${esc(type)}">${esc(CT_ERR_KO[type])}</span>
        <b>${esc(sub.answer)}</b> <span class="cd-where">${esc(ctxWhere(target))}</span>
        <div class="cd-mine">내가 쓴 것: ${esc(val)}${note ? " · " + esc(note) : ""}</div>
        ${refCell ? `<div class="cd-mine">그 내용이 들어갈 칸: ${esc(ctxWhere(refCell))}</div>` : ""}
      </li></ul>`;
    setErr({ t: type, r: ctNo(it.ref), w: val, n: note });

    /* 판정 제안은 AI, 확정은 언제나 본인 (표 빈칸형과 같은 규칙) */
    if (!subEl.querySelector(".vbtn.chosen")) {
      const v = it.verdict === "good" ? "O" : it.verdict === "partial" ? "T" : "X";
      subEl.dataset.suggest = v;
      subEl.querySelectorAll(".vbtn").forEach(b => b.classList.toggle("suggest", b.dataset.v === v));
      const lbl = subEl.querySelector(".vlbl");
      if (lbl) lbl.textContent = `내 판정 (제안: ${vName(v)})`;
      const chip = subEl.querySelector(".kw");
      if (chip && v === "O") {
        chip.classList.remove("miss"); chip.classList.add("hit", "ai");
        chip.textContent = "✓ " + chip.textContent.replace(/^[✓✗△]\s*/, "") + " (의미)";
        if (note) chip.title = note;
      }
    }
  } catch (e) {
    box.innerHTML = mis
      ? `<div class="cd-sum"><span class="cttag t-${mis.t}">${CT_ERR_KO[mis.t]}</span>${esc(ctxWhere(mis.cell))} 칸의 내용이에요</div>`
      : `<div class="cd-sum">AI 진단 실패(${esc(e && e.message ? e.message : "오류")})</div>`;
  }
}

/* ---------- 퀴즈 페이지 (전체 보기) ---------- */
function quizCardsHtml(quiz, weakOnly, pred) {
  if (quiz.kind === "won") return wonHtml(quiz, weakOnly, pred);
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

function renderQuiz(quizId, weakOnly, heat) {
  const quiz = DATA.find(z => z.id === quizId);
  if (!quiz) { location.hash = ""; return; }

  /* 표로 보기: 같은 표를 풀지 않고 누적 약점만 얹어서 본다. 표 있는 묶음에서만 켜진다 */
  const isHeat = !!heat && quiz.kind === "ct";
  const qCards = isHeat ? ctHeatHtml(quiz) : quizCardsHtml(quiz, weakOnly);

  const totalSubs = quiz.questions.reduce((a, q) => a + q.subs.length, 0);
  const doneSubs = quiz.questions.reduce((a, q) =>
    a + q.subs.filter(sub => latest(subId(quiz, q, sub))).length, 0);

  $("#app").innerHTML = `
    <div class="topbar">
      <a class="back" href="#">← 홈</a>
      <span class="ttl">${esc(quiz.title)}${weakOnly ? ' <span class="chip">틀린 것만</span>' : ""}</span>
      <span class="prog" id="prog">기록 ${doneSubs}/${totalSubs}</span>
    </div>
    ${quiz.kind === "ct" ? `<div class="ct-modes">
      <a class="ctmode${isHeat ? "" : " on"}" href="#q/${encodeURIComponent(quiz.id)}">풀기</a>
      <a class="ctmode${isHeat ? " on" : ""}" href="#q/${encodeURIComponent(quiz.id)}/heat">표로 보기</a>
    </div>` : ""}
    ${quiz.kind === "ct" && !isHeat ? ctScopeHtml(quiz) : ""}
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
  /* 자동 백업: 마지막 백업이 3일 넘었으면 라운드 끝에 기록 JSON을 조용히 내려받는다.
     단 서버 동기화가 되고 있으면 내려받지 않는다 — 기록은 이미 서버에 있고,
     라운드마다 파일이 떨어지면 그게 더 성가시다 (백업 배너와 같은 조건) */
  let autoBackedUp = false;
  const recCount = Object.values(S.records).reduce((a, h) => a + h.length, 0);
  if (recCount && SYNC_STATE !== "ok" && (!S.lastExport || Date.now() - S.lastExport > 3 * DAY)) {
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
    /* 맥락형 내체표는 틀렸을 때 유형까지 갈라 준다. 표를 안 보여주는 형식이라
       내가 쓴 답이 옆 칸 내용이었다는 것을 본인은 알 수 없다 (reveal 이 그려진 뒤에 붙인다) */
    const ctxOwner = findSub(subEl);
    if (ctxOwner.quiz.kind === "ctx" && sub.ct && !flags[0]) {
      setTimeout(() => ctxDiagnose(subEl, ctxOwner.quiz, ctxOwner.q, sub, inputs[0] || ""), 0);
    }
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
  if (act === "won-edit") {
    WON_EDIT = !WON_EDIT;
    renderQuiz(decodeURIComponent(location.hash.replace(/^#q\//, "").split("/")[0]), false);
    return;
  }
  if (act === "won-drop") { wonDrop(btn.closest(".ct-card"), +btn.dataset.i, +btn.dataset.s); return; }
  if (act === "won-clear") {
    const id = decodeURIComponent(location.hash.replace(/^#q\//, "").split("/")[0]);
    const quiz = DATA.find(z => z.id === id);
    if (!quiz || !confirm("이 원문에서 뚫은 빈칸을 모두 뺄까요? 복습 기록은 지우지 않고 남겨 둡니다.")) return;
    /* 기록은 남긴다. 같은 자리를 다시 뚫으면 그대로 이어진다 (wonDrop 과 같은 이유) */
    S.won = wonList().filter(x => x.q !== id);
    persist();
    wonBuild();
    renderQuiz(id, false);
    return;
  }
  /* 표로 보기에서 칸 누르기: 그 칸의 시도 이력을 펴고, 그때 혼동한 칸을 표 위에서 같이 표시한다.
     "이 칸에 쓸 걸 저 칸에 썼다"의 짝이 기록에 남아 있어서(x.r) 목록으로는 안 보이던
     맞바꿈 버릇이 표 위에서 보인다 */
  if (act === "heat-cell") {
    const sec = btn.closest(".ct-heat");
    if (!sec) return;
    const quiz = DATA.find(d => d.id === (sec.dataset.quiz
      || decodeURIComponent(location.hash.replace(/^#q\//, "").split("/")[0])));
    if (!quiz) return;
    const q = quiz.questions[+sec.dataset.qi];
    const no = btn.dataset.no;
    const sub = q && q.subs.find(s => String(s.no) === String(no));
    if (!sub) return;
    const box = sec.querySelector(".heat-detail");
    const reopen = box && box.dataset.no === String(no);
    /* 열려 있던 것은 표 전체에서 닫는다. 두 칸이 동시에 선택돼 보이면 연결선이 어느 쪽 것인지 흐려진다 */
    document.querySelectorAll(".hcell.sel, .hcell.hlink").forEach(x => x.classList.remove("sel", "hlink"));
    document.querySelectorAll(".heat-detail").forEach(x => { x.innerHTML = ""; x.dataset.no = ""; });
    if (reopen) return;                       // 같은 칸을 다시 누르면 닫기
    btn.classList.add("sel");
    const refs = new Set(history(btn.dataset.sid).filter(r => r.x && r.x.r).map(r => ctNo(r.x.r)));
    refs.forEach(n => {
      const el = [...sec.querySelectorAll(".hcell")].find(x => x.dataset.no === n);
      if (el && el !== btn) el.classList.add("hlink");
    });
    if (box) {
      box.dataset.no = String(no);
      box.innerHTML = ctHeatDetailHtml(quiz, q, sub, btn.dataset.sid);
    }
    return;
  }
  if (act === "heat-close") {
    document.querySelectorAll(".hcell.sel, .hcell.hlink").forEach(x => x.classList.remove("sel", "hlink"));
    const box = btn.closest(".heat-detail");
    if (box) { box.innerHTML = ""; box.dataset.no = ""; }
    return;
  }
  if (act === "ct-cat") {
    const quiz = DATA.find(d => d.id === decodeURIComponent(location.hash.replace(/^#q\//, "").split("/")[0]));
    if (!quiz) return;
    const set = ctCats(quiz);
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
    /* 같은 [범주 · 영역 · 학년군] 안의 빈칸끼리는 순서가 없다. 내용 요소를 나열해 둔
       것이라 몇 번째로 쓰느냐는 시험에서 묻지 않는다. 자기 답부터 맞춰 보고, 남은
       것끼리 묶음 안에서 짝을 짓는다 (정답 하나는 한 번만 쓰인다. 같은 걸 두 번
       쓰면 하나만 인정). 묶음 열쇠가 없는 것(원문 모드)은 혼자 두어 자기 답만 본다 */
    const hitSet = new Set();
    const eff = new Map();      // 빈칸 → 이 칸이 실제로 책임질 정답
    const gctx = ctCardCtx(card);
    if (!reveal) {
      const groups = new Map();
      card.querySelectorAll(".ctb").forEach(b => {
        const key = ctGroupKey(gctx, String(b.dataset.sid).split("|").pop()) || b;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(b);
      });
      for (const list of groups.values()) {
        const left = [];   // 아직 못 맞춘 빈칸
        const pool = [];   // 아직 아무도 안 쓴 정답 (원문 그대로)
        for (const b of list) {
          const v = norm(b.querySelector(".ctin").value);
          const a = b.dataset.ans;
          if (v && v === norm(a)) { hitSet.add(b); eff.set(b, a); continue; }
          left.push({ b, v });
          pool.push(a);
        }
        // 순서만 바뀐 것: 남은 정답 중 글자가 같은 것이 있으면 그 자리로 인정
        for (let i = left.length - 1; i >= 0; i--) {
          const it = left[i];
          const k = it.v ? pool.findIndex(a => norm(a) === it.v) : -1;
          if (k < 0) continue;
          hitSet.add(it.b); eff.set(it.b, pool[k]);
          pool.splice(k, 1); left.splice(i, 1);
        }
        /* 남은 빈칸에는 **아직 안 나온 요소**를 붙인다. 자기 칸의 원래 정답을 그대로
           두면, 이미 옆 칸에서 맞힌 것을 "이게 정답이에요"라고 말하게 된다.
           여럿 남았으면 쓴 것과 가장 닮은 요소부터 짝지어 진단이 어긋나지 않게 */
        for (const it of left) {
          if (!pool.length) continue;
          let k = 0, best = -1;
          pool.forEach((a, i) => { const s = sim2(norm(a), it.v); if (s > best) { best = s; k = i; } });
          eff.set(it.b, pool[k]);
          pool.splice(k, 1);
        }
      }
    }
    card.querySelectorAll(".ctb").forEach(b => {
      const inp = b.querySelector(".ctin");
      /* 이 칸이 책임질 정답. 묶음 안에서 자리를 다시 나눈 결과다 (없으면 원래 정답) */
      const ans = eff.get(b) || b.dataset.ans;
      b.dataset.eff = ans;
      const hit = hitSet.has(b);
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
        record(b.dataset.sid, hit ? "O" : "X", hit ? "O" : "X", hit ? null : [ans], "", null, inp.value);
        bumpGoal();   // 빈칸 하나가 카드 하나이므로 칸마다 센다
      }
    });
    /* 같은 표 안에 이 요소를 요구하는 칸이 또 있으면 말해 준다. 학년군이나 범주가 달라
       정말로 두 칸의 답인데(음악 '노래 부르거나 악기 연주하기'는 두 학년군에 있다),
       말해 주지 않으면 "아까 썼는데 또 정답이라 한다"로 보인다 */
    if (!reveal && gctx) {
      const key = (b) => norm(eff.get(b) || b.dataset.ans);
      const byAns = new Map();
      card.querySelectorAll(".ctb").forEach(b => {
        const k = key(b);
        if (!byAns.has(k)) byAns.set(k, []);
        byAns.get(k).push(b);
      });
      card.querySelectorAll(".ctb.miss").forEach(b => {
        const mates = (byAns.get(key(b)) || []).filter(x => x !== b);
        if (!mates.length) return;
        const where = mates.map(x => {
          const no = String(x.dataset.sid).split("|").pop();
          const s = (gctx.q.subs || []).find(y => y.no === no);
          return s && s.ct ? ctWhere(s, gctx.area) : "";
        }).filter(Boolean);
        if (!where.length) return;
        let el = b.querySelector(".ctdup");
        if (!el) { el = document.createElement("div"); el.className = "ctdup"; b.appendChild(el); }
        el.textContent = `이 요소는 ${where.join(" / ")} 칸에도 들어가요`;
      });
    }
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
    const ans = b.dataset.eff || b.dataset.ans;   // 묶음 안에서 다시 나눈 정답
    if (next !== "O") b.querySelector(".ctans").textContent = ans;
    record(b.dataset.sid, next === "△" ? "T" : next, null, next === "O" ? null : [ans], "",
      null, (b.querySelector(".ctin") || {}).value);
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
    /* 맥락형 오답 유형(ctxDiagnose가 남긴 것)도 같이 기록한다. 완벽으로 확정하면 유형은 지운다 */
    let cterr = null;
    try { cterr = btn.dataset.v === "O" ? null : JSON.parse(subEl.dataset.cterr || "null"); } catch (_) { /* 무시 */ }
    /* 답안 칸이 여럿이면(파트·재질문) 이어 붙여 남긴다 */
    const wrote = [...subEl.querySelectorAll(".answer")].map(a => a.value.trim())
      .filter(Boolean).join(" / ");
    record(id, btn.dataset.v, subEl.dataset.suggest || null, missNames, subEl.dataset.rq || "", cterr, wrote);
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
  const m = location.hash.match(/^#q\/([^/]+)(?:\/(weak|heat))?/);
  if (m) renderQuiz(decodeURIComponent(m[1]), m[2] === "weak", m[2] === "heat");
  else { SESSION = null; renderHome(); }
}
window.addEventListener("hashchange", render);
document.addEventListener("mouseup", e => { if (e.target.closest(".won-body")) wonPick(); });
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
  /* 첫 그리기 **전에** 원문 묶음을 DATA 에 올린다. 안 그러면 원문 모드 주소로 바로
     들어왔을 때 그런 묶음이 없다고 보고 홈으로 튕긴다 (동기화는 그 뒤에 온다) */
  wonBuild();
  render();
  if (!syncKey()) makeSyncKey();
  pullAndMerge();
})();
