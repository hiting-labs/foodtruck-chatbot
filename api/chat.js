// api/chat.js
// 백엔드 프록시: 프론트에서 대화 내역을 받아 Claude API에 넘기고,
// AI가 견적 도구를 부르면 quote-engine으로 계산해 다시 넘긴 뒤, 최종 답변만 프론트로 돌려준다.
// ★ ANTHROPIC_API_KEY 는 Vercel 환경변수. 프론트엔드에 절대 노출하지 않는다.

const { calculateQuote } = require('../lib/quote-engine.js');
const { getMenuData, menuPromptText } = require('../lib/menu-source.js');
const { SYSTEM_KNOWLEDGE, CLASSIC_DRINKS } = require('../lib/knowledge.js');
const { sendLeadAlert } = require('../lib/lead-notify.js');
const { logLead } = require('../lib/sheet-log.js');
const { logChat } = require('../lib/chat-log.js');
const { capacityCheck, capacityGuide } = require('../lib/capacity.js');
const { checkRate, limitMessage } = require('../lib/rate-limit.js');

// 대화 크기 제한 (비용·악용 방지): 손님 말 40번 넘으면 전화 안내, 한 말은 2,000자까지
const MAX_USER_TURNS = Number(process.env.CHAT_MAX_TURNS) || 40;
const MAX_USER_CHARS = 2000, MAX_BOT_CHARS = 6000, MAX_MESSAGES = 100;

// 상담용 모델. 환경변수 CHAT_MODEL로 바꿀 수 있음(기본 claude-sonnet-5-5, 되돌리려면 claude-sonnet-4-6). Sonnet 5.5는 생각 설정(CHAT_THINKING·CHAT_EFFORT)을 같이 맞춤
const MODEL = process.env.CHAT_MODEL || 'claude-sonnet-5-5';   // 2026-11-10 4.6 → 5.5 (회귀 17개·시험 손님 30명 비교: 2배 빠르고 약 1/3 저렴, 품질 같거나 나음)
const IS_S55 = /^claude-sonnet-5-5/.test(MODEL);
const S55_THINKING = process.env.CHAT_THINKING || 'adaptive';   // adaptive(필요할 때만 짧게) / between_tools(생각 끔)
const S55_EFFORT = process.env.CHAT_EFFORT || 'low';
// 요금(달러, 100만 토큰당) — 대화 기록에 비용을 같이 남기기 위함. Sonnet 4.6은 공개 요금 기준, 바뀌면 여기만 고침
const PRICE = { 'claude-sonnet-4-6': { in: 3, out: 15, cw: 3.75, cr: 0.30 }, 'claude-sonnet-5-5': { in: 2, out: 10, cw: 2.5, cr: 0.20 } };

