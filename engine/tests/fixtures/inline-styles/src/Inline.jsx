import { __experimentalHStack as HStack, __experimentalText as Text, Button } from '@wordpress/components';

// Raw element: every declaration classified exactly as its CSS equivalent.
export const Bar = () => (
	<div style={{ display: 'flex', gap: 8, marginBottom: 16, fontSize: 13 }}>
		<span style={{ fontWeight: 600, color: '#1e1e1e' }}>Draft</span>
	</div>
);

// System component: one finding for the attribute, superseding per-declaration
// remedies — the answer is "use the props", not "tokenize that value".
export const Actions = () => (
	<HStack>
		<Button style={{ marginRight: 12, color: '#1e1e1e' }}>Save</Button>
		<Text style={{ fontWeight: 600 }}>Draft</Text>
	</HStack>
);

// React's unitless properties, a zero margin, an auto margin, and a token: none
// of these are findings. `opacity` and `zIndex` are not token-backed props, so
// a bare number there is just a number.
export const Quiet = () => (
	<div style={{ opacity: 0.5, zIndex: 10, margin: 0 }}>
		<div style={{ margin: '0 auto', padding: 'var(--wpds-dimension-padding-md)' }} />
	</div>
);

// Unitless is about the VALUE, not about escaping the rule: `lineHeight: 1.5`
// correctly stays a ratio rather than becoming `1.5px`, and is still a finding,
// because WPDS ships --wpds-typography-line-height-* to express it.
export const Ratio = () => <div style={{ lineHeight: 1.5 }} />;

// Grid is a genuine keep, and dynamic values are unknowable rather than wrong.
export const Grid = ({ w }) => (
	<div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
		<div style={{ width: w, ...rest }} />
	</div>
);

// A suppression carries through to the inline channel too.
export const Allowed = () => (
	/* wpds-allow layout/margin-on-child -- trailing space in a scroll container */
	<div style={{ marginBottom: 24 }} />
);
