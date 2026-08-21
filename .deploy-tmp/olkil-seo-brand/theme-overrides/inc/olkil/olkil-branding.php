<?php
/**
 * OLKIL branding layer for Astra
 *
 * @package Astra
 * @since 4.13.8
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'OLKIL_VERSION', '1.4.5' );
/** Desktop installer version (matches ide-electron/product.json). */
define( 'OLKIL_APP_VERSION', '1.3.13' );
define( 'OLKIL_DIR', trailingslashit( get_template_directory() ) );
define( 'OLKIL_URI', trailingslashit( get_template_directory_uri() ) );

/**
 * Packaged desktop app version string (no leading v).
 *
 * @return string
 */
function olkil_app_version() {
	return apply_filters( 'olkil_app_version', OLKIL_APP_VERSION );
}

/**
 * Platform download URLs for Windows / macOS / Linux.
 * Binaries are published to GitHub Releases (see ide-electron/scripts/publish-update.js).
 * Windows also keeps a Hostinger /downloads/ mirror for the site CTA.
 *
 * @return array{windows:string,macos:string,macos_intel:string,linux:string,linux_appimage:string}
 */
function olkil_download_urls() {
	$v = olkil_app_version();
	// Hostinger /downloads/ mirror (same pattern as Windows CTA).
	$urls = array(
		'windows'        => home_url( '/downloads/OLKIL-' . $v . '.exe' ),
		'macos'          => home_url( '/downloads/OLKIL-' . $v . '-arm64.dmg' ),
		'macos_intel'    => home_url( '/downloads/OLKIL-' . $v . '-x64.dmg' ),
		'linux'          => home_url( '/downloads/OLKIL-' . $v . '.deb' ),
		'linux_appimage' => home_url( '/downloads/OLKIL-' . $v . '.AppImage' ),
	);

	/**
	 * Filter download URLs per platform.
	 *
	 * @param array $urls Platform => URL map.
	 */
	return apply_filters( 'olkil_download_urls', $urls );
}

/**
 * Single-platform download URL.
 *
 * @param string $os windows|macos|macos_intel|linux|linux_appimage
 * @return string
 */
function olkil_download_url( $os = 'windows' ) {
	$urls = olkil_download_urls();
	return isset( $urls[ $os ] ) ? $urls[ $os ] : '#';
}

/**
 * Best available post image URL for cards (featured → attachment → content img).
 *
 * @param int    $post_id Post ID.
 * @param string $size    Preferred size.
 * @return string
 */
function olkil_get_post_thumbnail_url( $post_id = 0, $size = 'medium_large' ) {
	$post_id = $post_id ? (int) $post_id : get_the_ID();
	if ( ! $post_id ) {
		return '';
	}

	$sizes = array( $size, 'large', 'medium', 'full', 'thumbnail' );
	$sizes = array_unique( $sizes );

	if ( has_post_thumbnail( $post_id ) ) {
		foreach ( $sizes as $try ) {
			$url = get_the_post_thumbnail_url( $post_id, $try );
			if ( $url ) {
				return $url;
			}
		}
		$thumb_id = get_post_thumbnail_id( $post_id );
		$src      = wp_get_attachment_image_src( $thumb_id, 'full' );
		if ( ! empty( $src[0] ) ) {
			return $src[0];
		}
	}

	$attachments = get_attached_media( 'image', $post_id );
	if ( ! empty( $attachments ) ) {
		$first = reset( $attachments );
		$src   = wp_get_attachment_image_src( $first->ID, $size );
		if ( empty( $src[0] ) ) {
			$src = wp_get_attachment_image_src( $first->ID, 'full' );
		}
		if ( ! empty( $src[0] ) ) {
			return $src[0];
		}
	}

	$post = get_post( $post_id );
	if ( $post && ! empty( $post->post_content ) ) {
		if ( preg_match( '/<img[^>]+src=["\']([^"\']+)["\']/i', $post->post_content, $m ) ) {
			return esc_url_raw( $m[1] );
		}
		// Gutenberg image block / wp-image-ID
		if ( preg_match( '/wp-image-(\d+)/', $post->post_content, $m ) ) {
			$src = wp_get_attachment_image_src( (int) $m[1], $size );
			if ( empty( $src[0] ) ) {
				$src = wp_get_attachment_image_src( (int) $m[1], 'full' );
			}
			if ( ! empty( $src[0] ) ) {
				return $src[0];
			}
		}
	}

	return '';
}

