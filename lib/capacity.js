// lib/capacity.js
// 손님이 말한 날짜에 우리 차·집기 여유가 있는지 보드에 물어봄 (보드 DB 함수 capacity_check — 단계만 돌려주고 행사·고객 정보는 안 줌)
//   open  = 직영 여유 → 꼼꼼히 묻고 전화 상담으로 연결
//   tight = 빠듯 → 보통 응대
//   busy  = 외주 예상(차 대부분 나감 또는 필요한 집기 모자람) → 견적·연락처만 받고 간단히 마무리
// 손님에게는 여유·외주 이야기를 절대 하지 않음 — 응대 깊이만 달라짐
const SB_URL = process.env.CAP_SUPABASE_URL || process.env.SUPABASE_URL || 'https://vopoinbleggjqdbrxwpc.supabase.co';
const SB_KEY = process.env.CAP_SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || 'sb_publishable_HDlbxhnF0l4okkeZXmg7wg_m_Krjqds';

async function capacityCheck(date, menuText, powerOff) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return null;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 3000);
  try {
    const r = await fetch(`${SB_URL}/rest/v1/rpc/capacity_check`, {
      method: 'POST', signal: ctl.signal,
      headers: { apikey: SB_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_date: date, p_menu: String(menuText || ''), p_power_off: !!powerOff }),
    });
    if (!r.ok) return null;                       // 함수가 아직 없거나 오류면 판단 없이 평소대로
    const j = await r.json();
    return j && j.level ? j : null;
  } catch (e) { return null; } finally { clearTimeout(t); }
}

// 봇에게 줄 응대 안내 (손님에게 그대로 쓰지 말 것)
function capacityGuide(cap) {
  if (!cap) return null;
  if (cap.level === 'open') return "[봇에게] 응대: 꼼꼼히 — 이 날짜는 직접 진행하기 좋은 날이에요. 인원·정확한 장소·배식 시간을 하나씩 확인하고, 연락처를 받으면 '담당자가 전화로 자세히 안내드려도 될까요? 통화 편한 시간대가 언제세요?'까지 물어 통화 시간을 받으세요(submit_lead의 callTime). 날짜 여유·일정 이야기는 손님에게 하지 말 것";
  if (cap.level === 'busy') return "[봇에게] 응대: 간단히 — 견적과 성함·연락처만 받고, 주소·이메일·결제 같은 추가 질문은 하지 말고 짧게 마무리하세요. '그날 바쁘다/일정이 찼다/외주' 같은 말은 절대 하지 말 것. 손님이 진행 가능하냐고 물으면 '네, 진행 가능해요. 담당자가 확인 후 연락드릴게요'";
  return null;
}

module.exports = { capacityCheck, capacityGuide };
