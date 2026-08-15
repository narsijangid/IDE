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
				<p style="margin-top:.75rem;font-size:.85rem;color:var(--olkil-text-dim);">
					<strong>NARSI RAM JANGID</strong><br />
					Lochhbo ki Basthi, Merasi, Beenthwaliya, Nagaur, Rajasthan, India - 341503<br />
					<a href="mailto:narsi@olkil.com">narsi@olkil.com</a>
				</p>
			</div>

			<div>
				<h4><?php esc_html_e( 'Product', 'astra' ); ?></h4>
				<ul>
					<li><a href="<?php echo esc_url( olkil_page_url( 'features' ) ); ?>"><?php esc_html_e( 'Features', 'astra' ); ?></a></li>
					<li><a href="<?php echo esc_url( olkil_page_url( 'download' ) ); ?>"><?php esc_html_e( 'Download', 'astra' ); ?></a></li>
					<li><a href="<?php echo esc_url( olkil_page_url( 'pricing' ) ); ?>"><?php esc_html_e( 'Pricing (INR)', 'astra' ); ?></a></li>
					<li><a href="<?php echo esc_url( home_url( '/about-us/' ) ); ?>"><?php esc_html_e( 'About Us', 'astra' ); ?></a></li>
				</ul>
			</div>

			<div>
				<h4><?php esc_html_e( 'Policies', 'astra' ); ?></h4>
				<ul>
					<li><a href="<?php echo esc_url( olkil_page_url( 'privacy-policy' ) ); ?>"><?php esc_html_e( 'Privacy Policy', 'astra' ); ?></a></li>
					<li><a href="<?php echo esc_url( olkil_page_url( 'terms-and-conditions' ) ); ?>"><?php esc_html_e( 'Terms & Conditions', 'astra' ); ?></a></li>
					<li><a href="<?php echo esc_url( olkil_page_url( 'refund-policy' ) ); ?>"><?php esc_html_e( 'Return & Refund', 'astra' ); ?></a></li>
					<li><a href="<?php echo esc_url( home_url( '/cancellation-policy/' ) ); ?>"><?php esc_html_e( 'Cancellation', 'astra' ); ?></a></li>
					<li><a href="<?php echo esc_url( home_url( '/shipping-policy/' ) ); ?>"><?php esc_html_e( 'Shipping / Delivery', 'astra' ); ?></a></li>
					<li><a href="<?php echo esc_url( olkil_page_url( 'contact' ) ); ?>"><?php esc_html_e( 'Contact Us', 'astra' ); ?></a></li>
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
			<span>&copy; <?php echo esc_html( $year ); ?> OLKIL · Operated by NARSI RAM JANGID</span>
			<span class="olkil-footer__legal-links">
				<a href="<?php echo esc_url( olkil_page_url( 'privacy-policy' ) ); ?>">Privacy</a>
				<span aria-hidden="true">·</span>
				<a href="<?php echo esc_url( olkil_page_url( 'terms-and-conditions' ) ); ?>">Terms</a>
				<span aria-hidden="true">·</span>
				<a href="<?php echo esc_url( olkil_page_url( 'refund-policy' ) ); ?>">Refund</a>
				<span aria-hidden="true">·</span>
				<a href="<?php echo esc_url( home_url( '/cancellation-policy/' ) ); ?>">Cancel</a>
				<span aria-hidden="true">·</span>
				<a href="<?php echo esc_url( home_url( '/shipping-policy/' ) ); ?>">Shipping</a>
				<span aria-hidden="true">·</span>
				<a href="<?php echo esc_url( olkil_page_url( 'contact' ) ); ?>">Contact</a>
			</span>
		</div>
	</div>
</footer>