// AI에게 알려줄 도구 정의
const tools = [
  {
    name: 'calculate_quote',
    description: '고객 정보(메뉴·인분수·지역 등)가 충분히 모였을 때만 호출한다. 정확한 견적을 계산해 반환한다. 이 도구 없이 절대 금액을 말하지 않는다. 메뉴는 "현재 메뉴판"의 메뉴 이름 그대로, 인분과 함께만 넘긴다(단가는 넘기지 않는다 — 메뉴판에서 자동으로 찾음).',
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: '주문 메뉴 항목들',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '현재 메뉴판의 메뉴 이름 (예: 감자핫도그, 베이직세트(커피음료 7종))' },
              servings: { type: 'number', description: '인분 수' },
            },
            required: ['name', 'servings'],
          },
        },
        region: { type: 'string', description: '행사 지역·도시 (예: 수원, 판교, 부산)' },
        serviceHours: { type: 'number', description: '배식 시간(시간). 모르면 3' },
        startTime: { type: 'string', description: '배식 시작 시각 HH:MM (손님이 말했을 때만, 예: 10:00)' },
        eventDate: { type: 'string', description: '행사 날짜 YYYY-MM-DD (손님이 날짜를 말했으면 오늘 날짜 기준으로 바꿔서 꼭 넣기. 모르면 비움)' },
        powerAvailable: { type: 'boolean', description: '220V 전기 연결 가능 여부. 고객이 "전기 없다/모른다"면 false, 말 안 했으면 넣지 않음' },
        venueStatus: { type: 'string', enum: ['확정', '미정', '허가필요'], description: '트럭 진행 장소: 정해짐 / 아직 미정 / 학교·공원 등 허가 필요. 말 안 했으면 넣지 않음' },
        sideBanners: { type: 'array', items: { type: 'string', enum: ['좌', '우'] }, description: '좌·우 옆면 현수막: 원하면 ["좌","우"](한쪽만이면 그쪽), 필요 없다고 했으면 [] 빈 배열, 아직 안 물어봤으면 넣지 않음 (상단·중앙은 항상 기본이라 넣지 않음)' },
        extras: {
          type: 'array',
          description: '고객이 원한 기타비용만: 발전기 / X배너 / 스티커(1,000장 단위 qty) / 섹터이동 / 모니터 / 실내부스. 여러 개면 qty',
          items: { type: 'object', properties: { name: { type: 'string' }, qty: { type: 'number' } }, required: ['name'] },
        },
        offMenu: { type: 'string', description: '메뉴판에 없는 요청(있으면 그대로)' },
      },
      required: ['items', 'region'],
    },
  },
  {
    name: 'submit_lead',
    description: '고객이 상담을 원하거나 연락처를 남겼을 때 호출한다. 담당자에게 상담 리드를 문자로 전달하고, 보드에서 행사·견적서를 만들 때 이 값을 그대로 쓴다. 반드시 성함(회사명)과 연락처를 받은 뒤에만 호출한다. 이후 견적서 정보(회사명·담당자·이메일·주소·결제방식 등)를 더 받으면 지금까지 받은 값 전부를 담아 isUpdate:true로 한 번 더 호출한다.',
    input_schema: {
      type: 'object',
      properties: {
        contactName: { type: 'string', description: '담당자명 또는 회사명' },
        phone: { type: 'string', description: '연락처(전화번호)' },
        region: { type: 'string', description: '행사 지역(있으면)' },
        menu: { type: 'string', description: '문의 메뉴·인분 요약(있으면)' },
        quote: { type: 'string', description: '안내한 견적 금액 요약(있으면)' },
        datetime: { type: 'string', description: '행사 날짜·시간(있으면)' },
        note: { type: 'string', description: '기타 문의·특이사항(있으면). 손님이 남긴 번호가 본인 번호가 아니라고 했으면 "본인 번호 아님(손님 말)"을 꼭 적음' },
        company: { type: 'string', description: '회사·기관명 = 견적서 상호/행사명 (예: 판교테크)' },
        contactPerson: { type: 'string', description: '담당자 이름·직함 (예: 김과장)' },
        email: { type: 'string', description: '견적서 받을 이메일' },
        address: { type: 'string', description: '행사 정확한 주소·장소 (예: 성남시 분당구 판교역로 235 광장)' },
        payMethod: { type: 'string', description: '결제 방식: 세금계산서 / 카드 / 현금영수증 / 계좌이체 중 고객이 그걸로 하겠다고 정한 것만. "카드 되나요?"처럼 묻기만 했으면 비우고 note에 "카드 결제 문의"' },
        eventDate: { type: 'string', description: '행사 날짜 YYYY-MM-DD (오늘 날짜 기준으로 바꿔서). 모르면 비움' },
        serveTime: { type: 'string', description: '배식 시간 HH:MM~HH:MM (예: 11:00~14:00). 모르면 비움' },
        drinkChoice: { type: 'string', description: '커피 세트 음료 구성: 손님이 고른 음료, 또는 고르지 않았으면 "기본 구성(임시) · 통화 때 확인". 커피 세트가 없으면 비움' },
        callTime: { type: 'string', description: '손님이 말한 통화 편한 시간대(예: 오후 2~5시). 물어봐서 들었을 때만' },
        isUpdate: { type: 'boolean', description: '이 대화에서 submit_lead를 이미 한 번 불렀고, 정보를 보태려고 다시 부르는 경우에만 true. 처음 부르면 넣지 않음' },
      },
      required: ['contactName', 'phone'],
    },
  },
];

// 접수가 실제로 된 답 끝에 서버가 붙이는 정해진 한 줄 — 화면이 답 글을 그대로 다시 보내므로 다음 턴에 이 줄로 '이미 접수됨'을 안다
// (서버는 이전 턴의 도구 호출을 받지 못함. 모델이 "접수 안 됐다"고 단정하던 일 막기)
const LEAD_MARK = { ko: '✅ 상담 접수 완료 — 담당자에게 전달됐어요', koUpdate: '✅ 추가 정보 전달 완료 — 담당자에게 전달됐어요', en: '✅ Your request has been sent to our staff.' };
const LEAD_MARK_RE = /✅ (상담 접수 완료|추가 정보 전달 완료)|✅ Your request has been sent/;
// 이 줄이 생기기 전 대화를 위한 보조 판단: 앞선 챗봇 답의 접수 완료 문장("접수도 됐어요"·"접수했어요"·"접수해 두었어요" 등)
const LEAD_DONE = /(접수|전달)\s*(처리\s*)?(가|도|는|이|은)?\s*(잘\s*)?(됐|되었|완료|했|해\s*(두었|뒀|드렸))|has been (submitted|received|passed|sent)/i;

