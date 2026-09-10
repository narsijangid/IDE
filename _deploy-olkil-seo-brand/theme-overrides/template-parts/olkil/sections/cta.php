<?php
/**
 * Bottom CTA
 *
 * @package OLKIL
 */
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}
?>
<section class="olkil-cta" aria-labelledby="olkil-cta-title">
	<div class="olkil-cta__glow" aria-hidden="true"></div>
	<div class="olkil-wrap olkil-reveal">
		<h2 id="olkil-cta-title"><?php esc_html_e( 'Start building with OLKIL.', 'olkil' ); ?></h2>
		<p><?php esc_html_e( 'Begin on Dazzlone free — or go Lite, Pro, or Ultra for more tokens, agents, and priority compute.', 'olkil' ); ?></p>
		<div class="olkil-hero__ctas">
			<a class="olkil-btn olkil-btn--primary olkil-btn--lg" data-olkil-download="auto" href="<?php echo esc_url( home_url( '/download/' ) ); ?>">
				<span class="olkil-btn-label"><?php esc_html_e( 'Download free', 'olkil' ); ?></span>
			</a>
			<a class="olkil-btn olkil-btn--ghost olkil-btn--lg" href="<?php echo esc_url( home_url( '/pricing/' ) ); ?>">
				<?php esc_html_e( 'Compare plans', 'olkil' ); ?>
			</a>
		</div>
	</div>
</section>
