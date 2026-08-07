/* 다지기 — 퀴즈 재풀이 + 키워드 판정 제안 + 소문항 단위 기록 (localStorage)
   판정 철학: 자동 판정은 "제안"일 뿐. 기록은 언제나 본인이 O·△·X 버튼을 눌러 확정한다. */
"use strict";

const DATA = window.DAJIGI_DATA || [];
const KEY = "dajigi_v1";
const DAY = 24 * 60 * 60 * 1000;

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
function record(id, r, auto) {
  const h = S.records[id] || (S.records[id] = []);
  const t = Date.now();
  const last = h[h.length - 1];
  // 같은 세션에서 판정을 바꾸면(10분 안) 새 줄이 아니라 정정으로 처리
  if (last && t - last.t < 10 * 60 * 1000) { last.r = r; last.a = auto || last.a; last.t = t; }
  else h.push({ d: new Date().toISOString().slice(0, 10), r, a: auto || null, t });
  persist();
}

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
function renderHome() {
  const recCount = Object.values(S.records).reduce((a, h) => a + h.length, 0);
  const needBackup = recCount > 0 && (!S.lastExport || Date.now() - S.lastExport > 7 * DAY);
  const lastTs = Object.values(S.records).flat().reduce((m, r) => Math.max(m, r.t || 0), 0);
  const staleDays = lastTs ? Math.floor((Date.now() - lastTs) / DAY) : null;

  const cards = DATA.map(quiz => {
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
      <div class="meta">${esc(quiz.scope)}<br>기반 기출: ${esc(quiz.base)}</div>
      <div class="stats">문항 ${quiz.questions.length} · 소문항 ${total} ·
        풀어봄 <b>${tried}</b> · 최근 O <b>${ok}</b>${weak ? ` · 다시 볼 것 <b>${weak}</b>` : ""}</div>
      <div class="actions">
        <a class="btn primary" href="#q/${quiz.id}">풀기</a>
        <a class="btn ${weak ? "" : "ghost"}" href="#q/${quiz.id}/weak"
           ${weak ? "" : 'style="pointer-events:none;opacity:.4"'}>틀린 것만 (${weak})</a>
      </div>
    </section>`;
  }).join("");

  $("#app").innerHTML = `
    <header class="masthead">
      <h1>다지기</h1>
      <p>임용 기출형 퀴즈 재풀이 · 소문항 단위 기록</p>
    </header>
    ${needBackup ? `<div class="banner"><span>기록 ${recCount}건이 이 브라우저에만 있어요.
      ${staleDays !== null && staleDays > 0 ? `마지막 기록 ${staleDays}일 전. ` : ""}백업해 두세요.</span>
      <button class="btn" data-act="export">기록 내보내기</button></div>` : ""}
    ${cards || '<div class="empty">아직 퀴즈가 없어요. data/ 폴더에 퀴즈 파일을 추가하세요.</div>'}
    <footer class="home-foot">
      <span>기록 ${recCount}건 · 이 브라우저에 저장됨</span>
      <span class="spacer"></span>
      <button class="btn ghost" data-act="export">내보내기</button>
      <button class="btn ghost" data-act="import">가져오기</button>
      <input type="file" id="importFile" accept="application/json" hidden>
    </footer>`;
}

/* ---------- 퀴즈 페이지 ---------- */
function renderQuiz(quizId, weakOnly) {
  const quiz = DATA.find(z => z.id === quizId);
  if (!quiz) { location.hash = ""; return; }

  const qCards = quiz.questions.map((q, qi) => {
    const subs = q.subs
      .map((sub, si) => ({ sub, si }))
      .filter(x => !weakOnly || isWeak(subId(quiz, q, x.sub)));
    if (!subs.length) return "";

    const subsHtml = subs.map(({ sub, si }) => {
      const id = subId(quiz, q, sub);
      let inputHtml = "";
      if (sub.type === "term") {
        inputHtml = sub.parts.map((p, pi) => `
          <div class="part-row"><span class="plabel">${esc(p.label)}</span>
          <input class="answer" data-part="${pi}" autocomplete="off" placeholder="용어만"></div>`).join("");
      } else if (sub.type === "essay") {
        inputHtml = `<textarea class="answer" placeholder="한 문장으로 써 보세요 (입력 없이 정답만 봐도 돼요)"></textarea>`;
      }
      const gradeBtns = sub.type === "self"
        ? `<button class="btn primary" data-act="reveal">정답 보기</button>`
        : `<button class="btn primary" data-act="grade">채점하기</button>
           <button class="btn ghost" data-act="reveal">그냥 정답 보기</button>`;
      return `
      <div class="sub" data-sid="${esc(id)}" data-q="${qi}" data-s="${si}">
        <div class="sub-head"><span class="sno">${esc(sub.no)}</span>
          <span class="spts">[${sub.points}점]</span>${dotsHtml(id)}</div>
        <div class="sub-prompt md">${md(sub.prompt)}</div>
        <div class="sub-input">${inputHtml}</div>
        <div class="sub-actions">${gradeBtns}</div>
        <div class="reveal"></div>
      </div>`;
    }).join("");

    return `
    <section class="q-card">
      <div class="q-head"><span class="qno">${q.no}번 · ${esc(q.title)}</span>
        <span class="qpts">[${q.points}점]</span></div>
      <div class="q-frame">${esc(q.frame)}</div>
      <div class="q-body md">${md(q.body)}</div>
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

/* ---------- 채점 → 제안 → 본인 확정 ---------- */
function currentQuiz() {
  const m = location.hash.match(/^#q\/([^/]+)/);
  return m ? DATA.find(z => z.id === decodeURIComponent(m[1])) : null;
}
function findSub(el) {
  const quiz = currentQuiz();
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
    judgeHtml = sub.parts.map((p, i) => `
      <div class="part-verdict">${flags[i] ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>'}
      ${esc(p.label)} — 정답: <b>${esc(p.accept[0])}</b></div>`).join("");
  } else if (graded && sub.type === "essay") {
    const input = subEl.querySelector("textarea.answer").value;
    const flags = judgeEssay(input, sub.groups);
    suggest = suggestFrom(flags);
    judgeHtml = '<div class="kw-chips">' + sub.groups.map((g, i) =>
      `<span class="kw ${flags[i] ? "hit" : "miss"}">${flags[i] ? "✓" : "✗"} ${esc(g.name)}</span>`).join("") + "</div>";
  } else if (sub.type === "essay") {
    judgeHtml = '<div class="kw-chips">' + sub.groups.map(g =>
      `<span class="kw">${esc(g.name)}</span>`).join("") + "</div>";
  }

  const chosen = null;
  subEl.querySelector(".reveal").innerHTML = `
    ${judgeHtml}
    <div class="model"><span class="lbl">모범답안</span><div class="md">${md(sub.answer)}</div></div>
    ${sub.note ? `<div class="note">${esc(sub.note)}</div>` : ""}
    <div class="verdict-row">
      <span class="vlbl">내 판정${suggest ? ` (제안: ${vName(suggest)})` : ""} →</span>
      ${["O", "T", "X"].map(v => `
        <button class="vbtn ${v === suggest ? "suggest" : ""} ${v === chosen ? "chosen" : ""}"
          data-act="verdict" data-v="${v}">${v === "T" ? "△" : v}</button>`).join("")}
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

  const subEl = btn.closest(".sub");
  if (!subEl) return;

  if (act === "grade") showReveal(subEl, true);
  if (act === "reveal") showReveal(subEl, false);
  if (act === "verdict") {
    const { id } = findSub(subEl);
    record(id, btn.dataset.v, subEl.dataset.suggest || null);
    subEl.querySelectorAll(".vbtn").forEach(b => b.classList.toggle("chosen", b === btn));
    subEl.querySelector(".saved-msg").textContent = "기록됨";
    const head = subEl.querySelector(".sub-head");
    head.querySelector(".dots")?.remove();
    head.insertAdjacentHTML("beforeend", dotsHtml(id));
    // 진행 표시 갱신
    const quiz = currentQuiz();
    if (quiz) {
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
  const m = location.hash.match(/^#q\/([^/]+)(\/weak)?/);
  if (m) renderQuiz(decodeURIComponent(m[1]), !!m[2]);
  else renderHome();
}
window.addEventListener("hashchange", render);
document.addEventListener("click", onAppClick);
document.addEventListener("change", e => { if (e.target.id === "importFile") onImportFile(e); });
render();
