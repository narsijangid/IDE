<?php
/**
 * Shared posts loop grid + pagination.
 *
 * @package Astra
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}
?>
<div class="olkil-wrap">
	<?php if ( have_posts() ) : ?>
		<div class="olkil-posts">
			<?php
			while ( have_posts() ) :
				the_post();
				get_template_part( 'template-parts/olkil/post', 'card' );
			endwhile;
			?>
		</div>

		<nav class="olkil-reveal olkil-pagination" style="margin-top:2.5rem;display:flex;justify-content:center;gap:1rem;flex-wrap:wrap;" aria-label="<?php esc_attr_e( 'Posts pagination', 'astra' ); ?>">
			<?php
			the_posts_pagination(
				array(
					'mid_size'  => 1,
					'prev_text' => __( '← Newer', 'astra' ),
					'next_text' => __( 'Older →', 'astra' ),
				)
			);
			?>
		</nav>
	<?php else : ?>
		<p style="text-align:center;color:var(--olkil-text-muted);"><?php esc_html_e( 'No posts found.', 'astra' ); ?></p>
	<?php endif; ?>
</div>
