<?php
/**
 * Template Name: OLKIL Auth IDE
 * Description: Google-only Firebase login for OLKIL website and IDE.
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
			<?php esc_html_e( 'Continue with Google to sign in or create your OLKIL account.', 'olkil' ); ?>
		</p>

		<div id="olkil-auth-status" class="olkil-auth-status" hidden></div>

		<div class="olkil-auth-actions" id="olkil-auth-actions">
			<button type="button" class="olkil-btn olkil-btn--primary olkil-btn--lg olkil-auth-btn" id="olkil-auth-google">
				<?php esc_html_e( 'Continue with Google', 'olkil' ); ?>
			</button>
		</div>

		<div class="olkil-auth-done" id="olkil-auth-done" hidden>
			<a class="olkil-btn olkil-btn--primary olkil-btn--lg" href="olkil://auth/done"><?php esc_html_e( 'Open OLKIL', 'olkil' ); ?></a>
			<button type="button" class="olkil-btn olkil-btn--ghost olkil-btn--lg" id="olkil-auth-close"><?php esc_html_e( 'Close this tab', 'olkil' ); ?></button>
		</div>

		<p class="olkil-auth-footnote">
			<?php esc_html_e( 'By continuing you agree to OLKIL Terms and Privacy Policy.', 'olkil' ); ?>
		</p>
	</div>
</main>
<?php
get_footer( 'olkil' );
