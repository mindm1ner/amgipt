/* 다지기 — 퀴즈 재풀이 + 키워드 판정 제안 + 소문항 단위 기록 (localStorage)
   판정 철학: 자동 판정은 "제안"일 뿐. 기록은 언제나 본인이 O·△·X 버튼을 눌러 확정한다. */
"use strict";

const DATA = window.DAJIGI_DATA || [];
const KEY = "dajigi_v1";
const AI_KEY_NAME = "dajigi_api_key";
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
function apiKey() { return localStorage.getItem(AI_KEY_NAME) || ""; }

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

  $("#app").innerHTML = `
    <header class="masthead">
      <h1>다지기</h1>
      <p>임용 복습 · 기출형 재풀이 + 단권화 키워드 인출</p>
    </header>
    ${needBackup ? `<div class="banner"><span>기록 ${recCount}건이 이 브라우저에만 있어요.
      ${staleDays !== null && staleDays > 0 ? `마지막 기록 ${staleDays}일 전. ` : ""}백업해 두세요.</span>
      <button class="btn" data-act="export">기록 내보내기</button></div>` : ""}
    ${gichul.length ? `<h2 class="sec">기출 모드 <span>기출 프레임 그대로 문제 풀기</span></h2>` + gichul.map(quizCard).join("") : ""}
    ${review.length ? `<h2 class="sec">복습 모드 <span>단권화 기반 키워드 인출·설명</span></h2>` + review.map(quizCard).join("") : ""}
    ${DATA.length ? "" : '<div class="empty">아직 퀴즈가 없어요. data/ 폴더에 퀴즈 파일을 추가하세요.</div>'}
    <div class="ai-box">
      <div class="ai-row">
        <span>🤖 AI 채점(의미 판정): <b class="${apiKey() ? "on" : ""}">${apiKey() ? "켜짐" : "꺼짐"}</b>
          <span class="ai-hint">— 켜면 표기가 달라도 의미가 같은 키워드를 인정해요</span></span>
        <button class="btn ghost" data-act="ai-toggle">${apiKey() ? "키 관리" : "API 키 넣기"}</button>
      </div>
      <div class="ai-panel" hidden>
        <input type="password" id="aiKeyInput" placeholder="sk-ant-… (Anthropic API 키)" autocomplete="off">
        <button class="btn primary" data-act="ai-save">저장</button>
        <button class="btn ghost" data-act="ai-clear">삭제</button>
        <p class="ai-note">키는 이 브라우저(localStorage)에만 저장되고, 채점 요청 때 Anthropic API로만 전송돼요.
        기록 내보내기 파일에는 포함되지 않아요. 공용 PC에서는 넣지 마세요.</p>
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
        inputHtml = `<textarea class="answer" placeholder="${esc(sub.ph || "한 문장으로 써 보세요 (입력 없이 정답만 봐도 돼요)")}"></textarea>`;
      }
      const gradeBtns = sub.type === "self"
        ? `<button class="btn primary" data-act="reveal">정답 보기</button>`
        : `<button class="btn primary" data-act="grade">채점하기</button>
           <button class="btn ghost" data-act="reveal">그냥 정답 보기</button>`;
      return `
      <div class="sub" data-sid="${esc(id)}" data-q="${qi}" data-s="${si}">
        <div class="sub-head"><span class="sno">${esc(sub.no)}</span>
          ${sub.points ? `<span class="spts">[${sub.points}점]</span>` : ""}${dotsHtml(id)}</div>
        <div class="sub-prompt md">${md(sub.prompt)}</div>
        <div class="sub-input">${inputHtml}</div>
        <div class="sub-actions">${gradeBtns}</div>
        <div class="reveal"></div>
      </div>`;
    }).join("");

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

/* ---------- AI 채점(의미 판정) ----------
   역할 분담: 판정 결과의 합산(O/△/X)은 언제나 고정 코드(suggestFrom).
   AI는 "문자 일치에 실패한 키워드가 의미상으로는 들어 있는가"라는 해석만 맡는다. */
const AI_SCHEMA = {
  type: "object", additionalProperties: false, required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["name", "found", "evidence"],
        properties: {
          name: { type: "string" },
          found: { type: "boolean" },
          evidence: { type: "string" }
        }
      }
    }
  }
};
const AI_SYSTEM = "너는 초등 임용 시험 채점 보조다. 임용 서술형은 채점 요소(키워드)가 답안에 포함되었는가의 싸움이다. 각 채점 요소에 대해 수험생 답안이 그 요소를 의미상 담고 있는지만 판정하라. 표기·어순·조사가 달라도 같은 의미면 found=true. 관련 내용이 없거나, 의미가 다르거나, 사실을 틀리게 썼으면 false. evidence에는 답안에서 근거가 된 구절을 20자 이내로 인용하라(근거 없으면 빈 문자열). 후하게 주지 마라 — 애매하면 false. 채점 요소 순서 그대로, 하나도 빠짐없이 결과를 반환하라.";

async function aiJudgeKeywords(topic, model, names, input) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey(),
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model: "claude-opus-5",
      max_tokens: 4000,
      output_config: { effort: "low", format: { type: "json_schema", schema: AI_SCHEMA } },
      system: AI_SYSTEM,
      messages: [{
        role: "user",
        content: "주제: " + topic +
          "\n\n모범답안(단권화 원문):\n" + model +
          "\n\n채점 요소:\n" + names.map((n, i) => (i + 1) + ". " + n).join("\n") +
          "\n\n수험생 답안:\n" + input
      }]
    })
  });
  if (!res.ok) throw new Error("HTTP " + res.status + (res.status === 401 ? " (키 확인 필요)" : ""));
  const data = await res.json();
  if (data.stop_reason === "refusal") throw new Error("판정 불가 응답");
  const textBlock = (data.content || []).find(b => b.type === "text");
  if (!textBlock) throw new Error("빈 응답");
  return JSON.parse(textBlock.text).results || [];
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
      `<span class="kw ${flags[i] ? "hit" : "miss"}" data-g="${i}">${flags[i] ? "✓" : "✗"} ${esc(g.name)}</span>`).join("") + "</div>";
    if (apiKey() && norm(input) !== "" && flags.some(f => !f)) {
      judgeHtml += '<div class="ai-status">🤖 AI가 놓친 키워드의 의미 포함 여부를 판정하는 중…</div>';
      const { q } = findSub(subEl);
      setTimeout(() => runAiJudge(subEl, q.title, sub, input, flags), 0);
    }
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
  if (act === "ai-toggle") {
    const p = $(".ai-panel"); if (p) p.hidden = !p.hidden;
    return;
  }
  if (act === "ai-save") {
    const v = ($("#aiKeyInput").value || "").trim();
    if (!v) { alert("키를 입력해 주세요."); return; }
    localStorage.setItem(AI_KEY_NAME, v);
    renderHome();
    return;
  }
  if (act === "ai-clear") {
    localStorage.removeItem(AI_KEY_NAME);
    renderHome();
    return;
  }

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
