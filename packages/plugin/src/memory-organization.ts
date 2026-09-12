import type { MemoryGroupingResult } from '@rcm/shared';

export interface OrganizationRange {
  id: string; startOrdinal: number; endOrdinal: number; sourceMessageIds: string[]; eligible: boolean;
  reason: string | null; excerpt: string; rawTokens: number; memoryIds: string[]; groupIds: string[];
}
export interface OrganizationData { ranges: OrganizationRange[]; groups: any[]; regenerations: any[]; legacyHolds?: Array<{ id: string }> }
export interface OrganizationView {
  open: boolean; selection: string[]; focusedId: string; highlightedIds: string[]; mobileDetail: boolean;
  candidateId: string; detail?: { id: string; messages: Array<{ id: string; role: string; content: string | null; ordinal: number }> };
  data: OrganizationData; error?: string; busy?: boolean;
}
export type OrganizationTranslations = ReadonlyMap<string, string>;
export const createOrganizationView = (): OrganizationView => ({ open: false, selection: [], focusedId: '', highlightedIds: [], mobileDetail: false,
  candidateId: '', data: { ranges: [], groups: [], regenerations: [] } });
const html = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const number = (value: number): string => Math.round(value).toLocaleString('ko-KR');
const action = (name: string, label: string, id = '', disabled = false, primary = false) => `<button type="button" class="btn${primary ? ' btn--primary' : ''}" data-action="${name}" data-id="${html(id)}" ${disabled ? 'disabled' : ''}>${label}</button>`;
const rangeLabel = (range: OrganizationRange) => `메시지 ${range.startOrdinal + 1}–${range.endOrdinal + 1}`;

export function toggleOrganizationRange(ranges: OrganizationRange[], selected: string[], id: string): string[] {
  const range = ranges.find((row) => row.id === id);
  if (!range?.eligible) throw new Error(range?.reason ?? '선택할 수 없는 구간입니다.');
  const next = selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id];
  const positions = ranges.flatMap((row, index) => next.includes(row.id) ? [index] : []);
  if (positions.length && positions.at(-1)! - positions[0]! + 1 !== positions.length) throw new Error('연속된 구간을 선택해 주세요. 중간 구간은 건너뛸 수 없습니다.');
  return ranges.filter((row) => next.includes(row.id)).map((row) => row.id);
}

export function compareOrganizationMemories(before: any[], after: any[]) {
  const identity = (memory: any) => memory.key ?? memory.id;
  const left = new Map(before.map((memory) => [identity(memory), memory]));
  const right = new Map(after.map((memory) => [identity(memory), memory]));
  const summary = (memory: any) => JSON.stringify([memory.title, memory.content, memory.details ?? [], memory.keyDialogues ?? memory.dialogues ?? [], memory.knownBy ?? memory.known_by_json]);
  return {
    before: before.map((memory) => ({ ...memory, comparison: !right.has(identity(memory)) ? '제외' : summary(memory) === summary(right.get(identity(memory))) ? '유지' : '변경 전' })),
    after: after.map((memory) => ({ ...memory, comparison: !left.has(identity(memory)) ? '추가' : summary(memory) === summary(left.get(identity(memory))) ? '유지' : '변경 후' })),
  };
}

function memoryList(memories: any[], translations: OrganizationTranslations = new Map(), display = 'en'): string {
  const copy = (memory: any, field: 'title' | 'content') => display === 'en' ? String(memory[field] ?? '') : translations.get(`${memory.id}:${field}`) ?? String(memory[field] ?? '');
  return memories.length ? `<ul class="organization-memories">${memories.map((memory) => `<li>${memory.comparison ? `<small class="organization-muted">${html(memory.comparison)}</small><br>` : ""}<strong>${html(copy(memory, 'title'))}</strong><p>${html(copy(memory, 'content'))}</p>
    ${(memory.details ?? []).length ? `<details><summary>세부 ${(memory.details ?? []).length}개</summary>${memory.details.map((detail: any) => `<p>${html(detail.text)}</p>`).join('')}</details>` : ''}
    ${(memory.keyDialogues ?? memory.dialogues ?? []).length ? `<details><summary>보존된 대사 ${(memory.keyDialogues ?? memory.dialogues).length}개</summary>${(memory.keyDialogues ?? memory.dialogues).map((quote: any) => `<p><strong>${html(quote.speaker)}</strong> ${html(quote.text)}</p>`).join('')}</details>` : ''}</li>`).join('')}</ul>` : '<p class="organization-muted">기억이 없습니다.</p>';
}
function groupingResult(result: MemoryGroupingResult): string {
  return `<h3>${html(result.title)}</h3>${result.sections.map((section) => `<article><h4>${html(section.title)}</h4><p>${html(section.summary)}</p></article>`).join('')}
    ${result.reviewItems.length ? `<aside class="organization-notice"><strong>함께 확인할 내용</strong><ul>${result.reviewItems.map((item) => `<li>${html(item.reason)}</li>`).join('')}</ul></aside>` : ''}`;
}
function canonicalStates(values: any[]): string {
  const fields = [['relationshipEvents','관계 변화'],['assertions','사실'],['beliefs','믿음'],['promises','약속'],['physicalIntimacy','친밀 기록']] as const;
  return fields.map(([key, label]) => {
    const entries = values.flatMap((value) => value[key] ?? []);
    return `<details><summary>${label} ${entries.length}개</summary><ul>${entries.map((item: any) => `<li>${html([item.holder, item.subject, item.predicate, item.value, item.polarity, item.promisor, item.promisee, item.from, item.to, item.participantA, item.participantB, item.act, item.customLabel, item.reason, item.content, item.status, ...(item.changes ?? []).map((change: any) => `${change.axis}: ${change.effect} (${change.impact})`)].filter(Boolean).join(' · '))}</li>`).join('')}</ul></details>`;
  }).join('');
}

