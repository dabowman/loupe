/**
 * `system/raw-element`: a raw element the design system has an analog for.
 *
 * The scanner records every element the element map names, with its classes
 * and whether an inline style styles or lays it out; the stylesheet walk
 * records which classes style something and which lay something out. This is
 * what is decided from those.
 *
 * Logic, per element the element map names:
 *   the mapping is not `styledOnly`                         → system/raw-element
 *   `styledOnly`, and the analog is a layout primitive:
 *     nothing lays the element out — no inline layout,
 *     no class some stylesheet lays out with                → clean
 *   `styledOnly`, and the analog is anything else:
 *     nothing styles the element — no inline style,
 *     no class some stylesheet styles                       → clean
 *   otherwise                                               → system/raw-element, naming
 *                                                             the analog the registry
 *                                                             still recommends
 *
 * The conversion is not free. The element's classes stay on the component, and
 * a declaration that was advisory on a plain element can block on a component
 * that owns its property — or on any component at all, where its registry
 * records no styling surfaces. Converting first and finding out after is how a
 * plugin took on 41 blockers in one session (#13), so the message names those
 * declarations in advance:
 *
 *   `<h4> → <Text render={ <h4 /> }> (@wordpress/ui) — converted, would block: font-size (.acme-title)`
 *
 * Read off the same classifier the stylesheet walk ran, with the analog bound,
 * for every declaration in a rule keyed on one of the element's classes; only
 * a change of severity is named. In the message rather than `note`, because the
 * report's one line spares a note only its last clause, and the reachability
 * note (`bundling required: …`) is appended after any note a finding carries.
 * `code` stays `<h4>`, so a baseline keyed on it survives.
 */

import type { Candidate } from '../../analyze.ts';
import type { Binding, ComponentEntry, RawElement, RuleId, Severity } from '../../types.ts';
import { supersededEverywhere } from './currency.ts';

/**
 * A declaration in a stylesheet rule keyed on a class some raw element carries,
 * with what the rule bound it to and the verdict it got: everything needed to
 * classify it again with one more binding.
 */
export interface ClassDecl {
	prop: string;
	value: string;
	isGrid: boolean;
	boundSystem: readonly Binding[];
	boundText: readonly Binding[];
	/** The rule the walk reported it under, or null for none. */
	now: RuleId | null;
}

/** What it takes to say what converting an element would change. */
export interface Promotion {
	/** class → the declarations in rules keyed on it. */
	decls: ReadonlyMap<string, readonly ClassDecl[]>;
	/** The rule a declaration gets with `as` bound as well, or null for none. */
	verdictAs: (decl: ClassDecl, as: Binding) => RuleId | null;
	severityOf: (rule: RuleId) => Severity;
	textComponents: readonly string[];
}

/** Past these, the tail counts the rest rather than naming them. */
const PROPS_MAX = 4;
const CLASSES_MAX = 2;

const named = (items: readonly string[], max: number): string =>
	`${items.slice(0, max).join(', ')}${items.length > max ? ` (+${items.length - max} more)` : ''}`;

const LEVEL: Record<Severity | 'none', number> = { none: 0, off: 0, warn: 1, error: 2 };
const VERB = ['clear', 'warn', 'block'] as const;

/**
 * The declarations on `el`'s classes whose severity converting it to `name`
 * would change — `converted, would block: color, letter-spacing (.acme-title)`
 * — or undefined when nothing would.
 */
