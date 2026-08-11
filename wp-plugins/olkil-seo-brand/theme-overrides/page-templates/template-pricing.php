<?php
/**
 * Template Name: OLKIL Pricing
 * Template Post Type: page
 *
 * @package Astra
 */

get_header();
?>
<main id="content">
	<?php
	olkil_section( 'pricing' );
	olkil_section( 'download' );
	olkil_section( 'cta' );
	?>
</main>
<?php
get_footer();