/**
 * Blog URL (Posts page if set, else /blog/).
 */
function olkil_blog_url() {
	$posts_page = (int) get_option( 'page_for_posts' );
	if ( $posts_page ) {
		return get_permalink( $posts_page );
	}
	$page = get_page_by_path( 'blog' );
	if ( $page ) {
		return get_permalink( $page );
	}
	return home_url( '/blog/' );
}

/**
 * Features / Pricing / Download URLs by slug with fallback.
 *
 * @param string $slug Page slug.
 */
function olkil_page_url( $slug ) {
	$page = get_page_by_path( $slug );
	if ( $page ) {
		return get_permalink( $page );
	}
	return home_url( '/' . trim( $slug, '/' ) . '/' );
}

/**
 * Enqueue OLKIL fonts, CSS, JS.
 */
function olkil_enqueue_assets() {
	wp_enqueue_style(
		'olkil-fonts',
		'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&family=Syne:wght@600;700;800&display=swap',
		array(),
		null
	);

	wp_enqueue_style(
		'olkil-main',
		OLKIL_URI . 'assets/olkil/css/olkil.css',
		array( 'astra-theme-css', 'olkil-fonts' ),
		OLKIL_VERSION
	);

	wp_enqueue_script(
		'olkil-main',
		OLKIL_URI . 'assets/olkil/js/olkil.js',
		array(),
		OLKIL_VERSION,
		true
	);

	wp_localize_script(
		'olkil-main',
		'olkilData',
		array(
			'homeUrl'    => home_url( '/' ),
			'siteName'   => get_bloginfo( 'name' ) ?: 'OLKIL',
			'loginUrl'   => olkil_page_url( 'login' ),
			'profileUrl' => olkil_page_url( 'profile' ),
			'appVersion' => olkil_app_version(),
			'downloads'  => olkil_download_urls(),
		)
	);

	// Firebase — site-wide account chip + IDE login bridge
	wp_enqueue_script(
		'firebase-app',
		'https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js',
		array(),
		'10.14.1',
		true
	);
	wp_enqueue_script(
		'firebase-auth',
		'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth-compat.js',
		array( 'firebase-app' ),
		'10.14.1',
		true
	);
	wp_enqueue_script(
		'olkil-account',
		OLKIL_URI . 'assets/olkil/js/olkil-account.js',
		array( 'firebase-auth', 'olkil-main' ),
		OLKIL_VERSION,
		true
	);

	$load_ide_auth = is_page_template( 'page-templates/template-auth-ide.php' )
		|| is_page( array( 'auth', 'ide', 'auth-ide', 'login' ) );
	if ( $load_ide_auth ) {
		wp_enqueue_script(
			'olkil-auth',
			OLKIL_URI . 'assets/olkil/js/olkil-auth.js',
			array( 'firebase-auth' ),
			OLKIL_VERSION,
			true
		);
	}
}
add_action( 'wp_enqueue_scripts', 'olkil_enqueue_assets', 20 );

/**
 * Preload homepage demo video for instant playback.
 */
function olkil_preload_demo_video() {
	if ( ! is_front_page() ) {
		return;
	}
	$video = OLKIL_URI . 'assets/olkil/video/IDEdemo.mp4';
	echo '<link rel="preload" as="video" href="' . esc_url( $video ) . '" type="video/mp4" />' . "\n";
}
add_action( 'wp_head', 'olkil_preload_demo_video', 2 );

/**
 * Site icon / favicon fallback when none is set in Customizer.
 */
function olkil_site_icon_fallback( $url ) {
	if ( $url ) {
		return $url;
	}
	$path = OLKIL_DIR . 'assets/olkil/img/favicon.png';
	if ( file_exists( $path ) ) {
		return OLKIL_URI . 'assets/olkil/img/favicon.png';
	}
	return $url;
}
add_filter( 'get_site_icon_url', 'olkil_site_icon_fallback', 10, 1 );

/**
 * Extra menus for OLKIL chrome.
 */
function olkil_setup() {
	register_nav_menus(
		array(
			'olkil-primary' => __( 'OLKIL Primary Menu', 'astra' ),
			'olkil-footer'  => __( 'OLKIL Footer Menu', 'astra' ),
		)
	);
}
add_action( 'after_setup_theme', 'olkil_setup', 20 );

/**
 * Body classes.
 */
