<?php
/**
 * Every class here is built at runtime, one for each way PHP spells it.
 */
$variant = get_query_var( 'variant', 'plain' );
?>
<article class="<?php echo esc_attr( 'wf-card-' . $variant ); ?>">
	<h2 class="<?php echo esc_attr( "wf-title-$variant" ); ?>"></h2>
	<p class="<?php echo esc_attr( "wf-body-{$variant}" ); ?>"></p>
	<a class="<?php echo esc_attr( sprintf( 'wf-link-%s', $variant ) ); ?>"></a>
</article>
