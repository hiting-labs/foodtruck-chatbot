const crypto = require('crypto');
const { logLead } = require('../lib/sheet-log.js');
const { logChat } = require('../lib/chat-log.js');

function readRaw(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
    req.on('error', () => resolve(''));
  });
}

// 솔라피 HMAC-SHA256 서명 생성
function authHeader(apiKey, apiSecret) {
  const date = new Date().toISOString();
  const salt = crypto.randomBytes(32).toString('hex');
  const signature = crypto.createHmac('sha256', apiSecret).update(date + salt).digest('hex');
  return `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`;
}

// 솔라피 단일 발송 호출
async function solapiSend(message, apiKey, apiSecret) {
  const r = await fetch('https://api.solapi.com/messages/v4/send', {
    method: 'POST',
    headers: { Authorization: authHeader(apiKey, apiSecret), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  const result = await r.json().catch(() => ({}));
  return { httpOk: r.ok, status: r.status, result };
}

// 발송 성공 여부 판정 (HTTP + 솔라피 상태코드)
function isOk(httpOk, result) {
  if (!httpOk) return false;
  const code = result && (result.statusCode || (result.groupInfo && result.groupInfo.status));
  if (code && !String(code).startsWith('2')) return false;
  return true;
}

function pickReason(result, status) {
  return (result && (result.errorMessage || result.message)) || ('HTTP ' + status);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'POST only' }); return; }

  const apiKey = process.env.SOLAPI_API_KEY;
  const apiSecret = process.env.SOLAPI_API_SECRET;
  const from = (process.env.SOLAPI_SENDER || '').replace(/\D/g, '');
  const to = (process.env.ALERT_TO || '').replace(/\D/g, '');
  const pfId = (process.env.KAKAO_PFID || '').trim();
  const templateId = (process.env.KAKAO_TEMPLATE_ID || '').trim();

  // 본문 파싱
  let data = req.body;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { data = null; } }
  if (!data || typeof data !== 'object') {
    const raw = await readRaw(req);
    try { data = JSON.parse(raw || '{}'); } catch (e) { data = {}; }
  }

  // 보드 '챗봇 상담'에도 남김(간편 견적 상담 신청) — 문자 성공 여부와 무관. 실패해도 무시
  if (data && data.board && typeof data.board === 'object') {
    try {
      const b = data.board, tools = [];
      if (b.lead && typeof b.lead === 'object') tools.push({ name: 'submit_lead', input: b.lead, status: 'submitted' });
      if (b.quote && typeof b.quote === 'object') tools.push(Object.assign({ name: 'calculate_quote', status: 'ok' }, b.quote));
      const meta = { source: 'quick', tools };
      if (JSON.stringify(meta).length < 20000) {
        await logChat({ sessionId: b.sid, page: 'quick', userText: (data.message || '').toString().slice(0, 3000), reply: String(b.reply || '간편 견적 화면에서 상담 신청').slice(0, 1000), meta });
      }
    } catch (e) {}
  }

  if (!apiKey || !apiSecret || !from || !to) {
    res.status(500).json({ ok: false, error: '환경변수가 비어 있습니다. SOLAPI_API_KEY, SOLAPI_API_SECRET, SOLAPI_SENDER, ALERT_TO 를 확인하세요.' });
    return;
  }


  // 문자(대체발송)용 전체 텍스트
  const text = (data.message || '새 견적 신청이 접수되었습니다.').toString().slice(0, 1000);
  // 알림톡 템플릿 치환값
  const v = (data.vars && typeof data.vars === 'object') ? data.vars : null;

  // 구글시트에 먼저 영구 기록(문자 발송 성공 여부와 무관하게 리드를 남긴다). 실패해도 무시.
  await logLead({
    source: '선택형폼',
    contactName: v ? (v['담당자'] || '') : '',
    phone: v ? (v['연락처'] || '') : '',
    region: v ? (v['지역'] || '') : '',
    menu: v ? (v['내역'] || '') : '',
    quote: v ? (v['금액'] || '') : '',
    datetime: v ? (v['배식'] || '') : '',
    note: v ? [v['문의'], v['전기'] ? ('전기: ' + v['전기']) : ''].filter(Boolean).join(' / ') : text,
  });

  // 문자(LMS) 메시지
  function lmsMessage() {
    return { to, from, text, type: 'LMS', subject: '푸드트럭 견적 신청' };
  }

  try {
    // 1) 알림톡 우선 발송 (pfId + templateId + 치환값이 모두 있을 때만)
    if (pfId && templateId && v) {
      const variables = {
        '#{담당자}': String(v['담당자'] || '-'),
        '#{연락처}': String(v['연락처'] || '-'),
        '#{지역}': String(v['지역'] || '-'),
        '#{배식}': String(v['배식'] || '-'),
        '#{전기}': String(v['전기'] || '-'),
        '#{내역}': String(v['내역'] || '-'),
        '#{금액}': String(v['금액'] || '-'),
        '#{문의}': String(v['문의'] || '없음'),
      };
      const ataMessage = {
        to, from,
        kakaoOptions: { pfId, templateId, variables, disableSms: true },
      };

      const ata = await solapiSend(ataMessage, apiKey, apiSecret);
      if (isOk(ata.httpOk, ata.result)) {
        res.status(200).json({ ok: true, channel: 'alimtalk' });
        return;
      }

      // 알림톡 실패 시 → 문자로 대체발송 (리드 놓치지 않게)
      const sms = await solapiSend(lmsMessage(), apiKey, apiSecret);
      if (isOk(sms.httpOk, sms.result)) {
        res.status(200).json({ ok: true, channel: 'sms-fallback' });
        return;
      }
      res.status(502).json({ ok: false, reason: pickReason(sms.result, sms.status) || pickReason(ata.result, ata.status) });
      return;
    }

    // 2) 알림톡 조건 미충족 → 문자(LMS) 발송
    const sms = await solapiSend(lmsMessage(), apiKey, apiSecret);
    if (isOk(sms.httpOk, sms.result)) {
      res.status(200).json({ ok: true, channel: 'sms' });
      return;
    }
    res.status(502).json({ ok: false, reason: pickReason(sms.result, sms.status) });
  } catch (e) {
    res.status(502).json({ ok: false, reason: String((e && e.message) || e) });
  }
};