function olkil_body_classes( $classes ) {
	$classes[] = 'olkil-theme';
	$classes[] = 'olkil-dark';
	$classes[] = 'olkil-branded';
	if ( is_front_page() ) {
		$classes[] = 'olkil-front';
	}
	if ( is_home() || is_archive() || is_search() || is_singular( 'post' ) ) {
		$classes[] = 'olkil-blog';
	}
	return $classes;
}
add_filter( 'body_class', 'olkil_body_classes' );

/**
 * Document titles.
 */
function olkil_document_title_parts( $parts ) {
	if ( empty( $parts['site'] ) || 'OLKIL' === strtoupper( $parts['site'] ) ) {
		$parts['site'] = 'OLKIL';
	}
	if ( is_front_page() ) {
		$parts['title'] = 'OLKIL — Free AI-Powered IDE';
		unset( $parts['tagline'] );
	}
	return $parts;
}
add_filter( 'document_title_parts', 'olkil_document_title_parts' );

/**
 * SEO meta + OG + JSON-LD.
 */
function olkil_seo_head() {
	$site_name = 'OLKIL';
	$domain    = 'https://olkil.com';
	$url       = is_singular() ? get_permalink() : home_url( '/' );
	$title     = wp_get_document_title();
	$desc      = get_bloginfo( 'description' );

	if ( empty( $desc ) || false !== stripos( $desc, 'Just another' ) ) {
		$desc = 'OLKIL is a free AI-powered IDE — code faster with agents, autocomplete, and multi-model AI. Download for Windows, macOS, and Linux. Fully free.';
	}

	if ( is_singular() && has_excerpt() ) {
		$desc = wp_strip_all_tags( get_the_excerpt() );
	}

	$image = '';
	if ( is_singular() && has_post_thumbnail() ) {
		$thumb = wp_get_attachment_image_url( get_post_thumbnail_id(), 'full' );
		if ( $thumb ) {
			$image = $thumb;
		}
	}
	if ( ! $image && file_exists( OLKIL_DIR . 'assets/olkil/img/og-default.png' ) ) {
		$image = OLKIL_URI . 'assets/olkil/img/og-default.png';
	}

	echo "\n<!-- OLKIL SEO -->\n";
	echo '<meta name="description" content="' . esc_attr( $desc ) . '" />' . "\n";
	echo '<meta name="theme-color" content="#0a0a0b" />' . "\n";
	echo '<link rel="canonical" href="' . esc_url( $url ) . '" />' . "\n";

	echo '<meta property="og:type" content="' . ( is_singular( 'post' ) ? 'article' : 'website' ) . '" />' . "\n";
	echo '<meta property="og:site_name" content="' . esc_attr( $site_name ) . '" />' . "\n";
	echo '<meta property="og:title" content="' . esc_attr( $title ) . '" />' . "\n";
	echo '<meta property="og:description" content="' . esc_attr( $desc ) . '" />' . "\n";
	echo '<meta property="og:url" content="' . esc_url( $url ) . '" />' . "\n";
	if ( $image ) {
		echo '<meta property="og:image" content="' . esc_url( $image ) . '" />' . "\n";
	}

	echo '<meta name="twitter:card" content="' . ( $image ? 'summary_large_image' : 'summary' ) . '" />' . "\n";
	echo '<meta name="twitter:title" content="' . esc_attr( $title ) . '" />' . "\n";
	echo '<meta name="twitter:description" content="' . esc_attr( $desc ) . '" />' . "\n";
	if ( $image ) {
		echo '<meta name="twitter:image" content="' . esc_url( $image ) . '" />' . "\n";
	}

	$schema = array(
		'@context'            => 'https://schema.org',
		'@type'               => 'SoftwareApplication',
		'name'                => 'OLKIL',
		'applicationCategory' => 'DeveloperApplication',
		'operatingSystem'     => 'Windows, macOS, Linux',
		'url'                 => $domain,
		'description'         => $desc,
		'offers'              => array(
			'@type'         => 'Offer',
			'price'         => '0',
			'priceCurrency' => 'USD',
		),
		'publisher'           => array(
			'@type' => 'Organization',
			'name'  => 'OLKIL',
			'url'   => $domain,
		),
	);

	echo '<script type="application/ld+json">' . wp_json_encode( $schema, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE ) . '</script>' . "\n";
}
add_action( 'wp_head', 'olkil_seo_head', 1 );

/**
 * Fallback menu.
 */
