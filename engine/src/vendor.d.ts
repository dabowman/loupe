/**
 * The optional postcss syntaxes ship no type declarations.
 *
 * Declaring them here rather than reaching for `@ts-expect-error` at the import
 * keeps the untyped surface to one place and one line each: `syntax.ts` already
 * validates at runtime that whatever comes back exposes a `parse`, because
 * these are resolved from the host's `node_modules` and may be any version — or
 * absent entirely.
 */

declare module 'postcss-scss' {
	const syntax: unknown;
	export default syntax;
}

declare module 'postcss-less' {
	const syntax: unknown;
	export default syntax;
}
