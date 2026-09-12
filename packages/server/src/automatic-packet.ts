import { estimateTokens, type MemoryContextItem } from "@rcm/shared";
import { memoryDetailAtomKey, memoryDialogueAtomKey } from "./memory-atoms.js";

/** Internal evidence ranks only: these never grant access or core eligibility. */
export interface AutomaticAtomPriority {
  focus: number;
  cue: number;
  scene: number;
  semantic: number;
  /** Qualified direct evidence for one specific user cue, keyed by query-signal index. */
  cueViews?: Record<string, number>;
  connection?: number;
  connectionViaMemoryId?: string;
  connectionEvidence?: "typed_atom_relation";
  sourceMessageIds: string[];
}
export interface AutomaticPacketPolicy {
  priorities: ReadonlyMap<string, AutomaticAtomPriority>;
  focusIds: ReadonlySet<string>;
  continuityIds: ReadonlySet<string>;
  roles: ReadonlyMap<string, string>;
  associationSources?: ReadonlyMap<string, string>;
  /** At most one representative atom reserved for an otherwise uncovered user cue. */
  cueAnchorKeys?: ReadonlySet<string>;
}
export interface AutomaticAtomDecision {
  memoryId: string; atomKey: string; role: string; bundle: boolean; direct: boolean;
  cueAnchor?: boolean;
  cueViewIndex?: number;
  localRank: number;
  viaMemoryId?: string;
  connectionEvidence?: "shared_source" | "public_atom_overlap" | "typed_atom_relation";
  tokens: number; outcome: "retained" | "target_budget" | "hard_ceiling" | "memory_removed";
}

export function selectCueAnchor(decisions: AutomaticAtomDecision[], priorities: ReadonlyMap<string, AutomaticAtomPriority>,
  cueWeights: ReadonlyMap<number, number>): { decision: AutomaticAtomDecision; cueViewIndex: number } | undefined {
  const protectedCueScores = new Map<number, number>();
  for (const decision of decisions) {
    if (!(decision.direct && decision.role === "focus" || decision.bundle && ["focus", "continuity"].includes(decision.role))) continue;
    for (const [view, score] of Object.entries(priorities.get(decision.atomKey)?.cueViews ?? {})) {
      const cueViewIndex = Number(view);
      protectedCueScores.set(cueViewIndex, Math.max(protectedCueScores.get(cueViewIndex) ?? 0, score));
    }
  }
  return decisions.flatMap((decision) => {
    if (!decision.direct || decision.role !== "core") return [];
    return Object.entries(priorities.get(decision.atomKey)?.cueViews ?? {}).flatMap(([view, score]) => {
      const cueViewIndex = Number(view);
      const protectedScore = protectedCueScores.get(cueViewIndex) ?? 0;
      const gain = score - protectedScore;
      // Small differences between embedding views are ranking noise, not a
      // reason to consume the single cue reservation. With no protected route
      // the already-qualified core candidate still supplies the safety floor.
      if (protectedScore > 0 && score < protectedScore * 1.1) return [];
      return gain <= 0 ? [] : [{ decision, cueViewIndex, score, gain, weight: cueWeights.get(cueViewIndex) ?? 0 }];
    });
  }).sort((left, right) => right.gain - left.gain || right.score - left.score || right.weight - left.weight
    || left.decision.localRank - right.decision.localRank)[0];
}

export function automaticAtoms(item: MemoryContextItem) {
  return [
    ...item.details.map((detail) => ({ key: memoryDetailAtomKey(detail), text: detail.text, kind: "detail" as const })),
    ...item.keyDialogues.map((dialogue) => ({ key: memoryDialogueAtomKey(item.id, dialogue), text: dialogue.text, kind: "dialogue" as const })),
  ];
}

/** Plan the protected content once, before trimming alters any scene. */
export function planAutomaticAtoms(items: MemoryContextItem[], direct: ReadonlySet<string>, policy: AutomaticPacketPolicy): AutomaticAtomDecision[] {
  return items.flatMap((item) => {
    const atoms = automaticAtoms(item);
    const role = policy.focusIds.has(item.id) ? "focus" : policy.continuityIds.has(item.id) ? "continuity" : policy.roles.get(item.id) ?? "core";
    const score = (key: string): number[] => {
      const rank = policy.priorities.get(key);
      return [...(["association", "serendipity"].includes(role) ? [rank?.connection ?? 0] : []), rank?.focus ?? 0, rank?.cue ?? 0, rank?.semantic ?? 0, rank?.scene ?? 0];
    };
    const ordered = atoms.map((atom, index) => ({ ...atom, index })).sort((a, b) => {
      const left = score(a.key), right = score(b.key);
      for (let i = 0; i < left.length; i++) if (right[i] !== left[i]) return right[i]! - left[i]!;
      return a.index - b.index;
    });
    const bundle = new Set<string>();
    const seed = ordered[0];
    if (seed && ["focus", "continuity", "association", "serendipity"].includes(role)) {
      bundle.add(seed.key);
      if (role === "focus") {
        const seedSources = new Set(policy.priorities.get(seed.key)?.sourceMessageIds ?? []);
        const seenText = new Set([seed.text]);
        // Connected public atoms restore context; atom kind grants no priority.
        while (bundle.size < 3) {
          const next = ordered.filter((atom) => !bundle.has(atom.key) && !seenText.has(atom.text))
            .filter((atom) => score(atom.key).some((value) => value > 0)
              || policy.priorities.get(atom.key)?.sourceMessageIds.some((id) => seedSources.has(id)))
            .sort((a, b) => Number(policy.priorities.get(b.key)?.sourceMessageIds.some((id) => seedSources.has(id)))
              - Number(policy.priorities.get(a.key)?.sourceMessageIds.some((id) => seedSources.has(id))))[0];
          if (!next) break;
          bundle.add(next.key); seenText.add(next.text);
        }
      }
    }
    const localRanks = new Map(ordered.map((atom, index) => [atom.key, index]));
    return atoms.map((atom) => ({ memoryId: item.id, atomKey: atom.key, role, localRank: localRanks.get(atom.key)!, viaMemoryId: policy.priorities.get(atom.key)?.connectionViaMemoryId ?? policy.associationSources?.get(item.id),
      connectionEvidence: policy.priorities.get(atom.key)?.connectionEvidence ?? ((policy.priorities.get(atom.key)?.connection ?? 0) >= 2 ? "shared_source" as const
        : (policy.priorities.get(atom.key)?.connection ?? 0) > 0 ? "public_atom_overlap" as const : undefined),
      bundle: bundle.has(atom.key), direct: direct.has(atom.key), tokens: estimateTokens(atom.text), outcome: "retained" as const }));
  });
}

