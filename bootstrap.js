// ───────────────────────── AI 설정 모달 ─────────────────────────
(() => {
  const ov = document.getElementById('settings-overlay');
  const keyInput = document.getElementById('set-key');
  const modelSel = document.getElementById('set-model');
  const result = document.getElementById('set-result');
  // 모델 옵션 채우기
  Object.entries(CLAUDE_MODELS).forEach(([id, label]) => {
    const o = document.createElement('option');
    o.value = id; o.textContent = label;
    modelSel.appendChild(o);
  });
  let lastFocusSettings = null;
  const open = () => {
    lastFocusSettings = document.activeElement;
    keyInput.value = getClaudeKey();
    modelSel.value = getClaudeModel();
    result.textContent = '';
    const disp = getDisplaySettings(); // 섹션 표시 설정 복원
    document.querySelectorAll('.section-toggle').forEach(cb => { cb.checked = disp[cb.dataset.block] !== false; });
    ov.classList.add('open');
    document.body.style.overflow = 'hidden';
    setTimeout(() => { try { keyInput.focus(); } catch (e) {} }, 50);
  };
  const close = () => {
    ov.classList.remove('open');
    document.body.style.overflow = '';
    if (lastFocusSettings && lastFocusSettings.offsetParent !== null) { try { lastFocusSettings.focus(); } catch (e) {} }
  };
  document.getElementById('settings-btn').onclick = open;
  document.getElementById('settings-close').onclick = close;
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
  // 설정 탭 전환 (AI 연동 / 화면 구성)
  document.querySelectorAll('#set-tabs button').forEach(b => b.onclick = () => {
    const t = b.dataset.setTab;
    document.querySelectorAll('#set-tabs button').forEach(x => { const on = x === b; x.classList.toggle('active', on); x.setAttribute('aria-selected', on ? 'true' : 'false'); });
    document.getElementById('set-pane-ai').hidden = t !== 'ai';
    document.getElementById('set-pane-ui').hidden = t !== 'ui';
  });
  // 섹션 표시/숨김 토글
  document.querySelectorAll('.section-toggle').forEach(cb => cb.onchange = () => {
    const disp = getDisplaySettings();
    disp[cb.dataset.block] = cb.checked;
    try { localStorage.setItem('display-sections', JSON.stringify(disp)); } catch (e) {}
    applySectionVisibility(cb.dataset.block, cb.checked);
  });
  // 브라우저 알림 권한
  const notifBtn = document.getElementById('notif-enable');
  if (notifBtn) notifBtn.onclick = () => {
    if (typeof Notification === 'undefined') { alert('이 브라우저는 알림을 지원하지 않습니다.'); return; }
    Notification.requestPermission().then(p => { notifBtn.textContent = p === 'granted' ? '🔔 알림 켜짐' : '🔔 알림이 거부됨 — 브라우저 설정에서 허용하세요'; });
  };
  document.getElementById('set-save').onclick = () => {
    localStorage.setItem('anthropicKey', keyInput.value.trim());
    localStorage.setItem('anthropicModel', modelSel.value);
    result.innerHTML = '<span class="good">✓ 저장되었습니다.</span> 이제 종합 평가에서 \'🤖 Claude 심층 의견\'을 받을 수 있습니다.';
    syncAiButtons();
  };
  document.getElementById('set-clear').onclick = () => {
    localStorage.removeItem('anthropicKey');
    keyInput.value = '';
    result.innerHTML = '<span class="mid">키가 삭제되었습니다.</span> 규칙 기반 점수는 계속 동작합니다.';
    syncAiButtons();
  };
  document.getElementById('set-test').onclick = async () => {
    const k = keyInput.value.trim();
    if (!k) { result.innerHTML = '<span class="bad">먼저 API 키를 입력하세요.</span>'; return; }
    localStorage.setItem('anthropicKey', k);
    localStorage.setItem('anthropicModel', modelSel.value);
    result.innerHTML = '연결 테스트 중…';
    try {
      const r = await callClaude('You are a test.', '"OK"라고만 답하세요.', 20);
      result.innerHTML = '<span class="good">✓ 연결 성공</span> — 응답: ' + esc(r.slice(0, 40));
      syncAiButtons();
    } catch (e) {
      result.innerHTML = '<span class="bad">✗ 연결 실패: ' + esc(e.message) + '</span><br><span style="color:var(--muted);font-size:0.76rem">키가 올바른지, 크레딧이 있는지 확인하세요.</span>';
    }
  };
  document.addEventListener('keydown', e => {
    if (!ov.classList.contains('open')) return;
    if (e.key === 'Escape') { close(); return; }
    if (e.key === 'Tab') { // 포커스 트랩 (상세 모달과 동일)
      const list = [...ov.querySelectorAll('button, [tabindex="0"], input, select, textarea, a[href]')].filter(el => el.offsetParent !== null);
      if (!list.length) return;
      const first = list[0], last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
})();
// AI 버튼 상태 동기화 (키 유무에 따라 안내 갱신) — 각 기능에서 정의된 갱신 함수 호출
function syncAiButtons() {
  document.querySelectorAll('[data-ai-hint]').forEach(el => {
    el.textContent = hasClaudeKey() ? '🤖 Claude 심층 의견' : '🤖 Claude 의견 (AI 설정 필요)';
  });
}

// 접이식 섹션 토글 (제목 클릭/Enter/Space → 펼침/접힘)
function toggleSection(h) {
  const sec = h.closest('.section');
  if (!sec) return;
  const collapsed = sec.classList.toggle('collapsed');
  h.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
}
document.addEventListener('click', e => { const h = e.target.closest('.toggle-h'); if (h) toggleSection(h); });
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { const h = e.target.closest('.toggle-h'); if (h && e.target === h) { e.preventDefault(); toggleSection(h); } }
});

// 데이터 상태 배너 (지연·실패 시 상단 안내, 6초 후 자동 숨김)
let _dataStatusTimer = null;
function setDataStatus(msg) {
  const b = document.getElementById('data-status-banner');
  if (!b) return;
  b.textContent = '⚠️ ' + msg;
  b.classList.add('visible');
  clearTimeout(_dataStatusTimer);
  _dataStatusTimer = setTimeout(() => b.classList.remove('visible'), 6000);
}

// 화면 구성(섹션 표시) 설정
function getDisplaySettings() { try { return JSON.parse(localStorage.getItem('display-sections') || '{}'); } catch (e) { return {}; } }
function applySectionVisibility(id, show) { const el = document.getElementById(id); if (el) el.hidden = !show; }
function applyInitialSectionSettings() {
  const disp = getDisplaySettings();
  Object.keys(disp).forEach(id => { if (disp[id] === false) applySectionVisibility(id, false); });
}

// 발견 탭 토글
(() => {
  const tabs = document.getElementById('discovery-tabs');
  if (tabs) tabs.addEventListener('click', e => { const b = e.target.closest('button'); if (b) renderDiscovery(b.dataset.rank, false); });
})();

// ───────────────────────── 초기화 ─────────────────────────
document.getElementById('today').textContent =
  new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });

