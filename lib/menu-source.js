// lib/menu-source.js
// ★ 메뉴·가격·출장비·기타비용의 원본 = 보드 견적 메뉴판(quote_menus) 하나.
//   홈페이지는 원가를 뺀 공개용 보기(site_menus)를 읽는다. 보드에서 가격을 고치면 빠른 견적·대화 상담이 같이 바뀐다.
//   연결이 안 될 때만 lib/menu-snapshot.json(마지막 사본)으로 동작한다 — 사이트가 멈추지 않게.

const SB_URL = process.env.SUPABASE_URL || 'https://vopoinbleggjqdbrxwpc.supabase.co';          // 운영 보드 DB
const SB_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_HDlbxhnF0l4okkeZXmg7wg_m_Krjqds'; // 공개용(publishable) 키 — 원래 공개해도 되는 키
const TTL_MS = 5 * 60 * 1000;   // 5분마다 새로 읽음

// 메뉴판 분류 → 홈페이지 표시 이름 · 메뉴별 최소 인분
const CAT_INFO = {
  '커피음료':          { label: '커피·음료',           min: 50 },
  '간식류':            { label: '간식',               min: 50 },
  '디저트&베이커리':    { label: '디저트·베이커리',     min: 50 },
  '컵과일&아이스크림':  { label: '컵과일·아이스크림·빙수', min: 50 },
  '분식류':            { label: '분식',               min: 50 },
  '겨울간식':          { label: '겨울간식',            min: 50 },
  '식사-덮밥류':        { label: '식사 · 덮밥',         min: 100 },
  '식사-누들류':        { label: '식사 · 면',           min: 100 },
  '식사-기타 및 안주류': { label: '식사 · 기타·안주',    min: 100 },
  '뷔페':              { label: '출장뷔페',            min: 200 },
};
const FEE_CATS = ['출장비', '기타비용', '부대', '서비스'];
function catInfo(c) {
  if (CAT_INFO[c]) return CAT_INFO[c];
  return { label: String(c).replace(/&/g, '·'), min: /^식사/.test(c) ? 100 : 50 };
}

// 기타비용 줄 이름 → 계산에 쓰는 키
const FEE_KEYS = [
  ['gen', /발전기/], ['overHour', /시간추가/], ['print', /출력물/], ['sticker', /스티커 추가/],
  ['monitor', /모니터/], ['sector', /섹터/], ['booth', /실내부스/],
];

// 고객·AI가 흔히 쓰는 이름 → 메뉴판 이름 (띄어쓰기·괄호 차이는 따로 처리함)
const ALIAS = {
  '2종실속세트': '실속세트(커피음료 2종)', '실속세트': '실속세트(커피음료 2종)',
  '4종간편세트': '간편세트(커피음료 4종)', '간편세트': '간편세트(커피음료 4종)',
  '7종베이직세트': '베이직세트(커피음료 7종)', '베이직세트': '베이직세트(커피음료 7종)',
  '15종클래식세트': '클래식세트(커피음료 15종+)', '클래식세트': '클래식세트(커피음료 15종+)',
  '떡+튀': '분식 2종(떡튀/떡순/떡어)', '떡+순': '분식 2종(떡튀/떡순/떡어)', '떡+어': '분식 2종(떡튀/떡순/떡어)',
  '떡튀': '분식 2종(떡튀/떡순/떡어)', '떡순': '분식 2종(떡튀/떡순/떡어)', '떡어': '분식 2종(떡튀/떡순/떡어)',
  '떡+튀+순': '분식 3종(떡튀순/떡튀어/떡순어)', '떡+튀+어': '분식 3종(떡튀순/떡튀어/떡순어)', '떡+순+어': '분식 3종(떡튀순/떡튀어/떡순어)',
  '떡튀순': '분식 3종(떡튀순/떡튀어/떡순어)', '떡튀어': '분식 3종(떡튀순/떡튀어/떡순어)', '떡순어': '분식 3종(떡튀순/떡튀어/떡순어)',
  '떡+튀+순+어': '떡튀순어',
  '어묵1+물떡1': '어떡(어묵1+물떡1)', '어묵(어묵1+물떡1)': '어떡(어묵1+물떡1)', '어묵(2ea)': '어묵(2ea+국물)', '어묵': '어묵(2ea+국물)',
  '컵솜사탕': '컵 솜사탕', '솜사탕': '컵 솜사탕', '타코야끼': '타코야끼(10ea)', '뉴욕핫도그': '뉴욕식 핫도그',
  '닭강정(중간컵)': '컵 닭강정', '컵닭강정': '컵 닭강정',
  '고추장닭갈비덮밥': '닭갈비 덮밥', '고추장닭갈비': '닭갈비 덮밥', '소불고기': '소불고기덮밥',
  '스쿱아이스크림': '스쿱 아이스크림', '젤라또아이스크림': '젤라또 아이스크림', '아이스크림': '스쿱 아이스크림',
  '하': '뷔페 하', '우': '뷔페 우', '스': '뷔페 스',
};
const norm = s => String(s || '').normalize('NFC').replace(/\s+/g, '').toLowerCase();

let cache = null, cachedAt = 0;

