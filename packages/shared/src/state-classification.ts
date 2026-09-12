/** Shared semantic instructions; classification remains the auxiliary model's job. */
export const STATE_CLASSIFICATION_GUIDANCE = `CLASSIFY BY WHAT THE SOURCE ESTABLISHES:
- Event memory: an action, statement, discovery, or change at a particular time. Importance or urgency alone does not make it an ongoing world state.
- World state: a property or condition that the source establishes as applicable at the end of the supplied coverage and useful for later continuity. It may be lasting or temporary; duration and importance alone do not decide the category. A claim or private intention alone does not establish world truth.
- Character belief: a holder's consequential belief or interpretation; distinguish what the holder believes from what is true. Ordinary shared knowledge belongs in memory access, not a duplicate belief.
- Promise: a future or recurring obligation; follow the existing promise-event rules.
- An event can establish, change, or end a state. Preserve both only when the occurrence and the resulting condition each have future continuity or recall value. Keep recall-worthy events and their concrete details or dialogue even when they produce no state observation.
- Silence, elapsed time, and a scheduled end alone do not prove that a condition, promise, or belief changed. Do not decide an off-screen outcome.
- For every world-fact or belief predicate/predicateHint, name only the property being tracked with a short reusable noun or noun phrase. It must still name the same property if the value later changes. Put people, places, causes, limits, times, and event actions in subject or value, not in the predicate.
- When supplied stateVocabulary already contains a predicate for the same property, copy that predicate exactly. The vocabulary supplies names only; it is not evidence that a listed state applies to this source.`;

export const FIRST_MEETING_GUIDANCE = `Use first_met when source evidence establishes the pair's first meeting. Preserve the pair and evidence, and an explicit date only when supplied. First appearance in this transcript, a self-introduction, or a reunion alone does not establish a first meeting.`;

export const WHOLE_ATOM_ACCESS_GUIDANCE = `An access grant covers EVERY fact in the detail, dialogue, or source passage. Knowing one clause or participating in part of an event is insufficient. Split facts with different knowers, restrict the whole atom to supported knowers, or leave access empty. Narration describing what was withheld is not evidence that its listener learned the withheld fact.`;
