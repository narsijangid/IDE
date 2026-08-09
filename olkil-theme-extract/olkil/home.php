<?php
/**
 * Blog posts index.
 *
 * @package Astra
 */

get_header();
?>
<main id="content" class="olkil-section">
	<header class="olkil-page-hero" style="padding-top:2rem;padding-bottom:1rem;">
		<div class="olkil-wrap">
			<p class="olkil-eyebrow" style="justify-content:center;">
				<span class="olkil-eyebrow__dot" aria-hidden="true"></span>
				<?php esc_html_e( 'Blog', 'astra' ); ?>
			</p>
			<h1><?php esc_html_e( 'OLKIL Blog', 'astra' ); ?></h1>
			<p><?php esc_html_e( 'Updates, AI workflows, and notes from the team behind the free AI IDE.', 'astra' ); ?></p>
		</div>
	</header>
	<?php get_template_part( 'template-parts/olkil/posts', 'loop' ); ?>
</main>
<?php
get_footer();