function build(rows, source) {
  const menus = [], cats = [], travel = {}, fees = {}, feeNotes = {};
  for (const r of rows) {
    if (FEE_CATS.includes(r.category)) {
      if (r.category === '출장비') travel[r.name] = r.unit_price;   // null = 별도 안내(제주 등)
      if (r.category === '기타비용') {
        const k = (FEE_KEYS.find(([, re]) => re.test(r.name)) || [])[0];
        if (k && fees[k] == null) { fees[k] = r.unit_price; feeNotes[k] = { name: r.name, spec: r.spec, note: r.note }; }
      }
      continue;
    }
    if (r.type !== 'menu' || r.unit_price == null) continue;
    const ci = catInfo(r.category);
    if (!cats.find(c => c.cat === r.category)) cats.push({ cat: r.category, label: ci.label, min: ci.min });
    menus.push({ name: r.name, price: r.unit_price, cat: r.category, label: ci.label, min: ci.min, spec: r.spec || '인', note: r.note || '' });
  }
  return { source, at: new Date().toISOString(), menus, cats, travel, fees, feeNotes };
}

async function fetchLive() {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 4000);
  try {
    const r = await fetch(`${SB_URL}/rest/v1/site_menus?select=*&order=sort_order`, { headers: { apikey: SB_KEY }, signal: ctl.signal });
    if (!r.ok) throw new Error('메뉴판 응답 ' + r.status);
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) throw new Error('메뉴판이 비어 있음');
    return rows;
  } finally { clearTimeout(t); }
}

// 메뉴판 읽기 (5분 캐시 → 실패하면 직전 값 → 그것도 없으면 사본)
async function getMenuData() {
  if (cache && Date.now() - cachedAt < TTL_MS) return cache;
  try {
    cache = build(await fetchLive(), 'live'); cachedAt = Date.now();
  } catch (e) {
    if (!cache) { const snap = require('./menu-snapshot.json'); cache = build(snap.rows || [], 'snapshot'); cachedAt = Date.now() - TTL_MS + 30000; }  // 30초 뒤 다시 시도
  }
  return cache;
}

// 메뉴 이름 찾기: 정확히 → 띄어쓰기·대소문자 무시 → 별칭 → 앞부분이 같은 게 하나뿐일 때
function findMenu(data, name) {
  const n = norm(name); if (!n) return null;
  const by = m => norm(m.name);
  let hit = data.menus.find(m => m.name === name) || data.menus.find(m => by(m) === n);
  if (hit) return hit;
  const ak = Object.keys(ALIAS).find(k => norm(k) === n);
  if (ak) { hit = data.menus.find(m => m.name === ALIAS[ak]); if (hit) return hit; }
  const pre = data.menus.filter(m => by(m).startsWith(n) || n.startsWith(by(m).replace(/\(.*$/, '')) && by(m).replace(/\(.*$/, '').length >= 2);
  const uniq = [...new Map(pre.map(m => [m.name, m])).values()];
  return uniq.length === 1 ? uniq[0] : null;
}
function suggest(data, name, k = 5) {
  const n = norm(name);
  return data.menus.filter(m => { const b = norm(m.name); return b.includes(n) || n.includes(b.replace(/\(.*$/, '')) || [...n].filter(ch => b.includes(ch)).length >= Math.min(2, n.length); })
    .slice(0, k).map(m => m.name);
}

// 챗봇 시스템 프롬프트에 붙는 '현재 메뉴판' 글
// 메뉴판 비고에서 지금 계절 것만 — "하절기: A / 동절기: B" (5~9월 하절기, 한국 시간)
function seasonNote(note) {
  const t = String(note || '').trim(); if (!t) return '';
  const kst = new Date(Date.now() + 9 * 3600 * 1000), mo = kst.getUTCMonth() + 1, summer = mo >= 5 && mo <= 9;
  const s = t.match(/하절기\s*[:：]\s*([^/]+?)\s*(?:\/|$)/), w = t.match(/동절기\s*[:：]\s*([^/]+?)\s*(?:\/|$)/);
  if (s || w) return ((summer ? s : w) || s || w)[1].trim();
  return t;
}
function menuPromptText(data) {
  const won = v => Number(v).toLocaleString('ko-KR');
  const lines = ['# 현재 메뉴판 (보드 견적 메뉴판 기준 · 부가세 별도) — calculate_quote에는 아래 "메뉴 이름"을 그대로 넘기세요'];
  for (const c of data.cats) {
    const ms = data.menus.filter(m => m.cat === c.cat);
    lines.push(`[${c.label}] ※ ${c.min}인분 이상부터`);
    lines.push(ms.map(m => `${m.name} ${won(m.price)}${m.note ? ` (구성: ${seasonNote(m.note)})` : ''}`).join(', '));   // 계절 고른 구성만 → 봇이 계절 헷갈리지 않게
  }
  const tv = Object.entries(data.travel).map(([k, v]) => `${k} ${v == null ? '별도 안내' : won(v)}`).join(' / ');
  lines.push(`\n# 출장비 (차량 1대 기준)\n${tv}`);
  const F = data.fees, fn = k => (F[k] == null ? '문의' : won(F[k]) + '원');
  lines.push(`\n# 기타비용 (고객이 원할 때만 extras로 전달)\n자가발전기(전기 지원 불가 시) ${fn('gen')} · 초과 시간당 ${fn('overHour')} · 출력물(X배너·추가 현수막) 1개당 ${fn('print')} · 컵홀더 로고 스티커 1,000장당 ${fn('sticker')} · 섹터이동 1구역당 ${fn('sector')} · 모니터(영상재생) 1대당 ${fn('monitor')} · 실내부스(pop up 등) ${fn('booth')}`);
  return lines.join('\n');
}

module.exports = { getMenuData, findMenu, suggest, menuPromptText, seasonNote, CAT_INFO };
