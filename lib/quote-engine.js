// lib/quote-engine.js
// 대화 상담(챗봇)의 calculate_quote 도구.
// ★ 계산 규칙은 빠른 견적과 같은 lib/quote-calc.js 하나를 쓴다 → 두 화면 금액·안내가 항상 같음.
// ★ 가격·출장비·기타비용은 보드 견적 메뉴판(lib/menu-source.js)에서. 여기에 금액을 적지 않는다.
//   AI는 메뉴 '이름'과 인분, 아는 조건만 넘기고, 단가는 여기서 메뉴판으로 찾는다.

const { getMenuData, findMenu, suggest } = require('./menu-source.js');
const { calc, RULES } = require('./quote-calc.js');
const { capacityCheck, capacityGuide } = require('./capacity.js');

// 메뉴판 비고(구성)에서 지금 계절 것만 — 예 "하절기: A / 동절기: B" → 11월이면 B (5~9월 하절기)
function seasonNote(note) {
  const t = String(note || '').trim(); if (!t) return '';
  const kst = new Date(Date.now() + 9 * 3600 * 1000), mo = kst.getUTCMonth() + 1, summer = mo >= 5 && mo <= 9;
  const m = t.match(/하절기\s*[:：]\s*([^/]+?)\s*(?:\/|$)/), w = t.match(/동절기\s*[:：]\s*([^/]+?)\s*(?:\/|$)/);
  if (m || w) return ((summer ? m : w) || m || w)[1].trim();
  return t;
}

// 도시/키워드 → 출장비 지역(메뉴판 '출장비' 이름과 같아야 함)
const REGION_KEYWORDS = {
  "서울·경기남부": ["서울","수원","성남","용인","화성","안양","평택","광명","과천","의왕","군포","안산","오산","시흥","부천","안성","하남","이천","여주","분당","판교","강남","서초","송파","강동","마포","영등포","여의도","용산","종로","중구","성동","성수","광진","동대문","성북","강북","도봉","노원","은평","서대문","양천","강서","구로","금천","관악","동작","잠실","광교","동탄","위례"],
  "경기북부·외곽": ["고양","일산","파주","의정부","남양주","구리","양주","동두천","포천","연천","가평","양평","김포","인천","송도","청라","영종","부평","계양","검단"],
  "천안·아산": ["천안","아산"],
  "충청도권": ["충청","청주","대전","세종","충주","제천","공주","논산","서산","당진","보령","홍성","충남","충북"],
  "강원도권": ["강원","춘천","원주","강릉","속초","동해","삼척","태백","정선","평창","홍천","횡성"],
  "전라북도권": ["전북","전주","익산","군산","정읍","남원","김제","완주"],
  "전라남도권": ["전남","광주","목포","여수","순천","나주","광양","무안"],
  "경상북도권": ["경북","대구","포항","경주","구미","안동","김천","영주","경산","칠곡"],
  "경상남도권": ["경남","부산","울산","창원","김해","진주","양산","거제","통영","밀양","마산"],
  "제주·섬지역권": ["제주","서귀포","섬","울릉","독도"],
};
function resolveRegion(travel, input) {
  if (!input) return null;
  const s = String(input).trim();
  if (Object.prototype.hasOwnProperty.call(travel, s)) return s;
  for (const group in REGION_KEYWORDS) if (REGION_KEYWORDS[group].some((kw) => s.includes(kw))) return group;
  return null;
}

// extras 글자 → 계산 칸
const EXTRA_KEY = [
  ['gen', /발전기/], ['sector', /섹터/], ['monitor', /모니터/], ['print', /x\s*배너|엑스배너|출력물/i],
  ['sticker', /스티커/], ['booth', /실내\s*부스|부스|pop\s*up|팝업/i],
];

/**
 * @param {Object} p
 *  items: [{name, servings}]       메뉴판 이름과 인분
 *  region: 지역·도시 (예: "수원")
 *  serviceHours: 배식 시간(기본 3)
 *  powerAvailable: 전기(220V) 연결 가능 여부 — 모르면 비움(가능으로 계산)
 *  venueStatus: '확정' | '미정' | '허가필요'(학교·공원 등) — 모르면 비움
 *  sideBanners: ['좌','우'] 중 원하는 쪽 (상단·중앙은 항상 무료)
 *  extras: [{name, qty}]  발전기 / X배너 / 스티커(1,000장 단위) / 섹터이동 / 모니터 / 실내부스
 *  offMenu: 메뉴판에 없는 요청(있으면)
 */
