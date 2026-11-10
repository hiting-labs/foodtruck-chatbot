// lib/rate-limit.js
// 호출 횟수 제한: 한 사람(IP)이 너무 자주 보내거나, 하루 전체가 너무 많으면 AI·문자를 부르지 않고 안내만 돌려줌.
// 두 겹으로 셈:
//  1) 서버 메모리 — 항상 동작. 단 Vercel은 서버가 여러 대라 서버마다 따로 셈(빠른 연타 막기용)
//  2) 보드 DB(chat_rate_hit) — 모든 서버가 같이 셈. 열쇠(CHAT_LOG_KEY)가 있을 때만. DB가 느리거나 안 되면 막지 않고 통과
// 숫자는 환경변수로 바꿀 수 있음(아래 LIMITS). IP는 그대로 저장하지 않고 해시로만.
const crypto = require('crypto');

const SB_URL = process.env.SUPABASE_URL || 'https://vopoinbleggjqdbrxwpc.supabase.co';
const SB_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_HDlbxhnF0l4okkeZXmg7wg_m_Krjqds';
const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };

// kind별 기준: perMin = 한 사람 1분, perDay = 한 사람 하루, allDay = 전체 하루
const LIMITS = {
  chat:   { perMin: num('RL_CHAT_PER_MIN', 10), perDay: num('RL_CHAT_PER_DAY', 150), allDay: num('RL_CHAT_ALL_DAY', 2000) },
  notify: { perMin: num('RL_NOTIFY_PER_MIN', 3), perDay: num('RL_NOTIFY_PER_DAY', 20), allDay: num('RL_NOTIFY_ALL_DAY', 300) },
};

function clientIp(req) {
  const h = (req && req.headers) || {};
  const xf = String(h['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || String(h['x-real-ip'] || '') || (req && req.socket && req.socket.remoteAddress) || 'unknown';
}
function ipHash(ip) {
  return crypto.createHash('sha256').update('ftq-rl|' + (process.env.CHAT_LOG_KEY || '') + '|' + ip).digest('hex').slice(0, 20);
}
// 한국 시각 기준 분·날짜 글자 (예: 202611101530 / 20261110)
function stamps(now) {
  const k = new Date(now + 9 * 3600 * 1000).toISOString();
  const d = k.slice(0, 10).replace(/-/g, ''), m = d + k.slice(11, 16).replace(':', '');
  return { d, m };
}

// 1) 서버 메모리
const mem = new Map();   // key → { n, exp }
function memHit(key, ttlMs) {
  const now = Date.now();
  if (mem.size > 5000) for (const [k, v] of mem) if (v.exp < now) mem.delete(k);
  const e = mem.get(key);
  if (!e || e.exp < now) { mem.set(key, { n: 1, exp: now + ttlMs }); return 1; }
  e.n += 1; return e.n;
}

// 2) 보드 DB
async function dbHit(buckets) {
  const key = process.env.CHAT_LOG_KEY;
  if (!key) return null;
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 1500);
  try {
    const r = await fetch(`${SB_URL}/rest/v1/rpc/chat_rate_hit`, {
      method: 'POST', signal: ctl.signal,
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ p_key: key, p_buckets: buckets }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j) ? j : null;
  } catch (e) { return null; }
  finally { clearTimeout(tm); }
}

// 결과: { ok: true } 또는 { ok: false, why: 'min' | 'day' | 'all' }
async function checkRate(kind, req) {
  const L = LIMITS[kind]; if (!L) return { ok: true };
  if (process.env.RL_OFF === '1') return { ok: true };
  const h = ipHash(clientIp(req)), { d, m } = stamps(Date.now());
  const memMin = memHit(`${kind}:${h}:m`, 60 * 1000);
  const memDay = memHit(`${kind}:${h}:d:${d}`, 24 * 3600 * 1000);
  if (memMin > L.perMin) return { ok: false, why: 'min' };
  if (memDay > L.perDay) return { ok: false, why: 'day' };
  const c = await dbHit([`${kind}:ip:${h}:m:${m}`, `${kind}:ip:${h}:d:${d}`, `${kind}:all:d:${d}`]);
  if (c) {
    if (c[0] > L.perMin) return { ok: false, why: 'min' };
    if (c[1] > L.perDay) return { ok: false, why: 'day' };
    if (c[2] > L.allDay) return { ok: false, why: 'all' };
  }
  return { ok: true };
}

const PHONE = '1877-6901';
function limitMessage(why) {
  if (why === 'min') return `메시지가 너무 빠르게 이어지고 있어요. 잠시(1분 정도) 뒤에 다시 보내 주세요. 급하시면 대표번호 ${PHONE}로 전화 주세요.`;
  return `오늘은 상담 요청이 많아 대화 상담을 잠시 쉬고 있어요. 대표번호 ${PHONE}로 전화 주시면 바로 도와드릴게요.`;
}

module.exports = { checkRate, limitMessage, LIMITS, clientIp };
