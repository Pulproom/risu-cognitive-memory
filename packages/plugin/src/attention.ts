import type { RuntimeState } from "./types.js";
import type { ServerClient } from "./api-client.js";
import { addLog, isChatMemoryEnabled, saveSettings } from "./settings.js";
import { describeServerConnectionIssue, SERVER_RESPONSE_DELAYED } from "./connection.js";
import { timingsForChat } from "./timing.js";
import { pluginUpdateNeeded } from "./updates.js";

const BUTTON_ID = "risu-cognitive-memory-open";
export const MEMORY_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19.5 8a8.5 8.5 0 1 0 .5 7"/><path d="M16 9a4.5 4.5 0 1 0 .4 5"/><path d="M12 12 19.5 8"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="19.5" cy="8" r="1.6" fill="currentColor" stroke="none"/></svg>';
const ALERT_ICON = '<span aria-hidden="true" style="font-size:1.05rem;color:#ef4444">●</span>';
const WIDGET_SELECTOR = '[x-rcm-status-widget="true"]';
const WIDGET_CLOCK_STYLE_SELECTOR = '[x-rcm-status-clock-style="true"]';
export const STATUS_TIMED_ATTRIBUTE = "x-rcm-status-timed";
export const STATUS_CLOCK_CSS = `
  @property --rcm-status-seconds { syntax: "<integer>"; initial-value: 0; inherits: false; }
  @keyframes rcm-status-clock { from { --rcm-status-seconds: 0; } to { --rcm-status-seconds: 86400; } }
  [x-rcm-status-widget="true"][${STATUS_TIMED_ATTRIBUTE}="true"] [x-rcm-status-elapsed="true"] {
    animation: rcm-status-clock 86400s linear forwards;
    animation-delay: var(--rcm-status-delay, 0s);
    counter-reset: rcm-status-elapsed var(--rcm-status-seconds);
    font-variant-numeric: tabular-nums;
  }
  [x-rcm-status-widget="true"][${STATUS_TIMED_ATTRIBUTE}="true"] [x-rcm-status-elapsed="true"]::after {
    content: " · " counter(rcm-status-elapsed) "초";
  }
`;

export function shouldShowStatusWidget(state: RuntimeState, dashboardHidden = false): boolean {
  return !dashboardHidden && !!state.current && isChatMemoryEnabled(state.settings, state.current.chatId);
}

interface FloatingWidgetState { kind: string; label: string; detail: string; startedAt?: number }

export function statusVisualKey(state: FloatingWidgetState): string {
  return `${state.kind}\u0000${state.label}\u0000${state.detail}`;
}

export function statusDragStarted(startX: number, startY: number, currentX: number, currentY: number): boolean {
  return Math.hypot(currentX - startX, currentY - startY) >= 6;
}

export function statusPointerRegion(x: number, y: number, width: number, headerHeight = 36): "toggle" | "header" | undefined {
  if (y < 0 || y > headerHeight || x < 0 || x > width) return undefined;
  return x >= width - headerHeight ? "toggle" : "header";
}

