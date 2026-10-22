import { Button } from '@wordpress/components';

export const List = () => (
	<ul className="acme-list">
		<li className="acme-item">a</li>
		<li>
			<Button className="acme-btn">b</Button>
		</li>
		<li className="acme-row">c</li>
	</ul>
);
