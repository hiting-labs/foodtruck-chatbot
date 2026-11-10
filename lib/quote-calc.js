// lib/quote-calc.js
// ★ 견적 계산 규칙의 원본 — 빠른 견적(index.html, 브라우저)과 대화 상담(챗봇, 서버)이 이 파일 하나를 같이 쓴다.
//   두 화면의 금액·안내가 항상 같게. 가격은 여기 없음(보드 견적 메뉴판에서 받은 값을 넘겨받음).
//   아래 숫자는 가격이 아니라 진행 기준이다.
(function (root) {
  const RULES = {
    BASE_HOURS: 3,          // 서비스 기본 시간
    MIN_FOOD: 600000,       // 최소 음식값(메뉴 합계) — 미만이면 유선 상담
    RANGE_LOW: 1200000,     // 공급가 미만이고 상담 사유가 없으면 '예상 견적'(한 금액), 아니면 '대략 범위'
    RANGE_HIGH: 1500000,    // 이상이면 큰 행사 — 담당자 확인
    SIDE_FREE: 1000000,     // 견적가(출장비 제외) 이상이면 좌·우 현수막도 무료
    RANGE_FLOOR: 0.9,       // 범위 아래쪽 = 공급가의 90%
    VAT: 0.10,
    MULTI_TRUCK_MENUS: 4,   // 메뉴 4개 이상 또는
    MULTI_TRUCK_CATS: 3,    // 분류 3개 이상(식사 세부는 하나로) → 차량 2대 이상 가능성
  };
  const r1000 = n => Math.round(n / 1000) * 1000;

  /**
   * @param {Object} q
   *  items: [{name, price, qty, cat}]   메뉴(메뉴판 단가)·인분·메뉴판 분류
   *  region: 출장비 지역 이름, travel: {지역: 금액|null}
   *  loc: '확정' | '미정' | '허가필요'   (진행 장소)
   *  elecOk: true/false                 (전기 지원 가능 여부, false면 자가발전기)
   *  startH, endH  또는  hours          (배식 시간)
   *  sides: {좌:bool, 우:bool}           (좌·우 현수막 추가)
   *  xbannerQty, stickerBundles(1,000장 단위), sectorQty, monitorQty, boothQty
   *  offMenu: 메뉴판에 없는 요청 글
   * @param {Object} fees  {gen, overHour, print, sticker, sector, monitor, booth} — 메뉴판 기타비용
   */
  function calc(q, fees) {
    fees = fees || {};
    const items = (q.items || []).filter(it => it && Number(it.qty) > 0).map(it => ({
      label: it.name, qty: Number(it.qty), price: Number(it.price) || 0, cat: it.cat || '', amount: (Number(it.price) || 0) * Number(it.qty),
    }));
    const food = items.reduce((s, it) => s + it.amount, 0);
    const eligible = items.length > 0 && food >= RULES.MIN_FOOD;

    const hours = q.hours != null ? Number(q.hours) : Math.max(0, Number(q.endH) - Number(q.startH));
    const extraHours = Math.max(0, hours - RULES.BASE_HOURS);
    const travelMap = q.travel || {};
    const travelRaw = q.region ? travelMap[q.region] : undefined;
    const travel = travelRaw || 0;
    const gen = q.elecOk === false ? (fees.gen || 0) : 0;
    const overFee = extraHours * (fees.overHour || 0);
    const xb = (Number(q.xbannerQty) || 0) * (fees.print || 0);
    const stk = (Number(q.stickerBundles) || 0) * (fees.sticker || 0);
    const sector = (Number(q.sectorQty) || 0) * (fees.sector || 0);
    const monitor = (Number(q.monitorQty) || 0) * (fees.monitor || 0);
    const booth = (Number(q.boothQty) || 0) * (fees.booth || 0);
    const baseSub = food + travel + gen + overFee + xb + stk + sector + monitor + booth;

    // 현수막: 상단·중앙은 항상 무료. 좌·우는 면당 출력물 가격, 단 견적가(출장비 제외) 100만 이상이면 무료
    const sideFree = (baseSub - travel) >= RULES.SIDE_FREE;
    let bannerCost = 0;
    const bannerRows = [{ f: '상단', free: true }, { f: '중앙', free: true }];
    const sides = q.sides || {};
    [['좌', '좌측'], ['우', '우측']].forEach(([k, label]) => { if (sides[k]) { if (!sideFree) bannerCost += (fees.print || 0); bannerRows.push({ f: label, free: sideFree }); } });
    const subtotal = baseSub + bannerCost;

    // 상담 연결 사유 (견적은 항상 보여 줌)
    const reasons = [];
    if (q.offMenu) reasons.push('메뉴판에 없는 요청은 상담 시 반영해 드려요');
    // 대표 방침(11/10): 섭외 안 된 장소는 주·정차 위반 안내 + 협의된 장소여야 함을 꼭 알림
    const VENUE_RULE = '트럭은 미리 협의된 장소(행사장·건물 관리 측과 이야기된 자리)에서만 진행할 수 있어요. 섭외되지 않은 도로·공터에 세우면 주·정차 위반 단속이나 민원으로 운영이 중단될 수 있어요';
    if (q.loc === '미정') reasons.push('트럭 세울 장소가 아직 정해지지 않았어요. ' + VENUE_RULE);
    if (q.loc === '허가필요') reasons.push('학교·공원 등은 허가 문제로 인근에서 진행될 수 있어요. ' + VENUE_RULE);
    // 장소 섭외 안내(11/10 담당자 요청): 견적마다 붙임. 장소 미정·허가 필요면 공유받은 문구 전체, 아니면 짧게
    const venueNotice = (q.loc === '미정' || q.loc === '허가필요') ? VENUE_NOTICE_FULL : VENUE_NOTICE_SHORT;
    if (q.region && travelRaw == null) reasons.push(q.region + ' 출장비는 담당자가 별도로 상세히 안내드려요');
    const catCount = new Set(items.map(x => String(x.cat).replace(/^식사-.*/, '식사'))).size;
    const multiTruckLikely = items.length >= RULES.MULTI_TRUCK_MENUS || catCount >= RULES.MULTI_TRUCK_CATS;
    if (multiTruckLikely) reasons.push('메뉴 구성이 다양해 차량 2대 이상 운영이 필요할 수 있어요 — 출장비가 추가될 수 있어 담당자가 확인 후 정확히 안내드려요');
    const large = subtotal >= RULES.RANGE_HIGH;
    const needConsult = reasons.length > 0 || large;
    const exact = subtotal < RULES.RANGE_LOW && !needConsult;

    return {
      eligible, items, food, travel, gen, overFee, extraHours, hours, xb, stk, sector, monitor, booth,
      bannerRows, bannerCost, sideFree, subtotal, vat: subtotal * RULES.VAT, total: subtotal * (1 + RULES.VAT),
      lo: r1000(subtotal * RULES.RANGE_FLOOR), hi: r1000(subtotal), exact, large, needConsult, reasons, multiTruckLikely, venueNotice,
    };
  }

  // 담당자들이 공유한 장소 섭외 안내 문구 (2026-11-10)
  const VENUE_NOTICE_FULL = '행사장소는 따로 섭외드리고 있지 않습니다. 행사를 요청하신 고객사 측에서 장소 섭외 부탁드립니다. 섭외되지 않은 장소에서 행사 진행 시 민원, 과태료, 주차비 등이 발생될 경우 의뢰주신 고객님께서 부담해주셔야 되는 점 안내드립니다.';
  const VENUE_NOTICE_SHORT = '행사 장소는 고객사에서 섭외해 주셔야 해요. 섭외되지 않은 장소에서 진행해 민원·과태료·주차비 등이 생기면 고객님 부담이에요.';

  const api = { RULES, calc, VENUE_NOTICE_FULL, VENUE_NOTICE_SHORT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.QuoteCalc = api;
})(typeof window !== 'undefined' ? window : this);