// 손님이 넣은 값 정리 — 담당자 문자에 줄바꿈으로 가짜 머리글·"대표 승인 완료" 같은 줄이 끼던 일 막기
// 칸마다 줄바꿈을 공백으로, 길이 제한, 링크·머리글처럼 보이면 표시를 붙임
function cleanLeadValue(v, max) {
  let s = String(v).replace(/\s+/g, ' ').trim();   // \s는 줄바꿈·탭·줄 구분 문자(U+2028·2029)까지 포함
  // 꺾쇠는 전각으로 — 보드 화면에 이스케이프 없이 그리는 곳이 있어 태그가 되지 않게(문자는 HTML이 아니라 읽는 데 지장 없음)
  s = s.replace(/</g, '＜').replace(/>/g, '＞');
  if (s.length > max) s = s.slice(0, max) + '…';
  if (/https?:\/\/|www\.|\[[^\]]{0,40}\]/i.test(s)) s += ' (손님 글·확인 안 됨)';
  return s;
}
function cleanLead(input) {
  const out = {};
  for (const [k, v] of Object.entries(input || {})) out[k] = typeof v === 'string' ? cleanLeadValue(v, k === 'note' ? 500 : 200) : v;
  return out;
}
// 구글시트에서 =·+·-·@로 시작하는 값은 수식으로 실행될 수 있어 앞에 '를 붙임
const sheetSafe = (v) => (/^[=+\-@]/.test(String(v || '')) ? "'" + v : (v || ''));

// 지난 날짜면 다음 해로 — 모델이 연도를 틀리게 넣는 일(2027-01-15 → 2026-01-15)이 있어서. 담당자가 알 수 있게 표시를 남김
function fixPastDate(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d || ''))) return { date: d, note: '' };
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  if (d >= today) return { date: d, note: '' };
  const next = (Number(d.slice(0, 4)) + 1) + d.slice(4);
  return next >= today ? { date: next, note: ' (연도 자동 보정, 확인 필요)' } : { date: d, note: ' (지난 날짜, 확인 필요)' };
}

// 글 속 금액 → 숫자 목록 ("1,215,000~1,350,000원", "133만 1천 원")
function amounts(s) {
  const out = [];
  for (const m of String(s || '').matchAll(/(\d+(?:\.\d+)?)\s*만\s*(?:(\d)\s*천)?|\d{1,3}(?:,\d{3})+|\d{5,}/g)) {
    out.push(m[1] ? Math.round(Number(m[1]) * 10000 + (m[2] ? Number(m[2]) * 1000 : 0)) : Number(m[0].replace(/,/g, '')));
  }
  return out;
}

// 금액 숫자(1개=한 금액, 2개=범위) → 문자 견적 줄. withVat=false면 부가세 포함은 빼고 씀
function amountText(nums, withVat = true) {
  const won = (n) => Math.round(n).toLocaleString('ko-KR');
  const range = nums.length > 1, w = (xs) => (range ? '약 ' : '') + xs.map(won).join('~') + '원';
  return `${w(nums)} (부가세 별도${range ? ', 확정 전' : ''})` + (withVat ? ` · 부가세 포함 ${w(nums.map((n) => n * 1.1))}` : '');
}

// 모델 quote에 금액·기본 말 말고 다른 말("하루치", "제주 출장비 별도 안내" 등)이 있으면 원문을 뒤에 붙임 — 계산 결과로 바꿔 쓸 때 사라지지 않게
function quoteExtra(modelQuote) {
  const rest = String(modelQuote || '').replace(/(\d+(?:\.\d+)?)\s*만\s*(?:\d\s*천)?|\d{1,3}(?:,\d{3})+|\d{5,}/g, '')
    .replace(/합계|약|원|부가세\s*(별도|포함)|출장비\s*포함|확정\s*전|[~()·,./:\s-]/g, '');
  return rest ? ` / 챗봇 안내: ${modelQuote}` : '';
}

