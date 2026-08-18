import { __experimentalText as Text, __experimentalVStack as VStack } from '@wordpress/components';

export const Panel = ({ open }) => (
	<VStack className="wf-panel" style={{ maxWidth: 400 }}>
		<Text className="wf-panel__label" onClick={() => { track('x'); }}>Label</Text>
		<div className={['wf-panel__body', open && 'is-open'].filter(Boolean).join(' ')}>Body</div>
	</VStack>
);
