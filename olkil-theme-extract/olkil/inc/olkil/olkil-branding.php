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

define( 'OLKIL_VERSION', '1.6.2' );
/** Desktop installer version (matches ide-electron/product.json). */
define( 'OLKIL_APP_VERSION', '1.3.26' );
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
 * Installers are served from Hostinger /downloads/ (GitHub repo is private).
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
 * Product submenu: slug => nav label.
 *
 * @return array<string, string>
 */
function olkil_product_nav_items() {
	return array(
		'desktop'      => __( 'Desktop', 'olkil' ),
		'community'    => __( 'OLKIL Community', 'olkil' ),
		'cloud'        => __( 'Cloud', 'olkil' ),
		'live-test'    => __( 'Live Test', 'olkil' ),
		'cli'          => __( 'CLI', 'olkil' ),
		'autocomplete' => __( 'Autocomplete', 'olkil' ),
		'marketplace'  => __( 'Marketplace', 'olkil' ),
	);
}

/**
 * Product landing copy keyed by slug.
 *
 * @return array<string, array<string, mixed>>
 */
function olkil_product_catalog() {
	$download = olkil_page_url( 'download' );
	$pricing  = olkil_page_url( 'pricing' );
	$cli      = olkil_page_url( 'cli' );

	return array(
		'desktop'      => array(
			'eyebrow'  => __( 'Product · Desktop', 'olkil' ),
			'title'    => __( 'The OLKIL IDE on your machine.', 'olkil' ),
			'lead'     => __( 'A full editor — agents, autocomplete, terminal, Git, and debugging — free on Windows, macOS, and Linux. Same account as the CLI.', 'olkil' ),
			'cta'      => array(
				'label' => __( 'Download free', 'olkil' ),
				'url'   => $download,
			),
			'cta2'     => array(
				'label' => __( 'See plans', 'olkil' ),
				'url'   => $pricing,
			),
			'points'   => array(
				array(
					'icon'  => '⬡',
					'title' => __( 'Full IDE', 'olkil' ),
					'desc'  => __( 'Extensions, terminal, Git, and debugging. A complete workspace, not a thin wrapper.', 'olkil' ),
				),
				array(
					'icon'  => '⌘',
					'title' => __( 'Agents in the editor', 'olkil' ),
					'desc'  => __( 'Hand off multi-step tasks. OLKIL plans, edits, and iterates while you stay in control.', 'olkil' ),
				),
				array(
					'icon'  => '∇',
					'title' => __( 'Windows, macOS, Linux', 'olkil' ),
					'desc'  => __( 'One free experience everywhere. We highlight the installer that matches your OS.', 'olkil' ),
				),
				array(
					'icon'  => '◎',
					'title' => __( 'Same account everywhere', 'olkil' ),
					'desc'  => __( 'Sign in with Google. Desktop and CLI share your plan, quota, and workspace trust.', 'olkil' ),
				),
			),
			'steps'    => array(
				array( __( 'Download', 'olkil' ), __( 'Install the build for your OS. No account required to open the app.', 'olkil' ) ),
				array( __( 'Sign in', 'olkil' ), __( 'Continue with Google. Dazzlone is free; Lite, Pro, and Ultra unlock cloud tokens.', 'olkil' ) ),
				array( __( 'Ship', 'olkil' ), __( 'Open a folder, pick a model, and let the agent work beside you.', 'olkil' ) ),
			),
		),
		'agents'       => array(
			'eyebrow'  => __( 'Product · Agents', 'olkil' ),
			'title'    => __( 'Agents that plan, edit, and iterate.', 'olkil' ),
			'lead'     => __( 'Describe the outcome. OLKIL breaks it into steps, touches the right files, and keeps you in the loop — in the desktop app or the CLI.', 'olkil' ),
			'cta'      => array(
				'label' => __( 'Download free', 'olkil' ),
				'url'   => $download,
			),
			'cta2'     => array(
				'label' => __( 'Cloud plans', 'olkil' ),
				'url'   => $pricing,
			),
			'points'   => array(
				array(
					'icon'  => '⌘',
					'title' => __( 'Multi-step work', 'olkil' ),
					'desc'  => __( 'Refactors, features, and fixes that span files — not one-shot completions.', 'olkil' ),
				),
				array(
					'icon'  => '◈',
					'title' => __( 'You stay in control', 'olkil' ),
					'desc'  => __( 'Review diffs, steer the next step, or take over. The agent never replaces your judgment.', 'olkil' ),
				),
				array(
					'icon'  => '✦',
					'title' => __( 'Project context', 'olkil' ),
					'desc'  => __( 'The agent reads the repo you trust — structure, conventions, and the files that matter.', 'olkil' ),
				),
				array(
					'icon'  => '⬡',
					'title' => __( 'Parallel on Ultra', 'olkil' ),
					'desc'  => __( 'Ultra unlocks parallel agents and priority compute when you need more than one thread.', 'olkil' ),
				),
			),
			'steps'    => array(
				array( __( 'Trust a folder', 'olkil' ), __( 'Same workspace trust as the CLI. The agent only works where you allow it.', 'olkil' ) ),
				array( __( 'Pick a model', 'olkil' ), __( 'Local models on Dazzlone. Cloud models on Lite, Pro, and Ultra.', 'olkil' ) ),
				array( __( 'Hand off the task', 'olkil' ), __( 'Describe what you want shipped. Watch the plan, then the edits.', 'olkil' ) ),
			),
		),
		'community'    => array(
			'eyebrow'     => __( 'Product · Community', 'olkil' ),
			'title'       => __( 'The official OLKIL Community.', 'olkil' ),
			'lead'        => __( 'Ask questions, get help, share what you ship, request features, and follow announcements — discussions, support, and ideas in one place.', 'olkil' ),
			'cta'         => array(
				'label'    => __( 'Open OLKIL Community', 'olkil' ),
				'url'      => 'https://forum.olkil.com/',
				'external' => true,
			),
			'preview'     => array(
				'src' => 'assets/olkil/img/community.png',
				'alt' => __( 'OLKIL Community forum — discussions, announcements, help, and ideas', 'olkil' ),
				'url' => 'https://forum.olkil.com/',
			),
			'points'      => array(
				array(
					'icon'  => '◆',
					'title' => __( 'Discussions', 'olkil' ),
					'desc'  => __( 'Talk through CLI, desktop, and workflow questions with other people using OLKIL.', 'olkil' ),
				),
				array(
					'icon'  => '◎',
					'title' => __( 'Help & Support', 'olkil' ),
					'desc'  => __( 'Stuck on install, login, or a plan? Post it. The community and the team are there.', 'olkil' ),
				),
				array(
					'icon'  => '✦',
					'title' => __( 'Ideas', 'olkil' ),
					'desc'  => __( 'Request features and vote on what should land next in the IDE and the CLI.', 'olkil' ),
				),
				array(
					'icon'  => '⌘',
					'title' => __( 'Announcements', 'olkil' ),
					'desc'  => __( 'Product updates, CLI releases, and what is new — posted by the OLKIL team.', 'olkil' ),
				),
			),
			'steps'       => array(
				array( __( 'Open the forum', 'olkil' ), __( 'Join at forum.olkil.com. Sign up takes a moment.', 'olkil' ) ),
				array( __( 'Pick a category', 'olkil' ), __( 'Discussions, Help & Support, Ideas, or Announcements.', 'olkil' ) ),
				array( __( 'Start a thread', 'olkil' ), __( 'Ask, share a build, or request a feature. The community is public.', 'olkil' ) ),
			),
		),
		'cloud'        => array(
			'eyebrow'  => __( 'Product · Cloud', 'olkil' ),
			'title'    => __( 'Cloud models. One quota. Desktop and CLI.', 'olkil' ),
			'lead'     => __( 'Lite, Pro, and Ultra add cloud tokens on top of the free local Dazzlone plan. Sign in once — the same wallet follows you from the IDE to the terminal.', 'olkil' ),
			'cta'      => array(
				'label' => __( 'Compare plans', 'olkil' ),
				'url'   => $pricing,
			),
			'cta2'     => array(
				'label' => __( 'Download free', 'olkil' ),
				'url'   => $download,
			),
			'points'   => array(
				array(
					'icon'  => '◈',
					'title' => __( 'Shared quota', 'olkil' ),
					'desc'  => __( 'Tokens are on your OLKIL account. Use them in the desktop agent or run olkil in a project folder.', 'olkil' ),
				),
				array(
					'icon'  => '✦',
					'title' => __( 'Clear plans', 'olkil' ),
					'desc'  => __( 'Lite $3, Pro $10, Ultra $49 / month. Prices in USD. Cancel anytime.', 'olkil' ),
				),
				array(
					'icon'  => '◎',
					'title' => __( 'Dazzlone stays free', 'olkil' ),
					'desc'  => __( 'Local models and unlimited browser testing do not require a paid plan.', 'olkil' ),
				),
				array(
					'icon'  => '⌘',
					'title' => __( 'Priority on Ultra', 'olkil' ),
					'desc'  => __( 'Maximum context, parallel agents, and priority compute when you are shipping hard.', 'olkil' ),
				),
			),
			'steps'    => array(
				array( __( 'Start free', 'olkil' ), __( 'Download OLKIL and sign in. Dazzlone is enough to learn the workflow.', 'olkil' ) ),
				array( __( 'Upgrade when you need tokens', 'olkil' ), __( 'Pick Lite, Pro, or Ultra from Pricing. Checkout is in USD.', 'olkil' ) ),
				array( __( 'Use it anywhere', 'olkil' ), __( 'The same Google account powers the IDE and the CLI.', 'olkil' ) ),
			),
		),
		'live-test'    => array(
			'eyebrow'  => __( 'Product · Live Test', 'olkil' ),
			'title'    => __( 'Test in a real browser, inside the IDE.', 'olkil' ),
			'lead'     => __( 'Unlimited browser testing on every plan — including Dazzlone free. Click through flows, catch layout bugs, and keep shipping without leaving OLKIL.', 'olkil' ),
			'cta'      => array(
				'label' => __( 'Download free', 'olkil' ),
				'url'   => $download,
			),
			'cta2'     => array(
				'label' => __( 'See plans', 'olkil' ),
				'url'   => $pricing,
			),
			'points'   => array(
				array(
					'icon'  => '◎',
					'title' => __( 'Unlimited on every plan', 'olkil' ),
					'desc'  => __( 'Live Test is not a paid extra. Free, Lite, Pro, and Ultra all include unlimited browser testing.', 'olkil' ),
				),
				array(
					'icon'  => '⌘',
					'title' => __( 'Beside the agent', 'olkil' ),
					'desc'  => __( 'The agent can build the UI; you verify it in a live browser without switching tools.', 'olkil' ),
				),
				array(
					'icon'  => '⬡',
					'title' => __( 'Real pages, real clicks', 'olkil' ),
					'desc'  => __( 'Exercise the flow you just shipped — not a screenshot of it.', 'olkil' ),
				),
				array(
					'icon'  => '∇',
					'title' => __( 'Stays on your machine', 'olkil' ),
					'desc'  => __( 'Testing runs with the desktop app. You choose what leaves the workspace.', 'olkil' ),
				),
			),
			'steps'    => array(
				array( __( 'Install the desktop app', 'olkil' ), __( 'Live Test lives in the IDE. Download for your OS.', 'olkil' ) ),
				array( __( 'Open your project', 'olkil' ), __( 'Trust the folder, start a local server or open a URL.', 'olkil' ) ),
				array( __( 'Click through', 'olkil' ), __( 'Verify the UI, then send the next task back to the agent.', 'olkil' ) ),
			),
		),
		'autocomplete' => array(
			'eyebrow'  => __( 'Product · Autocomplete', 'olkil' ),
			'title'    => __( 'Suggestions that feel native.', 'olkil' ),
			'lead'     => __( 'Context-aware completions as you type. Basic on Dazzlone, unlimited on Lite, Pro, and Ultra — always inside the editor, never a separate chat window.', 'olkil' ),
			'cta'      => array(
				'label' => __( 'Download free', 'olkil' ),
				'url'   => $download,
			),
			'cta2'     => array(
				'label' => __( 'Compare plans', 'olkil' ),
				'url'   => $pricing,
			),
			'points'   => array(
				array(
					'icon'  => '✦',
					'title' => __( 'In the flow', 'olkil' ),
					'desc'  => __( 'Gray-text suggestions where you are typing. Tab to accept, keep moving.', 'olkil' ),
				),
				array(
					'icon'  => '◈',
					'title' => __( 'Project-aware', 'olkil' ),
					'desc'  => __( 'Uses nearby files and the patterns already in your repo — not generic snippets.', 'olkil' ),
				),
				array(
					'icon'  => '⌘',
					'title' => __( 'Pairs with agents', 'olkil' ),
					'desc'  => __( 'Complete the line yourself, or hand the whole feature to an agent. Same IDE.', 'olkil' ),
				),
				array(
					'icon'  => '⬡',
					'title' => __( 'Unlimited on paid plans', 'olkil' ),
					'desc'  => __( 'Dazzlone includes basic autocomplete. Lite, Pro, and Ultra remove the cap.', 'olkil' ),
				),
			),
			'steps'    => array(
				array( __( 'Install OLKIL', 'olkil' ), __( 'Autocomplete ships in the desktop IDE.', 'olkil' ) ),
				array( __( 'Open a file', 'olkil' ), __( 'Start typing. Accept a suggestion, or keep writing.', 'olkil' ) ),
				array( __( 'Upgrade if you outgrow free', 'olkil' ), __( 'Unlimited autocomplete starts at Lite.', 'olkil' ) ),
			),
		),
		'marketplace'  => array(
			'eyebrow'  => __( 'Product · Marketplace', 'olkil' ),
			'title'    => __( 'A full IDE, including extensions.', 'olkil' ),
			'lead'     => __( 'OLKIL is not a thin chat wrapper. Use the extension ecosystem you already know, plus OLKIL agents, autocomplete, and Live Test in the same window.', 'olkil' ),
			'cta'      => array(
				'label' => __( 'Download free', 'olkil' ),
				'url'   => $download,
			),
			'cta2'     => array(
				'label' => __( 'Browse features', 'olkil' ),
				'url'   => olkil_page_url( 'features' ),
			),
			'points'   => array(
				array(
					'icon'  => '⬡',
					'title' => __( 'Extensions', 'olkil' ),
					'desc'  => __( 'Language tools, themes, linters, and the rest of a real editor — install what your stack needs.', 'olkil' ),
				),
				array(
					'icon'  => '✦',
					'title' => __( 'Themes and keybindings', 'olkil' ),
					'desc'  => __( 'Make the IDE yours. OLKIL branding stays pink; your editor does not have to.', 'olkil' ),
				),
				array(
					'icon'  => '⌘',
					'title' => __( 'Agents on top', 'olkil' ),
					'desc'  => __( 'Extensions handle languages. OLKIL handles the agent, autocomplete, and Live Test.', 'olkil' ),
				),
				array(
					'icon'  => '∇',
					'title' => __( 'Growing catalog', 'olkil' ),
					'desc'  => __( 'More OLKIL-native extensions and listings as the product grows. The IDE is ready today.', 'olkil' ),
				),
			),
			'steps'    => array(
				array( __( 'Install the desktop app', 'olkil' ), __( 'Marketplace and extensions live in the IDE.', 'olkil' ) ),
				array( __( 'Add what you need', 'olkil' ), __( 'Languages, formatters, themes — same workflow as a full editor.', 'olkil' ) ),
				array( __( 'Keep OLKIL on', 'olkil' ), __( 'Agents and autocomplete stay available next to your extensions.', 'olkil' ) ),
			),
		),
		'cli'          => array(
			'eyebrow'  => __( 'Product · CLI', 'olkil' ),
			'title'    => __( 'OLKIL in your terminal.', 'olkil' ),
			'lead'     => __( 'Install once. Run olkil. Sign in with Google. Pick a model. The agent works in the folder you trust.', 'olkil' ),
			'cta'      => array(
				'label' => __( 'Install the CLI', 'olkil' ),
				'url'   => $cli,
			),
			'cta2'     => array(
				'label' => __( 'Download the IDE', 'olkil' ),
				'url'   => $download,
			),
			'points'   => array(),
			'steps'    => array(),
		),
	);
}

