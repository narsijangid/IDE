<?php
/**
 * Download platforms
 *
 * @package OLKIL
 */
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

$v     = olkil_app_version();
$urls  = olkil_download_urls();
$win   = $urls['windows'];
$mac   = $urls['macos'];
$linux = $urls['linux'];
?>
<section class="olkil-section olkil-section--tight" id="download" aria-labelledby="olkil-download-title">
	<div class="olkil-wrap">
		<div class="olkil-section__head olkil-reveal">
			<h2 id="olkil-download-title"><?php esc_html_e( 'Download OLKIL', 'olkil' ); ?></h2>
			<p><?php esc_html_e( 'Free for Windows, macOS, and Linux. Install in minutes and start shipping.', 'olkil' ); ?></p>
		</div>

		<div class="olkil-platforms">
			<a class="olkil-platform olkil-reveal" data-olkil-os="windows" href="<?php echo esc_url( $win ); ?>" download="OLKIL-<?php echo esc_attr( $v ); ?>.exe">
				<span class="olkil-platform__os"><?php esc_html_e( 'Windows', 'olkil' ); ?></span>
				<span class="olkil-platform__meta"><?php echo esc_html( sprintf( __( 'Windows 10 / 11 · x64 · v%s', 'olkil' ), $v ) ); ?></span>
				<span class="olkil-btn olkil-btn--primary"><?php esc_html_e( 'Download', 'olkil' ); ?></span>
			</a>
			<a class="olkil-platform olkil-reveal" data-olkil-os="macos" href="<?php echo esc_url( $mac ); ?>">
				<span class="olkil-platform__os"><?php esc_html_e( 'macOS', 'olkil' ); ?></span>
				<span class="olkil-platform__meta"><?php echo esc_html( sprintf( __( 'Apple Silicon & Intel · .dmg · v%s', 'olkil' ), $v ) ); ?></span>
				<span class="olkil-btn olkil-btn--primary"><?php esc_html_e( 'Download', 'olkil' ); ?></span>
			</a>
			<a class="olkil-platform olkil-reveal" data-olkil-os="linux" href="<?php echo esc_url( $linux ); ?>">
				<span class="olkil-platform__os"><?php esc_html_e( 'Linux', 'olkil' ); ?></span>
				<span class="olkil-platform__meta"><?php echo esc_html( sprintf( __( '.deb · .AppImage · x64 · v%s', 'olkil' ), $v ) ); ?></span>
				<span class="olkil-btn olkil-btn--primary"><?php esc_html_e( 'Download', 'olkil' ); ?></span>
			</a>
		</div>
	</div>
</section>