document.getElementById('refresh-btn').onclick = async () => {
  const btn = document.getElementById('refresh-btn');
  btn.disabled = true;
  btn.style.opacity = '0.55';
  document.getElementById('updated-at').textContent = '갱신 중…';
  renderMarketNews();
  renderSymbolNews();
  trendingCache = { kr: null, us: null };
  renderTrendingSectors(true);
  discoveryCache = {};
  renderDiscovery(null, true);
  await Promise.allSettled([renderMacro(true), (async () => renderWatchlist(true))()]);
  markUpdated();
  btn.disabled = false;
  btn.style.opacity = '';
};
function markUpdated() {
  document.getElementById('updated-at').textContent =
    new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}

applyInitialSectionSettings(); // 저장된 화면 구성(숨긴 섹션) 적용
renderMacro();
renderWatchlist();
// 뉴스는 시세 요청과 겹치지 않게 약간 늦게 시작 (프록시 동시요청 제한 회피)
setTimeout(() => { renderMarketNews(); renderSymbolNews(); }, 700);
// 오늘의 발견 (종목 랭킹)
setTimeout(() => renderDiscovery('up'), 1100);
// 떠오르는 업종은 더 늦게 시작 (프록시 동시요청 분산)
setTimeout(() => renderTrendingSectors(), 1500);
markUpdated();
