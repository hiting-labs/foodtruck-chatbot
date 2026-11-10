// lib/chat-log.js
// 대화 상담 기록을 보드 DB(chat_logs)에 한 줄씩 넣는다 — 직원이 보드에서 다시 보고 연락하기 위함.
// ★ 넣기는 열쇠(CHAT_LOG_KEY, Vercel 환경변수)가 있어야만 됨 — 보드 DB의 chat_log_add 함수가 확인.
//   열쇠가 없으면 기록하지 않고 넘어감. 실패해도 손님 대화에는 영향 없음. 읽기는 보드에 로그인한 직원만.
const SB_URL = process.env.SUPABASE_URL || 'https://vopoinbleggjqdbrxwpc.supabase.co';
const SB_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_HDlbxhnF0l4okkeZXmg7wg_m_Krjqds';

function cut(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) : s; }

async function logChat({ sessionId, page, userText, reply, meta }) {
  const key = process.env.CHAT_LOG_KEY;
  if (!key) return { ok: false, skipped: 'no key' };
  const sid = String(sessionId || '');
  if (sid.length < 8 || sid.length > 64) return { ok: false, skipped: 'no session' };
  const rows = [];
  if (userText) rows.push({ session_id: sid, role: 'user', content: cut(userText, 6000), meta: null, page: cut(page, 30) || null });
  if (reply) rows.push({ session_id: sid, role: 'assistant', content: cut(reply, 6000), meta: meta || null, page: cut(page, 30) || null });
  if (!rows.length) return { ok: false };
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 3000);
  try {
    const r = await fetch(`${SB_URL}/rest/v1/rpc/chat_log_add`, {
      method: 'POST', signal: ctl.signal,
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ p_key: key, p_rows: rows }),
    });
    return { ok: r.ok, status: r.status };
  } catch (e) { return { ok: false, error: String(e) }; }
  finally { clearTimeout(tm); }
}

module.exports = { logChat };
