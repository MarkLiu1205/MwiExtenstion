function fallbackTranslate(_key, fallback, options = {}) {
  return String(fallback || '').replace(/\{\{(\w+)\}\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(options, name) ? String(options[name]) : match,
  );
}

function normalizeTranslate(translate) {
  return typeof translate === 'function' ? translate : fallbackTranslate;
}

// 推荐扫描运行阶段文案：quick_scan / refine_top 附带完成计数，其余为固定文案。
// 供 AdvisorPage 页头状态 chips（runtimePhaseText）与顶栏 CombatCommandBar
// 进度摘要行（App.vue advisorPhaseText）共用，保持两处文案口径一致。
export function buildAdvisorRuntimePhaseText(runtime, translate) {
  const t = normalizeTranslate(translate);
  const phase = String(runtime?.phase || 'idle');
  // 本 repo：標出目標數與「輪」單位，避免把輪數誤讀成目標數（以為區域／難度過濾沒生效）
  const roundsUnit = t('common:advisor.roundsUnit', 'rounds');
  if (phase === 'quick_scan') {
    const targets = Number(runtime?.quickTargetCount || 0);
    const prefix =
      targets > 0
        ? t('common:advisor.phaseQuickDetail', 'Quick scan · {{targets}} targets', { targets })
        : t('common:advisor.phaseQuick', 'Quick scan in progress');
    return `${prefix} · ${runtime?.quickCompleted || 0}/${runtime?.quickTotal || 0} ${roundsUnit}`;
  }
  if (phase === 'refine_top') {
    const targets = Number(runtime?.refineTargetCount || 0);
    const prefix =
      targets > 0
        ? t('common:advisor.phaseRefineDetail', 'Refining top {{targets}}', { targets })
        : t('common:advisor.phaseRefine', 'Refining top picks');
    return `${prefix} · ${runtime?.refineCompleted || 0}/${runtime?.refineTotal || 0} ${roundsUnit}`;
  }
  if (phase === 'done') {
    return t('common:advisor.phaseDone', 'Scan complete');
  }
  if (phase === 'cancelled') {
    return t('common:advisor.phaseCancelled', 'Scan stopped');
  }
  return t('common:advisor.idle', 'Idle');
}

// 推荐扫描进度百分比（0-100 整数）：顶栏 CombatCommandBar 进度摘要行
// （App.vue advisorProgressText）使用；progress 缺失或 NaN 时兜底为 0。
export function buildAdvisorProgressPercent(runtime) {
  return Math.round(Number(runtime?.progress || 0) * 100);
}
