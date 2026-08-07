/* 다지기 — 퀴즈 재풀이 + 키워드 판정 제안 + 소문항 단위 기록 (localStorage)
   판정 철학: 자동 판정은 "제안"일 뿐. 기록은 언제나 본인이 O·△·X 버튼을 눌러 확정한다. */
"use strict";

const DATA = window.DAJIGI_DATA || [];
const KEY = "dajigi_v1";
const AI_OFF_NAME = "dajigi_ai_off";
/* AI 채점은 온고지신과 같은 Supabase Edge Function을 쓴다 (키는 서버 시크릿 — 브라우저에 키 없음) */
const AI_FN_URL = "https://lyculuojctqhsmhuqrdt.supabase.co/functions/v1/diagnose-reading";
const AI_FN_KEY = "sb_publishable_0WY4_2tj6O83jVKgWW80rA_G-KIl3su";
const DAY = 24 * 60 * 60 * 1000;

/* ---------- 복습 모드: 단권화 데이터 → 퀴즈 구조로 변환 ----------
   각 항목 = 문항 1개 + 소문항 2개(키워드 인출 ver / 설명 쓰기 ver). 채점 키워드는 공유. */
for (const set of (window.DAJIGI_DAN || [])) {
  DATA.push({
    id: set.id,
    subject: set.subject,
    title: set.title,
    scope: "출처: " + set.source,
    base: "단권화 원문 그대로 · 키워드 인출 ver / 설명 쓰기 ver",
    mode: "review",
    rules: [
      "키워드 ver → 핵심 키워드를 기억나는 대로 전부 쓴다. 문장일 필요 없다.",
      "설명 ver → 남에게 설명하듯 서술한다. 임용은 키워드가 포함되었는가의 싸움.",
      "AI 채점을 켜면(홈 하단) 표기가 달라도 의미가 같은 키워드를 인정해 준다."
    ],
    questions: set.items.map(it => ({
      no: it.no, points: 0, frame: "단권화 표11 · " + set.subject, title: it.title,
      body: "",
      subs: [
        { no: "키워드", points: 0, type: "essay",
          prompt: "**" + it.title + "** — 핵심 키워드를 기억나는 대로 **전부** 쓰세요.",
          ph: "키워드를 쉼표나 줄바꿈으로 나열해도 돼요",
          groups: it.groups, answer: it.model },
        { no: "설명", points: 0, type: "essay",
          prompt: "**" + it.title + "** — 남에게 설명하듯 서술하세요.",
          ph: "설명 안에 키워드가 자연스럽게 들어가야 득점이에요",
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
function persist() { localStorage.setItem(KEY, JSON.stringify(S)); }

function subId(quiz, q, sub) { return quiz.id + "|" + q.no + "|" + sub.no; }
function history(id) { return S.records[id] || []; }
function latest(id) { const h = history(id); return h.length ? h[h.length - 1] : null; }
function record(id, r, auto, miss) {
  const h = S.records[id] || (S.records[id] = []);
  const t = Date.now();
  const last = h[h.length - 1];
  const m = (miss && miss.length) ? miss : undefined;
  // 같은 세션에서 판정을 바꾸면(10분 안) 새 줄이 아니라 정정으로 처리
  if (last && t - last.t < 10 * 60 * 1000) { last.r = r; last.a = auto || last.a; last.t = t; if (m) last.m = m; else delete last.m; }
  else h.push({ d: new Date().toISOString().slice(0, 10), r, a: auto || null, t, ...(m ? { m } : {}) });
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
function todayStr() { return new Date().toISOString().slice(0, 10); }
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
function buildQueue(mode) {
  const subs = allSubs().map(x => ({ ...x, st: subState(x.id) }));
  if (mode === "chronic") return subs.filter(x => x.st.chronic);
  const relearn = subs.filter(x => x.st.status === "relearn" && x.st.isDue);
  const review = subs.filter(x => x.st.status === "review" && x.st.isDue);
  const fresh = subs.filter(x => x.st.status === "new");
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

function quizCard(quiz) {
  let total = 0, tried = 0, ok = 0, weak = 0;
  quiz.questions.forEach(q => q.subs.forEach(sub => {
    total++;
    const l = latest(subId(quiz, q, sub));
    if (l) { tried++; if (l.r === "O") ok++; else weak++; }
  }));
  return `
  <section class="quiz-card">
    <span class="chip">${esc(quiz.subject)}</span>
    <h2>${esc(quiz.title)}</h2>
    <div class="meta">${esc(quiz.scope)}<br>${esc(quiz.base)}</div>
    <div class="stats">문항 ${quiz.questions.length} · 소문항 ${total} ·
      풀어봄 <b>${tried}</b> · 최근 O <b>${ok}</b>${weak ? ` · 다시 볼 것 <b>${weak}</b>` : ""}</div>
    <div class="actions">
      <a class="btn primary" href="#q/${quiz.id}">풀기</a>
      <a class="btn ${weak ? "" : "ghost"}" href="#q/${quiz.id}/weak"
         ${weak ? "" : 'style="pointer-events:none;opacity:.4"'}>틀린 것만 (${weak})</a>
    </div>
  </section>`;
}

function renderHome() {
  const recCount = Object.values(S.records).reduce((a, h) => a + h.length, 0);
  const needBackup = recCount > 0 && (!S.lastExport || Date.now() - S.lastExport > 7 * DAY);
  const lastTs = Object.values(S.records).flat().reduce((m, r) => Math.max(m, r.t || 0), 0);
  const staleDays = lastTs ? Math.floor((Date.now() - lastTs) / DAY) : null;

  const gichul = DATA.filter(z => z.mode !== "review");
  const review = DATA.filter(z => z.mode === "review");
  const qc = queueCounts();
  const doneToday = goalToday();
  const dueNow = qc.relearn + qc.review;

  $("#app").innerHTML = `
    <header class="masthead">
      <h1>암기PT</h1>
      <p>임용 암기 트레이너 · 오늘 할 만큼만, 매일</p>
    </header>
    ${needBackup ? `<div class="banner"><span>기록 ${recCount}건이 이 브라우저에만 있어요.
      ${staleDays !== null && staleDays > 0 ? `마지막 기록 ${staleDays}일 전. ` : ""}백업해 두세요.</span>
      <button class="btn" data-act="export">기록 내보내기</button></div>` : ""}
    <section class="today-card">
      <div class="tc-top">
        <h2>오늘의 PT</h2>
        <span class="tc-streak">${S.streakDays ? `🔥 ${S.streakDays}일 연속` : "오늘부터 시작"}</span>
      </div>
      <div class="tc-counts">
        <span class="cnt c-fresh" title="아직 한 번도 안 본 카드">신규 <b>${qc.fresh}</b></span>
        <span class="cnt c-relearn" title="몰랐다·부분이어서 오늘 다시 볼 카드">다시 <b>${qc.relearn}</b></span>
        <span class="cnt c-review" title="완벽이었지만 간격이 돌아온 카드">복습 <b>${qc.review}</b></span>
      </div>
      <div class="tc-goal">
        <div class="goal-bar"><div class="goal-fill" style="width:${Math.min(100, doneToday * 10)}%"></div></div>
        <span class="goal-txt">미니 골 ${Math.min(doneToday, 10)}/10장${doneToday >= 10 ? " ✅" : ""}</span>
      </div>
      <div class="actions">
        <button class="btn primary big" data-act="start-session"
          ${qc.fresh + dueNow ? "" : "disabled"}>${qc.fresh + dueNow ? "오늘의 PT 시작" : "오늘 볼 카드 없음 🎉"}</button>
        ${qc.chronic ? `<button class="btn" data-act="start-chronic">🔥 고질 약점만 (${qc.chronic})</button>` : ""}
      </div>
    </section>
    ${gichul.length ? `<h2 class="sec">기출 모드 <span>기출 프레임 그대로, 문서형 전체 보기</span></h2>` + gichul.map(quizCard).join("") : ""}
    ${review.length ? `<h2 class="sec">복습 모드 <span>단권화 기반 키워드 인출·설명</span></h2>` + review.map(quizCard).join("") : ""}
    ${DATA.length ? "" : '<div class="empty">아직 퀴즈가 없어요. data/ 폴더에 퀴즈 파일을 추가하세요.</div>'}
    <div class="ai-box">
      <div class="ai-row">
        <span>🤖 AI 의미 판정: <b class="${aiOn() ? "on" : ""}">${aiOn() ? "켜짐" : "꺼짐"}</b>
          <span class="ai-hint">— 표기가 달라도 의미가 같은 키워드를 인정 (온고지신 서버 사용, 키 불필요)</span></span>
        <button class="btn ghost" data-act="ai-onoff">${aiOn() ? "끄기" : "켜기"}</button>
      </div>
    </div>
    <footer class="home-foot">
      <span>기록 ${recCount}건 · 이 브라우저에 저장됨</span>
      <span class="spacer"></span>
      <button class="btn ghost" data-act="export">내보내기</button>
      <button class="btn ghost" data-act="import">가져오기</button>
      <input type="file" id="importFile" accept="application/json" hidden>
    </footer>`;
}

/* ---------- 소문항 블록 (목록·세션 공용) ---------- */
function subBlockHtml(quiz, q, sub, qi, si) {
  const id = subId(quiz, q, sub);
  let inputHtml = "";
  if (sub.type === "term") {
    inputHtml = sub.parts.map((p, pi) => `
      <div class="part-row"><span class="plabel">${esc(p.label)}</span>
      <input class="answer" data-part="${pi}" autocomplete="off" placeholder="용어만"></div>`).join("");
  } else if (sub.type === "essay") {
    inputHtml = `<textarea class="answer" placeholder="${esc(sub.ph || "한 문장으로 써 보세요 (입력 없이 정답만 봐도 돼요)")}"></textarea>`;
  }
  const gradeBtns = sub.type === "self"
    ? `<button class="btn primary" data-act="reveal">정답 보기</button>`
    : `<button class="btn primary" data-act="grade">채점하기</button>
       <button class="btn ghost" data-act="reveal">그냥 정답 보기</button>`;
  const ml = missLog(id);
  const mlHtml = ml.length ? `<div class="miss-log">📌 누가기록, 이전에 놓친 포인트: ` +
    ml.slice(0, 6).map(([n, c]) => `<b>${esc(n)}</b>${c > 1 ? ` ×${c}` : ""}`).join(" · ") +
    (ml.length > 6 ? " 외" : "") + `</div>` : "";
  return `
  <div class="sub" data-sid="${esc(id)}" data-quiz="${esc(quiz.id)}" data-q="${qi}" data-s="${si}">
    <div class="sub-head"><span class="sno">${esc(sub.no)}</span>
      ${sub.points ? `<span class="spts">[${sub.points}점]</span>` : ""}${dotsHtml(id)}</div>
    <div class="sub-prompt md">${md(sub.prompt)}</div>
    ${mlHtml}
    <div class="sub-input">${inputHtml}</div>
    <div class="sub-actions">${gradeBtns}</div>
    <div class="reveal"></div>
  </div>`;
}

/* ---------- 퀴즈 페이지 (전체 보기) ---------- */
function renderQuiz(quizId, weakOnly) {
  const quiz = DATA.find(z => z.id === quizId);
  if (!quiz) { location.hash = ""; return; }

  const qCards = quiz.questions.map((q, qi) => {
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

  const totalSubs = quiz.questions.reduce((a, q) => a + q.subs.length, 0);
  const doneSubs = quiz.questions.reduce((a, q) =>
    a + q.subs.filter(sub => latest(subId(quiz, q, sub))).length, 0);

  $("#app").innerHTML = `
    <div class="topbar">
      <a class="back" href="#">← 홈</a>
      <span class="ttl">${esc(quiz.title)}${weakOnly ? ' <span class="chip">틀린 것만</span>' : ""}</span>
      <span class="prog" id="prog">기록 ${doneSubs}/${totalSubs}</span>
    </div>
    <details class="rules"><summary>답안 규칙 (기출 채점 방식)</summary>
      <ul>${(quiz.rules || []).map(r => `<li>${esc(r)}</li>`).join("")}</ul>
    </details>
    ${qCards || '<div class="empty">다시 볼 소문항이 없어요. 전부 O!</div>'}`;
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
        ${st && st.chronic ? '<span class="chronic">🔥 고질 약점</span>' : ""}
        ${lastR
          ? `<span class="lastmark m-${lastR}">지난 판정 ${lastR === "T" ? "△" : lastR}</span>`
          : '<span class="lastmark m-new">처음 보는 카드</span>'}
      </div>
      <div class="q-head"><span class="qno">${esc(q.title)}</span>
        <span class="qpts">${esc(String(sub.no))}</span></div>
      ${q.body ? `<details class="ctx"><summary>지문·자료 펼치기</summary><div class="q-body md">${md(q.body)}</div></details>` : ""}
      ${subBlockHtml(quiz, q, sub, qi, si)}
    </section>`;
  window.scrollTo(0, 0);
}

function renderCheckpoint(finished) {
  const r = SESSION.results;
  const subs = allSubs();
  const mastered = subs.filter(x => { const l = latest(x.id); return l && l.r === "O"; }).length;
  const pct = subs.length ? Math.round(mastered / subs.length * 100) : 0;
  const left = SESSION.queue.length - SESSION.idx;
  const done = goalToday();
  $("#app").innerHTML = `
    <div class="checkpoint">
      <h2>${finished ? "오늘 큐 완주! 🎉" : "라운드 완료"}</h2>
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
        ? `오늘의 미니 골 달성 · 🔥 스트릭 ${S.streakDays || 1}일`
        : `오늘 ${done}장 풀었어요. 미니 골까지 ${10 - done}장`}</p>
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
async function aiJudgeKeywords(topic, model, names, input) {
  const res = await fetch(AI_FN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: AI_FN_KEY,
      Authorization: "Bearer " + AI_FN_KEY
    },
    body: JSON.stringify({ type: "grade_keywords", topic, model, names, answer: input })
  });
  const text = await res.text();
  if (!res.ok) throw new Error("HTTP " + res.status);
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error("서버 함수에 채점 기능이 아직 없어요 — 엣지 함수 재배포 필요"); }
  if (data.error) throw new Error(String(data.error).slice(0, 80));
  return data.results || [];
}

async function runAiJudge(subEl, topic, sub, input, literalFlags) {
  const missIdx = literalFlags.map((f, i) => (f ? -1 : i)).filter(i => i >= 0);
  const statusEl = () => subEl.querySelector(".ai-status");
  try {
    const results = await aiJudgeKeywords(
      topic, sub.answer, missIdx.map(i => sub.groups[i].name), input);
    const flags = literalFlags.slice();
    missIdx.forEach((gi, k) => {
      const r = results[k];
      if (r && r.found) {
        flags[gi] = true;
        const chip = subEl.querySelector(`.kw[data-g="${gi}"]`);
        if (chip) {
          chip.classList.remove("miss");
          chip.classList.add("hit", "ai");
          chip.textContent = "✓ " + sub.groups[gi].name + " (의미)";
          if (r.evidence) chip.title = "근거: " + r.evidence;
        }
      }
    });
    const s = statusEl();
    if (s) s.textContent = "🤖 AI 판정 완료 — 표기가 달라도 의미가 같으면 (의미)로 인정했어요. 칩에 마우스를 올리면 근거가 보여요.";
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
    if (s) s.textContent = "⚠️ AI 채점 실패(" + (e && e.message ? e.message : "오류") + ") — 문자 일치 판정만 반영했어요.";
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
    const flags = judgeEssay(input, sub.groups);
    suggest = suggestFrom(flags);
    judgeHtml = '<div class="kw-chips">' + sub.groups.map((g, i) =>
      `<span class="kw ${flags[i] ? "hit" : "miss"}" data-g="${i}" data-act="kw-toggle" data-name="${esc(g.name)}">${flags[i] ? "✓" : "✗"} ${esc(g.name)}</span>`).join("") + "</div>";
    if (aiOn() && norm(input) !== "" && flags.some(f => !f)) {
      judgeHtml += '<div class="ai-status">🤖 AI가 놓친 키워드의 의미 포함 여부를 판정하는 중…</div>';
      const { q } = findSub(subEl);
      setTimeout(() => runAiJudge(subEl, q.title, sub, input, flags), 0);
    }
    judgeHtml += '<div class="kw-note">판정이 틀렸으면 칩을 탭해서 ✓↔✗로 고칠 수 있어요.</div>';
  } else if (sub.type === "essay" || sub.type === "term") {
    // 눈풀이: 중립 칩 — 몰랐던 포인트를 탭해서 ✗로 표시하면 누가기록에 쌓인다
    const names = sub.type === "essay"
      ? sub.groups.map(g => g.name)
      : sub.parts.map(p => p.label + ": " + p.accept[0]);
    judgeHtml = '<div class="kw-note">답을 보고, <b>몰랐던 포인트를 탭</b>해서 ✗로 표시하세요 — 누가기록에 쌓여요.</div>' +
      '<div class="kw-chips">' + names.map(nm =>
      `<span class="kw" data-act="kw-toggle" data-name="${esc(nm)}">${esc(nm)}</span>`).join("") + "</div>";
  }

  subEl.querySelector(".reveal").innerHTML = `
    ${judgeHtml}
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
    const blob = new Blob([JSON.stringify(S, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "dajigi-records-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click(); URL.revokeObjectURL(a.href);
    S.lastExport = Date.now(); persist(); renderHome();
    return;
  }
  if (act === "import") { $("#importFile").click(); return; }
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
  if (act === "ai-onoff") {
    if (aiOn()) localStorage.setItem(AI_OFF_NAME, "1");
    else localStorage.removeItem(AI_OFF_NAME);
    renderHome();
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

  if (act === "grade") showReveal(subEl, true);
  if (act === "reveal") showReveal(subEl, false);
  if (act === "verdict") {
    const { quiz, id } = findSub(subEl);
    const missNames = [...subEl.querySelectorAll(".kw.miss")].map(c => c.dataset.name).filter(Boolean);
    record(id, btn.dataset.v, subEl.dataset.suggest || null, missNames);
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
  if (location.hash === "#today") { renderSession(); return; }
  const m = location.hash.match(/^#q\/([^/]+)(\/weak)?/);
  if (m) renderQuiz(decodeURIComponent(m[1]), !!m[2]);
  else { SESSION = null; renderHome(); }
}
window.addEventListener("hashchange", render);
document.addEventListener("click", onAppClick);
document.addEventListener("change", e => { if (e.target.id === "importFile") onImportFile(e); });
render();
