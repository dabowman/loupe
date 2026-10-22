import { __experimentalText as Text } from '@wordpress/components';

export const Field = <T,>({ label }: { label: T }) => (
	<Text className="wf-field__label">{String(label)}</Text>
);
