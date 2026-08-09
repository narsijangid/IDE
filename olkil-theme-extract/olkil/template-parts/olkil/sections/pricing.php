<?php
/**
 * Pricing teaser — Free
 *
 * @package OLKIL
 */
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}
?>
<section class="olkil-section" id="pricing" aria-labelledby="olkil-pricing-title">
	<div class="olkil-wrap">
		<div class="olkil-section__head olkil-reveal">
			<h2 id="olkil-pricing-title"><?php esc_html_e( 'Pricing', 'olkil' ); ?></h2>
			<p><?php esc_html_e( 'Simple. Transparent. Free.', 'olkil' ); ?></p>
		</div>

		<div class="olkil-price olkil-reveal">
			<span class="olkil-price__badge"><?php esc_html_e( 'Free forever', 'olkil' ); ?></span>
			<p class="olkil-price__amount">$0 <span>/ forever</span></p>
			<p class="olkil-price__name"><?php esc_html_e( 'OLKIL Free', 'olkil' ); ?></p>
			<ul>
				<li><?php esc_html_e( 'Full AI-powered IDE', 'olkil' ); ?></li>
				<li><?php esc_html_e( 'Agents & autocomplete', 'olkil' ); ?></li>
				<li><?php esc_html_e( 'Multi-model chat', 'olkil' ); ?></li>
				<li><?php esc_html_e( 'Windows, macOS & Linux', 'olkil' ); ?></li>
				<li><?php esc_html_e( 'Updates included', 'olkil' ); ?></li>
				<li><?php esc_html_e( 'No credit card required', 'olkil' ); ?></li>
			</ul>
			<a class="olkil-btn olkil-btn--primary olkil-btn--lg olkil-btn--block" data-olkil-download="auto" href="<?php echo esc_url( home_url( '/download/' ) ); ?>">
				<span class="olkil-btn-label"><?php esc_html_e( 'Get OLKIL free', 'olkil' ); ?></span>
			</a>
		</div>
	</div>
</section>
