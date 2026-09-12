export const DIALOGUE_SOURCE_FORM_GUIDANCE = `DIALOGUE SOURCE FORM
- Preserve each key dialogue's complete displayed source form, including its surrounding quotation marks.
- When a quoted utterance is immediately followed by a parenthesized counterpart, keep the entire quoted utterance and the entire parenthesized counterpart together, in their original order. This applies regardless of either side's language.
- Never return only one side of that displayed pair or leave an unmatched quotation mark or parenthesis. Do not strip, translate, reorder, reconstruct, or complete source punctuation.`;

export const KEY_DIALOGUE_SELECTION_GUIDANCE = `KEY DIALOGUE SELECTION
- Key dialogues are a curated set of future-recall anchors, not merely evidence excerpts. Prefer preserving a scene's useful voice and relationship texture rather than minimizing the count, but include a line only when its exact wording adds value beyond the memory synopsis.
- It qualifies when at least one is true: it establishes or resolves a consequential commitment, boundary, disclosure, threat, value, or reversal; its wording materially changes how the event is understood; it carries distinctive character voice or relationship language likely to support a later callback; or losing the quote would remove an important emotional or relational beat.
- Omit routine greetings, introductions, ordering, scheduling, acknowledgements, and other scene logistics when the synopsis or structured fields already preserve everything useful. These categories may qualify only when their exact wording independently meets a rule above.
- Apply the removal test: if future roleplay loses no usable quote, character voice, relationship cue, or interpretation when this dialogue is removed, omit it.
- In a dialogue-rich ordinary scene, two to five qualifying key dialogues is a useful density, not a quota. Zero is valid when none qualifies, and more than five is valid when the additional lines have distinct future-recall value. Do not discard a qualifying character or relationship line merely to minimize the count, and never pad with weak lines to reach a number.`;
