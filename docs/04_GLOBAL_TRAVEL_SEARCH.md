# Global Travel Discovery — Actual Offers, Not Invented Packages

## Goal
When asked for Turkey, Japan, Emirates, Italy, any other foreign destination or domestic travel, the agent must research *actual offers where possible*, even when RAHHAL (demo company) has no package. Answer “هل فيه سفر برا؟” by asking helpful constraints if needed and offering to search. Do not restrict to four seed programs.

## Tool routing
1. `search_company_packages({destination, budget, days, dates, passengers})` against company DB.
2. If outside catalog or user asks for worldwide options: `search_external_travel_offers({country, city, dateRange, departureCity, groupSize, maxBudget, currency})` through a compliant provider/website search connector; source results must be parsed and checked.
3. If possible `search_flights` and `search_hotels` using separately authorized inventory APIs. Combining airfare/hotel estimate ≠ verified package offer.
4. If source is a reputable agency listing, return provider name, original URL, quoted price/currency, published travel dates/duration, inclusions/exclusions, `retrievedAt`, `lastConfirmedAt` if available, and confidence/status.
5. Ask for exact date/departure if needed; don't interrogate unnecessarily, begin broad search if intent is broad.

## Offer classification
| `source_type` | Meaning | Can say available? |
|---|---|---|
| `company_demo` | Fictional seed data | No; explicitly DEMO |
| `company_verified` | Company-controlled published program | Only if current inventory confirmed |
| `external_listing` | Third-party agency offer page | Listing observed; live availability unconfirmed unless API confirms |
| `supplier_live_inventory` | Authenticated supplier returned live availability | Yes, with `asOf` and terms |
| `estimated_itinerary` | Generated plan + indicative costs | Never claim as bookable |
| `general_information` | Destination guidance | Not an offer |

## Source quality and limits
- Prefer officially integrated supplier APIs and primary agency listing pages with working links. Generic search snippets alone are weaker evidence and not real-time inventory.
- For flight APIs, **Amadeus test environment has restricted/test data**; do not represent test responses as production live availability. Some airlines/fares aren't covered. Production booking and ticketing have business/legal requirements.
- Google Places is venue discovery not tour inventory, and billing/quotas apply.
- Visa, entry and safety rules can change; prefer official consular/government sources and an airline destination rules reference where authorized; specify last checked time.
- No scraping behind login, CAPTCHA bypass, or unauthorized booking. Respect provider terms, attribution and rate limits.

## External answer format
Offer name; provider; destination; travel period; days/nights; price and currency including known per-person basis; inclusions/exclusions; availability status; link; retrieved timestamp; notes/uncertainties. Distinguish price from a budget estimate.

## Fallback logic
No connected provider -> say real-time offer research is not configured and give grounded destination advice / illustrative itinerary labeled estimate. Search unavailable -> explain briefly and offer to retry; do not invent agency names, links, inventory or exact live prices.

## Sample dialog
User: «هل عندكم برامج لتركيا الأسبوع الجاي؟»
Agent: «هشوف الأول عروض شركتنا، ولو مش موجودة هبحث عن برامج من جهات سفر أخرى. من أي مدينة هتسافر وكم شخص؟»
Tool -> company DB; if none -> external provider search; return only sourced results with status. If connector absent, state limitation and offer indicative plan without faking bookings.