export function statusPointInRect(x: number, y: number, rect: { left: number; right: number; top: number; bottom: number }): boolean {
  return Number.isFinite(x) && Number.isFinite(y) && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

export function statusWidgetWidth(expanded: boolean, viewportWidth: number): number {
  return Math.max(0, Math.min(expanded ? 232 : 156, viewportWidth - 16));
}

export function clampStatusPosition(left: number, top: number, viewportWidth: number, viewportHeight: number, widgetWidth = 154, widgetHeight = 48): { left: number; top: number } {
  const right = Math.max(8, viewportWidth - Math.max(154, widgetWidth) - 8);
  const bottom = Math.max(8, viewportHeight - Math.max(48, widgetHeight) - 8);
  return { left: Math.max(8, Math.min(right, left)), top: Math.max(8, Math.min(bottom, top)) };
}

function activeBackfillStage(state: RuntimeState): string | undefined {
  return state.currentJob?.phase ?? state.serverWorker?.phase ?? state.serverWorker?.activeJob?.kind;
}

function progressLabel(state: RuntimeState, stage = activeBackfillStage(state)): string {
  const progress = liveBackfillProgress(state);
  if (!progress?.totalGroups) return "";
  return ["first_extraction", "post_extraction_audit", "state_reconciliation", "storing", "retrying"].includes(stage ?? "") && progress.activeGroupOrdinal && progress.activeGroupTotal
    ? ` · ${progress.activeGroupOrdinal}/${progress.activeGroupTotal}`
    : ` · 완료 ${progress.processedGroups}/${progress.totalGroups}`;
}

function progressDetail(state: RuntimeState, fallback: string, activeStage = activeBackfillStage(state)): string {
  const progress = liveBackfillProgress(state);
  if (!progress?.totalGroups) return fallback;
  const stageLabels: Record<string, string> = {
    initial_calibration: "초기 인물 설정",
    first_extraction: "1차 기억 추출",
    post_extraction_audit: "추출 결과 재검수",
    state_reconciliation: "세계·인식·약속 대조",
    ledger_consistency: "최종 장부 대조",
    relationship_projection: "관계 상태 투영",
    story_consolidation: "줄거리 갱신",
    storing: "기억 반영",
  };
  const stage = activeStage && stageLabels[activeStage] ? ` · ${stageLabels[activeStage]}` : "";
  const groupPosition = ["first_extraction", "post_extraction_audit", "state_reconciliation", "storing", "retrying"].includes(activeStage ?? "") && progress.activeGroupOrdinal && progress.activeGroupTotal
    ? `현재 묶음 ${progress.activeGroupOrdinal}/${progress.activeGroupTotal}`
    : `완료 ${progress.processedGroups}/${progress.totalGroups}`;
  return `${groupPosition}${stage} · 기억 ${progress.memories}개 · 세부 ${progress.details}개`;
}

function liveBackfillProgress(state: RuntimeState): NonNullable<NonNullable<RuntimeState["statusSummary"]>["progress"]> | undefined {
  const progress = state.statusSummary?.progress;
  return progress?.backfillRunId && progress.runComplete !== true ? progress : undefined;
}

function stageProgressDetail(state: RuntimeState, stage: "ledger" | "relationship" | "story", fallback: string): string {
  const progress = liveBackfillProgress(state);
  if (!progress) return fallback;
  if (stage === "ledger" && (progress.ledgerTotal ?? 0) > 0) {
    return `마지막 장부 대조 ${progress.ledgerProcessed ?? 0}/${progress.ledgerTotal} · 겹치거나 교체된 상태를 확인하고 있습니다.`;
  }
  if (stage === "relationship" && (progress.relationshipTotal ?? 0) > 0) {
    return `관계 상태 ${progress.relationshipProcessed ?? 0}/${progress.relationshipTotal} · 인물 사이의 최신 상태를 반영하고 있습니다.`;
  }
  if (stage === "story" && (progress.storyTotal ?? 0) > 0) {
    return `줄거리 ${progress.storyProcessed ?? 0}/${progress.storyTotal} · 완료된 기억을 장면과 이야기 흐름에 반영하고 있습니다.`;
  }
  return fallback;
}

function activeStartedAt(state: RuntimeState): number | undefined {
  if (state.currentJob?.startedAt && state.currentJob.chatId === state.current?.chatId) return state.currentJob.startedAt;
  const active = state.serverWorker?.activeJob;
  return active && (!active.chatId || active.chatId === state.current?.chatId) ? active.startedAt : undefined;
}

export function widgetState(state: RuntimeState): FloatingWidgetState {
  const summary = state.statusSummary ?? { queuedJobs: 0, failedJobs: 0, pendingReviews: 0, pendingEmbeddings: 0, failedEmbeddings: 0 };
  if (state.current && !isChatMemoryEnabled(state.settings, state.current.chatId)) return { kind: "disabled", label: "RCM 꺼짐", detail: "현재 채팅에서는 새 기억 동기화·추출·도구 호출을 사용하지 않습니다." };
  const connectionIssue = state.serverConnectionIssue ?? describeServerConnectionIssue(state.settings);
  if (connectionIssue) return {
    kind: connectionIssue.kind === "unconfigured" ? "setup" : "connection",
    label: connectionIssue.kind === "unconfigured" ? "서버 연결 필요" : "연결 정보 확인",
    detail: connectionIssue.detail,
  };
  if (state.activityStatusError === SERVER_RESPONSE_DELAYED) return {
    kind: "connection",
    label: "서버 응답 확인 중",
    detail: SERVER_RESPONSE_DELAYED,
  };
  if (state.updateApplying) return state.updateApplying.error ? {
    kind: "review",
    label: "업데이트 확인 필요",
    detail: state.updateApplying.error,
  } : {
    kind: "timing",
    label: "서버 업데이트 중",
    detail: `RCM ${state.updateApplying.targetVersion}을 적용하고 다시 연결하고 있습니다.`,
    startedAt: state.updateApplying.startedAt,
  };
  if (state.updateStatus?.restartRequired) return {
    kind: "review",
    label: "서버 재시작 필요",
    detail: `RCM ${state.updateStatus.stagedVersion ?? state.updateStatus.latestServerVersion ?? "새 버전"} 설치를 마치려면 서버를 다시 시작해 주세요.`,
  };
  if (state.updateStatus?.available) return {
    kind: "review",
    label: "RCM 업데이트",
    detail: pluginUpdateNeeded(state.updateStatus)
      ? `${state.updateStatus.latestVersion ?? state.updateStatus.latestServerVersion ?? "새 버전"} 서버와 플러그인 업데이트가 필요합니다. 대시보드에서 확인해 주세요.`
      : `${state.updateStatus.latestVersion ?? state.updateStatus.latestServerVersion ?? "새 버전"} 서버 업데이트를 설치할 수 있습니다. 대시보드에서 확인해 주세요.`,
  };
  if (pluginUpdateNeeded(state.updateStatus)) return {
    kind: "review",
    label: "플러그인 업데이트 필요",
    detail: `Risu 플러그인 메뉴의 + 버튼으로 RCM ${state.updateStatus?.latestPluginVersion}을 설치해 주세요.`,
  };
  const activeTiming = timingsForChat(state, state.current?.chatId).find((event) => event.outcome === "running");
  if (activeTiming) return {
    kind: "timing",
    label: activeTiming.kind === "automatic_injection" ? "기억 주입 준비 중" : activeTiming.kind === "mcp" ? "기억 도구 검색 중" : "보조 모델 처리 중",
    detail: activeTiming.label,
    startedAt: activeTiming.startedAt,
  };
  const activeServerTiming = state.serverWorker?.auxiliaryCalls?.find((event) => event.outcome === "running");
  if (activeServerTiming) return {
    kind: "timing",
    label: "서버 보조 모델 처리 중",
    detail: `보조 모델 · ${activeServerTiming.purpose}`,
    startedAt: activeServerTiming.startedAt,
  };
  if (!state.activityReady) return { kind: "checking", label: "RCM 확인 중", detail: "현재 채팅의 대기열과 오류 상태를 확인하고 있습니다." };
  if (state.lastPrepare?.lineage?.status === "choice_required" || state.lastPrepare?.lineage?.status === "ambiguous") return {
    kind: "review",
    label: "기억 이어받기 선택",
    detail: (state.lastPrepare.lineage.ambiguousCandidates?.length ?? 0) > 1
      ? "복사된 채팅과 일치하는 원본이 여러 개입니다. 대시보드에서 선택해 주세요."
      : "복사된 채팅에서 기억을 이어받거나 새로 시작할 수 있습니다.",
  };
  const blockingFailures = summary.blockingFailedJobs ?? summary.failedJobs;
  const calibration = summary.initialCalibration;
  const setupCaptured = Boolean(state.current && state.lastResolvedSetup?.chatId === state.current.chatId);
  const historicalBackfillPending = summary.ingestionState === "historical_pending" || Number(summary.historicalBackfillMessages ?? 0) > 0;
  if (calibration?.status === "awaiting_setup") return setupCaptured
    ? { kind: "review", label: "과거 기억 생성 준비됨", detail: "기억 홈에서 ‘과거 대화로 기억 생성’을 눌러 주세요." }
    : { kind: "review", label: "초기 설정 캡처 필요", detail: "채팅에 메시지를 한 번 보내 설정을 가져온 뒤 ‘과거 대화로 기억 생성’을 다시 눌러 주세요." };
  if (calibration?.status === "awaiting_confirmation") return { kind: "review", label: "초기 장부 확인 필요", detail: "분석된 인물과 초기 관계를 확인하면 과거 기억 생성을 이어서 시작합니다." };
  if (calibration?.status === "queued") {
    const startedAt = activeStartedAt(state);
    return {
      kind: "initial",
      label: "초기 장부 생성 중",
      detail: startedAt ? "인물과 초기 관계를 설정 원문에서 정리하고 있습니다." : "초기 장부 작업이 순서를 기다리고 있습니다.",
      startedAt,
    };
  }
  if (setupCaptured && historicalBackfillPending && (!calibration || calibration.status === "unseeded")) return {
    kind: "review",
    label: "과거 기억 생성 준비됨",
    detail: "기억 홈에서 ‘과거 대화로 기억 생성’을 눌러 주세요.",
  };
  if (state.settings.workerPaused) return { kind: "paused", label: "일시정지", detail: "기억 처리가 재개될 때까지 대기합니다." };
  const episode = state.episodeActivity;
  if (episode?.status === "failed") return { kind: "error", label: "캡슐 오류", detail: episode.lastError ?? "에피소드 캡슐을 만들지 못했습니다. 원문과 기존 기억은 그대로입니다." };
  const currentJob = state.currentJob?.chatId === state.current?.chatId ? state.currentJob : undefined;
  if (episode?.status === "queued" || episode?.status === "processing" || currentJob?.phase === "capsule") return { kind: "capsule", label: "에피소드 정리 중", detail: `${episode?.turnCount ?? 0}턴, 약 ${Math.max(1, Math.round((episode?.sourceTokens ?? 0) / 100) / 10)}k 토큰을 정리하고 있습니다.` };
  if (episode?.status === "holding") return { kind: "holding", label: "기억 보류 중", detail: `완료 ${episode.turnCount}턴 · 약 ${Math.max(0, Math.round(episode.sourceTokens / 100) / 10)}k 토큰` };
  const serverActiveJob = state.serverWorker?.activeJob;
  const serverJobIsCurrent = !serverActiveJob?.chatId || serverActiveJob.chatId === state.current?.chatId;
  if (!currentJob && serverActiveJob && !serverJobIsCurrent) return {
    kind: "running", label: "다른 채팅 기억 처리 중", detail: "서버는 모든 채팅의 보조 모델 작업을 한 번에 하나씩 처리합니다.", startedAt: serverActiveJob.startedAt,
  };
  if (state.serverWorker?.phase === "storing") return { kind: "storing", label: "기억 반영 중", detail: progressDetail(state, "추출 결과를 검증하고 장기기억에 반영하고 있습니다."), startedAt: activeStartedAt(state) };
  if (currentJob || (state.serverWorker?.activeCalls ?? 0) > 0) {
    const activeKind = serverActiveJob?.kind;
    const startedAt = activeStartedAt(state);
    const socialBackfill = currentJob?.phase === "social_backfill" || state.serverWorker?.phase === "social_backfill" || activeKind === "social_backfill";
    if (socialBackfill) return { kind: "running", label: "지인 관계 확인 중", detail: "기존 원문에서 직접 확인되는 만남과 인지 관계만 정리하고 있습니다.", startedAt };
    if (currentJob?.phase === "relationship_projection" || state.serverWorker?.phase === "relationship_projection" || activeKind === "relationship_projection") return { kind: "running", label: "관계 변화 정리 중", detail: stageProgressDetail(state, "relationship", "인물 사이의 최신 관계 상태를 반영하고 있습니다."), startedAt };
    if (currentJob?.phase === "story_consolidation" || state.serverWorker?.phase === "story_consolidation" || activeKind === "story_consolidation") return { kind: "running", label: "스토리 흐름 정리 중", detail: stageProgressDetail(state, "story", "완료된 기억을 장면과 이야기 흐름에 반영하고 있습니다."), startedAt };
    const sourceRecovery = currentJob?.sourceRecovery === true || serverActiveJob?.sourceRecovery === true;
    if (sourceRecovery) return { kind: "running", label: "원문 발췌 보완 중", detail: "검색에 직접 관련된 과거 원문에서 빠진 장기 회상용 발췌가 있는지 확인하고 있습니다.", startedAt };
    const auditing = currentJob?.phase === "post_extraction_audit" || state.serverWorker?.phase === "post_extraction_audit";
    const reconciling = currentJob?.phase === "state_reconciliation" || state.serverWorker?.phase === "state_reconciliation";
    const checkingLedger = currentJob?.phase === "ledger_consistency" || state.serverWorker?.phase === "ledger_consistency" || activeKind === "ledger_consistency";
    const sourceMessageCount = currentJob?.sourceMessageCount ?? serverActiveJob?.sourceMessageCount;
    const sourceTurnCount = currentJob?.sourceTurnCount ?? serverActiveJob?.sourceTurnCount;
    const extractionDetail = sourceTurnCount
      ? `완결 ${sourceTurnCount}턴 · 원문 ${sourceMessageCount ?? 0}개를 정리하고 있습니다.`
      : `원문 ${sourceMessageCount ?? "여러"}개를 정리하고 있습니다.`;
    return {
      kind: "running",
      label: `${auditing ? "추출 결과 재검수 중" : reconciling ? "상태 장부 대조 중" : checkingLedger ? "최종 장부 대조 중" : "기억 추출 중"}${progressLabel(state)}`,
      detail: auditing
        ? progressDetail(state, "원문과 1차 기억 초안을 다시 대조하고 있습니다.")
        : reconciling
          ? progressDetail(state, "기존 세계 사실·인물 인식·약속과 새 관측을 대조하고 있습니다.")
          : checkingLedger
            ? stageProgressDetail(state, "ledger", "백필 전체에서 겹치거나 교체된 상태가 남았는지 제한적으로 확인하고 있습니다.")
            : progressDetail(state, extractionDetail),
      startedAt,
    };
  }
  if (state.settings.workerAttention || blockingFailures > 0 || summary.failedEmbeddings > 0) return { kind: "error", label: "오류", detail: `실패 ${blockingFailures + summary.failedEmbeddings || 1}건, 확인이 필요합니다.` };
  if (summary.progress?.retryAttempt) return {
    kind: "queued",
    label: `재시도 ${summary.progress.retryAttempt}/${summary.progress.retryMax ?? 3}`,
    detail: "같은 기억 묶음을 다시 처리한 뒤 다음 묶음으로 넘어갑니다.",
  };
  if (summary.pendingEmbeddings > 0) return { kind: "indexing", label: `검색 인덱싱 ${summary.pendingEmbeddings}`, detail: "새 기억의 벡터 검색 인덱스를 만들고 있습니다." };
  if (summary.queuedJobs > 0) {
    const count = summary.queuedJobs;
    return { kind: "queued", label: `대기 ${count}`, detail: "백그라운드 기억 작업이 순서를 기다립니다." };
  }
  if (summary.pendingReviews > 0) return { kind: "review", label: `상태 확인 ${summary.pendingReviews}`, detail: `${summary.pendingReconciliations ?? summary.pendingReviews}개 상태와 충돌의 확인을 기다립니다.` };
  if ((summary.advisoryFailedJobs ?? 0) > 0) return {
    kind: "review", label: `부가 정리 확인 ${summary.advisoryFailedJobs}`,
    detail: "기억 추출은 계속 완료됐습니다. 관계·줄거리·최종 대조 실패는 처리 상태에서 확인할 수 있습니다.",
  };
  if (state.lastPrepare?.lineage?.status === "inherited" && !state.lastPrepare.lineage.acknowledgedAt) return {
    kind: "review",
    label: state.lastPrepare.lineage.kind === "branch" ? "분기 기억 이어받음" : "복사 기억 이어받음",
    detail: state.lastPrepare.lineage.kind === "branch"
      ? "분기 이전의 기억을 이어받았습니다."
      : "선택한 원본 채팅의 기억을 이어받았습니다.",
  };
  if (state.perspectiveStatus?.unresolved) return {
    kind: "review",
    label: "관점 확인 필요",
    detail: state.perspectiveStatus.omissionReason === "unresolved_perspective"
      ? "등장인물 관점을 확정하지 못해 공유 기억만 안전하게 사용했습니다. Settings에서 자동 감지 결과를 확인하세요."
      : "마지막으로 확인된 관점 또는 공유 기억만 사용하고 있습니다.",
  };
  if ((state.translationActivity?.pending ?? 0) > 0) return { kind: "translation", label: `번역 중 ${state.translationActivity?.pending}`, detail: "화면에 보이는 영어 정본의 한국어 참고 번역을 만들고 있습니다." };
  return { kind: "idle", label: "RCM 정상", detail: "새 기억 작업을 기다리고 있습니다." };
}

export async function installStatusWidget(state: RuntimeState, client: ServerClient): Promise<void> {
  let installedRoot: SafeRootDocument | undefined;
  let installedWidget: SafeRootElement | undefined;
  let installedClockStyle: SafeRootElement | undefined;
  const installedListeners: Array<{ type: string; id: string }> = [];
  try {
    const root = await risuai.getRootDocument();
    installedRoot = root;
    await (await root.querySelector(WIDGET_SELECTOR))?.remove();
    await (await root.querySelector(WIDGET_CLOCK_STYLE_SELECTOR))?.remove();
    const clockStyle = await root.createElement("style");
    installedClockStyle = clockStyle;
    await clockStyle.setAttribute("x-rcm-status-clock-style", "true");
    await clockStyle.setTextContent(STATUS_CLOCK_CSS + `
[x-rcm-status-widget] button:focus-visible{outline:2px solid var(--risu-theme-textcolor,#f5f5f5);outline-offset:-3px}
[x-rcm-status-widget] button:hover{background:color-mix(in srgb,var(--risu-theme-textcolor,#f5f5f5) 8%,transparent)!important}
@media(pointer:coarse){[x-rcm-status-widget] [data-rcm-drag]{height:44px!important}[x-rcm-status-widget] button{min-height:44px!important}[x-rcm-status-widget] [data-rcm-toggle]{width:44px!important}}
`);
    const styleHost = await root.querySelector("head") ?? await root.querySelector("body");
    if (styleHost) await styleHost.appendChild(clockStyle);
    const widget = await root.createElement("div");
    installedWidget = widget;
    await widget.setAttribute("x-rcm-status-widget", "true");
    const viewportWidth = await root.clientWidth();
    const viewportHeight = await root.clientHeight();
    const savedPosition = state.settings.statusWidgetPosition;
    const initialPosition = clampStatusPosition(savedPosition?.left ?? viewportWidth - statusWidgetWidth(false, viewportWidth) - 8, savedPosition?.top ?? viewportHeight - 140, viewportWidth, viewportHeight);
    let widgetLeft = initialPosition.left;
    let widgetTop = initialPosition.top;
    const baseStyles: Record<string, string> = {
      display: "none", position: "fixed", zIndex: "2147482900", boxSizing: "border-box", minWidth: "0", maxWidth: "calc(100vw - 16px)",
      border: "1px solid color-mix(in srgb,var(--risu-theme-darkborderc,#4b5563) 65%,transparent)", borderRadius: "8px",
      backgroundColor: "color-mix(in srgb,var(--risu-theme-darkbg,#21222c) 90%,transparent)", color: "var(--risu-theme-textcolor,#f5f5f5)",
      boxShadow: "0 4px 14px rgba(0,0,0,.12)",
      fontFamily: "Arial,system-ui,sans-serif", fontSize: "12px", left: `${widgetLeft}px`, top: `${widgetTop}px`,
    };
    for (const [name, value] of Object.entries(baseStyles)) await widget.setStyle(name, value);
    let expanded = false;
    let press: { x: number; y: number; region: "header" | "action" } | undefined;
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;
    let callObservedAt = 0;
    let renderedTimerStartedAt = 0;
    let actionError = "";
    let renderedStatusKey = "";
    const escapeHtml = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
    const eventInsideWidget = async (event: any): Promise<{ inside: boolean; x: number; y: number; width: number; height: number }> => {
      const x = Number(event.clientX) - widgetLeft;
      const y = Number(event.clientY) - widgetTop;
      const width = await widget.clientWidth();
      const height = await widget.clientHeight();
      return { inside: Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= width && y >= 0 && y <= height, x, y, width, height };
    };
    const currentVisual = () => {
      const current = widgetState(state);
      if (["running", "initial", "storing", "capsule", "timing"].includes(current.kind)) {
        if (current.startedAt) callObservedAt = current.startedAt;
        else if (!callObservedAt) callObservedAt = Date.now();
        current.startedAt = callObservedAt;
      } else callObservedAt = 0;
      const color = current.kind === "error" ? "#ef4444" : current.kind === "disabled" ? "#94a3b8" : ["paused", "review", "queued", "holding", "checking", "setup", "connection"].includes(current.kind) ? "#f59e0b" : ["running", "initial", "capsule", "storing", "indexing", "translation"].includes(current.kind) ? "#3b82f6" : "#22c55e";
      return { current, color };
    };
    const syncElapsedClock = async (current: FloatingWidgetState, force = false): Promise<void> => {
      const startedAt = current.startedAt ?? 0;
      await widget.setAttribute(STATUS_TIMED_ATTRIBUTE, startedAt ? "true" : "false");
      if (!startedAt || (!force && startedAt === renderedTimerStartedAt)) return;
      renderedTimerStartedAt = startedAt;
      const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1_000));
      await (await widget.querySelector('[x-rcm-status-elapsed="true"]'))?.setStyle("--rcm-status-delay", `-${elapsed}s`);
    };
    const keepInViewport = async (): Promise<void> => {
      const width = statusWidgetWidth(expanded, await root.clientWidth());
      await widget.setStyle("width", `${width}px`);
      const position = clampStatusPosition(
        widgetLeft,
        widgetTop,
        await root.clientWidth(),
        await root.clientHeight(),
        width,
        await widget.clientHeight(),
      );
      if (position.left !== widgetLeft) { widgetLeft = position.left; await widget.setStyle("left", `${widgetLeft}px`); }
      if (position.top !== widgetTop) { widgetTop = position.top; await widget.setStyle("top", `${widgetTop}px`); }
    };
    let dashboardHidden = false;
    let widgetChatId = state.current?.chatId;
    const syncVisibility = async () => {
      if (widgetChatId !== state.current?.chatId) {
        widgetChatId = state.current?.chatId;
        expanded = false;
        actionError = "";
      }
      const visible = shouldShowStatusWidget(state, dashboardHidden);
      await widget.setStyle("display", visible ? "block" : "none");
      return visible;
    };
    const patchStatus = async () => {
      if (!await syncVisibility()) return;
      await keepInViewport();
      const { current, color } = currentVisual();
      await (await widget.querySelector('[x-rcm-status-dot="true"]'))?.setStyle("background", color);
      await (await widget.querySelector('[x-rcm-status-label-text="true"]'))?.setTextContent(current.label);
      await syncElapsedClock(current);
      await (await widget.querySelector('[x-rcm-status-detail="true"]'))?.setTextContent(current.detail);
    };
    let patchQueue = Promise.resolve();
    const schedulePatch = (): Promise<void> => {
      patchQueue = patchQueue.then(patchStatus, patchStatus);
      return patchQueue;
    };
    state.setStatusWidgetHidden = async (hidden) => {
      dashboardHidden = hidden;
      if (!await syncVisibility()) return;
      // display:none may restart the host-side CSS clock. Rebase its negative
      // delay to wall time before showing the widget again.
      renderedTimerStartedAt = 0;
      await widget.setStyle("visibility", "hidden");
      await schedulePatch();
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      await widget.setStyle("visibility", "visible");
      await schedulePatch();
    };
    const render = async () => {
      await syncVisibility();
      await keepInViewport();
      const { current, color } = currentVisual();
      renderedStatusKey = statusVisualKey(current);
      const buttonStyle = "min-height:32px;border:1px solid var(--risu-theme-darkborderc,#4b5563);border-radius:6px;background:transparent;color:inherit;padding:8px 10px;cursor:pointer;text-align:left";
      const primaryStyle = `${buttonStyle};background:var(--risu-theme-selected,#44475a)`;
      const compactButtonStyle = "min-width:0;min-height:32px;border:1px solid var(--risu-theme-darkborderc,#4b5563);border-radius:6px;background:transparent;color:inherit;cursor:pointer;text-align:left;font-size:12px;line-height:1.5;white-space:normal;word-break:keep-all;overflow-wrap:anywhere;padding:6px 8px";
      const compactPrimaryStyle = `${compactButtonStyle};background:var(--risu-theme-selected,#44475a)`;
      let body = `<div x-rcm-status-detail="true" style="color:color-mix(in srgb,var(--risu-theme-textcolor,#f5f5f5) 76%,transparent)">${escapeHtml(current.detail)}</div>`;
      const timingRows = [
        ...timingsForChat(state, state.current?.chatId),
        ...(state.serverWorker?.auxiliaryCalls ?? []).map((event) => ({ ...event, label: `서버 보조 모델 · ${event.purpose}` })),
      ].sort((left, right) => right.startedAt - left.startedAt).slice(0, 6).map((event) => {
        const outcome = event.outcome === "succeeded" ? "완료" : event.outcome === "failed" ? "실패" : event.outcome === "reused" ? "재사용" : "진행 중";
        const elapsedMs = event.outcome === "running" ? Date.now() - event.startedAt : event.elapsedMs ?? 0;
        const tone = event.outcome === "failed" ? "#ef4444" : event.outcome === "running" ? "#60a5fa" : "color-mix(in srgb,var(--risu-theme-textcolor,#f5f5f5) 68%,transparent)";
        return `<div style="display:flex;gap:6px;justify-content:space-between;padding-top:4px;font-variant-numeric:tabular-nums"><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(event.label)}</span><span style="color:${tone};white-space:nowrap">${outcome} · ${(Math.max(0, elapsedMs) / 1000).toFixed(1)}초</span></div>`;
      }).join("");
      if (timingRows) body += `<div style="border-top:1px solid var(--risu-theme-darkborderc,#4b5563);margin-top:8px;padding-top:4px"><div style="font-size:11px;color:color-mix(in srgb,var(--risu-theme-textcolor,#f5f5f5) 58%,transparent)">최근 실행 시간</div>${timingRows}</div>`;
      const dashboardLabel = state.statusSummary?.initialCalibration?.status === "awaiting_confirmation" ? "초기 장부 확인" : "대시보드";
      body += `${state.settings.workerPaused ? `<button data-rcm-resume="true" style="${compactButtonStyle};width:100%;margin-top:6px">처리 재개</button>` : ""}<button data-rcm-open="true" style="${compactButtonStyle};width:100%;border-color:transparent;margin-top:4px">${dashboardLabel} 열기 →</button>`;
      if (actionError) body = `<div role="alert" style="border:1px solid #ef4444;border-radius:6px;padding:7px;margin-bottom:8px;color:var(--risu-theme-draculared,#ef4444)">${escapeHtml(actionError)}</div>${body}`;
      await widget.setInnerHTML(`<div data-rcm-drag="true" style="box-sizing:border-box;display:flex;align-items:center;gap:6px;height:36px;padding:0 0 0 8px;cursor:grab;touch-action:none"><span aria-hidden="true" style="color:color-mix(in srgb,var(--risu-theme-textcolor,#f5f5f5) 55%,transparent);font-weight:700;letter-spacing:-2px">⋮⋮</span><span x-rcm-status-dot="true" aria-hidden="true" style="width:8px;height:8px;border-radius:50%;background:${color};flex:none"></span><strong x-rcm-status-label="true" title="${escapeHtml(current.label)}" style="flex:1;min-width:0;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><span x-rcm-status-label-text="true">${escapeHtml(current.label)}</span><span x-rcm-status-elapsed="true" aria-hidden="true"></span></strong><button type="button" data-rcm-toggle="true" aria-label="${expanded ? "접기" : "펼치기"}" style="display:grid;place-items:center;width:36px;height:36px;flex:none;border:0;background:transparent;border-radius:6px;color:var(--risu-theme-textcolor,#f5f5f5);font-size:18px;font-weight:500;line-height:1;cursor:pointer">${expanded ? "−" : "+"}</button></div>${expanded ? `<div style="border-top:1px solid var(--risu-theme-darkborderc,#4b5563);padding:8px;line-height:1.5;max-height:calc(100vh - 60px);overflow:auto;box-sizing:border-box">${body}</div>` : ""}`);
      await syncElapsedClock(current, true);
      await keepInViewport();
    };

    type WidgetAction = { key: string; selector: string; run: () => void | Promise<void> };
    const widgetActions = (): WidgetAction[] => {
      const actions: WidgetAction[] = [
        { key: "toggle", selector: '[data-rcm-toggle="true"]', run: async () => { expanded = !expanded; await render(); } },
        { key: "open", selector: '[data-rcm-open="true"]', run: () => state.openDashboard?.() },
        { key: "resume", selector: '[data-rcm-resume="true"]', run: async () => { state.settings.workerPaused = false; delete state.settings.workerAttention; await saveSettings(state.settings); if (state.settings.extractionEngine === "server") state.serverWorker = await client.resumeServerWorker(state.workerId); else void import("./worker.js").then(({ drainWorker }) => drainWorker(state, client)); await render(); } },
      ];
      return actions;
    };
    const actionAt = async (x: number, y: number): Promise<WidgetAction | undefined> => {
      for (const action of widgetActions()) {
        const element = await widget.querySelector(action.selector);
        if (!element) continue;
        const rect = await element.getBoundingClientRect();
        if (statusPointInRect(x, y, rect)) return action;
      }
      return undefined;
    };
    const runAction = async (action: WidgetAction): Promise<void> => {
      actionError = "";
      try {
        await action.run();
      } catch (error) {
        actionError = String(error).replace(/^Error:\s*/, "");
        addLog(state.logs, "warn", `Episode action failed: ${actionError}`);
        await render();
      }
    };
    // Polling may update the compact status, but it must not rebuild an open
    // picker/confirmation panel while the user is scrolling or deciding.
    state.refreshStatusWidget = () => {
      const next = currentVisual().current;
      const nextKey = statusVisualKey(next);
      if (widgetChatId !== state.current?.chatId || (nextKey !== renderedStatusKey)) {
        renderedStatusKey = nextKey;
        void render();
      } else void schedulePatch();
    };
    await render();
    const listen = async (type: string, callback: (event: any) => void | Promise<void>): Promise<void> => {
      installedListeners.push({ type, id: await root.addEventListener(type, callback) });
    };
    await listen("pointerdown", async (event: any) => {
      const hit = await eventInsideWidget(event);
      if (!hit.inside) return;
      const pointerRegion = statusPointerRegion(hit.x, hit.y, hit.width, await (await widget.querySelector('[data-rcm-drag="true"]'))?.clientHeight() ?? 36);
      if (pointerRegion === "toggle") {
        press = { x: Number(event.clientX), y: Number(event.clientY), region: "action" };
        return;
      }
      const region = pointerRegion === "header" ? "header" : undefined;
      press = { x: Number(event.clientX), y: Number(event.clientY), region: region ?? "action" };
      dragging = false;
      offsetX = Number(event.clientX) - widgetLeft; offsetY = Number(event.clientY) - widgetTop;
    });
    await listen("pointermove", async (event: any) => {
      if (!press) return;
      if (!dragging && !statusDragStarted(press.x, press.y, Number(event.clientX), Number(event.clientY))) return;
      if (press.region === "action") {
        press = undefined;
        return;
      }
      dragging = true;
      const width = await root.clientWidth();
      const height = await root.clientHeight();
      const position = clampStatusPosition(Number(event.clientX) - offsetX, Number(event.clientY) - offsetY, width, height, await widget.clientWidth(), await widget.clientHeight());
      widgetLeft = position.left;
      widgetTop = position.top;
      state.settings.statusWidgetPosition = { left: widgetLeft, top: widgetTop };
      await widget.setStyle("left", `${widgetLeft}px`); await widget.setStyle("top", `${widgetTop}px`);
    });
    await listen("pointerup", async (event: any) => {
      if (!press) return;
      const released = press;
      press = undefined;
      if (dragging) {
        dragging = false;
        await saveSettings(state.settings).catch(() => undefined);
        return;
      }
      const hit = await eventInsideWidget(event);
      if (!hit.inside) return;
      if (released.region === "header") {
        expanded = !expanded;
        await render();
        return;
      }
      const action = await actionAt(Number(event.clientX), Number(event.clientY));
      if (action) await runAction(action);
    });
    await listen("pointercancel", async () => {
      press = undefined;
      dragging = false;
    });
    await root.appendChild(widget);
    await keepInViewport();
    await risuai.onUnload(async () => {
      state.refreshStatusWidget = undefined;
      state.setStatusWidgetHidden = undefined;
      for (const listener of installedListeners) await (root as any).removeEventListener(listener.type, listener.id);
      await widget.remove();
      await clockStyle.remove();
    });
  } catch (error) {
    state.refreshStatusWidget = undefined;
    state.setStatusWidgetHidden = undefined;
    if (installedRoot) {
      for (const listener of installedListeners) {
        await Promise.resolve((installedRoot as any).removeEventListener(listener.type, listener.id)).catch(() => undefined);
      }
    }
    if (installedWidget) await installedWidget.remove().catch(() => undefined);
    if (installedClockStyle) await installedClockStyle.remove().catch(() => undefined);
    addLog(state.logs, "warn", `Status widget unavailable: ${String(error)}`);
    // Chat menu state remains the fallback in hosts without SafeRoot support.
  }
}

export async function updateWorkerMenuButton(state: RuntimeState): Promise<void> {
  await risuai.registerButton(
    {
      name: state.settings.workerAttention ? "⚠ Cognitive Memory · 처리 멈춤" : "Cognitive Memory",
      icon: state.settings.workerAttention ? ALERT_ICON : MEMORY_ICON,
      iconType: "html",
      location: "chat",
      id: BUTTON_ID,
    },
    () => state.openDashboard?.(),
  );
}

export async function showWorkerPauseNotice(state: RuntimeState): Promise<void> {
  state.refreshStatusWidget?.();
  await updateWorkerMenuButton(state).catch((error) => {
    addLog(state.logs, "warn", `Worker menu unavailable: ${String(error)}`);
  });
}
