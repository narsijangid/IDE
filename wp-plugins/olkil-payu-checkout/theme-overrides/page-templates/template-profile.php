<?php
/**
 * Template Name: OLKIL Profile
 * Description: Signed-in user profile (Google / GitHub / email via Firebase).
 *
 * @package Astra
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

get_header( 'olkil' );
$login_url = olkil_page_url( 'login' );
?>
<main class="olkil-profile-page" id="olkil-profile">
	<div class="olkil-profile-page__glow" aria-hidden="true"></div>
	<div class="olkil-wrap">
		<div class="olkil-profile-empty" id="olkil-profile-empty">
			<img class="olkil-profile-empty__logo" src="<?php echo esc_url( OLKIL_URI . 'assets/olkil/img/logo-mark.png' ); ?>" width="56" height="56" alt="" />
			<h1><?php esc_html_e( 'Your OLKIL profile', 'olkil' ); ?></h1>
			<p><?php esc_html_e( 'Sign in with Google to see your account details here.', 'olkil' ); ?></p>
			<a class="olkil-btn olkil-btn--primary olkil-btn--lg" data-olkil-signin href="<?php echo esc_url( $login_url ); ?>">
				<?php esc_html_e( 'Sign in', 'olkil' ); ?>
			</a>
		</div>

		<section class="olkil-profile-card" id="olkil-profile-card" hidden>
			<div class="olkil-profile-card__hero">
				<div class="olkil-profile-photo" aria-hidden="true">
					<img id="olkil-profile-photo" alt="" hidden decoding="async" />
					<span id="olkil-profile-photo-fallback" class="olkil-profile-photo__fallback">OL</span>
				</div>
				<div>
					<p class="olkil-eyebrow" style="margin-bottom:0.5rem">
						<span class="olkil-eyebrow__dot" aria-hidden="true"></span>
						<?php esc_html_e( 'Account', 'olkil' ); ?>
					</p>
					<h1 id="olkil-profile-name">—</h1>
					<span class="olkil-plan-badge" id="olkil-profile-badge" hidden>…</span>
					<p class="olkil-profile-card__email" id="olkil-profile-email">—</p>
				</div>
			</div>

			<div class="olkil-profile-plan" id="olkil-profile-plan" hidden>
				<div class="olkil-profile-plan__row">
					<div>
						<p class="olkil-profile-plan__label"><?php esc_html_e( 'Current plan', 'olkil' ); ?></p>
						<p class="olkil-profile-plan__value" id="olkil-profile-plan-name">—</p>
					</div>
					<div>
						<p class="olkil-profile-plan__label"><?php esc_html_e( 'Renews / expires', 'olkil' ); ?></p>
						<p class="olkil-profile-plan__value" id="olkil-profile-plan-expiry">—</p>
					</div>
				</div>
				<div class="olkil-profile-plan__credits">
					<div class="olkil-profile-plan__credits-top">
						<span><?php esc_html_e( 'Credits remaining', 'olkil' ); ?></span>
						<strong id="olkil-profile-credits-pct">—</strong>
					</div>
					<div class="olkil-dash__bar" aria-hidden="true"><span id="olkil-profile-bar-fill" style="width:0%"></span></div>
					<p class="olkil-profile-plan__hint" id="olkil-profile-tokens">—</p>
				</div>
			</div>

			<dl class="olkil-profile-meta">
				<div>
					<dt><?php esc_html_e( 'Signed in with', 'olkil' ); ?></dt>
					<dd id="olkil-profile-provider">—</dd>
				</div>
				<div>
					<dt><?php esc_html_e( 'Email status', 'olkil' ); ?></dt>
					<dd id="olkil-profile-verified">—</dd>
				</div>
				<div>
					<dt><?php esc_html_e( 'User ID', 'olkil' ); ?></dt>
					<dd class="olkil-profile-uid" id="olkil-profile-uid">—</dd>
				</div>
			</dl>

			<div class="olkil-profile-actions">
				<a class="olkil-btn olkil-btn--primary" data-olkil-dashboard href="<?php echo esc_url( home_url( '/dashboard/' ) ); ?>">
					<?php esc_html_e( 'Dashboard', 'olkil' ); ?>
				</a>
				<a class="olkil-btn olkil-btn--ghost" href="<?php echo esc_url( olkil_page_url( 'download' ) ); ?>">
					<?php esc_html_e( 'Download OLKIL', 'olkil' ); ?>
				</a>
				<button type="button" class="olkil-btn olkil-btn--ghost" data-olkil-signout>
					<?php esc_html_e( 'Sign out', 'olkil' ); ?>
				</button>
			</div>
		</section>
	</div>
</main>
<?php
get_footer( 'olkil' );
