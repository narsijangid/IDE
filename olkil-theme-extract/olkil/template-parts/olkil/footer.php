<?php
/**
 * OLKIL footer — PayU policy links
 *
 * @package Astra
 */
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}
$year = gmdate( 'Y' );
?>
<footer class="olkil-footer" role="contentinfo">
	<div class="olkil-wrap">
		<div class="olkil-footer__grid">
			<div class="olkil-footer__brand">
				<a class="olkil-logo" href="<?php echo esc_url( home_url( '/' ) ); ?>">
					<img class="olkil-logo__img" src="<?php echo esc_url( OLKIL_URI . 'assets/olkil/img/logo-mark.png' ); ?>" width="32" height="32" alt="" decoding="async" />
					<span>OLKIL</span>
				</a>
				<p><?php esc_html_e( 'Free AI-powered IDE for ambitious builders. Windows, macOS & Linux.', 'astra' ); ?></p>
			</div>

			<div>
				<h4><?php esc_html_e( 'Product', 'astra' ); ?></h4>
				<ul>
					<?php foreach ( olkil_product_nav_items() as $item_slug => $label ) : ?>
						<li><a href="<?php echo esc_url( olkil_page_url( $item_slug ) ); ?>"><?php echo esc_html( $label ); ?></a></li>
					<?php endforeach; ?>
					<li><a href="<?php echo esc_url( olkil_page_url( 'features' ) ); ?>"><?php esc_html_e( 'Features', 'astra' ); ?></a></li>
					<li><a href="<?php echo esc_url( olkil_page_url( 'pricing' ) ); ?>"><?php esc_html_e( 'Pricing', 'astra' ); ?></a></li>
					<li><a href="<?php echo esc_url( olkil_page_url( 'download' ) ); ?>"><?php esc_html_e( 'Download', 'astra' ); ?></a></li>
				</ul>
			</div>

			<div>
				<h4><?php esc_html_e( 'Policies', 'astra' ); ?></h4>
				<ul>
					<li><a href="<?php echo esc_url( olkil_page_url( 'privacy-policy' ) ); ?>"><?php esc_html_e( 'Privacy Policy', 'astra' ); ?></a></li>
					<li><a href="<?php echo esc_url( olkil_page_url( 'terms-and-conditions' ) ); ?>"><?php esc_html_e( 'Terms & Conditions', 'astra' ); ?></a></li>
					<li><a href="<?php echo esc_url( olkil_page_url( 'refund-policy' ) ); ?>"><?php esc_html_e( 'Return & Refund', 'astra' ); ?></a></li>
					<li><a href="<?php echo esc_url( home_url( '/cancellation-policy/' ) ); ?>"><?php esc_html_e( 'Cancellation', 'astra' ); ?></a></li>
					<li><a href="<?php echo esc_url( olkil_page_url( 'contact' ) ); ?>"><?php esc_html_e( 'Contact Us', 'astra' ); ?></a></li>
					<li><a href="<?php echo esc_url( home_url( '/about-us/' ) ); ?>"><?php esc_html_e( 'About Us', 'astra' ); ?></a></li>
				</ul>
			</div>

			<div>
				<h4><?php esc_html_e( 'Get OLKIL', 'astra' ); ?></h4>
				<ul>
					<li><a data-olkil-os="windows" href="<?php echo esc_url( olkil_download_url( 'windows' ) ); ?>"><?php esc_html_e( 'Windows', 'astra' ); ?></a></li>
					<li><a data-olkil-os="macos" href="<?php echo esc_url( olkil_download_url( 'macos' ) ); ?>"><?php esc_html_e( 'macOS', 'astra' ); ?></a></li>
					<li><a data-olkil-os="linux" href="<?php echo esc_url( olkil_download_url( 'linux' ) ); ?>"><?php esc_html_e( 'Linux', 'astra' ); ?></a></li>
				</ul>
			</div>
		</div>

		<div class="olkil-footer__bottom">
			<span>&copy; <?php echo esc_html( $year ); ?> OLKIL</span>
			<div class="olkil-theme-toggle" role="radiogroup" aria-label="<?php esc_attr_e( 'Theme', 'olkil' ); ?>">
				<button type="button" class="olkil-theme-toggle__btn" data-olkil-theme="system" role="radio" aria-checked="false" title="<?php esc_attr_e( 'System', 'olkil' ); ?>" aria-label="<?php esc_attr_e( 'System theme', 'olkil' ); ?>">
					<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 20h8M12 17v3"/></svg>
				</button>
				<button type="button" class="olkil-theme-toggle__btn" data-olkil-theme="light" role="radio" aria-checked="false" title="<?php esc_attr_e( 'Light', 'olkil' ); ?>" aria-label="<?php esc_attr_e( 'Light theme', 'olkil' ); ?>">
					<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4"/></svg>
				</button>
				<button type="button" class="olkil-theme-toggle__btn" data-olkil-theme="dark" role="radio" aria-checked="false" title="<?php esc_attr_e( 'Dark', 'olkil' ); ?>" aria-label="<?php esc_attr_e( 'Dark theme', 'olkil' ); ?>">
					<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 14.3A8.5 8.5 0 1 1 9.7 3 7 7 0 0 0 21 14.3z"/></svg>
				</button>
			</div>
			<span class="olkil-footer__legal-links">
				<a href="<?php echo esc_url( olkil_page_url( 'privacy-policy' ) ); ?>">Privacy</a>
				<span aria-hidden="true">·</span>
				<a href="<?php echo esc_url( olkil_page_url( 'terms-and-conditions' ) ); ?>">Terms</a>
				<span aria-hidden="true">·</span>
				<a href="<?php echo esc_url( olkil_page_url( 'refund-policy' ) ); ?>">Refund</a>
				<span aria-hidden="true">·</span>
				<a href="<?php echo esc_url( home_url( '/cancellation-policy/' ) ); ?>">Cancel</a>
				<span aria-hidden="true">·</span>
				<a href="<?php echo esc_url( olkil_page_url( 'contact' ) ); ?>">Contact</a>
			</span>
		</div>
	</div>
</footer>
