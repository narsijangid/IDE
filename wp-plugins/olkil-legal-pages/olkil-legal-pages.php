<?php
/**
 * Plugin Name: OLKIL Legal Pages Footer
 * Description: Legal footer links + fixes blank long pages/posts (reveal animation) and syncs theme templates.
 * Version: 1.1.3
 * Author: OLKIL
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'OLKIL_LEGAL_PAGES_VERSION', '1.1.3' );
define( 'OLKIL_LEGAL_PAGES_DIR', plugin_dir_path( __FILE__ ) );
define( 'OLKIL_LEGAL_PAGES_URL', plugin_dir_url( __FILE__ ) );

/**
 * Use patched page/single templates from this plugin (avoids theme file write permission issues).
 * Never override pages that use a custom page template (profile, auth, pricing, etc.).
 *
 * @param string $template Current template path.
 * @return string
 */
function olkil_legal_pages_template_include( $template ) {
	if ( is_singular( 'post' ) ) {
		$single = OLKIL_LEGAL_PAGES_DIR . 'single.php';
		if ( file_exists( $single ) ) {
			return $single;
		}
	}

	if ( is_page() && ! is_front_page() ) {
		$custom = get_page_template_slug( get_queried_object_id() );
		if ( $custom && 'default' !== $custom ) {
			return $template;
		}

		// Also protect PayU / account slugs even if template meta is missing.
		$slug = get_post_field( 'post_name', get_queried_object_id() );
		$skip = array(
			'profile',
			'dashboard',
			'checkout',
			'login',
			'auth',
			'auth-ide',
			'payment-success',
			'payment-failed',
			'download',
			'pricing',
		);
		if ( $slug && in_array( $slug, $skip, true ) ) {
			return $template;
		}

		$page = OLKIL_LEGAL_PAGES_DIR . 'page.php';
		if ( file_exists( $page ) ) {
			return $page;
		}
	}

	return $template;
}
add_filter( 'template_include', 'olkil_legal_pages_template_include', 99 );

/**
 * Sync patched theme assets when writable.
 */
function olkil_legal_pages_sync_theme() {
	if ( get_option( 'olkil_legal_pages_sync_v3' ) === OLKIL_LEGAL_PAGES_VERSION ) {
		return;
	}

	$theme_dir = trailingslashit( get_theme_root() ) . 'olkil';
	if ( ! is_dir( $theme_dir ) ) {
		return;
	}

	$map = array(
		'footer.php' => 'template-parts/olkil/footer.php',
		'olkil.js'   => 'assets/olkil/js/olkil.js',
		'olkil.css'  => 'assets/olkil/css/olkil.css',
	);

	$ok = true;
	foreach ( $map as $src_rel => $dest_rel ) {
		$src  = OLKIL_LEGAL_PAGES_DIR . $src_rel;
		$dest = $theme_dir . $dest_rel;
		if ( ! file_exists( $src ) ) {
			$ok = false;
			continue;
		}
		$dest_dir = dirname( $dest );
		if ( ! is_dir( $dest_dir ) ) {
			wp_mkdir_p( $dest_dir );
		}
		if ( ! @copy( $src, $dest ) ) {
			$ok = false;
		}
	}

	if ( $ok ) {
		update_option( 'olkil_legal_pages_sync_v3', OLKIL_LEGAL_PAGES_VERSION, false );
		if ( function_exists( 'opcache_reset' ) ) {
			@opcache_reset();
		}
	}
}
add_action( 'init', 'olkil_legal_pages_sync_theme', 2 );

/**
 * Emergency CSS: never leave long articles/posts invisible if old markup still has olkil-reveal.
 */