/**
 * True when the current request is a Product landing page.
 */
function olkil_is_product_page() {
	return is_page( array_keys( olkil_product_nav_items() ) );
}

/**
 * Critical Product dropdown CSS — beats Astra list/button resets even if olkil.css is cached.
 */
function olkil_product_nav_inline_css() {
	return <<<'CSS'
body.olkil-theme header.olkil-header{overflow:visible!important;height:auto!important;min-height:var(--olkil-header-h,64px)!important;background:var(--olkil-header-bg,rgba(5,5,6,.72))!important}
body.olkil-theme .olkil-header__inner{overflow:visible!important;align-items:center}
body.olkil-theme .olkil-nav-list{list-style:none!important;margin:0!important;padding:0!important}
body.olkil-theme .olkil-nav-item--has-sub{position:relative!important}
body.olkil-theme header.olkil-header button.olkil-nav-trigger{-webkit-appearance:none!important;appearance:none!important;background:transparent!important;background-color:transparent!important;border:0!important;box-shadow:none!important;padding:0.35rem 0!important;min-height:0!important;color:var(--olkil-text-muted,#a1a1aa)!important;font:inherit!important;font-size:.9rem!important;font-weight:500!important;cursor:pointer!important;display:inline-flex!important;align-items:center!important;gap:.35rem}
body.olkil-theme header.olkil-header button.olkil-nav-trigger:hover,
body.olkil-theme .olkil-nav-item--has-sub.is-open>button.olkil-nav-trigger,
body.olkil-theme .olkil-nav-item--has-sub:hover>button.olkil-nav-trigger{color:var(--olkil-heading,#fff)!important}
body.olkil-theme .olkil-product-dropdown{position:absolute!important;top:calc(100% + 10px)!important;left:0!important;z-index:200!important;min-width:200px;margin:0!important;padding:.45rem!important;display:none!important;grid-template-columns:1fr;gap:.12rem;list-style:none!important;border-radius:12px;border:1px solid var(--olkil-border,rgba(255,255,255,.08));background:var(--olkil-bg-card,#111114)!important;box-shadow:0 16px 48px rgba(0,0,0,.45)}
body.olkil-theme .olkil-product-dropdown::before{content:"";position:absolute;top:-12px;left:0;right:0;height:12px}
body.olkil-theme .olkil-nav-item--has-sub:hover>.olkil-product-dropdown,
body.olkil-theme .olkil-nav-item--has-sub:focus-within>.olkil-product-dropdown,
body.olkil-theme .olkil-nav-item--has-sub.is-open>.olkil-product-dropdown{display:grid!important}
body.olkil-theme .olkil-product-dropdown a{display:block!important;padding:.55rem .75rem!important;border-radius:8px;color:var(--olkil-text,#e4e4e7)!important;font-size:.88rem!important;font-weight:500!important;text-decoration:none!important;background:transparent!important}
body.olkil-theme .olkil-product-dropdown a:hover{background:var(--olkil-bg-hover,#18181c)!important;color:var(--olkil-heading,#fff)!important}
@media(max-width:860px){
body.olkil-theme .olkil-product-dropdown{position:static!important;top:auto!important;min-width:0;box-shadow:none;border:0;background:transparent!important;padding:.35rem 0 0 .75rem!important;display:none!important}
body.olkil-theme .olkil-nav-item--has-sub.is-open>.olkil-product-dropdown{display:grid!important}
body.olkil-theme .olkil-nav-item--has-sub:hover>.olkil-product-dropdown{display:none!important}
body.olkil-theme .olkil-nav-item--has-sub.is-open:hover>.olkil-product-dropdown{display:grid!important}
}
CSS;
}

/**
 * Apply saved theme before paint to avoid a flash.
 */
function olkil_theme_boot_script() {
	echo '<script>(function(){try{var k="olkil-theme";var p=localStorage.getItem(k)||"dark";var r=p;if(p==="system"){r=(window.matchMedia&&matchMedia("(prefers-color-scheme: light)").matches)?"light":"dark"}document.documentElement.setAttribute("data-olkil-theme",r);document.documentElement.setAttribute("data-olkil-theme-pref",p);}catch(e){document.documentElement.setAttribute("data-olkil-theme","dark");document.documentElement.setAttribute("data-olkil-theme-pref","dark");}})();</script>' . "\n";
}
add_action( 'wp_head', 'olkil_theme_boot_script', 0 );

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
	wp_add_inline_style( 'olkil-main', olkil_product_nav_inline_css() );

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

/**
 * Ensure /cli/ page exists (Product → CLI).
 */
function olkil_ensure_cli_page() {
	if ( get_option( 'olkil_setup_cli_v1' ) ) {
		return;
	}

	$cli = get_page_by_path( 'cli' );
	if ( ! $cli ) {
		$cli_id = wp_insert_post(
			array(
				'post_title'   => 'CLI',
				'post_name'    => 'cli',
				'post_status'  => 'publish',
				'post_type'    => 'page',
				'post_content' => '',
			),
			true
		);
		if ( ! is_wp_error( $cli_id ) && $cli_id ) {
			update_post_meta( $cli_id, '_wp_page_template', 'page-templates/template-cli.php' );
		}
	} else {
		update_post_meta( $cli->ID, '_wp_page_template', 'page-templates/template-cli.php' );
	}

	update_option( 'olkil_setup_cli_v1', 1 );
}
add_action( 'admin_init', 'olkil_ensure_cli_page', 8 );
add_action( 'init', 'olkil_ensure_cli_page', 27 );

/**
 * Ensure Product landing pages exist (Desktop, Community, Cloud, …).
 */
function olkil_ensure_product_pages() {
	if ( get_option( 'olkil_setup_product_pages_v2' ) ) {
		return;
	}

	foreach ( olkil_product_nav_items() as $slug => $title ) {
		if ( 'cli' === $slug ) {
			continue;
		}
		$existing = get_page_by_path( $slug );
		$template = 'page-templates/template-product.php';
		if ( $existing ) {
			update_post_meta( $existing->ID, '_wp_page_template', $template );
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
				'post_title'   => $title,
				'post_name'    => $slug,
				'post_status'  => 'publish',
				'post_type'    => 'page',
				'post_content' => '',
			),
			true
		);
		if ( ! is_wp_error( $page_id ) && $page_id ) {
			update_post_meta( $page_id, '_wp_page_template', $template );
		}
	}

	update_option( 'olkil_setup_product_pages_v2', 1 );
}
add_action( 'admin_init', 'olkil_ensure_product_pages', 9 );
add_action( 'init', 'olkil_ensure_product_pages', 28 );
