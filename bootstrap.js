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
  const open = () => {
    keyInput.value = getClaudeKey();
    modelSel.value = getClaudeModel();
    result.textContent = '';
    ov.classList.add('open');
    document.body.style.overflow = 'hidden';
  };
  const close = () => { ov.classList.remove('open'); document.body.style.overflow = ''; };
  document.getElementById('settings-btn').onclick = open;
  document.getElementById('settings-close').onclick = close;
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
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
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && ov.classList.contains('open')) close(); });
})();
// AI 버튼 상태 동기화 (키 유무에 따라 안내 갱신) — 각 기능에서 정의된 갱신 함수 호출
function syncAiButtons() {
  document.querySelectorAll('[data-ai-hint]').forEach(el => {
    el.textContent = hasClaudeKey() ? '🤖 Claude 심층 의견' : '🤖 Claude 의견 (AI 설정 필요)';
  });
}

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
  await Promise.allSettled([renderMacro(true), (async () => renderWatchlist(true))()]);
  markUpdated();
  btn.disabled = false;
  btn.style.opacity = '';
};
function markUpdated() {
  document.getElementById('updated-at').textContent =
    new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}

renderMacro();
renderWatchlist();
// 뉴스는 시세 요청과 겹치지 않게 약간 늦게 시작 (프록시 동시요청 제한 회피)
setTimeout(() => { renderMarketNews(); renderSymbolNews(); }, 700);
// 떠오르는 업종은 더 늦게 시작 (프록시 동시요청 분산)
setTimeout(() => renderTrendingSectors(), 1500);
markUpdated();
