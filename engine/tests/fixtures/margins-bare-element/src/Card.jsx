import styled from '@emotion/styled';

export const Lead = styled.p`
	margin-bottom: 16px;
`;

export const Body = styled.div`
	p {
		margin: 0 0 1em;
	}
`;

export const Card = () => (
	<div className="acme-card">
		<p style={{ marginBottom: 16 }}>Hi</p>
	</div>
);
