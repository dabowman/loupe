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
	'tokens/hardcoded-value': {
		severity: 'warn',
		rank: 9,
		needs: [],
		title: 'hardcoded value — replace with the matching {tokenPrefix} token',
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
};

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
};

export const canonicalRuleId = (id) => ALIASES[id] || id;

export const SEVERITIES = new Set(['error', 'warn', 'off']);

/**
 * Interpolate {placeholders} in a rule title from the resolved design system, so
 * guidance names the actual components in play ("use <Stack>") rather than a
 * generic phrase.
 */
export function renderTitle(ruleId, ds, keyword) {
	const list = (arr, fallback) =>
		arr && arr.length ? arr.slice(0, 2).map((c) => `<${c}>`).join('/') : fallback;
	return RULES[ruleId].title
		.replace('{layout}', list(ds.layoutComponents, 'a layout primitive'))
		.replace('{text}', list(ds.textComponents, 'a text component'))
		.replace('{tokenPrefix}', ds.tokenPrefixes?.[0] ? `${ds.tokenPrefixes[0]}*` : 'a design')
		.replace('{kw}', keyword);
}
