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
        note: { type: 'string', description: '기타 문의·특이사항(있으면)' },
        company: { type: 'string', description: '회사·기관명 = 견적서 상호/행사명 (예: 판교테크)' },
        contactPerson: { type: 'string', description: '담당자 이름·직함 (예: 김과장)' },
        email: { type: 'string', description: '견적서 받을 이메일' },
        address: { type: 'string', description: '행사 정확한 주소·장소 (예: 성남시 분당구 판교역로 235 광장)' },
        payMethod: { type: 'string', description: '결제 방식: 세금계산서 / 카드 / 현금영수증 / 계좌이체 중 고객이 말한 것' },
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

// 상담 리드를 담당자에게 문자로 발송
async function handleLead(input) {
  const p = input || {};
  const lines = [
    p.isUpdate ? '[푸드트럭하우스 챗봇 상담 · 추가 정보]' : '[푸드트럭하우스 챗봇 상담 신청]',
    `담당자/회사: ${[p.company, p.contactPerson].filter(Boolean).join(' ') || p.contactName || '-'}`,
    `연락처: ${p.phone || '-'}`,
  ];
  if (p.email) lines.push(`이메일: ${p.email}`);
  if (p.eventDate || p.serveTime) lines.push(`날짜·시간: ${[p.eventDate, p.serveTime].filter(Boolean).join(' ')}`);
  if (p.address) lines.push(`주소: ${p.address}`);
  if (p.callTime) lines.push(`통화 편한 시간: ${p.callTime}`);
  if (p.payMethod) lines.push(`결제: ${p.payMethod}`);
  if (p.region) lines.push(`지역: ${p.region}`);
  if (p.menu) lines.push(`메뉴/인분: ${p.menu}`);
  if (p.quote) lines.push(`견적: ${p.quote}`);
  if (p.datetime) lines.push(`일정: ${p.datetime}`);
  if (p.note) lines.push(`문의: ${p.note}`);

  const res = await sendLeadAlert(lines.join('\n'));

  // 구글시트에도 영구 기록(문자를 놓쳐도 리드를 잃지 않기 위함). 실패해도 무시.
  await logLead({
    source: '대화형챗봇',
    contactName: p.contactName || '',
    phone: p.phone || '',
    region: p.region || '',
    menu: p.menu || '',
    quote: p.quote || '',
    datetime: p.datetime || '',
    note: p.note || '',
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
    .map((x) => CLASSIC_DRINKS.find((c) => base(c) === base(x)) || x);   // "아이스티" → 목록 이름 "아이스티(아이스)"
  const options = [...new Set([...defaults, ...CLASSIC_DRINKS])];
  return { kind: 'drinks', count, defaults: defaults.slice(0, count), options };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }
  try {
    const { messages, sessionId, page } = req.body || {};
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages 배열이 필요합니다.' });
    }

    const convo = [...messages];
    const lastUser = [...messages].reverse().find(m => m && m.role === 'user' && typeof m.content === 'string');
    const meta = { tools: [] };   // 이번 답에서 쓴 도구 요약 → 대화 기록에 같이 남김
    const usage = { model: MODEL, calls: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };   // 이번 답에 쓴 토큰(여러 번 부르면 합산)
    const menuText = menuPromptText(await getMenuData());   // 보드 견적 메뉴판 → 챗봇이 아는 메뉴·가격

    const preTexts = [];   // 도구를 부르기 전에 쓴 글(예: "네, 카드 결제 가능해요!") — 예전엔 마지막 답만 보내서 이 글이 빠졌음
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

        const results = await Promise.all(toolUses.map(async (tu) => {
          let out;
          if (tu.name === 'calculate_quote') {
            out = await calculateQuote(tu.input);
            meta.tools.push({ name: 'calculate_quote', input: tu.input, status: out.status, subtotal: out.subtotal, rangeLow: out.rangeLow, rangeHigh: out.rangeHigh, mode: out.mode, region: out.region, items: out.items, costs: out.costs, banners: out.banners, capacity: out.capacity });   // 보드에서 견적서 품목 채울 때 씀
          } else if (tu.name === 'submit_lead') {
            out = await handleLead(tu.input);
            // 날짜가 있으면 그날 직영 여유(보드 '챗봇 상담'에 🟢/🟡/🟠로 표시 + 이후 응대 깊이)
            // 전기 없다는 말이 대화에 있었으면 발전기까지 따져서 판단 (예전엔 빠져서 발전기 모자란 날도 '여유'로 나왔음)
            const allUser = convo.filter((m) => m.role === 'user' && typeof m.content === 'string').map((m) => m.content).join(' ');
            const powerOff = /전기\s*(가|는|도)?\s*(없|안\s*(돼|되|들어)|불가|모르)|콘센트\s*(가|는)?\s*없/.test(allUser);
            const cap = tu.input && tu.input.eventDate ? await capacityCheck(tu.input.eventDate, tu.input.menu || '', powerOff) : null;
            const guide = capacityGuide(cap); if (guide) out = Object.assign({}, out, { note: guide });
            // 연락처와 함께 온 질문을 접수 인사로 덮어 버리는 일이 잦아서 도구 결과에 다시 짚어 줌
            out = Object.assign({}, out, { reminder: '[봇에게] 손님의 마지막 말에 질문(결제·가격·가능 여부 등)이 있었다면 답의 첫 줄에서 그 질문에 먼저 답한 뒤 접수 안내를 하세요.' });
            meta.tools.push({ name: 'submit_lead', input: tu.input, status: out.status, capacity: cap ? cap.level : undefined });
            meta.lead = true;
          } else {
            out = { error: 'unknown tool' };
          }
          return {
            type: 'tool_result',
            tool_use_id: tu.id,
            content: JSON.stringify(out),
          };
        }));

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
      if (!hasPhone && !askedBefore && /담당자.{0,20}(확인|조율)/.test(reply) && !/연락처|1877-6901/.test(reply)) {
        reply += '\n\n담당자가 전화로 바로 맞춰 드릴 수 있게, 성함(회사명)·연락처와 통화 편한 시간을 알려 주시겠어요? 바로 통화를 원하시면 대표번호 **1877-6901**로 주셔도 돼요.';
      }
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
