/**
 * Rule catalog.
 *
 * `title` is the one-time fix guidance, printed once per group header. Per-
 * finding lines carry only what varies (file:line + the offending code), so the
 * guidance is never repeated across hundreds of lines — the agent reading this
 * output pays for every duplicated token.
 *
 * `rank` orders findings within a report: higher first. It lives here rather
 * than at the call site so severity and ordering are data, not scattered
 * magic numbers.
 *
 * `needs` declares what the rule requires from the design-system model. A rule
 * whose needs aren't met by the active config disables itself silently — that
 * is what lets a component-less preset (a block theme, say) reuse the same
 * engine without emitting garbage.
 */

import type { DesignSystem, RuleDef, RuleId, Severity } from './types.ts';

export const RULES = {
	'suppression/malformed': {
		severity: 'error',
		rank: 30,
		needs: [],
		title: 'blanket or malformed suppression — replace with `{kw} <ruleId> -- <reason>`',
	},
	'stylesheet/unparsed': {
		severity: 'error',
		rank: 25,
		needs: [],
		title: 'stylesheet could not be parsed — nothing in this file was checked',
	},
	'css/dead-class': {
		severity: 'warn',
		rank: 20,
		needs: ['projectNamespace'],
		title: 'dead CSS class — referenced in no markup or reference file; delete the rule',
	},
	'system/locked-component': {
		severity: 'error',
		rank: 24,
		needs: ['componentRegistry'],
		title: 'private API — {system} does not recommend using this outside its own core; it can break without notice on any update',
	},
	'system/superseded-component': {
		severity: 'warn',
		rank: 6,
		needs: ['componentRegistry'],
		title: 'a current, recommended component now covers this job — see the finding for what replaces it',
	},
	'patterns/duplicate-composite': {
		severity: 'warn',
		rank: 15,
		needs: ['patternRegistry'],
		title: 'rebuilds a registered pattern — import the shared implementation instead of reassembling it',
	},
	'patterns/unregistered-composite': {
		severity: 'warn',
		rank: 14,
		needs: ['components'],
		title: 'the same composite is assembled in several files — extract it and register it as a pattern',
	},
	'tokens/unknown-token': {
		severity: 'warn',
		rank: 22,
		needs: ['tokenPrefixes'],
		title: 'unknown token — no {tokenPrefix} token by this name is defined; check the spelling against the design system',
	},
	'tokens/hardcoded-value': {
		severity: 'warn',
		rank: 9,
		needs: [],
		title: 'hardcoded value — replace with a {tokenPrefix} token',
	},
	'layout/margin-on-child': {
		severity: 'warn',
		rank: 5,
		needs: [],
		title: 'margin — move spacing to the parent layout primitive\u2019s gap prop',
	},
	'layout/negative-margin': {
		severity: 'warn',
		rank: 4,
		needs: [],
		title: 'negative margin \u2014 usually a deliberate bleed; confirm it, or restructure the parent',
	},
	'layout/in-css': {
		severity: 'warn',
		rank: 8,
		needs: ['layoutComponents'],
		title: 'flex layout in CSS — use {layout} and its gap prop',
	},
	'typography/untokenized': {
		severity: 'warn',
		rank: 10,
		needs: [],
		title: 'raw type styling — use {text}, or a {tokenPrefix} type token if it cannot be used',
	},
	'system/override': {
		severity: 'warn',
		rank: 11,
		needs: ['components'],
		title: 'overrides a design-system component — restyle via its props/tokens, not CSS',
	},
	'system/inline-style': {
		severity: 'warn',
		rank: 13,
		needs: ['components'],
		title: 'inline style on a design-system component \u2014 use its props, which the style attribute overrides',
	},
	'system/raw-element': {
		severity: 'warn',
		rank: 7,
		needs: ['elementMap'],
		title: 'raw element — use its design-system analog',
	},
	'typography/in-css': {
		severity: 'warn',
		rank: 12,
		needs: ['textComponents'],
		title: 'text component typed in CSS — use its style/size prop instead',
	},
} satisfies Record<RuleId, RuleDef>;

/** Every rule id, once, in declaration order — `Object.keys` loses the union. */
export const RULE_IDS = Object.keys(RULES) as RuleId[];

/** Legacy R0–R8 ids, honored in config and in suppression comments. */
export const ALIASES = {
	R0: 'suppression/malformed',
	R1: 'css/dead-class',
	R2: 'tokens/hardcoded-value',
	R3: 'layout/margin-on-child',
	R4: 'layout/in-css',
	R5: 'typography/untokenized',
	R6: 'system/override',
	R7: 'system/raw-element',
	R8: 'typography/in-css',
} satisfies Record<string, RuleId>;

/**
 * Resolve a legacy id, returning a plain string rather than a `RuleId`: the
 * input is whatever someone typed in a config or a comment, and claiming it is
 * a known rule is exactly the lie that would let an unknown id reach a lookup
 * unchecked. Callers narrow with {@link isRuleId}.
 */
export const canonicalRuleId = (id: string): string => ALIASES[id as keyof typeof ALIASES] ?? id;

/** Narrow an arbitrary string to a rule the engine actually has. */
export const isRuleId = (id: string): id is RuleId => Object.hasOwn(RULES, id);

export const SEVERITIES: ReadonlySet<string> = new Set<Severity>(['error', 'warn', 'off']);

/** Narrow an arbitrary string to a severity. */
export const isSeverity = (v: unknown): v is Severity =>
	typeof v === 'string' && SEVERITIES.has(v);

/**
 * Interpolate {placeholders} in a rule title from the resolved design system, so
 * guidance names the actual components in play ("use <Stack>") rather than a
 * generic phrase.
 */
export function renderTitle(ruleId: RuleId, ds: DesignSystem, keyword: string): string {
	const list = (arr: readonly string[] | undefined, fallback: string): string =>
		arr && arr.length ? arr.slice(0, 2).map((c) => `<${c}>`).join('/') : fallback;
	return RULES[ruleId].title
		.replace('{layout}', list(ds.layoutComponents, 'a layout primitive'))
		.replace('{text}', list(ds.textComponents, 'a text component'))
		.replace(/\{tokenPrefix\}/g, ds.tokenPrefixes?.[0] ? `${ds.tokenPrefixes[0]}*` : 'design-system')
		.replace('{system}', ds.name || 'the design system')
		.replace('{kw}', keyword);
}
