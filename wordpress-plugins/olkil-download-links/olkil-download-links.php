<?php
/**
 * Plugin Name: OLKIL Download Links
 * Description: Sets Windows / macOS / Linux download URLs for OLKIL desktop installers. Mirrors installers into /downloads/.
 * Version: 1.3.0
 * Author: OLKIL
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

function olkil_dl_app_version() {
	return '1.3.13';
}

function olkil_dl_release_tag() {
	return 'v' . olkil_dl_app_version() . '-desktop';
}

function olkil_dl_github_base() {
	return 'https://github.com/narsijangid/IDE/releases/download/' . olkil_dl_release_tag();
}

/**
 * Filenames we publish under /downloads/.
 *
 * @return array<string,string> os => filename
 */
function olkil_dl_filenames() {
	$v = olkil_dl_app_version();
	return array(
		'windows'        => 'OLKIL-' . $v . '.exe',
		'macos'          => 'OLKIL-' . $v . '-arm64.dmg',
		'macos_intel'    => 'OLKIL-' . $v . '-x64.dmg',
		'linux'          => 'OLKIL-' . $v . '.deb',
		'linux_appimage' => 'OLKIL-' . $v . '.AppImage',
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
 * Platform → installer URL map.
 * Prefer Hostinger /downloads/ when present; else GitHub Release.
 *
 * @return array<string,string>
 */
function olkil_dl_urls() {
	$files = olkil_dl_filenames();
	$gh    = olkil_dl_github_base();
	$out   = array();
	foreach ( $files as $os => $name ) {
		$out[ $os ] = olkil_dl_has_local( $name )
			? home_url( '/downloads/' . $name )
			: $gh . '/' . $name;
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

/**
 * Pull missing Mac/Linux installers from GitHub onto Hostinger /downloads/.
 * Runs once per version (cron/admin) so large MCP uploads are not required.
 */
function olkil_dl_fetch_missing_from_github() {
	if ( get_option( 'olkil_dl_fetched_v' ) === olkil_dl_app_version() ) {
		return;
	}
	if ( ! function_exists( 'download_url' ) ) {
		require_once ABSPATH . 'wp-admin/includes/file.php';
	}
	$dest_dir = trailingslashit( ABSPATH ) . 'downloads/';
	if ( ! is_dir( $dest_dir ) ) {
		wp_mkdir_p( $dest_dir );
	}
	$gh    = olkil_dl_github_base();
	$files = olkil_dl_filenames();
	$ok    = true;
	foreach ( $files as $name ) {
		// Keep existing Windows.exe if already present.
		if ( olkil_dl_has_local( $name ) ) {
			continue;
		}
		$url = $gh . '/' . $name;
		$tmp = download_url( $url, 600 );
		if ( is_wp_error( $tmp ) ) {
			$ok = false;
			continue;
		}
		$target = $dest_dir . $name;
		// phpcs:ignore WordPress.WP.AlternativeFunctions.rename_rename
		if ( ! @rename( $tmp, $target ) ) {
			copy( $tmp, $target );
			@unlink( $tmp );
		}
		if ( ! olkil_dl_has_local( $name ) ) {
			$ok = false;
		}
	}
	if ( $ok ) {
		update_option( 'olkil_dl_fetched_v', olkil_dl_app_version(), false );
	}
}

register_activation_hook( __FILE__, function () {
	olkil_dl_mirror_installers();
	olkil_dl_fetch_missing_from_github();
} );

add_action( 'admin_init', function () {
	olkil_dl_mirror_installers();
	olkil_dl_fetch_missing_from_github();
} );

add_action( 'init', function () {
	olkil_dl_mirror_installers();
	// Avoid blocking every front-page request with huge downloads.
	if ( is_admin() || wp_doing_cron() ) {
		olkil_dl_fetch_missing_from_github();
	}
}, 20 );

// One background fetch shortly after deploy (non-admin visitors won't wait).
add_action( 'wp_loaded', function () {
	if ( get_option( 'olkil_dl_fetched_v' ) === olkil_dl_app_version() ) {
		return;
	}
	if ( ! wp_next_scheduled( 'olkil_dl_fetch_event' ) ) {
		wp_schedule_single_event( time() + 30, 'olkil_dl_fetch_event' );
	}
} );
add_action( 'olkil_dl_fetch_event', 'olkil_dl_fetch_missing_from_github' );

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
		document.querySelectorAll('[data-olkil-os]').forEach(function (el) {
			var key = el.getAttribute('data-olkil-os');
			var href = hrefFor(key);
			if (href) el.setAttribute('href', href);
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
