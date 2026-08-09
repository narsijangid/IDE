<?php
/**
 * OLKIL footer
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
				<p><?php esc_html_e( 'Free AI-powered IDE for ambitious builders. Windows, macOS & Linux — all features free.', 'astra' ); ?></p>
			</div>

			<div>
				<h4><?php esc_html_e( 'Product', 'astra' ); ?></h4>
				<ul>
					<li><a href="<?php echo esc_url( olkil_page_url( 'features' ) ); ?>"><?php esc_html_e( 'Features', 'astra' ); ?></a></li>
					<li><a href="<?php echo esc_url( olkil_page_url( 'download' ) ); ?>"><?php esc_html_e( 'Download', 'astra' ); ?></a></li>
					<li><a href="<?php echo esc_url( olkil_page_url( 'pricing' ) ); ?>"><?php esc_html_e( 'Pricing', 'astra' ); ?></a></li>
				</ul>
			</div>

			<div>
				<h4><?php esc_html_e( 'Resources', 'astra' ); ?></h4>
				<ul>
					<li><a href="<?php echo esc_url( olkil_blog_url() ); ?>"><?php esc_html_e( 'Blog', 'astra' ); ?></a></li>
					<li><a href="<?php echo esc_url( olkil_page_url( 'docs' ) ); ?>"><?php esc_html_e( 'Docs', 'astra' ); ?></a></li>
					<li><a href="https://olkil.com"><?php esc_html_e( 'olkil.com', 'astra' ); ?></a></li>
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
			<span>&copy; <?php echo esc_html( $year ); ?> OLKIL. <?php esc_html_e( 'All rights reserved.', 'astra' ); ?></span>
			<span><?php esc_html_e( 'Built for developers. Fully free.', 'astra' ); ?></span>
		</div>
	</div>
</footer>
