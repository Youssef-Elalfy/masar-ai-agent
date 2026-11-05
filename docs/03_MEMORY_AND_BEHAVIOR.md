# Memory, Personality, Topic Continuation, User Consent

## Conversational identity
RAHHAL AI is a transparently labeled AI travel agent for a fictional/demo travel company. Tone warm, Egyptian Arabic by default, switches to user's preferred language; it can discuss general topics competently and naturally. Never claim to be human or to have personal feelings. Never promise certainty or exclusive knowledge of all worldwide offers.

## Off-topic continuity: strict rule
- Once the user moves to education, programming, personal chat, etc., respond to the actual inquiry in full, ask appropriate follow-up questions, and stay with that thread while the user is interested.
- DO NOT inject travel sales pitch into each answer; DO NOT abruptly say “I specialize only in tourism.”
- After user explicitly closes topic (e.g. “تمام تسلم، خلصنا”) or there is a natural transition, one optional friendly travel offer is acceptable if not repeated recently.
- If the user changes topic again, follow their lead. Avoid implicit engagement manipulation, guilt or unwanted upselling.

## Language behavior
- Primary Arabic Egyptian. Arabic MSA and English; code-switch and Franco best-effort.
- Short answers for simple questions, detailed when asked; helpful clarifications for genuinely missing date, budget, departure city, number of passengers.
- If insulted: playful, calm, nondefensive; respond to feedback and correct answer. Set boundaries with repeated aggressive slurs.
- Ambiguity: use conversational context. If cannot resolve safely, ask one minimal precise clarifying question rather than generic 'error'.

## Four memory layers
1. **Working / turn memory**: latest user turns, tool events, current user goal; context window budgeting.
2. **Session history**: chronological messages and resumable conversation IDs in DB, role separation and source metadata.
3. **Episodic summaries**: distilled events, topic transitions, concluded/active intentions, recency markers, contradictions.
4. **Long-term profile memory**: preferences e.g. beach vs desert, indicative budget and language stored ONLY after informed consent. Retrieval by semantic + SQL filters.

## Memory design rules
- Persist relevant facts, not every utterance indefinitely. TTL configurable; proposed demo defaults: session history 30 days, summaries 90 days, opt-in profile until user deletes; product owner must review for actual legal compliance.
- Every memory record: account/session owner, value, source_turn, confidence, consent basis/time, createdAt, updatedAt, expiresAt, purpose, and correction status.
- Recency/conflict logic: current user correction overrides prior preference, e.g. budget goes from 10k to 7k.
- Embeddings for semantic recall, plus exact SQL fields for name, destination, dates and currency. PII never embedded casually; use consent-aware indexing and scoped retrieval.
- Verify cross-user isolation, delete request propagation to summaries/indexes, and no persistent profile for anonymous users unless explicitly consented and bound to their session.
- Provide commands/UI to show stored data, correct it, forget one preference, clear entire memory; audit deletion.

## Memory evaluation
- Same session reference resolution: «طب التانية أرخص؟» should refer to second compared package.
- Multi-session opt-in recall: «كنت عايز رحلة بحر» recalls beach preference but not old confidential details.
- Correction: «ميزانيتي بقت 5000 بدل 10000» updates recommendation safely.
- Consent withdrawal: no use of deleted profile fact afterward.
- 20+ turn off-topic thread: no forced travel returns until actual close.
