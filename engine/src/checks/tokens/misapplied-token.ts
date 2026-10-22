/**
 * `tokens/misapplied-token`: a token that exists, used outside the scope its
 * design system declares for it — a foreground colour on a `background`, a
 * `surface` background on a clickable control, the menu radius on a button.
 *
 * Spelling is `tokens/unknown-token`'s. This is the other half: the name is
 * real, and it gives the right pixels with the wrong meaning, which is exactly
 * what survives review — and what moves the wrong way the next time the system
 * does. The scope is the profile's `tokenScopes`; see `scopes.ts`.
 *
 * Advisory: it is a judgement the profile's author encoded, and a wrong
 * declaration must not block a turn before it has met real code.
 *
 * Logic, per `var(--name)` written in a declaration's value:
 *   no active profile declares token scopes          → report nothing at all
 *   the declaration sets a custom property           → clean, nothing says what it is for
 *   the name is not a known token (when any are)     → clean, tokens/unknown-token's
 *   the var() is inside calc(), min(), max(), clamp() → clean, arithmetic is not a role
 *   no declared grammar or scale places the name     → clean, no declared scope
 *   its property segment neither sets nor may appear
 *   in the declaration's property                    → tokens/misapplied-token
 *   it is scoped to kinds of element, and every
 *   element the declaration is shown to land on is
 *   one it is not for                                → tokens/misapplied-token
 *   otherwise — including every element unknown      → clean
 *
 * Design notes: docs/design/checks.md#tokensmisapplied-token
 */

import type { Candidate } from '../../analyze.ts';
import { fitOf, place, propMatches } from '../../scopes.ts';
import type { TokenScopes } from '../../scopes.ts';
import type { TokenRef } from './unknown-token.ts';

/** A token reference with what a scope is checked against: its declaration's value, and what it lands on. */
export interface ScopedRef extends TokenRef {
	value: string;
	/** Element and component names the declaration is shown to style; empty where nothing shows it. */
	elements: readonly string[];
}

/** The `var()`s in a value that are not inside a math function. */
function plainRefs(value: string): string[] {
	const out: string[] = [];
	// Every open paren, and whether it opened arithmetic. A var() under any of
	// them is an operand, not the value.
	const stack: boolean[] = [];
	for (let i = 0; i < value.length; i++) {
		const ch = value[i];
		if (ch === ')') stack.pop();
		if (ch !== '(') continue;
		const fn = /([-\w]*)$/.exec(value.slice(0, i))?.[1]?.toLowerCase() ?? '';
		if (fn === 'var' && !stack.includes(true)) {
			const name = /^\(\s*(--[\w-]+)/.exec(value.slice(i))?.[1];
			if (name) out.push(name);
		}
		stack.push(['calc', 'min', 'max', 'clamp'].includes(fn) || fn.endsWith('-calc'));
	}
	return out;
}

export function misappliedTokens(
	refs: readonly ScopedRef[],
	scopes: TokenScopes | undefined,
	known: ReadonlySet<string>,
): Candidate[] {
	if (!scopes) return [];
	const out: Candidate[] = [];
	const seen = new Set<string>();
	for (const ref of refs) {
		const prop = ref.prop.toLowerCase();
		if (prop.startsWith('--')) continue;
		if (known.size && !known.has(ref.name)) continue;
		if (!plainRefs(ref.value).includes(ref.name)) continue;
		const at = place(scopes, ref.name);
		if (!at) continue;
		// One finding per token on a line, but only once one is reported: two
		// references on a line can land on different elements, and a clean first
		// one must not hide a misapplied second.
		const key = `${ref.file}\u0000${ref.line}\u0000${prop}\u0000${ref.name}`;
		if (seen.has(key)) continue;
		let why: string | null = null;
		if (at.property !== null && !propMatches(at.sets, prop) && !propMatches(at.also, prop))
			why = `${at.property.startsWith('--') ? 'its family' : `a ${at.property} token`} sets ${at.sets.join(', ')}`;
		else {
			const fit = fitOf(scopes, ref.name, ref.elements);
			if (fit.fit === 'off') why = fit.why;
		}
		if (why === null) continue;
		seen.add(key);
		out.push({
			rule: 'tokens/misapplied-token',
			file: ref.file,
			line: ref.line,
			message: `${prop}: ${ref.name} — ${why}`,
			// The token and where it is written, not why: a declaration that edits
			// its scope stays the same finding.
			code: `${prop}: ${ref.name}`,
			scopeLines: ref.scopeLines,
		});
	}
	return out;
}
