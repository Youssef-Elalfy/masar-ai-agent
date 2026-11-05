import type { ChatMessage } from './providers/types.ts';

/** Tools whose results ground statements about the company's own programs. */
const CATALOG_TOOLS = new Set(['list_company_destinations', 'search_company_packages', 'get_package_details', 'compare_company_packages', 'check_company_departures']);

/**
 * Phrases that assert knowledge of the company catalog ("I checked the catalog", "our programs",
 * "not in our catalog"). Arabic is matched on common Egyptian/MSA forms; English case-insensitively.
 */
const CATALOG_CLAIM = new RegExp(
  [
    'كتالوج', 'كاتالوج', 'برامجنا', 'برامج الشركة', 'رحلات الشركة', 'باقاتنا', 'عروض الشركة', 'راجعت', 'راجعنا',
    'catalog', 'catalogue', 'our (programs|packages|trips|tours)', 'company (programs|packages|trips)', 'i checked', 'we checked',
  ].join('|'),
  'i',
);

export type GroundingIssue = 'catalog_claim_without_lookup';

function catalogResultInContext(history: ChatMessage[]): boolean {
  const catalogCalls = new Set<string>();
  for (const m of history) {
    for (const b of m.content) {
      if (b.type === 'tool_call' && CATALOG_TOOLS.has(b.name)) catalogCalls.add(b.id);
      if (b.type === 'tool_result' && catalogCalls.has(b.toolCallId) && !b.isError) return true;
    }
  }
  return false;
}

/**
 * Deterministic check of a final answer against the model-visible context: claiming to know the catalog
 * requires a successful catalog tool result somewhere in this conversation's context.
 */
export function groundingIssues(answer: string, history: ChatMessage[]): GroundingIssue[] {
  if (CATALOG_CLAIM.test(answer) && !catalogResultInContext(history)) return ['catalog_claim_without_lookup'];
  return [];
}

/** Runtime note sent back to the model (never shown to the customer). */
export const GROUNDING_NOTE =
  '[Automatic runtime check — not written by the customer] Your previous reply described the company catalog without a catalog lookup in this conversation. ' +
  'Call the catalog tools now (search_company_packages, get_package_details or list_company_destinations) and answer the customer again using only their results. Do not mention this check.';
