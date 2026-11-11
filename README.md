# 푸드트럭하우스 견적 · 상담 챗봇

푸드트럭하우스 홈페이지에서 손님이 행사 견적을 바로 받아 보고, 상담을 신청할 수 있는 사이트입니다.

## 주요 기능

- **간편 견적**: 메뉴 · 인분 · 지역을 고르면 바로 견적 계산
- **대화 상담**: AI 챗봇(Claude)에게 말로 물어보면 메뉴 안내와 견적 계산
- **상담 접수 알림**: 손님이 연락처를 남기면 담당자 문자(알림톡) 발송, 구글시트 · 행사 보드에 기록
- **메뉴판 연동**: 메뉴 · 단가는 행사 보드(foodtruck-board)의 공개 메뉴판에서 읽어 옴

## 기술 스택

- 화면: HTML · CSS · JavaScript (빌드 없음)
- 서버: Vercel Serverless Functions (Node.js, 외부 패키지 없음)
- AI: Claude API
- DB: Supabase (행사 보드 DB)
- 알림: Solapi (문자 · 카카오 알림톡), Google Sheets

## 폴더 구조

```
index.html        홈페이지 견적 화면 ([간편 견적] · [대화 상담] 탭)
chatbot.html      예전 대화형 단독 화면 (지금은 안 씀)
*.jpg             챗봇이 보여 주는 메뉴판 · 현수막 · 캐노피 사진
api/
  chat.js         대화 상담 (Claude 호출, 견적 계산 · 상담 접수 도구 실행)
  menu.js         간편 견적 화면용 메뉴판
  notify.js       간편 견적 상담 신청 알림
lib/
  quote-calc.js   견적 계산 (간편 견적 · 챗봇 공통)
  quote-engine.js 챗봇용 견적 도구
  menu-source.js  메뉴판 읽기 (5분 캐시, 실패 시 menu-snapshot.json)
  knowledge.js    챗봇 응대 규칙 · 자주 묻는 질문 · 말투
  capacity.js     날짜별 차량 여유 확인
  chat-log.js     대화 기록 저장
  rate-limit.js   호출 횟수 제한
  lead-notify.js  상담 접수 문자
  sheet-log.js    구글시트 기록
```

## 시작하기

```bash
git clone https://github.com/hiting-labs/foodtruck-chatbot.git
cd foodtruck-chatbot
npm i -g vercel        # Vercel CLI가 없을 때
vercel link            # Vercel 프로젝트 foodtruck-quote 선택
vercel env pull .env   # 환경변수 받기 (.env는 커밋하지 않음)
vercel dev             # http://localhost:3000
```

## 환경변수

| 이름 | 용도 |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API 키 |
| `CHAT_MODEL` · `CHAT_THINKING` · `CHAT_EFFORT` | 모델 설정 (비워 두면 기본값) |
| `SUPABASE_URL` · `SUPABASE_ANON_KEY` | 행사 보드 DB |
| `CHAT_LOG_KEY` | 대화 기록 · 호출 횟수 저장용 키 |
| `SOLAPI_API_KEY` · `SOLAPI_API_SECRET` · `SOLAPI_SENDER` · `ALERT_TO` | 담당자 문자 |
| `KAKAO_PFID` · `KAKAO_TEMPLATE_ID` | 카카오 알림톡 |
| `SHEET_WEBHOOK_URL` | 구글시트 기록 (`리드저장_구글시트_설정.md` 참고) |
| `RL_*` · `CHAT_MAX_TURNS` | 호출 제한 기준 변경 (선택) |

키는 Vercel 환경변수에만 둡니다. 화면 코드나 저장소에 넣지 않습니다.

## 배포

`main` 브랜치에 머지되면 Vercel(프로젝트 `foodtruck-quote`)이 자동으로 운영 배포합니다. PR을 열면 미리보기 배포가 만들어집니다.

## 주의사항

- 가격은 AI가 만들지 않습니다. 모든 금액은 `lib/quote-calc.js`에서만 계산합니다.
- 가격은 이 저장소에 적지 않습니다. 행사 보드의 견적 메뉴판에서만 고칩니다.

## 관련 문서

- `CLAUDE.md`: 처음 만들 때의 설계 · 규칙
- `챗봇_로드맵_메모.md`, `챗봇_채울내용.md`: 진행 메모
- `리드저장_구글시트_설정.md`: 구글시트 연결 방법