/** Drop the least useful remaining unit, including a peripheral scene's last atom. */
export function trimAutomaticAtom(items: MemoryContextItem[], direct: ReadonlySet<string>, allowDirect = false,
  policy?: AutomaticPacketPolicy, decisions?: AutomaticAtomDecision[],
  outcome: AutomaticAtomDecision["outcome"] = allowDirect ? "hard_ceiling" : "target_budget"): boolean {
  if (!policy || !decisions) {
    // Standalone callers retain the original direct-atom protection contract.
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index]!;
      if (automaticAtoms(item).length <= 1) continue;
      const atoms = automaticAtoms(item);
      const atom = [...atoms.filter((entry) => entry.kind === "detail").reverse(),
        ...atoms.filter((entry) => entry.kind === "dialogue").reverse()].find((entry) => allowDirect || !direct.has(entry.key));
      if (!atom) continue;
      items[index] = removeAtom(item, atom.key);
      return true;
    }
    return false;
  }
  const itemIndices = new Map(items.map((item, index) => [item.id, index]));
  const decisionIndices = new Map(decisions.map((entry, index) => [entry, index]));
  const focusSources = new Map<string, Set<string>>();
  for (const entry of decisions) if (entry.bundle && entry.role === "focus") {
    const sources = focusSources.get(entry.memoryId) ?? new Set<string>();
    for (const id of policy.priorities.get(entry.atomKey)?.sourceMessageIds ?? []) sources.add(id);
    focusSources.set(entry.memoryId, sources);
  }
  const available = decisions.filter((entry) => entry.outcome === "retained" && itemIndices.has(entry.memoryId)
    && (allowDirect || !(entry.direct && entry.role === "focus" || entry.bundle && ["focus", "continuity"].includes(entry.role)
      || policy.cueAnchorKeys?.has(entry.atomKey))));
  const rank = (entry: AutomaticAtomDecision): number[] => {
    const priority = policy.priorities.get(entry.atomKey);
    const reserved = entry.bundle && entry.role === "focus" ? 6 : policy.cueAnchorKeys?.has(entry.atomKey) ? 5
      : entry.bundle && entry.role === "continuity" ? 4
      // A real typed-path endpoint is the strongest form of optional
      // serendipity: keep its representative atom ahead of ordinary optional
      // direct tails, while remaining below focus/cue/continuity protection.
      : entry.bundle && entry.role === "serendipity" && entry.connectionEvidence === "typed_atom_relation" ? 3.5
      : entry.direct ? 3 : entry.bundle && ["association", "serendipity"].includes(entry.role) ? 2
      : entry.role === "focus" && ((priority?.focus ?? 0) + (priority?.cue ?? 0) + (priority?.semantic ?? 0) > 0
        || priority?.sourceMessageIds.some((id) => focusSources.get(entry.memoryId)?.has(id))) ? 1 : 0;
    // Compare local evidence depth, never raw below-threshold scores across
    // memories. Equal-depth content follows the existing portfolio order.
    return [reserved, -entry.localRank, -itemIndices.get(entry.memoryId)!];
  };
  available.sort((a, b) => {
    const left = rank(a), right = rank(b);
    for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return left[i]! - right[i]!;
    return decisionIndices.get(b)! - decisionIndices.get(a)!;
  });
  const removed = available[0];
  if (!removed) return false;
  const index = itemIndices.get(removed.memoryId)!;
  const next = removeAtom(items[index]!, removed.atomKey);
  if (!automaticAtoms(next).length && next.atomAccessVersion > 0) items.splice(index, 1);
  else items[index] = next;
  removed.outcome = outcome;
  return true;
}

function removeAtom(item: MemoryContextItem, key: string): MemoryContextItem {
  return { ...item, details: item.details.filter((detail) => memoryDetailAtomKey(detail) !== key),
    keyDialogues: item.keyDialogues.filter((dialogue) => memoryDialogueAtomKey(item.id, dialogue) !== key) };
}
