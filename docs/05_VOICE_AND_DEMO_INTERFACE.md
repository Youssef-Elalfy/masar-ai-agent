# Voice + Standalone Demo Console

## Voice notes (required first)
- Input audio web upload/record with explicit mic permission, length and size limits; accept at least common browser formats supported by chosen STT provider.
- STT transcript -> same memory, tools and orchestrator as text; store transcript only under relevant privacy policy/consent.
- Agent can display transcript for correction; confirmation of names, dates, passport or phone if ambiguous.
- TTS voice outputs offered as toggle; avoid auto-speaking sensitive data in public settings.
- Error messages human-friendly, with retry/audio-format guidance. If voice unavailable, text remains functional.

## Realtime voice (second milestone)
- Full-duplex/interruption when supported by provider, safe ephemeral credentials and browser permissions.
- Conversation state integrated with text agent and tool authorization; voice must not bypass consent/approval gates.
- VAD, barge-in, network reconnect, transcript sync, silence/timeout and dropped packet tests.
- True realtime capability cannot be claimed until actual tests pass.

## Small demo interface — NOT a website
- Chat list, typing field, voice record/upload button, audio playback toggle, response citations and source links, current session indicator, opt-in memory management, privacy notice.
- Developer diagnostics drawer: actions executed (tool name/status/time/source, no raw secrets or chain-of-thought), cost/latency, mock/live provider indicators.
- Accessible responsive Arabic RTL + English LTR, keyboard navigation, contrast, reduced motion. Keep polish modest; assignment is the agent.
- No tourism destinations catalogue, hero, video background, marketing sections, page transitions or portfolio case study.

## Graceful degradation
No mic permission -> type. STT error -> retry or type. No TTS -> text response. Realtime unsupported -> voice notes work. Provider failure -> honest recovery path, never a fabricated answer.
