# 다지기 — 임용 복습 사이트

기출형 퀴즈를 다시 꺼내 풀고, 키워드 판정 + 소문항 단위 O·△·X 기록으로 약한 곳을 보여 주는 정적 사이트.

- 라이브: https://mindm1ner.github.io/dajigi/
- 소스(단일 원본): `10-projects/11-app-dev/dajigi/` ← 여기를 고치고 배포 repo로 복사·push
- 배포 repo: `mindm1ner/dajigi` (GitHub Pages, main 브랜치 루트)
- 기획서: [기획-게이트.md](기획-게이트.md)

## 구조

```
index.html      셸. 새 퀴즈 추가 시 data/ script 한 줄 추가
app.css         스타일
app.js          라우터·판정(고정 코드)·기록(localStorage)·AI 채점
data/quiz-*.js  기출 모드 데이터 (window.DAJIGI_DATA.push 형식)
data/dan-*.js   복습 모드 데이터 (window.DAJIGI_DAN.push — 단권화 원문 기반)
```

## 두 모드

- **기출 모드**: 기출 프레임 병렬 출제 퀴즈를 문항 그대로 푼다.
- **복습 모드(단권화)**: 단권화 표에서 뽑은 항목별로 ①키워드 인출 ver ②설명 쓰기 ver.
  데이터는 `dan-*.js`의 `items: [{no, title, groups, model}]` — 앱이 소문항 2개로 펼친다.
  `model`은 단권화 **원문 그대로**(요약 금지 — 스모크 테스트가 키워드↔원문 대조를 검사).

## AI 채점 (의미 판정)

- 홈 하단에서 Anthropic API 키 입력(localStorage `dajigi_api_key` — 기록 내보내기에 미포함).
- 흐름: 문자 일치 판정(고정 코드) → 놓친 키워드만 `claude-opus-5`에 의미 포함 여부 질의
  (구조화 출력 json_schema로 응답 고정, effort low) → 의미 인정 키워드는 점선 칩 "(의미)" + 근거 툴팁.
- ⭐ 최종 O/△/X 합산은 언제나 고정 코드(`suggestFrom`) — AI는 키워드별 해석만.
- 키 없음/요청 실패 → 문자 일치 판정만으로 동작(그레이스풀 폴백).

## 판정 규칙 (고정 코드 — app.js)

- 정규화: 소문자화 + 공백·문장부호(·괄호 등) 제거
- 용어(term) 문항: 정규화 후 `accept` 목록과 **일치** 비교
- 서술(essay) 문항: 정규화 후 키워드 그룹별 **포함** 검사 → 전부 히트 O / 일부 △ / 없음 X
- ⭐ 자동 판정은 **제안**일 뿐. 기록은 본인이 O·△·X 버튼을 눌러야 저장된다.
  입력 없이 "그냥 정답 보기 → 원클릭 판정"도 정식 플로우(폰에서 눈풀이용).

## 기록

- `localStorage` 키 `dajigi_v1`. 소문항 단위 `{d(날짜), r(O/T/X), a(자동 제안), t(타임스탬프)}`
- 같은 소문항을 10분 안에 다시 판정하면 새 줄이 아니라 정정으로 처리
- 홈 하단 내보내기/가져오기(JSON 병합). 7일 이상 백업 없으면 홈에 배너 경고
- 기기(폰↔노트북) 이동 = 내보내기 → 가져오기

## 새 퀴즈 추가 (md 파서 없음 — 의도된 결정)

퀴즈 md를 자동 파싱하지 않는다(파싱 10원칙: 추출기를 늘리지 않는다). 대신 **Claude에게 이관을 위임**한다:

1. 퀴즈 md는 지금처럼 `20-study/22-과목별노트/{과목}/퀴즈/`에 만든다 (공부 흐름 유지)
2. Claude에게 "다지기에 올려줘"라고 하면 → `00-system/commands/dajigi-add.md` 지침대로
   md를 `data/quiz-{날짜}-{주제}.js`로 변환(키워드 그룹 설계 포함)하고 index.html에 script 줄 추가 후 배포

데이터 스키마는 `data/quiz-2026-08-05-hanguksa.js` 맨 위 주석과 실제 구조를 본뜬다.
- `type: "term"` → `parts: [{label, accept: [정답 표기들]}]`
- `type: "essay"` → `groups: [{name, variants: [부분 문자열들]}]` — variants는 어간(예: "갈라지", "이어받")까지 줄여서 어미 변화를 흡수
- `type: "self"` → 자동 판정 불가한 문항. 모범답안만 보여 주고 본인 판정

## 배포

```bash
# 소스 수정 후:
cd 배포클론 && cp -r (소스)/index.html (소스)/app.* (소스)/data . && git add -A && git commit && git push
```