function candidateDetail(view: OrganizationView, memories: any[], translations: OrganizationTranslations, display: string): string {
  const group = view.data.groups.find((row) => `group:${row.id}` === view.candidateId);
  const run = view.data.regenerations.find((row) => `regeneration:${row.id}` === view.candidateId);
  if (!group && !run) return '<p>확인할 후보를 선택하세요.</p>';
  const item = group ?? run, ready = item.status === 'ready';
  const kind = group ? 'group' : 'regeneration';
  const before = group ? memories.filter((memory) => group.memberIds.includes(memory.id)) : run.preview?.beforeCurrentMemories ?? (Array.isArray(run.preview?.before)
    ? run.preview.before.flatMap((value: any) => value.memories) : run.preview?.before?.memories ?? []);
  const after = group ? [] : run.preview?.afterCurrentMemories ?? (Array.isArray(run.preview?.after) ? run.preview.after.flatMap((value: any) => value.memories) : run.preview?.after?.memories ?? []);
  const compared = compareOrganizationMemories(before, after);
  return `<div class="organization-reader"><header>${action('organization-back-detail', '← 구간 상세로')}<h2>${group ? '묶기 결과' : run.mode === 'episode' ? '구간 재생성 결과' : '이후 기억 재생성 결과'}</h2></header>
    <p class="organization-muted">${ready ? '현재 기억은 아직 변경되지 않았습니다. 결과를 확인한 뒤 적용하세요.' : '기존 기억을 계속 사용합니다. 화면을 닫아도 작업은 유지됩니다.'}</p>
    ${item.error ? `<p role="alert" class="organization-notice">${html(item.error)}</p>` : ''}
    ${ready ? `<div class="organization-compare"><section><h3>현재 기억 ${before.length}개</h3>${memoryList(group ? before : compared.before, translations, display)}${run?.mode === 'canonical_suffix' ? canonicalStates([run.preview.beforeStates]) : ''}</section>
      <section><h3>${group ? '새 통합 에피소드' : `새 기억 ${after.length}개`}</h3>${group ? groupingResult(group.candidate) : memoryList(compared.after, translations, display)}${run?.mode === 'canonical_suffix' ? canonicalStates([run.preview.afterStates]) : ''}</section></div>
      ${group ? '<p class="organization-notice">기존 세부·대사·접근 권한과 관계·사실·믿음·약속은 보존됩니다. 묶기는 표시 방식과 통합 요약을 바꿉니다.</p>' : ''}` : `<p class="organization-muted">${item.status === 'failed' ? '작업을 끝내지 못했습니다.' : item.status === 'stale' ? '원문이나 기억이 바뀌어 이 결과를 사용할 수 없습니다.' : '후보를 만드는 중입니다.'}</p>`}
    <footer class="organization-actions">${ready ? action(`organization-apply-${kind}`, '적용', item.id, false, true) : ''}${action(`organization-discard-${kind}`, '후보 버리기', item.id)}
      ${group && item.canRetry ? action('organization-retry-group', '실패 단계 다시 시도', item.id) : ''}</footer></div>`;
}