// 문자 견적 줄. 순서: ① 이번 요청의 calculate_quote 결과(접수가 이번 답보다 먼저 실행돼 대화 기록엔 아직 없음)
// ② 손님에게 보여 준 "**합계 …**" 줄(계산기 summaryLine) 중 모델 quote와 금액이 같은 것 ③ 모델 quote 그대로(영어 등 합계 줄 없음)
// 같은 게 없으면(메뉴를 바꿨는데 최소 미달, A·B 비교 등) 둘 다 적고 확인 필요 표시 — 이때 맞지 않는 줄의 부가세 포함은 빼서 확정처럼 안 보이게
function quoteLine(modelQuote, botTexts, calcs = []) {
  const q = amounts(modelQuote);
  const same = (nums) => nums.length > 0 && nums.every((n) => q.includes(n));
  if (calcs.length) {
    const last = calcs[calcs.length - 1];
    if (last.status !== 'ok') return modelQuote || '최소 금액 미달 · 수량 조정 상담 필요';
    const nums = (c) => (c.mode === 'range' ? [c.rangeLow, c.rangeHigh] : [c.subtotal]);
    const ok = calcs.filter((c) => c.status === 'ok');
    const pick = [...ok].reverse().find((c) => same(nums(c))) || last;   // 같은 요청에 A·B를 계산했으면 모델이 고른 쪽
    return amountText(nums(pick)) + quoteExtra(modelQuote);
  }
  const sums = [];
  for (const t of botTexts) for (const l of String(t || '').split('\n')) if (/^\s*\*\*합계/.test(l)) sums.push(amounts(l.replace(/\(.*$/, '')).slice(0, 2));
  if (!sums.filter((s) => s.length).length) return modelQuote || '';
  for (let i = sums.length - 1; i >= 0; i--) if (modelQuote && same(sums[i])) return amountText(sums[i]) + quoteExtra(modelQuote);
  const last = amountText(sums.filter((s) => s.length).pop(), false);
  return modelQuote ? `${modelQuote} / 대화 마지막 합계: ${last} (견적 확인 필요)` : `${last} (견적 확인 필요)`;
}

// 상담 리드를 담당자에게 문자로 발송 (ctx: 날짜 보정 표시, 손님에게 보여 준 챗봇 글)
async function handleLead(input, ctx = {}) {
  const p = input || {};
  const quote = quoteLine(p.quote, ctx.botTexts || [], ctx.calcs || []);
  const when = [p.eventDate, p.serveTime].filter(Boolean).join(' ');
  const org = [p.company, p.contactPerson].filter(Boolean).join(' ');
  const who = [org, p.contactName && !org.includes(p.contactName) ? p.contactName : ''].filter(Boolean).join(' / ');   // 회사명이 있어도 손님 이름이 빠지지 않게
  const lines = [
    p.isUpdate ? '[푸드트럭하우스 챗봇 상담 · 추가 정보]' : '[푸드트럭하우스 챗봇 상담 신청]',
    `담당자/회사: ${who || '-'}`,
    `연락처: ${p.phone || '-'}`,
  ];
  if (p.email) lines.push(`이메일: ${p.email}`);
  if (when) lines.push(`날짜·시간: ${when}${ctx.dateNote || ''}`);
  if (p.address) lines.push(`주소: ${p.address}`);
  if (p.callTime) lines.push(`통화 편한 시간: ${p.callTime}`);
  if (p.payMethod) lines.push(`결제: ${p.payMethod}`);
  if (p.region) lines.push(`지역: ${p.region}`);
  if (p.menu) lines.push(`메뉴/인분: ${p.menu}`);
  if (p.drinkChoice) lines.push(`음료 구성: ${p.drinkChoice}`);
  if (quote) lines.push(`견적: ${quote}`);
  const norm = (s) => String(s).replace(/\s/g, '').replace(/\d{4}-/g, '');   // 연도 보정으로 연도만 달라진 건 같은 글로 봄
  if (p.datetime && (!when || norm(p.datetime) !== norm(when))) lines.push(`일정: ${p.datetime}`);   // 날짜·시간 줄과 같은 글일 때만 생략(여러 날 일정 등은 남김)
  if (p.note) lines.push(`문의: ${p.note}`);

  const res = await sendLeadAlert(lines.join('\n'));

  // 구글시트에도 영구 기록(문자를 놓쳐도 리드를 잃지 않기 위함). 실패해도 무시.
  // 시트 칸은 Apps Script에 고정돼 있어 음료 구성은 note에 붙임
  await logLead({
    source: '대화형챗봇',
    contactName: sheetSafe(p.contactName),
    phone: sheetSafe(p.phone),
    region: sheetSafe(p.region),
    menu: sheetSafe(p.menu),
    quote: sheetSafe(quote),
    datetime: sheetSafe(when ? when + (ctx.dateNote || '') : p.datetime),
    note: sheetSafe([p.note, p.drinkChoice && `음료 구성: ${p.drinkChoice}`].filter(Boolean).join(' / ')),
  });

  // AI에게는 항상 접수됨을 알려 고객에게 안심 안내하도록 한다(발송 실패해도 대화상 리드는 남음).
  return res.ok
    ? { status: 'submitted', message: '담당자에게 상담 신청이 전달되었습니다.' }
    : { status: 'received', message: '상담 신청이 접수되었습니다. (담당자 확인 예정)' };
}

// 한국 시간 오늘 날짜 (예: 오늘: 2026-11-06 (금))
function todayText() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  const w = '일월화수목금토'[d.getUTCDay()];
  return `오늘: ${d.toISOString().slice(0, 10)} (${w}) — 한국 시간`;
}

