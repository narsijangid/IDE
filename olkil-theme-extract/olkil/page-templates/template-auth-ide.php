<?php
/**
 * Template Name: OLKIL Auth IDE
 * Description: Firebase login for OLKIL IDE (Cursor/Trae-style browser auth + loopback redirect).
 *
 * @package Astra
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

get_header( 'olkil' );
?>
<main class="olkil-auth-page" id="olkil-auth-ide">
	<div class="olkil-auth-page__glow" aria-hidden="true"></div>
	<div class="olkil-auth-card olkil-reveal">
		<div class="olkil-auth-card__brand">
			<img src="<?php echo esc_url( OLKIL_URI . 'assets/olkil/img/logo-mark.png' ); ?>" width="48" height="48" alt="" />
			<span>OLKIL</span>
		</div>
		<h1><?php esc_html_e( 'Sign in to continue', 'olkil' ); ?></h1>
		<p class="olkil-auth-card__lead" id="olkil-auth-lead">
			<?php esc_html_e( 'Sign in to connect your OLKIL IDE. You will be redirected back to the app automatically.', 'olkil' ); ?>
		</p>

		<div id="olkil-auth-status" class="olkil-auth-status" hidden></div>

		<div class="olkil-auth-actions" id="olkil-auth-actions">
			<button type="button" class="olkil-btn olkil-btn--primary olkil-btn--lg olkil-auth-btn" id="olkil-auth-google">
				<?php esc_html_e( 'Continue with Google', 'olkil' ); ?>
			</button>
			<button type="button" class="olkil-btn olkil-btn--ghost olkil-btn--lg olkil-auth-btn" id="olkil-auth-github">
				<?php esc_html_e( 'Continue with GitHub', 'olkil' ); ?>
			</button>
		</div>

		<details class="olkil-auth-email">
			<summary><?php esc_html_e( 'Use email instead', 'olkil' ); ?></summary>
			<form id="olkil-auth-email-form" class="olkil-auth-email__form">
				<label>
					<span><?php esc_html_e( 'Email', 'olkil' ); ?></span>
					<input type="email" name="email" required autocomplete="username" />
				</label>
				<label>
					<span><?php esc_html_e( 'Password', 'olkil' ); ?></span>
					<input type="password" name="password" required minlength="6" autocomplete="current-password" />
				</label>
				<div class="olkil-auth-email__row">
					<button type="submit" class="olkil-btn olkil-btn--primary" data-mode="signin"><?php esc_html_e( 'Sign in', 'olkil' ); ?></button>
					<button type="button" class="olkil-btn olkil-btn--ghost" id="olkil-auth-signup"><?php esc_html_e( 'Create account', 'olkil' ); ?></button>
				</div>
			</form>
		</details>

		<p class="olkil-auth-footnote">
			<?php esc_html_e( 'By continuing you agree to OLKIL Terms and Privacy Policy.', 'olkil' ); ?>
		</p>
	</div>
</main>
<?php
get_footer( 'olkil' );
