<?php
/**
 * Template Name: OLKIL Dashboard
 * Description: Full-page account dashboard (plan, credits, billing).
 *
 * @package Astra
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

get_header( 'olkil' );
echo olkil_payu_dashboard_html(); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
get_footer( 'olkil' );