// 커피 세트(2·4·7종) 견적에서 음료 구성을 묻는 답 → { kind:'drinks', count, defaults, options }
function drinkPicker(reply) {
  const t = String(reply || '');
  if (!/음료는 기본 구성|바꾸고 싶은 음료|원하시는 음료로|음료를 골라|음료 구성/.test(t) || !/\?|말씀해 주세요|정하셔도/.test(t)) return null;
  const m = t.match(/\(커피음료\s*([247])종\)[^\n]*\n\s*└\s*([^\n]+)/);
  if (!m) return null;
  const count = Number(m[1]);
  const base = (x) => x.replace(/\(아이스\)/g, '').trim();
  const line = m[2].includes('기본') ? m[2].split(/기본[:：]?/).pop() : m[2];   // "15종 중 7가지 선택 (기본: …)" → 기본 뒤만
  const defaults = line.replace(/[()*]/g, ' ').split(/[·,/]/).map((x) => x.trim()).filter((x) => x && x.length <= 14)
    .map((x) => (base(x) === '아이스티' ? '복숭아아이스티' : x))   // 아이스티는 복숭아 하나뿐이라 합침(레몬 등이 생기면 따로 구분)
    .map((x) => CLASSIC_DRINKS.find((c) => base(c) === base(x)) || x);   // "아샷추" → 목록 이름 "아샷추(아이스)"
  const options = [...new Set([...defaults, ...CLASSIC_DRINKS])];
  return { kind: 'drinks', count, defaults: defaults.slice(0, count), options };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }
  try {
    const { messages: rawMessages, sessionId, page } = req.body || {};
    if (!Array.isArray(rawMessages)) {
      return res.status(400).json({ error: 'messages 배열이 필요합니다.' });
    }
    // 손님 화면이 보내는 건 글자 대화뿐 — 그 외 모양은 버리고, 너무 긴 말은 자름
    const messages = rawMessages
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .slice(-MAX_MESSAGES)
      .map(m => ({ role: m.role, content: m.role === 'user' && m.content.length > MAX_USER_CHARS
        ? m.content.slice(0, MAX_USER_CHARS) + '\n\n(손님 말이 너무 길어 뒷부분이 잘렸어요. 놓친 내용이 있을 수 있으니 필요한 건 다시 여쭤보세요.)'   // 잘린 걸 챗봇이 알게
        : m.content.slice(0, m.role === 'user' ? MAX_USER_CHARS : MAX_BOT_CHARS) }));
    while (messages.length && messages[0].role !== 'user') messages.shift();
    if (!messages.length) return res.status(400).json({ error: '메시지가 비어 있어요.' });

    // 호출 횟수 제한 — 걸리면 AI를 부르지 않고 안내만 (손님 화면엔 보통 답처럼 보임)
    const rate = await checkRate('chat', req);
    if (!rate.ok) return res.status(200).json({ reply: limitMessage(rate.why), limited: rate.why });
    const lastSaysPhone = /01[016789][-\s.]?\d{3,4}[-\s.]?\d{4}/.test(messages[messages.length - 1].content);   // 연락처를 남기는 말은 길어도 받아서 접수
    if (messages.filter(m => m.role === 'user').length > MAX_USER_TURNS && !lastSaysPhone) {
      return res.status(200).json({ reply: '대화가 길어져서 여기부터는 담당자가 직접 도와드리는 게 정확해요. 대표번호 1877-6901로 전화 주시거나, 성함과 연락처를 남겨 주시면 담당자가 연락드릴게요. 새로 상담하시려면 위의 ↺ 새로 시작을 눌러 주세요.', limited: 'turns' });
    }

    const convo = [...messages];
    const lastUser = [...messages].reverse().find(m => m && m.role === 'user' && typeof m.content === 'string');
    const meta = { tools: [] };   // 이번 답에서 쓴 도구 요약 → 대화 기록에 같이 남김
    const usage = { model: MODEL, calls: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };   // 이번 답에 쓴 토큰(여러 번 부르면 합산)
    const menuText = menuPromptText(await getMenuData());   // 보드 견적 메뉴판 → 챗봇이 아는 메뉴·가격

    const preTexts = [];   // 도구를 부르기 전에 쓴 글(예: "네, 카드 결제 가능해요!") — 예전엔 마지막 답만 보내서 이 글이 빠졌음
    const calcs = [];   // 이번 요청에서 돌린 calculate_quote 결과(차례대로)
    let leadKind = null;   // 이번 요청에서 접수했으면 'new'(새 접수) / 'update'(추가 정보)
    // 글자가 있는 가장 최근 손님 말이 한글 없이 영어면 영어 손님("300"처럼 숫자만 있는 말은 건너뜀)
    const lastWords = [...messages].reverse().find((m) => m.role === 'user' && /[가-힣A-Za-z]/.test(m.content));
    const english = !!lastWords && !/[가-힣]/.test(lastWords.content) && /[A-Za-z]{2,}/.test(lastWords.content);
    let leadSent = messages.some((m) => m.role === 'assistant' && (LEAD_MARK_RE.test(m.content) || LEAD_DONE.test(m.content)));   // 이미 접수한 대화면 다음 접수는 '추가 정보'로
    // 이미 접수한 대화면 모델에게도 알림(앞 턴의 도구 호출은 모델에 가지 않아 "접수 안 됐다"고 단정하던 일)
    const leadNote = leadSent ? [{ type: 'text', text: '[봇에게] 이 대화에서는 이미 상담 접수가 됐어요(담당자에게 전달됨). 손님이 접수 여부를 물으면 "네, 접수돼 있어요"라고 답하고, 정보를 보태면 submit_lead로 추가하세요. 내부 도구 이름은 말하지 않습니다.' }] : [];
    // 도구 호출이 나오면 실행하고 다시 물어보는 루프 (최대 3회)
    for (let i = 0; i < 3; i++) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: IS_S55 ? 4096 : 1024,
          ...(IS_S55 ? { thinking: { type: S55_THINKING }, output_config: { effort: S55_EFFORT } } : {}),
          // 프롬프트 캐싱: 고정 지식(system)에 캐시 지점을 두면 tools+system이 함께 캐시된다.
          // 반복 요청 시 이 부분은 재계산하지 않고 캐시에서 읽어 비용·속도를 크게 줄인다(답변 품질은 동일).
          system: [
            { type: 'text', text: SYSTEM_KNOWLEDGE },
            { type: 'text', text: menuText, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: todayText() },   // 날짜는 캐시 지점 뒤에(매일 바뀜)
            ...leadNote,
          ],
          tools,
          messages: convo,
        }),
      });

      const data = await r.json();
      if (data && data.usage) { const u = data.usage; usage.calls++; usage.input += u.input_tokens || 0; usage.output += u.output_tokens || 0; usage.cacheWrite += u.cache_creation_input_tokens || 0; usage.cacheRead += u.cache_read_input_tokens || 0; }
      if (data.error) {
        return res.status(500).json({ error: data.error.message || 'API 오류' });
      }

      if (data.stop_reason === 'tool_use') {
        const toolUses = data.content.filter((b) => b.type === 'tool_use');
        convo.push({ role: 'assistant', content: data.content });
        // 단, "잠깐만요, 계산해 볼게요!" 같은 빈말 줄은 빼고(바로 뒤에 "견적 나왔어요"가 와서 같은 말을 두 번 하는 것처럼 보임)
        const FILLER = /^(잠깐만?요?|잠시만?요?|네)?[,!~ ]*[^.?!]{0,40}(계산|확인|정리|반영|접수)[^.?!]{0,12}(볼게요|드릴게요|할게요|하겠습니다|해 볼게요)[!.~ 🙂😊]*$|^let me (calculate|check)/i;
        const pre = data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
          .split('\n').filter((l) => !FILLER.test(l.trim())).join('\n').trim();
        if (pre) preTexts.push(pre);

        const runTool = async (tu) => {
          let out;
          if (tu.name === 'calculate_quote') {
            const cin = Object.assign({}, tu.input, tu.input && tu.input.eventDate ? { eventDate: fixPastDate(tu.input.eventDate).date } : {});   // 지난 날짜면 다음 해로(날짜 여유 조회용)
            out = await calculateQuote(cin);
            // 영어 손님이면 장소 안내 자리에 정해 둔 영어 문구를 넣음(매뉴얼 지시만으로는 한국어 원문이 가끔 그대로 나감)
            if (english && out.venueNoticeEn) out = Object.assign({}, out, { venueNotice: out.venueNoticeEn });
            calcs.push(out);   // 같은 요청의 접수 문자 견적 줄에 씀
            meta.tools.push({ name: 'calculate_quote', input: cin, status: out.status, subtotal: out.subtotal, rangeLow: out.rangeLow, rangeHigh: out.rangeHigh, mode: out.mode, region: out.region, items: out.items, costs: out.costs, banners: out.banners, capacity: out.capacity });   // 보드에서 견적서 품목 채울 때 씀
          } else if (tu.name === 'submit_lead') {
            const input = cleanLead(tu.input);   // 손님이 넣은 값 정리(문자·시트·보드 기록 모두 이 값)
            if (leadSent) input.isUpdate = true;   // 모델이 isUpdate를 빠뜨려 같은 손님이 '상담 신청'으로 여러 번 들어가던 일 막기
            leadSent = true;
            const fd = fixPastDate(input.eventDate); input.eventDate = fd.date;
            const botTexts = [...messages.filter((m) => m.role === 'assistant').map((m) => m.content), ...preTexts];
            out = await handleLead(input, { dateNote: fd.note, botTexts, calcs });
            // 날짜가 있으면 그날 직영 여유(보드 '챗봇 상담'에 🟢/🟡/🟠로 표시 + 이후 응대 깊이)
            // 전기 없다는 말이 대화에 있었으면 발전기까지 따져서 판단 (예전엔 빠져서 발전기 모자란 날도 '여유'로 나왔음)
            const allUser = convo.filter((m) => m.role === 'user' && typeof m.content === 'string').map((m) => m.content).join(' ');
            const powerOff = /전기\s*(가|는|도)?\s*(없|안\s*(돼|되|들어)|불가|모르)|콘센트\s*(가|는)?\s*없/.test(allUser);
            const cap = input.eventDate ? await capacityCheck(input.eventDate, input.menu || '', powerOff) : null;
            const guide = capacityGuide(cap); if (guide) out = Object.assign({}, out, { note: guide });
            // 연락처와 함께 온 질문을 접수 인사로 덮어 버리는 일이 잦아서 도구 결과에 다시 짚어 줌
            out = Object.assign({}, out, { reminder: '[봇에게] 손님의 마지막 말에 질문(결제·가격·가능 여부 등)이 있었다면 답의 첫 줄에서 그 질문에 먼저 답한 뒤 접수 안내를 하세요.' });
            meta.tools.push({ name: 'submit_lead', input, status: out.status, capacity: cap ? cap.level : undefined });
            meta.lead = true;
            leadKind = leadKind === 'new' || !input.isUpdate ? 'new' : 'update';   // 답 끝 접수 표시 줄 고르기
          } else {
            out = { error: 'unknown tool' };
          }
          return {
            type: 'tool_result',
            tool_use_id: tu.id,
            content: JSON.stringify(out),
          };
        };
        // 계산을 먼저 다 끝낸 뒤 접수(같은 답에서 둘 다 부르면 접수 문자에 새 견적이 실리게), 접수끼리는 차례로(두 번째가 '추가 정보'가 되게)
        const done = {};
        await Promise.all(toolUses.filter((tu) => tu.name !== 'submit_lead').map(async (tu) => { done[tu.id] = await runTool(tu); }));
        for (const tu of toolUses.filter((t) => t.name === 'submit_lead')) done[tu.id] = await runTool(tu);
        const results = toolUses.map((tu) => done[tu.id]);

        convo.push({ role: 'user', content: results });
        continue; // 결과를 넣고 한 번 더 AI에게 물어본다
      }

      // 도구 없이 바로 답한 경우 → 최종 답변 반환
      // 도구 전에 쓴 글 중 마지막 답에 이미 같은 말이 있는 문장은 뺌(같은 합계·"접수됐어요"가 두 번 보이던 문제)
      const finalText = data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const key = (s) => s.replace(/[\s*#😊🙂🎉😅📞👍✅!.,~?]/g, '');
      const finalKey = key(finalText);
      const ANNOUNCE = /접수|견적.{0,4}(나왔|뽑아|내\s*드릴)|계산해|확인해 드릴게요|정리해 드릴게요|감사해요!?$|감사합니다!?$/;
      const keptPre = preTexts.map((p) => p.split('\n').filter((l) => {
        const k = key(l); if (!k) return true;
        // "접수할게요" 같은 알림 줄은 빼되, "네, 카드 결제 가능해요! 접수할게요"처럼 질문 답이 섞인 줄은 남김
        if (ANNOUNCE.test(l.trim()) && l.trim().length < 60 && !/가능|돼요|됩니다|어려|안\s*돼|있어요|없어요/.test(l)) return false;
        return !(k.length >= 6 && finalKey.includes(k));
      }).join('\n').trim()).filter(Boolean);
      let reply = [...keptPre, finalText]
        .join('\n\n')
        .replace(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/gm, '')   // 채팅창에 그대로 보이는 구분선 줄 제거
        .replace(/^\s*>\s?/gm, '')                       // 인용 기호(>)도 그대로 보여서 제거
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      // 조율·확인이 필요한 답은 전화 상담으로 이어지게: 아직 번호를 안 받았고 이번 대화에서 연락처를 물은 적도 없으면 한 줄 붙임
      // (규칙 글만으로는 "인원·지역 알려 주세요"로 끝나는 경우가 있어 서버에서 보장)
      const userTexts = convo.filter((m) => m.role === 'user' && typeof m.content === 'string').map((m) => m.content).join(' ');
      const hasPhone = /01[016789][-\s.]?\d{3,4}[-\s.]?\d{4}/.test(userTexts) || meta.lead;
      const askedBefore = messages.some((m) => m.role === 'assistant' && /연락처|1877-6901/.test(String(m.content || '')));
      // "담당자 확인" 말이 목록 줄(- · •)에만 있으면 원칙 설명 같은 글이라 붙이지 않음(내부 지침 질문 답 끝에 연락처 요청이 붙던 일)
      const consultLine = reply.split('\n').some((l) => /담당자.{0,20}(확인|조율)/.test(l) && !/^\s*([-·•*]|\d+\.)\s/.test(l));
      if (!hasPhone && !askedBefore && consultLine && !/연락처|1877-6901/.test(reply)) {
        reply += '\n\n담당자가 전화로 바로 맞춰 드릴 수 있게, 성함(회사명)·연락처와 통화 편한 시간을 알려 주시겠어요? 바로 통화를 원하시면 대표번호 **1877-6901**로 주셔도 돼요.';
      }
      // 이번 요청에서 접수했으면 답 끝에 정해진 접수 표시 줄(다음 턴의 '이미 접수됨' 판단 근거 + 손님에게도 분명히)
      if (leadKind) reply += '\n\n' + (english ? LEAD_MARK.en : leadKind === 'update' ? LEAD_MARK.koUpdate : LEAD_MARK.ko);
      // 상담 기록은 답을 먼저 보낸 뒤 저장 (손님 대기 시간 줄이기). Vercel이 응답 뒤에도 끝까지 기다리게 waitUntil 사용,
      // 그 기능이 없는 곳(로컬 시험 서버 등)에서는 예전처럼 저장하고 나서 보냄
      // 이번 답의 비용(달러) — 대화 기록(meta.usage)에 남겨 보드에서 대화별 비용을 볼 수 있게
      const pr = PRICE[MODEL.replace(/-\d{8}$/, '')];
      if (pr) usage.usd = Math.round(((usage.input * pr.in + usage.output * pr.out + usage.cacheWrite * pr.cw + usage.cacheRead * pr.cr) / 1e6) * 1e5) / 1e5;
      meta.usage = usage;
      const logP = logChat({ sessionId, page, userText: lastUser && lastUser.content, reply, meta }).catch(() => {});
      const vctx = globalThis[Symbol.for('@vercel/request-context')];
      const ctx = vctx && typeof vctx.get === 'function' ? vctx.get() : null;
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(logP); else await logP;
      // 음료 구성을 묻는 답이면 화면 아래(입력칸 위)에 '음료 고르기' 버튼을 띄우게 목록을 같이 보냄
      // (대화가 길면 메뉴는 위, 답은 아래라 손님이 위아래로 오가야 했음)
      const picker = drinkPicker(reply);
      return res.status(200).json(picker ? { reply, usage, picker } : { reply, usage });
    }

    return res.status(200).json({ reply: '죄송해요, 잠시 후 다시 시도해 주세요.' });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
};