function olkil_fallback_menu() {
	$items = array(
		olkil_page_url( 'features' ) => __( 'Features', 'astra' ),
		olkil_page_url( 'pricing' )  => __( 'Pricing', 'astra' ),
		olkil_blog_url()             => __( 'Blog', 'astra' ),
		olkil_page_url( 'download' ) => __( 'Download', 'astra' ),
	);
	echo '<ul class="olkil-nav-list">';
	foreach ( $items as $href => $label ) {
		$current = ( untrailingslashit( $href ) === untrailingslashit( home_url( add_query_arg( array() ) ) ) ) ||
			( __( 'Blog', 'astra' ) === $label && ( is_home() || is_singular( 'post' ) || is_archive() ) );
		printf(
			'<li class="%s"><a href="%s">%s</a></li>',
			$current ? 'current-menu-item' : '',
			esc_url( $href ),
			esc_html( $label )
		);
	}
	echo '</ul>';
}

/**
 * Include OLKIL section partial.
 *
 * @param string $name Section slug.
 */
function olkil_section( $name ) {
	$path = OLKIL_DIR . 'template-parts/olkil/sections/' . $name . '.php';
	if ( file_exists( $path ) ) {
		include $path;
	}
}

/**
 * Admin setup hint.
 */
function olkil_activation_notice() {
	if ( get_option( 'olkil_setup_v1' ) ) {
		return;
	}
	echo '<div class="notice notice-warning is-dismissible"><p><strong>OLKIL:</strong> Pages auto-setup pending. Open WP Admin once, or re-activate the OLKIL theme.</p></div>';
}
add_action( 'admin_notices', 'olkil_activation_notice' );

/**
 * Create required pages, reading settings, and primary menu.
 */
function olkil_run_setup() {
	if ( get_option( 'olkil_setup_v1' ) ) {
		return;
	}

	$pages = array(
		'home'     => array(
			'title'    => 'Home',
			'template' => '',
		),
		'features' => array(
			'title'    => 'Features',
			'template' => 'page-templates/template-features.php',
		),
		'pricing'  => array(
			'title'    => 'Pricing',
			'template' => 'page-templates/template-pricing.php',
		),
		'download' => array(
			'title'    => 'Download',
			'template' => 'page-templates/template-download.php',
		),
		'blog'     => array(
			'title'    => 'Blog',
			'template' => '',
		),
	);

	$ids = array();

	foreach ( $pages as $slug => $cfg ) {
		$existing = get_page_by_path( $slug );
		if ( $existing ) {
			$ids[ $slug ] = (int) $existing->ID;
			if ( ! empty( $cfg['template'] ) ) {
				update_post_meta( $existing->ID, '_wp_page_template', $cfg['template'] );
			}
			if ( 'publish' !== $existing->post_status ) {
				wp_update_post(
					array(
						'ID'          => $existing->ID,
						'post_status' => 'publish',
					)
				);
			}
			continue;
		}

		$page_id = wp_insert_post(
			array(
				'post_title'   => $cfg['title'],
				'post_name'    => $slug,
				'post_status'  => 'publish',
				'post_type'    => 'page',
				'post_content' => '',
			),
			true
		);

		if ( is_wp_error( $page_id ) || ! $page_id ) {
			continue;
		}

		$ids[ $slug ] = (int) $page_id;
		if ( ! empty( $cfg['template'] ) ) {
			update_post_meta( $page_id, '_wp_page_template', $cfg['template'] );
		}
	}

	if ( ! empty( $ids['home'] ) ) {
		update_option( 'show_on_front', 'page' );
		update_option( 'page_on_front', $ids['home'] );
	}
	if ( ! empty( $ids['blog'] ) ) {
		update_option( 'page_for_posts', $ids['blog'] );
	}

	if ( ! get_option( 'permalink_structure' ) ) {
		update_option( 'permalink_structure', '/%postname%/' );
	}

	$menu_name = 'OLKIL Primary';
	$menu      = wp_get_nav_menu_object( $menu_name );
	if ( ! $menu ) {
		$menu_id = wp_create_nav_menu( $menu_name );
	} else {
		$menu_id = (int) $menu->term_id;
		$items   = wp_get_nav_menu_items( $menu_id );
		if ( $items ) {
			foreach ( $items as $item ) {
				wp_delete_post( $item->ID, true );
			}
		}
	}

	if ( ! is_wp_error( $menu_id ) && $menu_id ) {
		$order = array( 'features', 'pricing', 'blog', 'download' );
		$pos   = 1;
		foreach ( $order as $slug ) {
			if ( empty( $ids[ $slug ] ) ) {
				continue;
			}
			wp_update_nav_menu_item(
				$menu_id,
				0,
				array(
					'menu-item-title'     => $pages[ $slug ]['title'],
					'menu-item-object'    => 'page',
					'menu-item-object-id' => $ids[ $slug ],
					'menu-item-type'      => 'post_type',
					'menu-item-status'    => 'publish',
					'menu-item-position'  => $pos++,
				)
			);
		}

		$locations                  = get_theme_mod( 'nav_menu_locations', array() );
		$locations['olkil-primary'] = (int) $menu_id;
		set_theme_mod( 'nav_menu_locations', $locations );
	}

	flush_rewrite_rules( false );
	update_option( 'olkil_setup_v1', 1 );
	update_option( 'olkil_pages_notice_dismissed', 1 );
}
add_action( 'after_switch_theme', 'olkil_run_setup' );
add_action( 'admin_init', 'olkil_run_setup', 5 );

