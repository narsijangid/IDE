<?php
/**
 * Search results — OLKIL UI.
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
				<?php esc_html_e( 'Search', 'astra' ); ?>
			</p>
			<h1>
				<?php
				printf(
					/* translators: %s: search query */
					esc_html__( 'Results for “%s”', 'astra' ),
					esc_html( get_search_query() )
				);
				?>
			</h1>
		</div>
	</header>
	<?php get_template_part( 'template-parts/olkil/posts', 'loop' ); ?>
</main>
<?php
get_footer();
