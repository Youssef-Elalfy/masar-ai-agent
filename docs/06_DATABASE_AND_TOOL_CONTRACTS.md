# Data Model and Tools — Architecture Contract

## Core DB tables (planned)
- `organizations` id, name, demo_flag, created_at
- `packages` id, organization_id, slug, destination/country, name, duration_days/nights, price_amount/currency/basis, itinerary_json, include/exclude, source_type, status, updated_at
- `package_departures` id, package_id, departure_datetime, origin, availability_status, seats_remaining **nullable**, verified_at, provider
- `customers` id, user_id, consent status, safe contact fields encrypted, locale, created_at
- `leads` id, customer_id, destination, date_range, budget, party_size, notes, status, created_at
- `quote_requests` id, customer/lead_id, package_id nullable, summary, approval_id, status, created_at
- `conversations` id, owner_id/session_owner, locale, memory_opt_in, created_at
- `messages` id, conversation_id, role, content, source_refs, recorded_at
- `memory_items` id, owner_id, content, memory_type, consent_ref, source_message_id, valid_from, expires_at, deleted_at
- `memory_embeddings` id, memory_id, embedding, owner_id, index_metadata
- `tool_executions` id, trace_id, tool_name, input_redacted, outcome, latency_ms, provider_id, executed_at
- `external_offers_cache` id, source_url, provider_name, country, price, currency, dates, status, verified_at, retrieved_at, raw_hash
- `consents` id, owner_id, purpose, granted_at, revoked_at, version

No raw PII in analytics or vector indexes by default. Secure storage + migrations + RLS/isolation.

## Required tools + return behavior
| Tool name | Inputs (illustrative) | Output & guarantees |
|---|---|---|
| `list_company_destinations` | filters optional | Distinct destinations currently in company DB, not model guessing |
| `search_company_packages` | destination, budget, min/max days | Typed package rows; demo flag explicit |
| `get_package_details` | package_id | Exact inclusions/exclusions, policy, source |
| `compare_company_packages` | package_ids, party_size | Computed prices with assumptions, references |
| `check_company_departures` | package_id, date_range | confirmed/unconfirmed/demo_on_request statuses; no fake availability |
| `research_external_packages` | destination, dates, origin, size | Attributed URLs, provider, retrieval time, offer classification |
| `get_destination_advice` | place, question | Grounded general info, source, checkedAt when fresh |
| `build_custom_itinerary` | destination, dates, preferences | Draft/estimate label, not for sale by default |
| `retrieve_customer_memory` | session/owner, query | consent-aware relevant memories only |
| `request_memory_consent` | scope, purpose | clear decision; no persistence without grant |
| `upsert_customer_preference` | owner, category, value | update provenance, consent, expiry |
| `create_lead` | name/contact & preferences, consent proof | stored lead ID with idempotency key |
| `create_quote_request` | lead, travel requirements, approval | stored request ID, no booking claim |
| `request_human_handoff` | reason, summary, contact consent | ticket/reference only if integration exists |
| `get_system_status` | no PII | health and configured provider flags for diagnostics |

## Typed tool contract
- Use Zod discriminated unions for `OfferStatus` and `OfferSourceType`.
- For any mutable tool: use explicit `approvalId`, `idempotencyKey`, actor/user scoping and DB transaction; retry safely.
- Tool output should include `requestId`, `source`, `dataAsOf`, `verifiedAt` optional, `warnings`, `result` and status.
- Protect rate limits, timeouts, upstream provider errors; never trust `owner_id` provided by language model.

## Business rules
- `status=demo_on_request` does NOT mean confirmed seats.
- If the user says «بسافر مع طفلين» don't multiply adult fare blindly; ask for age/child fare before quote.
- Always distinguish per-person vs total price and state included taxes/fees when supported.
- Date arithmetic depends on location/timezone; never infer departure date without user input.