function olkil_legal_pages_visibility_css() {
	static $printed = false;
	if ( $printed ) {
		return;
	}
	$printed = true;
	echo '<style id="olkil-long-content-fix">'
		. 'body.page .olkil-article.olkil-reveal,'
		. 'body.single .olkil-article.olkil-reveal,'
		. 'article.olkil-article.olkil-reveal,'
		. '.olkil-article.olkil-reveal,'
		. 'body.page .olkil-article,'
		. 'body.single .olkil-article,'
		. '.olkil-article .entry-content,'
		. '.olkil-article .olkil-prose,'
		. 'body.page .entry-content.olkil-prose,'
		. 'body.single .entry-content.olkil-prose{'
		. 'opacity:1!important;transform:none!important;visibility:visible!important'
		. '}'
		. '</style>';
}
add_action( 'wp_head', 'olkil_legal_pages_visibility_css', 99 );
add_action( 'wp_footer', 'olkil_legal_pages_visibility_css', 5 );

/**
 * JS safety: force-show article content even if reveal animation never fires.
 */
function olkil_legal_pages_visibility_js() {
	?>
	<script id="olkil-long-content-fix-js">
	(function () {
		function showArticles() {
			document.querySelectorAll('.olkil-article, .olkil-article.olkil-reveal, .entry-content.olkil-prose').forEach(function (el) {
				el.classList.add('is-visible');
				el.style.opacity = '1';
				el.style.transform = 'none';
				el.style.visibility = 'visible';
			});
		}
		if (document.readyState === 'loading') {
			document.addEventListener('DOMContentLoaded', showArticles);
		} else {
			showArticles();
		}
		window.addEventListener('load', showArticles);
	})();
	</script>
	<?php
}
add_action( 'wp_footer', 'olkil_legal_pages_visibility_js', 1 );

/**
 * Fallback footer links only when missing.
 */
function olkil_legal_pages_footer_fallback() {
	$privacy = esc_url( home_url( '/privacy-policy/' ) );
	$terms   = esc_url( home_url( '/terms-and-conditions/' ) );
	$refund  = esc_url( home_url( '/refund-policy/' ) );
	$contact = esc_url( home_url( '/contact/' ) );
	?>
	<style id="olkil-legal-footer-css">
		.olkil-footer__legal-links{display:inline-flex;flex-wrap:wrap;align-items:center;gap:.45rem}
		.olkil-footer__legal-links a{font-size:.8rem}
	</style>
	<script id="olkil-legal-footer-js">
	(function () {
		function ready(fn) {
			if (document.readyState !== 'loading') fn();
			else document.addEventListener('DOMContentLoaded', fn);
		}
		ready(function () {
			var footer = document.querySelector('.olkil-footer');
			if (!footer) return;
			if (footer.querySelector('a[href*="privacy-policy"]')) return;

			var grid = footer.querySelector('.olkil-footer__grid');
			if (grid) {
				var col = document.createElement('div');
				col.innerHTML = '<h4>Legal</h4><ul>' +
					'<li><a href="<?php echo $privacy; ?>">Privacy Policy</a></li>' +
					'<li><a href="<?php echo $terms; ?>">Terms &amp; Conditions</a></li>' +
					'<li><a href="<?php echo $refund; ?>">Refund Policy</a></li>' +
					'<li><a href="<?php echo $contact; ?>">Contact Us</a></li>' +
					'</ul>';
				grid.appendChild(col);
			}

			var bottom = footer.querySelector('.olkil-footer__bottom');
			if (bottom && !bottom.querySelector('.olkil-footer__legal-links')) {
				var links = document.createElement('span');
				links.className = 'olkil-footer__legal-links';
				links.innerHTML =
					'<a href="<?php echo $privacy; ?>">Privacy</a><span aria-hidden="true"> · </span>' +
					'<a href="<?php echo $terms; ?>">Terms</a><span aria-hidden="true"> · </span>' +
					'<a href="<?php echo $refund; ?>">Refunds</a><span aria-hidden="true"> · </span>' +
					'<a href="<?php echo $contact; ?>">Contact</a>';
				bottom.appendChild(links);
			}
		});
	})();
	</script>
	<?php
}
add_action( 'wp_footer', 'olkil_legal_pages_footer_fallback', 99 );
