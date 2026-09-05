<?php
/**
 * OLKIL header
 *
 * @package Astra
 */
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}
$login_url   = olkil_page_url( 'login' );
$profile_url = olkil_page_url( 'profile' );
?>
<header class="olkil-header" role="banner">
	<div class="olkil-header__inner">
		<a class="olkil-logo" href="<?php echo esc_url( home_url( '/' ) ); ?>" aria-label="OLKIL home">
			<img class="olkil-logo__img" src="<?php echo esc_url( OLKIL_URI . 'assets/olkil/img/logo-mark.png' ); ?>" width="32" height="32" alt="" decoding="async" />
			<span>OLKIL</span>
		</a>

		<button class="olkil-menu-toggle" type="button" aria-label="<?php esc_attr_e( 'Open menu', 'astra' ); ?>" aria-expanded="false" aria-controls="olkil-primary-nav">
			<span></span>
		</button>

		<nav class="olkil-nav" id="olkil-primary-nav" aria-label="<?php esc_attr_e( 'Primary', 'astra' ); ?>">
			<ul class="olkil-nav-list">
				<li class="olkil-nav-item olkil-nav-item--has-sub<?php echo olkil_is_product_page() ? ' current-menu-item' : ''; ?>">
					<button type="button" class="olkil-nav-trigger" aria-expanded="false" aria-haspopup="true" aria-controls="olkil-product-menu">
						<?php esc_html_e( 'Product', 'olkil' ); ?>
						<span class="olkil-nav-caret" aria-hidden="true"></span>
					</button>
					<div class="olkil-product-dropdown" id="olkil-product-menu" role="menu">
						<?php foreach ( olkil_product_nav_items() as $item_slug => $label ) : ?>
							<a role="menuitem" href="<?php echo esc_url( olkil_page_url( $item_slug ) ); ?>"><?php echo esc_html( $label ); ?></a>
						<?php endforeach; ?>
					</div>
				</li>
				<li class="<?php echo is_page( 'features' ) ? 'current-menu-item' : ''; ?>">
					<a href="<?php echo esc_url( olkil_page_url( 'features' ) ); ?>"><?php esc_html_e( 'Features', 'olkil' ); ?></a>
				</li>
				<li class="<?php echo is_page( 'pricing' ) ? 'current-menu-item' : ''; ?>">
					<a href="<?php echo esc_url( olkil_page_url( 'pricing' ) ); ?>"><?php esc_html_e( 'Pricing', 'olkil' ); ?></a>
				</li>
				<li class="<?php echo ( is_home() || is_singular( 'post' ) || is_page( 'blog' ) ) ? 'current-menu-item' : ''; ?>">
					<a href="<?php echo esc_url( olkil_blog_url() ); ?>"><?php esc_html_e( 'Blog', 'olkil' ); ?></a>
				</li>
				<li class="<?php echo is_page( 'download' ) ? 'current-menu-item' : ''; ?>">
					<a href="<?php echo esc_url( olkil_page_url( 'download' ) ); ?>"><?php esc_html_e( 'Download', 'olkil' ); ?></a>
				</li>
			</ul>
		</nav>

		<div class="olkil-header__actions">
			<a class="olkil-btn olkil-btn--ghost olkil-header__pricing" href="<?php echo esc_url( olkil_page_url( 'pricing' ) ); ?>"><?php esc_html_e( 'Pricing', 'astra' ); ?></a>
			<a class="olkil-btn olkil-btn--primary" data-olkil-download="auto" href="<?php echo esc_url( olkil_page_url( 'download' ) ); ?>">
				<span class="olkil-btn-label"><?php esc_html_e( 'Download', 'astra' ); ?></span>
			</a>

			<!-- Account: guest -->
			<div class="olkil-account" id="olkil-account-guest">
				<a class="olkil-btn olkil-btn--ghost olkil-account__signin" data-olkil-signin href="<?php echo esc_url( $login_url ); ?>">
					<?php esc_html_e( 'Sign in', 'olkil' ); ?>
				</a>
			</div>

			<!-- Account: signed in (filled by olkil-account.js) -->
			<div class="olkil-account olkil-account--authed" id="olkil-account-authed" hidden>
				<button type="button" class="olkil-account__toggle" id="olkil-account-toggle" aria-expanded="false" aria-haspopup="true" aria-controls="olkil-account-menu">
					<span class="olkil-account__avatar" aria-hidden="true">
						<img id="olkil-account-avatar-img" alt="" hidden decoding="async" />
						<span id="olkil-account-avatar-fallback" class="olkil-account__avatar-fallback">OL</span>
					</span>
					<span class="olkil-account__meta">
						<span class="olkil-account__name" id="olkil-account-name">Account</span>
						<span class="olkil-account__email" id="olkil-account-email" hidden></span>
					</span>
				</button>
				<div class="olkil-account__menu" id="olkil-account-menu" role="menu">
					<a role="menuitem" href="<?php echo esc_url( olkil_page_url( 'dashboard' ) ); ?>"><?php esc_html_e( 'Dashboard', 'olkil' ); ?></a>
					<a role="menuitem" href="<?php echo esc_url( $profile_url ); ?>"><?php esc_html_e( 'Profile', 'olkil' ); ?></a>
					<a role="menuitem" href="<?php echo esc_url( olkil_page_url( 'download' ) ); ?>"><?php esc_html_e( 'Download', 'olkil' ); ?></a>
					<button type="button" role="menuitem" data-olkil-signout><?php esc_html_e( 'Sign out', 'olkil' ); ?></button>
				</div>
			</div>
		</div>
	</div>
</header>
