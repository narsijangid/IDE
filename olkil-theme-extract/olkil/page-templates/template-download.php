<?php
/**
 * Template Name: OLKIL Download
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
				<?php esc_html_e( 'Download', 'astra' ); ?>
			</p>
			<h1><?php esc_html_e( 'Get OLKIL for your OS', 'astra' ); ?></h1>
			<p><?php esc_html_e( 'Windows, macOS, and Linux — one free AI IDE. We’ll highlight the build that matches your system.', 'astra' ); ?></p>
			<p style="margin-top:1.5rem;">
				<a class="olkil-btn olkil-btn--primary olkil-btn--lg" data-olkil-download="auto" href="#">
					<span class="olkil-btn-label"><?php esc_html_e( 'Download for your OS', 'astra' ); ?></span>
				</a>
			</p>
		</div>
	</header>
	<?php
	olkil_section( 'download' );
	olkil_section( 'pricing' );
	?>
</main>
<?php
get_footer();