/**
 * If theme files were replaced without reactivation, still create pages once.
 */
function olkil_maybe_setup_frontend() {
	if ( ! get_option( 'olkil_setup_v1' ) ) {
		olkil_run_setup();
	}
}
add_action( 'init', 'olkil_maybe_setup_frontend', 20 );

/**
 * Ensure /auth/ide/ page exists (additive; safe on existing installs).
 */
function olkil_ensure_auth_pages() {
	if ( get_option( 'olkil_setup_auth_v1' ) ) {
		return;
	}

	$auth = get_page_by_path( 'auth' );
	if ( ! $auth ) {
		$auth_id = wp_insert_post(
			array(
				'post_title'   => 'Auth',
				'post_name'    => 'auth',
				'post_status'  => 'publish',
				'post_type'    => 'page',
				'post_content' => '',
			),
			true
		);
	} else {
		$auth_id = (int) $auth->ID;
	}

	if ( is_wp_error( $auth_id ) || ! $auth_id ) {
		return;
	}

	$ide = get_page_by_path( 'auth/ide' );
	if ( ! $ide ) {
		$ide_id = wp_insert_post(
			array(
				'post_title'   => 'IDE Sign in',
				'post_name'    => 'ide',
				'post_status'  => 'publish',
				'post_type'    => 'page',
				'post_parent'  => $auth_id,
				'post_content' => '',
			),
			true
		);
		if ( ! is_wp_error( $ide_id ) && $ide_id ) {
			update_post_meta( $ide_id, '_wp_page_template', 'page-templates/template-auth-ide.php' );
		}
	} else {
		update_post_meta( $ide->ID, '_wp_page_template', 'page-templates/template-auth-ide.php' );
	}

	// Web login alias
	$login = get_page_by_path( 'login' );
	if ( ! $login ) {
		$login_id = wp_insert_post(
			array(
				'post_title'   => 'Login',
				'post_name'    => 'login',
				'post_status'  => 'publish',
				'post_type'    => 'page',
				'post_content' => '',
			),
			true
		);
		if ( ! is_wp_error( $login_id ) && $login_id ) {
			update_post_meta( $login_id, '_wp_page_template', 'page-templates/template-auth-ide.php' );
		}
	}

	update_option( 'olkil_setup_auth_v1', 1 );
}
add_action( 'admin_init', 'olkil_ensure_auth_pages', 6 );
add_action( 'init', 'olkil_ensure_auth_pages', 25 );

/**
 * Ensure /profile/ page exists (user account details).
 */
function olkil_ensure_profile_page() {
	if ( get_option( 'olkil_setup_profile_v1' ) ) {
		return;
	}

	$profile = get_page_by_path( 'profile' );
	if ( ! $profile ) {
		$profile_id = wp_insert_post(
			array(
				'post_title'   => 'Profile',
				'post_name'    => 'profile',
				'post_status'  => 'publish',
				'post_type'    => 'page',
				'post_content' => '',
			),
			true
		);
		if ( ! is_wp_error( $profile_id ) && $profile_id ) {
			update_post_meta( $profile_id, '_wp_page_template', 'page-templates/template-profile.php' );
		}
	} else {
		update_post_meta( $profile->ID, '_wp_page_template', 'page-templates/template-profile.php' );
	}

	update_option( 'olkil_setup_profile_v1', 1 );
}
add_action( 'admin_init', 'olkil_ensure_profile_page', 7 );
add_action( 'init', 'olkil_ensure_profile_page', 26 );
