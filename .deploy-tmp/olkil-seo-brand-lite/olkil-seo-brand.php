<?php
/**
 * Plugin Name: OLKIL SEO Brand
 * Description: Advanced OLKIL SEO + syncs Dazzlone pricing UI into the OLKIL theme.
 * Version: 1.3.9
 * Author: OLKIL
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'OLKIL_SEO_BRAND_NAME', 'OLKIL' );
define( 'OLKIL_SEO_BRAND_VERSION', '1.3.9' );
define( 'OLKIL_SEO_BRAND_DIR', plugin_dir_path( __FILE__ ) );
define( 'OLKIL_SEO_BRAND_URL', plugin_dir_url( __FILE__ ) );

/**
 * Sync pricing UI theme overrides into the active OLKIL theme.
 */
function olkil_seo_brand_sync_theme_files() {
	if ( get_option( 'olkil_seo_brand_theme_sync_v130' ) === OLKIL_SEO_BRAND_VERSION ) {
		return;
	}

	$theme_dir = trailingslashit( get_theme_root() ) . 'olkil';
	if ( ! is_dir( $theme_dir ) ) {
		return;
	}

	$map = array(
		'theme-overrides/template-parts/olkil/sections/hero.php'    => 'template-parts/olkil/sections/hero.php',
		'theme-overrides/template-parts/olkil/sections/demo.php'    => 'template-parts/olkil/sections/demo.php',
		'theme-overrides/front-page.php'                            => 'front-page.php',
		'theme-overrides/page.php'                                  => 'page.php',
		'theme-overrides/home.php'                                  => 'home.php',
		'theme-overrides/assets/olkil/js/olkil-account.js'          => 'assets/olkil/js/olkil-account.js',
		'theme-overrides/assets/olkil/js/olkil.js'                  => 'assets/olkil/js/olkil.js',
		'theme-overrides/assets/olkil/video/IDEdemo.mp4'            => 'assets/olkil/video/IDEdemo.mp4',
		'theme-overrides/template-parts/olkil/header.php'           => 'template-parts/olkil/header.php',
		'theme-overrides/template-parts/olkil/sections/blog.php'  => 'template-parts/olkil/sections/blog.php',
		'theme-overrides/template-parts/olkil/posts-loop.php'     => 'template-parts/olkil/posts-loop.php',
		'theme-overrides/template-parts/olkil/sections/pricing.php' => 'template-parts/olkil/sections/pricing.php',
		'theme-overrides/template-parts/olkil/sections/cta.php'     => 'template-parts/olkil/sections/cta.php',
		'theme-overrides/template-parts/olkil/footer.php'           => 'template-parts/olkil/footer.php',
		'theme-overrides/page-templates/template-pricing.php'       => 'page-templates/template-pricing.php',
		'theme-overrides/assets/olkil/css/olkil.css'                => 'assets/olkil/css/olkil.css',
		'theme-overrides/inc/olkil/olkil-branding.php'              => 'inc/olkil/olkil-branding.php',
	);

	$ok = true;
	foreach ( $map as $src_rel => $dest_rel ) {
		$src  = OLKIL_SEO_BRAND_DIR . $src_rel;
		$dest = trailingslashit( $theme_dir ) . $dest_rel;
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

	// Google crawls /favicon.ico first — overwrite tiny/default root icon.
	$brand_ico = OLKIL_SEO_BRAND_DIR . 'brand/favicon.ico';
	$brand_48  = OLKIL_SEO_BRAND_DIR . 'brand/favicon-48.png';
	if ( file_exists( $brand_ico ) ) {
		@copy( $brand_ico, ABSPATH . 'favicon.ico' );
	}
	if ( file_exists( $brand_48 ) ) {
		@copy( $brand_48, ABSPATH . 'favicon-48x48.png' );
		@copy( OLKIL_SEO_BRAND_DIR . 'brand/favicon-192.png', ABSPATH . 'favicon-192x192.png' );
	}

	if ( $ok ) {
		update_option( 'olkil_seo_brand_theme_sync_v130', OLKIL_SEO_BRAND_VERSION, false );
		if ( function_exists( 'opcache_reset' ) ) {
			@opcache_reset();
		}
	}
}
add_action( 'init', 'olkil_seo_brand_sync_theme_files', 3 );

/**
 * Brand asset URL helper.
 *
 * @param string $file File under brand/.
 * @return string
 */
function olkil_seo_brand_asset( $file ) {
	return OLKIL_SEO_BRAND_URL . 'brand/' . ltrim( $file, '/' );
}

/**
 * @return array<int, array<string, mixed>>
 */
function olkil_seo_brand_plans() {
	return array(
		array(
			'slug'     => 'dazzlone',
			'name'     => 'Dazzlone',
			'price'    => '0',
			'blurb'    => 'Start shipping with local AI.',
			'tokens'   => '',
			'features' => array( 'Free Local Models', 'Unlimited Browser Testing', 'Basic Autocomplete', 'Basic AI Chat', 'Basic Code Assistance' ),
		),
		array(
			'slug'     => 'lite',
			'name'     => 'Lite',
			'price'    => '249',
			'blurb'    => 'Everyday AI coding, unlocked.',
			'tokens'   => '100M',
			'requests' => '~3,500',
			'features' => array( '100M tokens / mo', '~3,500 approx requests', 'Unlimited Autocomplete', 'Unlimited Browser Testing', 'AI Coding Agent', 'Project Context' ),
		),
		array(
			'slug'     => 'pro',
			'name'     => 'Pro',
			'price'    => '849',
			'blurb'    => 'Full project power for builders.',
			'tokens'   => '350M',
			'requests' => '~12,180',
			'features' => array( '350M tokens / mo', '~12,180 approx requests', 'Unlimited Autocomplete', 'Unlimited Browser Testing', 'AI Coding Agent', 'Full Project Context' ),
		),
		array(
			'slug'     => 'max',
			'name'     => 'Max',
			'price'    => '2499',
			'blurb'    => 'Advanced agents. Priority speed.',
			'tokens'   => '1B',
			'requests' => '~34,230',
			'features' => array( '1B tokens / mo', '~34,230 approx requests', 'Unlimited Autocomplete', 'Unlimited Browser Testing', 'Advanced Agent', 'Large Context', 'Priority Compute' ),
		),
		array(
			'slug'     => 'ultra',
			'name'     => 'Ultra',
			'price'    => '4199',
			'blurb'    => 'Unlimited ceiling. Parallel agents.',
			'tokens'   => '2B',
			'requests' => '~68,460',
			'features' => array( '2B tokens / mo', '~68,460 approx requests', 'Unlimited Autocomplete', 'Unlimited Browser Testing', 'Unlimited Agent Usage', 'Maximum Context', 'Parallel Agents', 'Priority Compute' ),
		),
	);
}

function olkil_seo_brand_activate() {
	$opt = get_option( 'rank-math-options-titles', array() );
	if ( ! is_array( $opt ) ) {
		$opt = array();
	}
	$opt['website_name']        = OLKIL_SEO_BRAND_NAME;
	$opt['knowledgegraph_name'] = OLKIL_SEO_BRAND_NAME;
	update_option( 'rank-math-options-titles', $opt, false );
	update_option( 'blogname', OLKIL_SEO_BRAND_NAME );
	update_option( 'blogdescription', 'Free AI code editor & IDE — Dazzlone free, Lite 100M, Pro 350M, Max 1B, Ultra 2B tokens' );
	delete_option( 'olkil_seo_brand_theme_sync_v130' );
	olkil_seo_brand_sync_theme_files();
}
register_activation_hook( __FILE__, 'olkil_seo_brand_activate' );

function olkil_seo_brand_maybe_persist() {
	if ( get_option( 'olkil_seo_brand_persisted_v130' ) ) {
		return;
	}
	olkil_seo_brand_activate();
	update_option( 'olkil_seo_brand_persisted_v130', 1, false );
}
add_action( 'init', 'olkil_seo_brand_maybe_persist', 5 );

function olkil_seo_brand_disable_theme_seo() {
	remove_action( 'wp_head', 'olkil_seo_head', 1 );
}
add_action( 'wp_head', 'olkil_seo_brand_disable_theme_seo', 0 );

/**
 * Drop WordPress 32x32 site icons — Google requires multiples of 48px.
 */
function olkil_seo_brand_strip_small_site_icons() {
	remove_action( 'wp_head', 'wp_site_icon', 99 );
}
add_action( 'init', 'olkil_seo_brand_strip_small_site_icons', 20 );

/**
 * Emit Google-compliant favicon tags (48+ multiples) + brand meta.
 */
function olkil_seo_brand_favicon_head() {
	$icon_48  = olkil_seo_brand_asset( 'favicon-48.png' );
	$icon_96  = olkil_seo_brand_asset( 'favicon-96.png' );
	$icon_144 = olkil_seo_brand_asset( 'favicon-144.png' );
	$icon_192 = olkil_seo_brand_asset( 'favicon-192.png' );
	$icon_512 = olkil_seo_brand_asset( 'favicon-512.png' );
	$apple    = olkil_seo_brand_asset( 'apple-touch-icon.png' );
	$ico      = home_url( '/favicon.ico' );

	echo "\n<!-- OLKIL Favicon (Google 48px+) -->\n";
	echo '<link rel="icon" href="' . esc_url( $ico ) . '" sizes="any" />' . "\n";
	echo '<link rel="icon" type="image/png" sizes="48x48" href="' . esc_url( $icon_48 ) . '" />' . "\n";
	echo '<link rel="icon" type="image/png" sizes="96x96" href="' . esc_url( $icon_96 ) . '" />' . "\n";
	echo '<link rel="icon" type="image/png" sizes="192x192" href="' . esc_url( $icon_192 ) . '" />' . "\n";
	echo '<link rel="icon" type="image/png" sizes="512x512" href="' . esc_url( $icon_512 ) . '" />' . "\n";
	echo '<link rel="apple-touch-icon" sizes="180x180" href="' . esc_url( $apple ) . '" />' . "\n";
	echo '<link rel="shortcut icon" href="' . esc_url( $ico ) . '" />' . "\n";
	echo '<meta name="msapplication-TileImage" content="' . esc_url( $icon_144 ) . '" />' . "\n";
	echo '<meta name="msapplication-TileColor" content="#0a0a0b" />' . "\n";
}
add_action( 'wp_head', 'olkil_seo_brand_favicon_head', 2 );

function olkil_seo_brand_head() {
	$desc = 'OLKIL is a free AI code editor and AI IDE with multi-model AI, agents, autocomplete, unlimited browser testing, and chat. Plans (INR): Dazzlone free, Lite ₹249 (100M tokens), Pro ₹849 (350M), Max ₹2499 (1B), Ultra ₹4199 (2B). Windows, macOS, and Linux.';
	$url  = is_singular() ? get_permalink() : home_url( '/' );
	$logo = olkil_seo_brand_asset( 'favicon-512.png' );

	echo "\n<!-- OLKIL SEO Brand " . esc_html( OLKIL_SEO_BRAND_VERSION ) . " -->\n";
	echo '<meta name="theme-color" content="#0a0a0b" />' . "\n";
	echo '<meta name="application-name" content="OLKIL" />' . "\n";
	echo '<meta name="apple-mobile-web-app-title" content="OLKIL" />' . "\n";

	$offers = array();
	foreach ( olkil_seo_brand_plans() as $plan ) {
		$token_bit = ! empty( $plan['tokens'] ) ? ( $plan['tokens'] . ' tokens/mo, ' . ( $plan['requests'] ?? '' ) . ' requests. ' ) : '';
		$offers[]  = array(
			'@type'         => 'Offer',
			'name'          => 'OLKIL ' . $plan['name'],
			'price'         => $plan['price'],
			'priceCurrency' => 'INR',
			'url'           => home_url( '/pricing/#plan-' . $plan['slug'] ),
			'availability'  => 'https://schema.org/InStock',
			'category'      => $plan['name'],
			'description'   => trim( $token_bit . $plan['blurb'] . ' ' . implode( ', ', $plan['features'] ) ),
		);
	}

	$org = array(
		'@context' => 'https://schema.org',
		'@type'    => 'Organization',
		'@id'      => 'https://olkil.com/#organization',
		'name'     => 'OLKIL',
		'url'      => 'https://olkil.com',
		'logo'     => array(
			'@type'  => 'ImageObject',
			'@id'    => 'https://olkil.com/#logo',
			'url'    => $logo,
			'width'  => 512,
			'height' => 512,
			'caption'=> 'OLKIL',
		),
		'image'    => $logo,
		'sameAs'   => array(
			'https://olkil.com',
		),
	);
	echo '<script type="application/ld+json">' . wp_json_encode( $org, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE ) . '</script>' . "\n";

	$website = array(
		'@context'        => 'https://schema.org',
		'@type'           => 'WebSite',
		'@id'             => 'https://olkil.com/#website',
		'name'            => 'OLKIL',
		'url'             => 'https://olkil.com',
		'publisher'       => array( '@id' => 'https://olkil.com/#organization' ),
		'potentialAction' => array(
			'@type'       => 'SearchAction',
			'target'      => home_url( '/?s={search_term_string}' ),
			'query-input' => 'required name=search_term_string',
		),
	);
	echo '<script type="application/ld+json">' . wp_json_encode( $website, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE ) . '</script>' . "\n";

	$software = array(
		'@context'            => 'https://schema.org',
		'@type'               => 'SoftwareApplication',
		'name'                => 'OLKIL',
		'applicationCategory' => 'DeveloperApplication',
		'operatingSystem'     => 'Windows, macOS, Linux',
		'url'                 => 'https://olkil.com',
		'downloadUrl'         => home_url( '/download/' ),
		'description'         => $desc,
		'image'               => $logo,
		'offers'              => $offers,
		'publisher'           => array( '@id' => 'https://olkil.com/#organization' ),
		'featureList'         => array( 'AI Agents', 'Smart Autocomplete', 'Multi-model Chat', 'Unlimited Browser Testing', 'Full IDE', 'Local Models' ),
	);
	echo '<script type="application/ld+json">' . wp_json_encode( $software, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE ) . '</script>' . "\n";

	echo '<script type="application/ld+json">' . wp_json_encode(
		array(
			'@context'        => 'https://schema.org',
			'@type'           => 'OfferCatalog',
			'name'            => 'OLKIL Pricing Plans',
			'url'             => home_url( '/pricing/' ),
			'itemListElement' => $offers,
		),
		JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
	) . '</script>' . "\n";

	echo '<script type="application/ld+json">' . wp_json_encode(
		array(
			'@context'   => 'https://schema.org',
			'@type'      => 'FAQPage',
			'mainEntity' => array(
				array(
					'@type'          => 'Question',
					'name'           => 'Is OLKIL free?',
					'acceptedAnswer' => array(
						'@type' => 'Answer',
						'text'  => 'Yes. OLKIL Dazzlone is free forever with local models, unlimited browser testing, basic autocomplete, AI chat, and code assistance. Paid plans start at ₹249/mo.',
					),
				),
				array(
					'@type'          => 'Question',
					'name'           => 'How many tokens do OLKIL plans include?',
					'acceptedAnswer' => array(
						'@type' => 'Answer',
						'text'  => 'Lite (₹249) includes 100M tokens (~3,500 requests). Pro (₹849) includes 350M tokens (~12,180). Max (₹2499) includes 1B tokens (~34,230). Ultra (₹4199) includes 2B tokens (~68,460). All plans include Unlimited Browser Testing. Prices in INR.',
					),
				),
				array(
					'@type'          => 'Question',
					'name'           => 'What is the difference between Pro, Max, and Ultra?',
					'acceptedAnswer' => array(
						'@type' => 'Answer',
						'text'  => 'Pro (₹849 · 350M tokens) includes unlimited autocomplete, unlimited browser testing, AI coding agent, and full project context. Max (₹2499 · 1B tokens) adds Advanced Agent, large context, and priority compute. Ultra (₹4199 · 2B tokens) adds unlimited agent usage, maximum context, and parallel agents.',
					),
				),
				array(
					'@type'          => 'Question',
					'name'           => 'Which platforms does OLKIL support?',
					'acceptedAnswer' => array(
						'@type' => 'Answer',
						'text'  => 'OLKIL runs on Windows, macOS, and Linux.',
					),
				),
				array(
					'@type'          => 'Question',
					'name'           => 'Is OLKIL a Cursor alternative?',
					'acceptedAnswer' => array(
						'@type' => 'Answer',
						'text'  => 'OLKIL is a free AI code editor and IDE with agents, autocomplete, multi-model chat, and unlimited browser testing — a powerful Cursor AI alternative.',
					),
				),
			),
		),
		JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
	) . '</script>' . "\n";

	$crumbs = array(
		'@context'        => 'https://schema.org',
		'@type'           => 'BreadcrumbList',
		'itemListElement' => array(
			array(
				'@type'    => 'ListItem',
				'position' => 1,
				'name'     => 'Home',
				'item'     => 'https://olkil.com/',
			),
		),
	);
	if ( is_page( 'pricing' ) ) {
		$crumbs['itemListElement'][] = array(
			'@type'    => 'ListItem',
			'position' => 2,
			'name'     => 'Pricing',
			'item'     => home_url( '/pricing/' ),
		);
	} elseif ( is_singular( 'post' ) ) {
		$crumbs['itemListElement'][] = array(
			'@type'    => 'ListItem',
			'position' => 2,
			'name'     => 'Blog',
			'item'     => home_url( '/blog/' ),
		);
		$crumbs['itemListElement'][] = array(
			'@type'    => 'ListItem',
			'position' => 3,
			'name'     => wp_strip_all_tags( get_the_title() ),
			'item'     => get_permalink(),
		);
	} elseif ( ! is_front_page() && is_singular() ) {
		$crumbs['itemListElement'][] = array(
			'@type'    => 'ListItem',
			'position' => 2,
			'name'     => wp_strip_all_tags( get_the_title() ),
			'item'     => $url,
		);
	}
	echo '<script type="application/ld+json">' . wp_json_encode( $crumbs, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE ) . '</script>' . "\n";
}
add_action( 'wp_head', 'olkil_seo_brand_head', 1 );

function olkil_seo_brand_rm_name( $value ) {
	return OLKIL_SEO_BRAND_NAME;
}
add_filter( 'rank_math/settings/titles/website_name', 'olkil_seo_brand_rm_name' );
add_filter( 'rank_math/settings/titles/knowledgegraph_name', 'olkil_seo_brand_rm_name' );
add_filter( 'rank_math/opengraph/facebook/og_site_name', 'olkil_seo_brand_rm_name' );
add_filter( 'rank_math/opengraph/facebook/site_name', 'olkil_seo_brand_rm_name' );

function olkil_seo_brand_titles_option( $value ) {
	if ( ! is_array( $value ) ) {
		return $value;
	}
	$value['website_name']        = OLKIL_SEO_BRAND_NAME;
	$value['knowledgegraph_name'] = OLKIL_SEO_BRAND_NAME;
	return $value;
}
add_filter( 'option_rank-math-options-titles', 'olkil_seo_brand_titles_option' );

function olkil_seo_brand_document_title( $title ) {
	if ( is_front_page() ) {
		return 'OLKIL AI Code Editor – Free AI IDE with Multi-Model AI';
	}
	if ( is_page( 'pricing' ) ) {
		return 'OLKIL Pricing – Dazzlone Free, Lite 100M, Pro 350M, Max 1B, Ultra 2B';
	}
	return $title;
}
add_filter( 'pre_get_document_title', 'olkil_seo_brand_document_title', 20 );

function olkil_seo_brand_json_ld( $data, $jsonld = null ) {
	if ( ! is_array( $data ) ) {
		return $data;
	}
	$fix_entity = static function ( &$entity ) {
		if ( ! is_array( $entity ) ) {
			return;
		}
		$types      = isset( $entity['@type'] ) ? (array) $entity['@type'] : array();
		$is_org     = in_array( 'Organization', $types, true ) || in_array( 'Corporation', $types, true );
		$is_website = in_array( 'WebSite', $types, true );
		if ( ! $is_org && ! $is_website ) {
			return;
		}
		$entity['name'] = OLKIL_SEO_BRAND_NAME;
		unset( $entity['alternateName'] );
		if ( isset( $entity['logo']['caption'] ) ) {
			$entity['logo']['caption'] = OLKIL_SEO_BRAND_NAME;
		}
	};
	if ( isset( $data['@graph'] ) && is_array( $data['@graph'] ) ) {
		foreach ( $data['@graph'] as &$node ) {
			$fix_entity( $node );
		}
		unset( $node );
		return $data;
	}
	$fix_entity( $data );
	return $data;
}
add_filter( 'rank_math/json_ld', 'olkil_seo_brand_json_ld', 99, 2 );