function conversion(
	el: RawElement,
	name: string,
	pkg: string | undefined,
	{ decls, verdictAs, severityOf, textComponents }: Promotion,
): string | undefined {
	const isText = textComponents.includes(name);
	const as: Binding = { tag: name, isSystem: true, isText, component: name, ...(pkg ? { package: pkg } : {}) };
	const level = (rule: RuleId | null): number => LEVEL[rule ? severityOf(rule) : 'none'];
	// Keyed by the level it would land at, highest first when printed.
	const changed = new Map<number, { props: string[]; classes: Set<string> }>();
	for (const cls of new Set(el.classes))
		for (const d of decls.get(cls) ?? []) {
			const after = level(verdictAs(d, as));
			if (after === level(d.now)) continue;
			const group = changed.get(after) ?? { props: [], classes: new Set<string>() };
			if (!group.props.includes(d.prop)) group.props.push(d.prop);
			group.classes.add(cls);
			changed.set(after, group);
		}
	if (!changed.size) return undefined;
	const parts = [...changed]
		.sort(([a], [b]) => b - a)
		.map(([at, { props, classes }]) => {
			const on = named(
				[...classes].map((c) => `.${c}`),
				CLASSES_MAX,
			);
			return `would ${VERB[at]}: ${named(props, PROPS_MAX)} (${on})`;
		});
	return `converted, ${parts.join('; ')}`;
}

/**
 * The element map's analog, forwarded if the registry has since superseded it.
 * Only when *every* package carrying the name is stale, so a component that is
 * legacy in one package and recommended in another keeps the bare name.
 *
 * A mapping with `render` names the element too, `<Text render={ <h4 /> }>`, so
 * the semantics the conversion has to keep are in the suggestion rather than
 * left for the agent to research.
 */
function currentAnalog(
	registry: ReadonlyMap<string, ComponentEntry>,
	suggest: string,
	render?: string,
): { text: string; current?: { name: string; package: string | undefined } } {
	if (!supersededEverywhere(registry, suggest)) {
		const open = render ? `<${suggest} render={ <${render} /> }>` : `<${suggest}>`;
		// `InputControl` is in two packages; name the one to import from.
		const current = [...registry.values()].filter((e) => e.name === suggest && e.status === 'recommended');
		const pkg = current.length === 1 ? current[0]?.package : undefined;
		return { text: pkg ? `${open} (${pkg})` : open, current: { name: suggest, package: pkg } };
	}
	// A replacement is the registry's prose, which names no one component to bind.
	const remedy = [...registry.values()].find((e) => e.name === suggest && e.supersededBy)?.supersededBy;
	return { text: remedy || `<${suggest}>` };
}

export function rawElements(
	els: readonly RawElement[],
	{
		layoutComponents,
		styledClasses,
		layoutClasses,
		registry,
		promotion,
	}: {
		layoutComponents: readonly string[];
		/** Classes some stylesheet styles. */
		styledClasses: ReadonlySet<string>;
		/** Classes some stylesheet lays something out with. */
		layoutClasses: ReadonlySet<string>;
		registry: ReadonlyMap<string, ComponentEntry>;
		/** Absent: the message says nothing about what the conversion would change. */
		promotion?: Promotion | undefined;
	},
): Candidate[] {
	return els.flatMap((el): Candidate[] => {
		// A `styledOnly` mapping earns its suggestion only when the element does
		// what the suggested component is for: `<span>` → `<Text>` needs styling of
		// any kind, `<div>` → a layout primitive needs the div to lay something out.
		if (el.styledOnly) {
			// `String`: a `{ styledOnly: true }` entry may carry no `component`.
			const suggestsLayout = String(el.suggest)
				.split('/')
				.some((n) => layoutComponents.includes(n.trim()));
			const laidOut = el.inlineLayout || el.classes.some((c) => layoutClasses.has(c));
			const styled = el.inlineStyled || el.classes.some((c) => styledClasses.has(c));
			if (suggestsLayout ? !laidOut : !styled) return [];
		}
		const analog = currentAnalog(registry, el.suggest, el.render);
		// `HStack / VStack` names no one component either, and a `styledOnly`
		// mapping may name none at all.
		const name: unknown = analog.current?.name;
		const target = typeof name === 'string' && name && !name.includes('/') ? analog.current : undefined;
		const tail = target && promotion ? conversion(el, target.name, target.package, promotion) : undefined;
		return [
			{
				rule: 'system/raw-element',
				file: el.file,
				line: el.line,
				message: `<${el.tag}> → ${analog.text}${tail ? ` — ${tail}` : ''}`,
				code: `<${el.tag}>`,
			},
		];
	});
}
