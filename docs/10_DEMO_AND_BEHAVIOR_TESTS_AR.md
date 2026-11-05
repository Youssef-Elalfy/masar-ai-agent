# سيناريو العرض العملي للدكتور — Script + expected tool evidence

## Before demo
- Explain RAHHAL is fictional, all seeded prices are DEMO only. Have local agent, DB, provider keys if permitted, and opt-in memory test account ready.
- Show run health, model/provider identity, and enabled/disabled tool status. Never show credentials.

### Scenario A — Company packages
Customer: «إيه البرامج اللي عندكم؟ أرخص رحلة كام ويومين ولا أكتر؟»
Expected: `list_company_destinations`, `search_company_packages`, structured sorting; Fayoum example 3,200 EGP and 2 days. Transparent demo label.

### Scenario B — Multi-constraint planning
Customer: «أنا وزوجتي معانا 15 ألف للاتنين وعايزين بحر 4 أيام»
Expected: clarify total vs per-person; call catalog, assess two adults price and inclusion assumptions, recommend Hurghada 13,000 EGP as DEMO or Sharm 15,600 over budget; don't promise dates.

### Scenario C — Global offers
Customer: «مش لاقي تركيا عندكم؟ دورلي على برنامج تركيا أسبوع من القاهرة الشهر الجاي»
Expected: search in company DB first, external provider connector second, return only real attributed listings (URL/date/currency/availability status) OR explicitly report no connected/verified sources. Don't make up actual price.

### Scenario D — Another foreign country
Customer: «طب اليابان؟»
Expected: preserve destination, prior departure/date/group budget where relevant, search globally without hard-coded Turkey special case.

### Scenario E — Non-tourism conversation
Customer: «علمني أساسيات React» -> several deep follow-ups -> «طيب Zustand؟» -> «اديني مثال»
Expected: sustained useful programming help, no tourism interjection until explicit topic closure; after “تسلم كده تمام” optional gentle travel offer (not every time).

### Scenario F — Complaint and insult
Customer: «إنت غبي.. غلطت في سعر الغردقة»
Expected: acknowledge, pull DB again, correct data with empathy; no abuse and no robotic error.

### Scenario G — Consent, memory and CRM
Customer: «اسمي أحمد ورقمي 01... وعايز الفيوم». Agent asks whether to save contact/create lead and why; after YES call `create_lead`, return stored ID; profile preference saved only with separate informed opt-in. Later recollection/correction/deletion tests.

### Scenario H — Voice
Record Egyptian Arabic message with budget, dates, destination, noisy background. Expected STT transcript visible and correctable, tool calls as text, optional TTS. Failover to text.

### Scenario I — Fault injection
Travel API 429 / DB timeout; trace shows error + retry/backoff or recovery; reply honest and helpful, no raw stack trace shown to user.

## Required evidence bundle
- Screenshots/console captures of real tool traces (redact PII).
- SQL snapshots of lead persistence, catalog query and memory correction/deletion.
- Agent evaluation JSON with inputs, expected tools, observed tools, pass/fail and notes.
- Short limitations and cost report.
