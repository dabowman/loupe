<?php
/**
 * Plugin Name: Loupe overlay
 * Description: Loads the `loupe serve` overlay into wp-admin and the front end, so design-system findings resolve against the rendered page without a bookmarklet click per navigation.
 * License: MIT
 *
 * A development mu-plugin, and never part of a shipped plugin or theme. It does
 * nothing at all unless LOUPE_OVERLAY_URL is defined, so an environment that
 * does not set it is unaffected even if this file is present.
 *
 * Two gates, both required:
 *
 *   LOUPE_OVERLAY_URL  where `loupe serve` is listening.
 *   a per-browser cookie, set with ?loupe=1 and cleared with ?loupe=0.
 *
 * The cookie is the load-bearing one. Browser tests usually drive the same
 * WordPress a developer is looking at, so a panel gated only on the constant
 * sits over every page of every test run and eats the clicks the tests are
 * trying to make. Turning the constant off for a separate "tests" environment
 * does not help when that is not the environment being driven — and it usually
 * is not.
 *
 * Installation: integrations/wordpress/README.md, or `loupe serve` and open the
 * URL it prints.
 *
 * @package Loupe
 */

declare( strict_types = 1 );

namespace Loupe\Overlay;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

const COOKIE = 'loupe_overlay';

/**
 * Read ?loupe=1 / ?loupe=0 and remember the answer for this browser.
 *
 * Applied to `$_COOKIE` as well as sent, so the request that flips the toggle
 * is already the one that shows the result — otherwise turning it on appears to
 * do nothing until the next navigation.
 */
function toggle(): void {
	// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- A development display toggle whose only effect is a cookie in the caller's own browser.
	if ( ! isset( $_GET['loupe'] ) ) {
		return;
	}

	// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- See above.
	$on = '1' === sanitize_text_field( wp_unslash( $_GET['loupe'] ) );

	setcookie( COOKIE, $on ? '1' : '', $on ? 0 : time() - 3600, '/' );

	if ( $on ) {
		$_COOKIE[ COOKIE ] = '1';
	} else {
		unset( $_COOKIE[ COOKIE ] );
	}
}

/**
 * Whether the overlay should load for this request.
 */
function enabled(): bool {
	if ( ! defined( 'LOUPE_OVERLAY_URL' ) || ! LOUPE_OVERLAY_URL ) {
		return false;
	}

	return isset( $_COOKIE[ COOKIE ] ) && '1' === $_COOKIE[ COOKIE ];
}

/**
 * Enqueue the overlay.
 *
 * In the footer and deferred: the overlay appends to `document.body` as it
 * evaluates, so a copy in `<head>` has nothing to attach to.
 *
 * No version string, and none wanted — `loupe serve` sends `cache-control:
 * no-store`, so the browser already refetches it on every load.
 */
function enqueue(): void {
	if ( ! enabled() ) {
		return;
	}

	wp_enqueue_script(
		'loupe-overlay',
		rtrim( LOUPE_OVERLAY_URL, '/' ) . '/overlay.js',
		array(),
		null, // phpcs:ignore WordPress.WP.EnqueuedResourceParameters.MissingVersion -- Served no-store; a version would only add a query string nothing reads.
		array(
			'in_footer' => true,
			'strategy'  => 'defer',
		)
	);
}

add_action( 'init', __NAMESPACE__ . '\\toggle' );
add_action( 'wp_enqueue_scripts', __NAMESPACE__ . '\\enqueue' );
add_action( 'admin_enqueue_scripts', __NAMESPACE__ . '\\enqueue' );
