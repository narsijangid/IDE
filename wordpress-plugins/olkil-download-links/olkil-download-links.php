<?php
/**
 * Plugin Name: OLKIL Download Links
 * Description: Sets Windows / macOS / Linux download URLs for OLKIL desktop installers. Mirrors installers into /downloads/.
 * Version: 1.3.27
 * Author: OLKIL
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

if ( get_option( 'olkil_opcache_bust_1327c' ) !== '1' ) {
	if ( function_exists( 'opcache_reset' ) ) {
		@opcache_reset();
	}
	update_option( 'olkil_opcache_bust_1327c', '1', false );
}

function olkil_dl_app_version() {
	return '1.3.27';
}

/**
 * Hostinger-hosted Mac/Linux build. GitHub Releases are private.
 */
function olkil_dl_maclin_version() {
	return '1.3.26';
}

/**
 * Filenames we publish under /downloads/.
 *
 * @return array<string,string> os => filename
 */
function olkil_dl_filenames() {
	$win = olkil_dl_app_version();
	$mac = olkil_dl_maclin_version();
	return array(
		'windows'        => 'OLKIL-' . $win . '.exe',
		'macos'          => 'OLKIL-' . $mac . '-arm64.dmg',
		'macos_intel'    => 'OLKIL-' . $mac . '-x64.dmg',
		// Hostinger WAF 403s newer .deb files; AppImage is the public Linux build.
		'linux'          => 'OLKIL-' . $mac . '.AppImage',
		'linux_appimage' => 'OLKIL-' . $mac . '.AppImage',
	);
}

function olkil_dl_local_path( $filename ) {
	return trailingslashit( ABSPATH ) . 'downloads/' . ltrim( $filename, '/' );
}

function olkil_dl_has_local( $filename ) {
	$path = olkil_dl_local_path( $filename );
	return file_exists( $path ) && filesize( $path ) > 1000000;
}

/**
 * Platform → installer URL map. Always Hostinger /downloads/.
 *
 * @return array<string,string>
 */
function olkil_dl_urls() {
	$files = olkil_dl_filenames();
	$out   = array();
	foreach ( $files as $os => $name ) {
		$out[ $os ] = home_url( '/downloads/' . $name );
	}
	return $out;
}

/**
 * Copy bundled installers from plugin/installers/ → ABSPATH/downloads/.
 */
function olkil_dl_mirror_installers() {
	$src = plugin_dir_path( __FILE__ ) . 'installers/';
	if ( ! is_dir( $src ) ) {
		return;
	}
	$dest = trailingslashit( ABSPATH ) . 'downloads/';
	if ( ! is_dir( $dest ) ) {
		wp_mkdir_p( $dest );
	}
	$files = glob( $src . 'OLKIL-*' );
	if ( ! is_array( $files ) ) {
		return;
	}
	foreach ( $files as $file ) {
		if ( ! is_file( $file ) ) {
			continue;
		}
		$target = $dest . basename( $file );
		if ( ! file_exists( $target ) || filesize( $target ) !== filesize( $file ) || filemtime( $file ) > filemtime( $target ) ) {
			copy( $file, $target );
		}
	}
}

register_activation_hook( __FILE__, 'olkil_dl_mirror_installers' );

add_action( 'admin_init', 'olkil_dl_mirror_installers' );

add_action( 'init', 'olkil_dl_mirror_installers', 20 );

add_filter( 'olkil_download_urls', function ( $urls ) {
	return array_merge( is_array( $urls ) ? $urls : array(), olkil_dl_urls() );
} );
add_filter( 'olkil_app_version', function () {
	return olkil_dl_app_version();
} );

function olkil_dl_start_buffer() {
	if ( is_admin() || wp_doing_ajax() || wp_doing_cron() ) {
		return;
	}
	ob_start( 'olkil_dl_rewrite_buffer' );
}
add_action( 'template_redirect', 'olkil_dl_start_buffer', 0 );

function olkil_dl_rewrite_buffer( $html ) {
	if ( ! is_string( $html ) || $html === '' ) {
		return $html;
	}
	$urls = olkil_dl_urls();
	foreach ( array( 'windows', 'macos', 'linux' ) as $os ) {
		if ( empty( $urls[ $os ] ) ) {
			continue;
		}
		$url = esc_url( $urls[ $os ] );
		$html = preg_replace(
			'/data-olkil-os="' . preg_quote( $os, '/' ) . '"(\s+)href="#"/',
			'data-olkil-os="' . $os . '"$1href="' . $url . '"',
			$html
		);
	}
	return $html;
}

function olkil_dl_print_footer_script() {
	$map = olkil_dl_urls();
	?>
	<script>
	(function () {
		var downloads = <?php echo wp_json_encode( $map ); ?>;
		window.olkilData = window.olkilData || {};
		window.olkilData.appVersion = <?php echo wp_json_encode( olkil_dl_app_version() ); ?>;
		window.olkilData.downloads = Object.assign({}, window.olkilData.downloads || {}, downloads);
		function isAppleSilicon() {
			try {
				var canvas = document.createElement('canvas');
				var gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
				if (!gl) return true;
				var info = gl.getExtension('WEBGL_debug_renderer_info');
				if (!info) return true;
				var renderer = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) || '');
				return /Apple|M1|M2|M3|M4/i.test(renderer);
			} catch (e) {
				return true;
			}
		}
		function hrefFor(os) {
			if (os === 'macos') {
				return isAppleSilicon()
					? (downloads.macos || downloads.macos_intel)
					: (downloads.macos_intel || downloads.macos);
			}
			return downloads[os] || '#';
		}
		function versionFromHref(href) {
			var m = /OLKIL-(\d+\.\d+\.\d+)/.exec(href || '');
			return m ? m[1] : '';
		}
		document.querySelectorAll('[data-olkil-os]').forEach(function (el) {
			var key = el.getAttribute('data-olkil-os');
			var href = hrefFor(key);
			if (href) el.setAttribute('href', href);
			var ver = versionFromHref(href);
			if (!ver) return;
			var meta = el.querySelector('.olkil-platform__meta');
			if (meta) meta.textContent = String(meta.textContent || '').replace(/v\d+\.\d+\.\d+/, 'v' + ver);
			if (el.hasAttribute('download')) el.setAttribute('download', 'OLKIL-' + ver + '.exe');
		});
		document.querySelectorAll('[data-olkil-download="auto"]').forEach(function (el) {
			var ua = navigator.userAgent || '';
			var os = /Win/i.test(ua) ? 'windows' : (/Mac/i.test(ua) ? 'macos' : (/Linux|X11/i.test(ua) ? 'linux' : 'windows'));
			el.setAttribute('href', hrefFor(os));
		});
	})();
	</script>
	<?php
}
add_action( 'wp_footer', 'olkil_dl_print_footer_script', 99 );
