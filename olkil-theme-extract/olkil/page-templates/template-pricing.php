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
	<header class="olkil-page-hero">
		<div class="olkil-wrap">
			<p class="olkil-eyebrow" style="justify-content:center;">
				<span class="olkil-eyebrow__dot" aria-hidden="true"></span>
				<?php esc_html_e( 'Pricing', 'astra' ); ?>
			</p>
			<h1><?php esc_html_e( 'Free. That’s the plan.', 'astra' ); ?></h1>
			<p><?php esc_html_e( 'OLKIL is a fully free AI-powered IDE. No tiers, no credit card — just download and build.', 'astra' ); ?></p>
		</div>
	</header>
	<?php
	olkil_section( 'pricing' );
	olkil_section( 'download' );
	olkil_section( 'cta' );
	?>
</main>
<?php
get_footer();
