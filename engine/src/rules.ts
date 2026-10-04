/**
 * Rule catalog.
 *
 * `title` is the one-time fix guidance, printed once per group header; per-
 * finding lines carry only what varies. `rank` orders findings within a report,
 * higher first. `needs` declares what the rule requires from the design-system
 * model — a rule whose needs the active config cannot meet disables itself.
 *
 * Design notes: docs/design/cli.md#the-rule-catalog
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
		title:
			'private API — {system} does not recommend using this outside its own core; it can break without notice on any update',
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
	'patterns/superseded-composite': {
		severity: 'warn',
		rank: 16,
		needs: ['patternRegistry'],
		title:
			'a sanctioned composition already covers this \u2014 see the finding for which pattern replaces the shape that was built',
	},
	'patterns/judged-redirect': {
		severity: 'warn',
		rank: 3,
		needs: ['patternRegistry'],
		title:
			'judged, advisory \u2014 a model read what this control stands for, and the pattern it was built as redirects that reading elsewhere; confirm before changing it',
	},
	'patterns/unregistered-composite': {
		severity: 'warn',
		rank: 14,
		needs: ['packages'],
		title: 'the same composite is assembled in several files — extract it and register it as a pattern',
	},
	'tokens/unknown-token': {
		severity: 'warn',
		rank: 22,
		needs: ['tokenPrefixes'],
		title:
			'unknown token — no {tokenPrefix} token by this name is defined; check the spelling against the design system',
	},
	'tokens/misapplied-token': {
		severity: 'warn',
		rank: 2,
		needs: ['tokenPrefixes'],
		title:
			'misapplied token — it exists, but {system} scopes it to another property or another kind of element; use the token whose role matches',
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
		title:
			'overrides styling a design-system component owns \u2014 use the prop the finding names; where it names none there is no prop, so keep the component\u2019s own styling or suppress with the reason the design needs it',
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
} satisfies Record<string, RuleDef>;

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

const SEVERITIES: ReadonlySet<string> = new Set<Severity>(['error', 'warn', 'off']);

/** Narrow an arbitrary string to a severity. */
export const isSeverity = (v: unknown): v is Severity => typeof v === 'string' && SEVERITIES.has(v);

/**
 * Interpolate {placeholders} in a rule title from the resolved design system, so
 * guidance names the actual components in play ("use <Stack>") rather than a
 * generic phrase.
 */
export function renderTitle(ruleId: RuleId, ds: DesignSystem, keyword: string): string {
	// The canonical entry only. `components.layout`/`.text` are recognition
	// lists — they carry every spelling a rule has to match, superseded ones
	// included — so naming the second entry recommended whatever happened to sit
	// there: `<Stack>/<HStack>` under WPDS, where `HStack` is legacy. Both lists
	// are canonical-first; see `components` in `AuthoredConfig`.
	const list = (arr: readonly string[] | undefined, fallback: string): string => {
		const canonical = arr?.[0];
		return canonical ? `<${canonical}>` : fallback;
	};
	// One prefix is the namespace; several are families within one, and naming the
	// first of them is a different, wrong statement. The per-finding suggestion
	// names the real token when the token set is readable; the title says which
	// namespace to look in, and says nothing when there is no single one.
	const prefixes = ds.tokenPrefixes ?? [];
	const namespace = prefixes.length === 1 && prefixes[0] ? `${prefixes[0]}*` : 'design-system';
	return RULES[ruleId].title
		.replace('{layout}', list(ds.layoutComponents, 'a layout primitive'))
		.replace('{text}', list(ds.textComponents, 'a text component'))
		.replace(/\{tokenPrefix\}/g, namespace)
		.replace('{system}', ds.name || 'the design system')
		.replace('{kw}', keyword);
}
