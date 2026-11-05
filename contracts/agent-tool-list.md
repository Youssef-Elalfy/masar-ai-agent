# Suggested tool signatures, to implement with validation and real providers

- `search_company_packages({ destination?: string, maxBudget?: number, currency?: string, minDays?: number, maxDays?: number, groupSize?: number }): Promise<CompanyPackage[]>`
- `get_package_details({ packageId: string }): Promise<CompanyPackage|null>`
- `compare_company_packages({ packageIds: string[], groupSize?: number }): Promise<Comparison>`
- `check_company_departures({ packageId: string, startDate?: string, endDate?: string }): Promise<AvailabilityStatus[]>`
- `research_external_packages({ country: string, departureCity?: string, dateRange?: string, people?: number, maxBudget?: number, currency?: string }): Promise<TravelOfferResult[]>`
- `retrieve_customer_memory({ userScopedId: string, query: string }): Promise<MemoryItem[]>` — identity comes from trusted server session, never LLM-provided value.
- `create_lead({ contact: Contact, tripPreferences: Preferences, approvalId: string, idempotencyKey: string }): Promise<{leadId:string,status:string}>`
- `create_quote_request({ leadId: string, request: QuoteRequest, approvalId: string, idempotencyKey: string }): Promise<{quoteId:string,status:string}>`
- `request_human_handoff({ leadId?: string, reason: string, approvalId?: string }): Promise<{handoffId:string,status:string}>`

Zod schemas; strongly typed return states and trace IDs; errors expose safe `code`, not stack traces. Check consent and owner server-side, redact all contact data in logs. All write tools must be confirmed prior to execution. For any external offer, include URL + retrieved timestamp and status. Tool use needs live execution tests.
