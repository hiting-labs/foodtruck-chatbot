# 푸드트럭하우스 홈페이지 견적 · 상담 챗봇

손님이 홈페이지에서 **간편 견적**(메뉴·인분·지역을 골라 바로 계산)이나 **대화 상담**(AI 챗봇에게 말로 물어보기)으로 견적을 받고, 연락처를 남기면 담당자에게 알림이 가는 사이트입니다.
행사 보드(foodtruck-board)와는 별도 저장소이고, Vercel에 올라갑니다.

## 화면

| 파일 | 내용 |
|---|---|
| `index.html` | 홈페이지 견적 화면 — [간편 견적] · [대화 상담] 두 탭 |
| `chatbot.html` | 예전 대화형 단독 화면 (지금은 안 씀) |
| `*-chat.jpg`, `*-zoom.jpg` | 챗봇이 보여 주는 메뉴판 · 현수막 · 우천 캐노피 사진 |

## 서버 (Vercel 함수)

| 파일 | 하는 일 |
|---|---|
| `api/chat.js` | 대화 상담. 손님 말을 Claude(AI)에 넘기고, AI가 견적 계산·상담 접수 도구를 부르면 실행해서 답을 돌려줌. 호출 횟수 제한 · 대화 기록 저장 포함 |
| `api/menu.js` | 간편 견적 화면이 쓰는 메뉴판 |
| `api/notify.js` | 간편 견적 상담 신청 → 담당자 문자(알림톡) · 구글시트 · 보드 '챗봇 상담' 기록 |

## 핵심 규칙 (lib)

| 파일 | 내용 |
|---|---|
| `lib/quote-calc.js` | **견적 계산** — 간편 견적과 챗봇이 같은 계산을 씀. 최소 금액, 출장비, 현수막, 범위 금액, 장소 섭외 안내 |
| `lib/quote-engine.js` | 챗봇용 견적 도구 (메뉴 이름 → 메뉴판 단가, 날짜별 차량 여유 안내) |
| `lib/menu-source.js` | 메뉴판을 **보드 DB의 공개 메뉴판(site_menus)** 에서 읽음 (5분 캐시, 실패하면 `menu-snapshot.json`) |
| `lib/knowledge.js` | 챗봇 응대 규칙 · 자주 묻는 질문 · 말투 (= AI에게 주는 지시문) |
| `lib/capacity.js` | 손님이 말한 날짜에 직영 차량 여유를 보고 응대 깊이를 정함 (손님에겐 말하지 않음) |
| `lib/chat-log.js` | 대화를 보드 DB에 저장 → 보드 더보기 '💬 챗봇 상담'에서 봄 (1년 보관) |
| `lib/rate-limit.js` | 호출 횟수 제한 (한 사람 1분 10번 · 하루 150번, 전체 하루 2,000번) |
| `lib/lead-notify.js`, `lib/sheet-log.js` | 상담 접수 문자 · 구글시트 기록 |

## 꼭 지킬 것

- **가격은 AI가 지어내지 않음** — 모든 금액은 계산 코드(`quote-calc.js`)에서만 나옴.
- **가격은 이 저장소에 적지 않음** — 보드 견적 메뉴판 한 곳에서만 고침 (보드에서 바꾸면 홈페이지도 같이 바뀜).
- 키(AI · 문자 · DB 열쇠)는 Vercel 환경변수에만. 화면 코드에 넣지 않음.

## 환경변수 (Vercel)

| 이름 | 용도 |
|---|---|
| `ANTHROPIC_API_KEY` | Claude AI |
| `CHAT_MODEL` · `CHAT_THINKING` · `CHAT_EFFORT` | 모델 설정 (기본 Sonnet 5.5, 비워 두면 기본값) |
| `SUPABASE_URL` · `SUPABASE_ANON_KEY` | 보드 DB (비워 두면 운영 DB 공개 키) |
| `CHAT_LOG_KEY` | 대화 기록 · 호출 횟수 DB 열쇠 (보드 DB `chat_log_secret` 값) |
| `SOLAPI_*` · `ALERT_TO` · `KAKAO_*` | 담당자 문자 · 알림톡 |
| `SHEET_WEBHOOK_URL` | 구글시트 기록 (`리드저장_구글시트_설정.md`) |
| `RL_*` · `CHAT_MAX_TURNS` | 호출 제한 기준 바꿀 때만 |

## 올리는 순서

1. `dev` 브랜치에 커밋 → push
2. GitHub에서 `dev → main` PR → 대표님 계정이 머지 → Vercel이 자동 배포
3. 보드 DB가 바뀌는 기능이면 **운영 DB에 SQL 먼저** (보드 저장소 `db/` 폴더)

## 시험

- 시험 서버 · 회귀 시험 도구는 저장소 밖(`Desktop\foodtruck-tools`)에 있음 — 테스트 DB 메뉴판으로 돌고 문자는 안 나감.
- 고친 뒤에는 회귀 시험(대화 23개 자동 채점)을 돌려 답이 망가지지 않았는지 확인.

## 관련 문서

- `CLAUDE.md` — 처음 만들 때의 설계 · 규칙
- `챗봇_로드맵_메모.md`, `챗봇_채울내용.md` — 진행 메모
- 보드 쪽 보고서: `Desktop\foodtruck-reports\조사_홈페이지견적챗봇_2026-11-05.html`
