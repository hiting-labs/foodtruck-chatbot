// api/menu.js
// 빠른 견적 화면(index.html)이 메뉴·가격·출장비·기타비용을 받아 가는 곳.
// 원본은 보드 견적 메뉴판(lib/menu-source.js). 원가는 애초에 받지 않는다.
const { getMenuData } = require('../lib/menu-source.js');

module.exports = async function handler(req, res) {
  try {
    const d = await getMenuData();
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');   // Vercel 쪽 5분 캐시
    return res.status(200).json({
      source: d.source, at: d.at,
      menus: d.menus.map(m => (m.note ? { n: m.name, p: m.price, c: m.cat, d: m.note } : { n: m.name, p: m.price, c: m.cat })),   // d = 메뉴판 비고(세트 구성 등)
      cats: d.cats.map(c => ({ c: c.cat, label: c.label, min: c.min })),
      travel: d.travel,
      fees: d.fees,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
};