export function memoryOrganization(view: OrganizationView, memories: any[], translations: OrganizationTranslations = new Map(), display = 'en'): string {
  const selected = view.data.ranges.filter((row) => view.selection.includes(row.id));
  const focused = view.data.ranges.find((row) => row.id === view.focusedId);
  const candidates = [...view.data.groups.filter((row) => row.status !== 'capsuled').map((row) => ({ ...row, key: `group:${row.id}`, label: '묶기' })),
    ...view.data.regenerations.map((row) => ({ ...row, key: `regeneration:${row.id}`, label: row.mode === 'episode' ? '구간 재생성' : '이후 기억 재생성' }))];
  const activeGroups = view.data.groups.filter((row) => row.status === 'capsuled');
  const rows = view.data.ranges.map((range) => `<div class="organization-range ${view.highlightedIds.includes(range.id) ? 'is-highlighted' : ''} ${range.id === view.focusedId ? 'is-focused' : ''}">
    <label><input type="checkbox" data-action="organization-select" data-id="${html(range.id)}" ${view.selection.includes(range.id) ? 'checked' : ''} ${range.eligible ? '' : 'disabled'} aria-label="${rangeLabel(range)} 선택"></label>
    <button type="button" data-action="organization-detail" data-id="${html(range.id)}"><strong>${rangeLabel(range)}</strong><span>${html(range.excerpt)}</span><small>기억 ${range.memoryIds.length}개 · 원문 약 ${number(range.rawTokens)}토큰</small>
    <small>${html(range.reason ?? '선택 가능')}</small></button></div>`).join('');
  const details = focused ? `<div class="organization-reader"><header>${action('organization-list','← 구간 목록으로')}<h2>${rangeLabel(focused)}</h2></header>
    ${focused.reason ? `<p class="organization-notice">${html(focused.reason)}</p>` : ''}<h3>연결된 기억</h3>${memoryList(memories.filter((memory) => focused.memoryIds.includes(memory.id)), translations, display)}
    <h3>원문</h3>${view.detail?.id === focused.id ? view.detail.messages.map((message) => `<details class="organization-source" data-preserve-open="organization-source:${html(focused.id)}:${html(message.id)}"><summary>메시지 ${message.ordinal + 1} · ${message.role === 'user' ? '사용자' : message.role === 'assistant' ? '캐릭터' : '시스템'}</summary><p>${html(message.content ?? '원문을 사용할 수 없어')}</p></details>`).join('') : '<p>원문을 불러오는 중…</p>'}</div>` : '<div class="timeline-empty"><strong>원문 구간을 선택하세요</strong><span>목록에서 내용을 확인하고 연속된 묶음을 선택할 수 있습니다.</span></div>';
  return `<style>${organizationCss}</style><div class="organization-page ${view.mobileDetail ? 'is-mobile-detail' : ''}"><header class="pagehead"><div class="pagehead__copy"><h1>기억 정리</h1><p>원문을 선택하고, 결과를 확인한 뒤 적용하세요.</p></div><div class="pagehead__actions">${action('organization-close','타임라인으로')}</div></header>
    ${view.busy ? '<p class="organization-notice" role="status">처리 예상량을 확인하고 있습니다…</p>' : ''}
    ${view.error ? `<p class="organization-notice" role="alert">${html(view.error)}</p>` : ''}
    <div class="organization-layout"><div class="organization-list" data-preserve-scroll="organization-list">
      ${(view.data.legacyHolds ?? []).map((hold) => `<aside class="organization-pending"><strong>이전 수동 보류가 남아 있습니다</strong><p>이미 처리된 기억은 유지하고, 미처리 원문만 다시 준비합니다.</p>${action('organization-release-hold','수동 보류 해제', hold.id)}</aside>`).join('')}
      ${candidates.length ? `<section class="organization-pending"><h2>확인할 작업 ${candidates.length}개</h2>${candidates.map((item) => action('organization-candidate', `${html(item.label)} · ${item.status === 'ready' ? '결과 확인' : item.status === 'failed' ? '확인 필요' : item.status === 'stale' ? '원문 변경됨' : '생성 중'}`, item.key)).join('')}</section>` : ''}
      ${activeGroups.length ? `<details class="organization-pending"><summary>적용된 묶기 ${activeGroups.length}개</summary>${activeGroups.map((group) => `<p>${html(group.title)} ${action('organization-ungroup', '묶기 해제', group.id)}</p>`).join('')}</details>` : ''}
      <div>${rows || '<div class="timeline-empty">아직 처리된 원문 묶음이 없습니다.</div>'}</div>
      <footer class="organization-selection"><strong>${selected.length}개 묶음 · 메시지 ${selected.reduce((sum, row) => sum + row.sourceMessageIds.length, 0)}개 선택</strong>
        <span>원문 약 ${number(selected.reduce((sum, row) => sum + row.rawTokens, 0))}토큰</span><small>원문 토큰은 실제 청구량과 다릅니다. 생성 전에 전체 예상 입력을 확인하세요.</small>
        ${action('organization-create-group','선택한 구간 묶기','',selected.length < 2,true)}
        ${action('regenerate-episode','이 구간의 기억 다시 만들기', selected[0]?.id ?? '', selected.length !== 1 || view.busy)}
        ${action('regenerate-canonical','여기부터 기억 다시 만들기', selected[0]?.id ?? '',selected.length !== 1 || view.busy)}
      </footer></div><div class="organization-detail">${view.candidateId ? candidateDetail(view, memories, translations, display) : details}</div></div></div>`;
}

