<?php
/**
 * Shared post card for blog grids.
 *
 * @package Astra
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

$thumb = olkil_get_post_thumbnail_url( get_the_ID(), 'medium_large' );
?>
<a class="olkil-post olkil-reveal" href="<?php the_permalink(); ?>">
	<div class="olkil-post__thumb<?php echo $thumb ? ' has-image' : ''; ?>">
		<?php if ( $thumb ) : ?>
			<img src="<?php echo esc_url( $thumb ); ?>" alt="<?php echo esc_attr( get_the_title() ); ?>" loading="lazy" decoding="async" width="640" height="360" />
		<?php else : ?>
			<span class="olkil-post__thumb-fallback" aria-hidden="true">OLKIL</span>
		<?php endif; ?>
	</div>
	<div class="olkil-post__body">
		<span class="olkil-post__meta"><?php echo esc_html( get_the_date() ); ?></span>
		<h3><?php the_title(); ?></h3>
		<p><?php echo esc_html( wp_trim_words( get_the_excerpt(), 22 ) ); ?></p>
	</div>
</a>
