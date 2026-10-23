import styled from 'styled-components';
import { __experimentalText as Text } from '@wordpress/components';

// An angle-bracket type assertion, which only parses with JSX off.
const input = <HTMLInputElement>document.getElementById('wf-field');

export const Label = styled(Text)`
	font-weight: 600;
`;

export const value = (): string => input.value;