const organizationCss = `.organization-page{display:flex;flex-direction:column;gap:16px;min-height:360px;height:calc(100dvh - 176px)}.organization-page .pagehead{flex-shrink:0}.organization-layout{display:grid;grid-template-columns:minmax(280px,360px) minmax(0,1fr);min-height:0;flex:1;border:1px solid var(--rcm-border);border-radius:12px;overflow:hidden}.organization-list,.organization-detail{min-width:0;overflow:auto}.organization-list{border-right:1px solid var(--rcm-border)}.organization-range{display:grid;grid-template-columns:44px minmax(0,1fr);border-bottom:1px solid var(--rcm-border)}.organization-range>label{display:grid;place-items:center;min-height:44px}.organization-range input{width:18px;height:18px;accent-color:var(--rcm-accent)}.organization-range>button{display:grid;gap:6px;min-width:0;min-height:96px;text-align:left;background:transparent;color:var(--rcm-text);border:0;padding:16px 14px 16px 0;cursor:pointer}.organization-range>button>span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.organization-range small,.organization-muted{color:var(--rcm-muted);line-height:1.65}.organization-range.is-highlighted{box-shadow:inset 3px 0 var(--rcm-accent)}.organization-range.is-focused{background:color-mix(in srgb,var(--rcm-accent) 8%,var(--rcm-surface))}.organization-selection,.organization-pending{display:grid;gap:9px;padding:16px;border-bottom:1px solid var(--rcm-border)}.organization-selection{position:sticky;bottom:0;background:var(--rcm-surface);border-top:1px solid var(--rcm-border);border-bottom:0}.organization-selection small{color:var(--rcm-muted);line-height:1.6}.organization-reader{padding:24px;overflow-wrap:anywhere}.organization-reader header{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.organization-reader header [data-action="organization-list"]{display:none}.organization-reader h2{font-size:20px}.organization-reader h3{margin:22px 0 12px;font-size:16px}.organization-reader p{white-space:pre-wrap;line-height:1.8}.organization-compare{display:grid;grid-template-columns:1fr 1fr;gap:24px}.organization-compare>section{min-width:0}.organization-memories{list-style:none;padding:0;margin:0}.organization-memories>li{padding:16px 0;border-bottom:1px solid var(--rcm-border)}.organization-memories details{margin:10px 0}.organization-memories summary{cursor:pointer;min-height:32px;color:var(--rcm-muted)}.organization-source{padding:0;border-bottom:1px solid var(--rcm-border)}.organization-source>summary{padding:18px 0;cursor:pointer;font-size:12px;color:var(--rcm-muted)}.organization-source>p{padding:0 0 18px}.organization-notice{padding:14px 16px;background:color-mix(in srgb,var(--rcm-accent) 7%,var(--rcm-surface));line-height:1.7}.organization-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:24px}.organization-pending h2{font-size:14px;margin:0}.organization-page button:focus-visible,.organization-page input:focus-visible{outline:2px solid var(--rcm-accent);outline-offset:2px}.organization-layout button{min-height:44px}.organization-page button:disabled{opacity:.5;cursor:not-allowed}@media(max-width:1040px){.organization-compare{grid-template-columns:1fr}.organization-layout{grid-template-columns:280px minmax(0,1fr)}}@media(max-width:760px){.organization-page{display:block;height:auto;min-height:0}.organization-layout{display:block;border:0;overflow:visible}.organization-list{border:0;overflow:visible}.organization-detail{display:none}.organization-page.is-mobile-detail .organization-list{display:none}.organization-page.is-mobile-detail .organization-detail{display:block}.organization-reader{padding:12px 0 28px}.organization-selection{position:static;padding:18px 0}.organization-range>button{padding-right:4px}.organization-page>.pagehead{margin-bottom:18px}.organization-actions>.btn{flex:1}.organization-notice{margin-inline:0}.organization-reader header [data-action="organization-list"]{display:inline-flex}.organization-page.is-mobile-detail>.pagehead{display:none}}`;
