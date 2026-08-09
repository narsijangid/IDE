<?php
/**
 * Template Name: OLKIL Features
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
				<?php esc_html_e( 'Product', 'astra' ); ?>
			</p>
			<h1><?php esc_html_e( 'Features built for real shipping', 'astra' ); ?></h1>
			<p><?php esc_html_e( 'OLKIL packs agentic AI, a full IDE, and cross-platform installs — free, with no feature gates on the core experience.', 'astra' ); ?></p>
		</div>
	</header>
	<?php
	olkil_section( 'features' );
	olkil_section( 'cta' );
	?>
</main>
<?php
get_footer();