async function calculateQuote({ items = [], region = "", eventDate = "", startTime = "", serviceHours = RULES.BASE_HOURS, powerAvailable, venueStatus, sideBanners, extras = [], offMenu = "" }) {
  const data = await getMenuData();

  // 1) 메뉴 이름 → 메뉴판 단가. 못 찾으면 계산하지 않고 되묻게 함
  const priced = [], unknown = [];
  for (const it of items) {
    const m = findMenu(data, it.name);
    if (!m) { unknown.push({ asked: it.name, candidates: suggest(data, it.name) }); continue; }
    priced.push({ name: m.name, price: m.price, qty: Number(it.servings) || 0, cat: m.cat, label: m.label, min: m.min, contents: seasonNote(m.note) });
  }
  if (unknown.length) {
    return { status: "unknown_menu", unknown, message: "메뉴가 하나로 정해지지 않았어요. ★후보 중 하나를 임의로 고르지 말고, 후보를 보여 드리며 어떤 것인지 고객에게 먼저 여쭤보세요(크기·종류가 다르면 가격도 달라요). 고객이 고른 뒤 그 메뉴판 이름으로 다시 계산하세요. 후보가 없으면 메뉴판에 없는 메뉴로 안내하세요." };
  }

  // 2) 메뉴별 최소 인분 (간식 등 50 / 식사 100 / 뷔페 200) — 빠른 견적은 자동으로 올리지만, 대화에서는 먼저 여쭤봄
  const short = priced.filter(p => p.qty < p.min);
  if (short.length) {
    return { status: "below_min_servings", items: short.map(p => ({ name: p.name, servings: p.qty, min: p.min })),
      message: "메뉴별 최소 인분보다 적어요. 최소 인분 이상으로 늘릴지 고객에게 여쭤보세요." };
  }

  // 3) 기타비용 묶기
  const ex = { gen: 0, print: 0, sticker: 0, sector: 0, monitor: 0, booth: 0 }; const unknownExtras = [];
  for (const e of extras || []) {
    const label = typeof e === 'string' ? e : (e && e.name) || '';
    const qty = typeof e === 'object' && e && Number(e.qty) > 0 ? Number(e.qty) : 1;
    const key = (EXTRA_KEY.find(([, re]) => re.test(label)) || [])[0];
    if (!key) { unknownExtras.push(label); continue; }
    ex[key] += qty;
  }
  const group = resolveRegion(data.travel, region);
  const sides = {}; (Array.isArray(sideBanners) ? sideBanners : []).forEach(k => { if (k === '좌' || k === '우') sides[k] = true; });   // 기준 이상이면 서비스, 아니면 면당 출력물 가격

  // 4) 빠른 견적과 같은 계산
  const R = calc({
    items: priced, region: group || '', travel: data.travel,
    loc: venueStatus || '확정', elecOk: !(powerAvailable === false || ex.gen > 0), hours: Number(serviceHours) || RULES.BASE_HOURS,
    sides, xbannerQty: ex.print, stickerBundles: ex.sticker, sectorQty: ex.sector, monitorQty: ex.monitor, boothQty: ex.booth,
    offMenu: offMenu || (unknownExtras.length ? unknownExtras.join(', ') : ''),
  }, data.fees);

  if (!R.eligible) {
    return { status: "below_minimum", items: R.items, foodValue: R.food, minimum: RULES.MIN_FOOD,
      message: `음식값이 최소 기준(${RULES.MIN_FOOD.toLocaleString('ko-KR')}원)보다 적어요. 인분·메뉴를 추가하시면 진행되며, 정확한 상담을 위해 담당자가 곧 연락드릴 예정입니다.` };
  }
  const reasons = R.reasons.slice();
  if (!group) reasons.push("정확한 출장비 반영을 위해 지역(도시)을 확인해야 해요");

  // 5) 혜택 안내 (견적 이력 분석: 100만↑ 일부·150만↑ 대부분 단가 조정, 한 메뉴 300인분↑ 조정 많음, 현수막 서비스는 거의 기본)
  const benefits = [];
  const bigQty = R.items.some(i => i.qty >= 300);
  if (R.subtotal >= RULES.RANGE_HIGH || bigQty) benefits.push("규모가 있는 견적이라 추가 서비스나 단가 조정은 전화 상담에서 담당자가 조율해 드려요 — 손님에게는 이렇게만 말하고, 무엇을 얼마나 빼 주는지·할인율은 약속하지 말 것(정해진 기준 없음)");
  else if (R.sideFree) benefits.push("좌·우 현수막까지는 서비스 기준에 들어요(손님이 좌·우를 원할 때만 언급). 그 밖의 조정은 전화 상담에서 담당자가 조율해 드려요 — 할인율·금액은 약속하지 말 것");

  // 6) 견적 끝에 한 줄로 붙일 안내 (손님이 말 안 한 조건은 묻지 않고 알려만 줌)
  const notes = [];
  // 현수막: 아직 위치를 안 물어봤으면(넣지 않음) 한 번 묻게 — 가격·무료 이야기는 하지 않음
  if (!Array.isArray(sideBanners)) notes.push("[봇에게] 현수막 위치를 아직 안 물어봤어요 — 현수막 설명(사진 포함) 후 '상단·중앙은 서비스로 들어가요. 그 외에 좌·우 옆면이나 X배너에도 다실 생각 있으세요?'를 한 번 물어보세요. 가격·무료·할인은 말하지 말 것. 답을 받으면 sideBanners(원하면 ['좌','우'], 필요 없으면 [])로 다시 계산. 한 번 물었는데 답이 없으면 sideBanners:[]");
  if (Number(serviceHours) && Number(serviceHours) !== RULES.BASE_HOURS && !startTime) notes.push("[봇에게] 배식 시간 길이만 들었어요 — 이 답 맨 끝에 '배식은 몇 시부터 시작할까요?'를 연락처 요청과 함께 꼭 물어보세요(이 문장은 손님에게 그대로 쓰지 말 것)");
  const sideRows = R.bannerRows.filter(b => b.f === '좌측' || b.f === '우측');
  if (sideRows.length && R.sideFree) notes.push("[봇에게] 손님이 고른 좌·우 현수막은 서비스로 들어가요 — 견적 줄에 '좌·우 현수막 — 서비스'로 쓰고 '좌·우도 서비스로 넣어 드려요'라고만 말하세요. 왜 서비스인지(얼마 이상이라 등 금액 조건)는 절대 말하지 말 것");
  else if (sideRows.length) notes.push(`[봇에게] 손님이 고른 좌·우 현수막 ${sideRows.length}면은 면당 ${Number(data.fees.print || 0).toLocaleString('ko-KR')}원으로 견적에 들어갔어요(costs.좌우현수막) — 견적 줄에 그대로 쓰세요. 얼마 이상이면 무료가 된다는 말은 하지 말 것`);
  if (powerAvailable === undefined && ex.gen === 0 && R.gen === 0) notes.push(`전기(220V) 연결이 안 되는 곳이면 자가발전기 ${Number(data.fees.gen || 0).toLocaleString('ko-KR')}원이 추가돼요`);

  // 날짜를 알면 그날 직영 여유를 보고 응대 깊이를 정함 (손님에게는 말하지 않음)
  const capacity = eventDate ? await capacityCheck(eventDate, priced.map(p => p.name).join(' '), powerAvailable === false || ex.gen > 0) : null;
  const guide = capacityGuide(capacity); if (guide) notes.push(guide);

  return {
    status: "ok", capacity: capacity ? capacity.level : undefined,
    mode: R.exact && group ? "fixed" : "range",       // fixed = 한 금액 / range = 대략 범위
    large: R.large,
    region: String(region || "").trim() || group || "미정",   // 손님이 말한 지역 그대로(출장비 줄에 씀)
    regionGroup: group || "",                                  // 출장비 요금 묶음(내부용 — 손님에게 쓰지 않음)
    items: R.items.map(i => { const p = priced.find(x => x.name === i.label); return Object.assign({ name: i.label, unitPrice: i.price, servings: i.qty, amount: i.amount }, p && p.contents ? { contents: p.contents } : {}); }),
    costs: { 출장비: R.travel, 자가발전기: R.gen, 추가시간: R.overFee, X배너: R.xb, 스티커: R.stk, 섹터이동: R.sector, 모니터: R.monitor, 실내부스: R.booth, 좌우현수막: R.bannerCost },
    banners: R.bannerRows, sideBannersWanted: (Array.isArray(sideBanners) ? sideBanners : []),
    subtotal: R.subtotal, vat: Math.round(R.vat), total: Math.round(R.total),
    rangeLow: R.lo, rangeHigh: R.hi,
    consultReasons: reasons, benefits, notes,
    venueNotice: R.venueNotice,
    unknownExtras,
    priceSource: data.source === 'live' ? '보드 견적 메뉴판(실시간)' : '메뉴판 사본',
    note: "부가세(VAT) 별도. mode가 range면 'rangeLow~rangeHigh원'으로 안내하고 담당자 확인 후 확정된다고 덧붙이세요. 빠른 견적과 같은 계산입니다.",
  };
}

module.exports = { calculateQuote };
