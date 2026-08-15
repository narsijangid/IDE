<?php
/**
 * Plugin Name: OLKIL PayU Checkout
 * Description: Simple PayU payment checkout for OLKIL plans (test/live). Keys via env / secrets / options — never hardcode in theme.
 * Version: 1.1.1
 * Author: OLKIL
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'OLKIL_PAYU_CHECKOUT_VERSION', '1.1.1' );
define( 'OLKIL_PAYU_CHECKOUT_DIR', plugin_dir_path( __FILE__ ) );
define( 'OLKIL_PAYU_CHECKOUT_URL', plugin_dir_url( __FILE__ ) );

require_once OLKIL_PAYU_CHECKOUT_DIR . 'includes/subscriptions.php';

/**
 * Load plugin .env (KEY=VALUE) if present — never commit real .env.
 */
function olkil_payu_load_dotenv() {
	static $done = false;
	if ( $done ) {
		return;
	}
	$done = true;
	$file = OLKIL_PAYU_CHECKOUT_DIR . '.env';
	if ( ! file_exists( $file ) || ! is_readable( $file ) ) {
		return;
	}
	$lines = file( $file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES );
	if ( ! is_array( $lines ) ) {
		return;
	}
	foreach ( $lines as $line ) {
		$line = trim( $line );
		if ( '' === $line || '#' === $line[0] || false === strpos( $line, '=' ) ) {
			continue;
		}
		list( $k, $v ) = array_map( 'trim', explode( '=', $line, 2 ) );
		$v             = trim( $v, " \t\"'" );
		if ( $k && false === getenv( $k ) ) {
			putenv( "{$k}={$v}" );
			$_ENV[ $k ] = $v;
		}
	}
}

/**
 * Plans catalog (INR). Amounts must match site pricing.
 *
 * @return array<string, array{name:string,amount:string,tokens:string}>
 */
function olkil_payu_plans() {
	return array(
		'lite'  => array(
			'name'   => 'OLKIL Lite',
			'amount' => '249.00',
			'tokens' => '100M tokens / mo',
		),
		'pro'   => array(
			'name'   => 'OLKIL Pro',
			'amount' => '849.00',
			'tokens' => '350M tokens / mo',
		),
		'max'   => array(
			'name'   => 'OLKIL Max',
			'amount' => '2499.00',
			'tokens' => '1B tokens / mo',
		),
		'ultra' => array(
			'name'   => 'OLKIL Ultra',
			'amount' => '4199.00',
			'tokens' => '2B tokens / mo',
		),
	);
}

/**
 * Credentials: secrets.php → env/constants → WP options. Default mode = test.
 *
 * @return array{key:string,salt:string,mode:string}
 */
function olkil_payu_credentials() {
	static $cached = null;
	if ( null !== $cached ) {
		return $cached;
	}

	olkil_payu_load_dotenv();

	$key  = '';
	$salt = '';
	$mode = '';

	$secrets_file = OLKIL_PAYU_CHECKOUT_DIR . 'secrets.php';
	if ( file_exists( $secrets_file ) ) {
		$s = include $secrets_file;
		if ( is_array( $s ) ) {
			$key  = trim( (string) ( $s['key'] ?? '' ) );
			$salt = trim( (string) ( $s['salt'] ?? '' ) );
			$mode = trim( (string) ( $s['mode'] ?? '' ) );
		}
	}

	$env_key  = getenv( 'PAYU_MERCHANT_KEY' ) ?: ( defined( 'OLKIL_PAYU_MERCHANT_KEY' ) ? OLKIL_PAYU_MERCHANT_KEY : '' );
	$env_salt = getenv( 'PAYU_MERCHANT_SALT' ) ?: ( defined( 'OLKIL_PAYU_MERCHANT_SALT' ) ? OLKIL_PAYU_MERCHANT_SALT : '' );
	$env_mode = getenv( 'PAYU_MODE' ) ?: ( defined( 'OLKIL_PAYU_MODE' ) ? OLKIL_PAYU_MODE : '' );
	if ( $env_key ) {
		$key = trim( (string) $env_key );
	}
	if ( $env_salt ) {
		$salt = trim( (string) $env_salt );
	}
	if ( $env_mode ) {
		$mode = trim( (string) $env_mode );
	}

	if ( '' === $key ) {
		$key = trim( (string) get_option( 'olkil_payu_merchant_key', '' ) );
	}
	if ( '' === $salt ) {
		$salt = trim( (string) get_option( 'olkil_payu_merchant_salt', '' ) );
	}
	if ( '' === $mode ) {
		$mode = trim( (string) get_option( 'olkil_payu_mode', 'test' ) );
	}

	$mode = ( 'live' === strtolower( $mode ) ) ? 'live' : 'test';

	$cached = array(
		'key'  => $key,
		'salt' => $salt,
		'mode' => $mode,
	);
	return $cached;
}

function olkil_payu_payment_url() {
	$creds = olkil_payu_credentials();
	return ( 'live' === $creds['mode'] )
		? 'https://secure.payu.in/_payment'
		: 'https://test.payu.in/_payment';
}

/**
 * PayU request hash.
 *
 * @param array<string,string> $params Form fields.
 */
function olkil_payu_request_hash( array $params ) {
	$creds = olkil_payu_credentials();
	$seq   = $creds['key'] . '|' .
		$params['txnid'] . '|' .
		$params['amount'] . '|' .
		$params['productinfo'] . '|' .
		$params['firstname'] . '|' .
		$params['email'] . '|' .
		( $params['udf1'] ?? '' ) . '|' .
		( $params['udf2'] ?? '' ) . '|' .
		( $params['udf3'] ?? '' ) . '|' .
		( $params['udf4'] ?? '' ) . '|' .
		( $params['udf5'] ?? '' ) . '||||||' .
		$creds['salt'];
	return strtolower( hash( 'sha512', $seq ) );
}

/**
 * Verify PayU response hash.
 *
 * @param array<string,string> $data Posted response.
 */
function olkil_payu_verify_response( array $data ) {
	$creds = olkil_payu_credentials();
	if ( '' === $creds['key'] || '' === $creds['salt'] ) {
		return false;
	}

	$status         = (string) ( $data['status'] ?? '' );
	$firstname      = (string) ( $data['firstname'] ?? '' );
	$amount         = (string) ( $data['amount'] ?? '' );
	$txnid          = (string) ( $data['txnid'] ?? '' );
	$posted_hash    = strtolower( (string) ( $data['hash'] ?? '' ) );
	$key            = (string) ( $data['key'] ?? '' );
	$productinfo    = (string) ( $data['productinfo'] ?? '' );
	$email          = (string) ( $data['email'] ?? '' );
	$additional     = (string) ( $data['additionalCharges'] ?? '' );

	if ( $key && $key !== $creds['key'] ) {
		return false;
	}

	if ( $additional ) {
		$seq = $additional . '|' . $creds['salt'] . '|' . $status . '|||||||||||' . $email . '|' . $firstname . '|' . $productinfo . '|' . $amount . '|' . $txnid . '|' . $creds['key'];
	} else {
		$seq = $creds['salt'] . '|' . $status . '|||||||||||' . $email . '|' . $firstname . '|' . $productinfo . '|' . $amount . '|' . $txnid . '|' . $creds['key'];
	}

	$calc = strtolower( hash( 'sha512', $seq ) );
	return hash_equals( $calc, $posted_hash );
}

function olkil_payu_new_txnid() {
	return 'OLK' . gmdate( 'ymdHis' ) . wp_generate_password( 6, false, false );
}

/**
 * Persist order row.
 *
 * @param array<string,mixed> $order Order data.
 */
function olkil_payu_save_order( array $order ) {
	$orders = get_option( 'olkil_payu_orders', array() );
	if ( ! is_array( $orders ) ) {
		$orders = array();
	}
	$txnid           = (string) $order['txnid'];
	$orders[ $txnid ] = $order;
	// Keep last 500.
	if ( count( $orders ) > 500 ) {
		$orders = array_slice( $orders, -500, null, true );
	}
	update_option( 'olkil_payu_orders', $orders, false );
}

/**
 * @param string $txnid Transaction id.
 * @return array<string,mixed>|null
 */
function olkil_payu_get_order( $txnid ) {
	$orders = get_option( 'olkil_payu_orders', array() );
	return ( is_array( $orders ) && isset( $orders[ $txnid ] ) ) ? $orders[ $txnid ] : null;
}

function olkil_payu_mark_order( $txnid, array $patch ) {
	$order = olkil_payu_get_order( $txnid );
	if ( ! $order ) {
		$order = array( 'txnid' => $txnid );
	}
	olkil_payu_save_order( array_merge( $order, $patch ) );
}

/**
 * Create / refresh checkout pages.
 */
function olkil_payu_ensure_pages() {
	if ( get_option( 'olkil_payu_checkout_pages' ) === OLKIL_PAYU_CHECKOUT_VERSION ) {
		return;
	}

	$pages = array(
		'checkout'         => array(
			'title'   => 'Checkout',
			'content' => '<!-- OLKIL PayU Checkout -->',
		),
		'payment-success'  => array(
			'title'   => 'Payment Successful',
			'content' => '<!-- OLKIL PayU Success -->',
		),
		'payment-failed'   => array(
			'title'   => 'Payment Failed',
			'content' => '<!-- OLKIL PayU Failed -->',
		),
		'dashboard'        => array(
			'title'   => 'Dashboard',
			'content' => '<!-- OLKIL Dashboard -->',
		),
	);

	foreach ( $pages as $slug => $page ) {
		$existing = get_page_by_path( $slug );
		$args     = array(
			'post_title'     => $page['title'],
			'post_name'      => $slug,
			'post_content'   => $page['content'],
			'post_status'    => 'publish',
			'post_type'      => 'page',
			'comment_status' => 'closed',
			'ping_status'    => 'closed',
		);
		if ( $existing ) {
			$args['ID'] = (int) $existing->ID;
			wp_update_post( $args );
		} else {
			wp_insert_post( $args );
		}
	}

	update_option( 'olkil_payu_checkout_pages', OLKIL_PAYU_CHECKOUT_VERSION, false );
}
add_action( 'init', 'olkil_payu_ensure_pages', 4 );

/**
 * Import secrets.php into options once / when empty.
 */
function olkil_payu_import_secrets_to_options() {
	$file = OLKIL_PAYU_CHECKOUT_DIR . 'secrets.php';
	if ( ! file_exists( $file ) ) {
		return;
	}
	$s = include $file;
	if ( ! is_array( $s ) || empty( $s['key'] ) || empty( $s['salt'] ) ) {
		return;
	}
	update_option( 'olkil_payu_merchant_key', (string) $s['key'], false );
	update_option( 'olkil_payu_merchant_salt', (string) $s['salt'], false );
	if ( ! get_option( 'olkil_payu_mode' ) ) {
		update_option( 'olkil_payu_mode', (string) ( $s['mode'] ?? 'test' ), false );
	}
}

register_activation_hook( __FILE__, function () {
	delete_option( 'olkil_payu_checkout_pages' );
	delete_option( 'olkil_payu_profile_sync' );
	olkil_payu_import_secrets_to_options();
	olkil_payu_ensure_pages();
	olkil_payu_sync_profile_template();
	flush_rewrite_rules();
} );

add_action( 'init', function () {
	if ( ! get_option( 'olkil_payu_merchant_key' ) ) {
		olkil_payu_import_secrets_to_options();
	}
}, 1 );

/** Sync profile template into active OLKIL theme. */
function olkil_payu_sync_profile_template() {
	if ( get_option( 'olkil_payu_profile_sync' ) === OLKIL_PAYU_CHECKOUT_VERSION ) {
		return;
	}
	$src  = OLKIL_PAYU_CHECKOUT_DIR . 'theme-overrides/page-templates/template-profile.php';
	$dest = trailingslashit( get_theme_root() ) . 'olkil/page-templates/template-profile.php';
	if ( file_exists( $src ) && is_dir( dirname( $dest ) ) ) {
		if ( @copy( $src, $dest ) ) {
			update_option( 'olkil_payu_profile_sync', OLKIL_PAYU_CHECKOUT_VERSION, false );
		}
	}
}
add_action( 'init', 'olkil_payu_sync_profile_template', 3 );

/**
 * Undo legal-pages forcing page.php onto profile/dashboard/checkout (priority > 99).
 *
 * @param string $template Template path.
 * @return string
 */
function olkil_payu_restore_custom_templates( $template ) {
	if ( ! is_page() ) {
		return $template;
	}

	$slug = get_post_field( 'post_name', get_queried_object_id() );
	$need = array(
		'profile'          => 'page-templates/template-profile.php',
		'dashboard'        => '',
		'checkout'         => '',
		'payment-success'  => '',
		'payment-failed'   => '',
		'login'            => 'page-templates/template-auth-ide.php',
	);

	if ( ! $slug || ! array_key_exists( $slug, $need ) ) {
		$custom = get_page_template_slug( get_queried_object_id() );
		if ( ! $custom || 'default' === $custom ) {
			return $template;
		}
		// Custom template assigned — locate it from theme.
		$located = locate_template( array( $custom ) );
		return $located ? $located : $template;
	}

	$rel = $need[ $slug ];
	if ( $rel ) {
		$located = locate_template( array( $rel ) );
		if ( $located ) {
			return $located;
		}
		// Bundled profile fallback.
		$bundled = OLKIL_PAYU_CHECKOUT_DIR . 'theme-overrides/' . $rel;
		if ( file_exists( $bundled ) ) {
			return $bundled;
		}
	}

	// Dashboard / checkout use default page shell + the_content from plugin.
	$theme_page = locate_template( array( 'page.php' ) );
	// Prefer theme page.php over plugin legal page.php.
	if ( $theme_page && false !== strpos( $template, 'olkil-legal-pages' ) ) {
		return $theme_page;
	}

	return $template;
}
add_filter( 'template_include', 'olkil_payu_restore_custom_templates', 120 );

/**
 * REST notify (server-to-server) + browser return handlers via template.
 */
function olkil_payu_register_routes() {
	register_rest_route(
		'olkil-payu/v1',
		'/notify',
		array(
			'methods'             => 'POST',
			'callback'            => 'olkil_payu_handle_notify',
			'permission_callback' => '__return_true',
		)
	);
	register_rest_route(
		'olkil-payu/v1',
		'/subscription',
		array(
			'methods'             => 'GET',
			'callback'            => 'olkil_payu_rest_subscription',
			'permission_callback' => '__return_true',
			'args'                => array(
				'email' => array(
					'required' => true,
					'type'     => 'string',
				),
			),
		)
	);
}
add_action( 'rest_api_init', 'olkil_payu_register_routes' );

/**
 * CORS for IDE / website subscription lookups.
 */
function olkil_payu_rest_cors() {
	remove_filter( 'rest_pre_serve_request', 'rest_send_cors_headers' );
	add_filter(
		'rest_pre_serve_request',
		function ( $value ) {
			header( 'Access-Control-Allow-Origin: *' );
			header( 'Access-Control-Allow-Methods: GET, POST, OPTIONS' );
			header( 'Access-Control-Allow-Headers: Content-Type, Authorization' );
			return $value;
		}
	);
}
add_action( 'rest_api_init', 'olkil_payu_rest_cors', 15 );

function olkil_payu_rest_subscription( WP_REST_Request $request ) {
	$email = sanitize_email( (string) $request->get_param( 'email' ) );
	if ( ! $email ) {
		return new WP_REST_Response( array( 'error' => 'email_required' ), 400 );
	}
	return new WP_REST_Response( olkil_payu_get_subscription( $email ), 200 );
}

function olkil_payu_handle_notify( WP_REST_Request $request ) {
	$data = array_map( 'sanitize_text_field', (array) $request->get_params() );
	if ( empty( $data ) ) {
		$data = array_map( 'sanitize_text_field', wp_unslash( $_POST ) ); // phpcs:ignore
	}

	$ok     = olkil_payu_verify_response( $data );
	$txnid  = (string) ( $data['txnid'] ?? '' );
	$status = strtolower( (string) ( $data['status'] ?? '' ) );

	if ( $txnid && $ok ) {
		olkil_payu_mark_order(
			$txnid,
			array(
				'status'        => $status,
				'payu_mihpayid' => (string) ( $data['mihpayid'] ?? '' ),
				'verified'      => 1,
				'paid_at'       => gmdate( 'c' ),
				'raw'           => $data,
			)
		);
		olkil_payu_maybe_activate_from_payment( $data );
	}

	return new WP_REST_Response( array( 'ok' => $ok ), 200 );
}

/**
 * Process browser surl/furl POST on success/fail pages.
 */
function olkil_payu_capture_browser_return() {
	if ( empty( $_POST['txnid'] ) || empty( $_POST['hash'] ) ) { // phpcs:ignore
		return;
	}
	if ( ! is_page( array( 'payment-success', 'payment-failed', 'checkout' ) ) ) {
		return;
	}

	$data = array_map( 'sanitize_text_field', wp_unslash( $_POST ) ); // phpcs:ignore
	$ok   = olkil_payu_verify_response( $data );
	$txnid = (string) ( $data['txnid'] ?? '' );
	$status = strtolower( (string) ( $data['status'] ?? '' ) );

	if ( $txnid && $ok ) {
		olkil_payu_mark_order(
			$txnid,
			array(
				'status'        => $status,
				'payu_mihpayid' => (string) ( $data['mihpayid'] ?? '' ),
				'verified'      => 1,
				'paid_at'       => gmdate( 'c' ),
				'raw'           => $data,
			)
		);
		olkil_payu_maybe_activate_from_payment( $data );
		set_transient( 'olkil_payu_last_' . md5( $txnid . wp_salt() ), $data, HOUR_IN_SECONDS );
	}
}
add_action( 'template_redirect', 'olkil_payu_capture_browser_return', 1 );

/**
 * Start payment: validate + auto-POST to PayU.
 */
function olkil_payu_maybe_start_payment() {
	if ( empty( $_POST['olkil_payu_action'] ) || 'pay' !== $_POST['olkil_payu_action'] ) { // phpcs:ignore
		return;
	}
	if ( ! is_page( 'checkout' ) ) {
		return;
	}

	check_admin_referer( 'olkil_payu_checkout', 'olkil_payu_nonce' );

	$creds = olkil_payu_credentials();
	if ( '' === $creds['key'] || '' === $creds['salt'] ) {
		wp_die( esc_html__( 'Payment gateway is not configured yet.', 'olkil' ) );
	}

	$plan_slug = sanitize_key( wp_unslash( $_POST['plan'] ?? '' ) );
	$plans     = olkil_payu_plans();
	if ( ! isset( $plans[ $plan_slug ] ) ) {
		wp_die( esc_html__( 'Invalid plan selected.', 'olkil' ) );
	}
	$plan = $plans[ $plan_slug ];

	$firstname = sanitize_text_field( wp_unslash( $_POST['firstname'] ?? '' ) );
	$email     = sanitize_email( wp_unslash( $_POST['email'] ?? '' ) );
	$phone     = preg_replace( '/\D+/', '', (string) wp_unslash( $_POST['phone'] ?? '' ) );

	if ( strlen( $firstname ) < 2 || ! is_email( $email ) || strlen( $phone ) < 10 ) {
		wp_safe_redirect( add_query_arg( array( 'plan' => $plan_slug, 'err' => '1' ), home_url( '/checkout/' ) ) );
		exit;
	}

	$txnid = olkil_payu_new_txnid();
	$params = array(
		'key'         => $creds['key'],
		'txnid'       => $txnid,
		'amount'      => $plan['amount'],
		'productinfo' => $plan['name'],
		'firstname'   => $firstname,
		'email'       => $email,
		'phone'       => $phone,
		'surl'        => home_url( '/payment-success/' ),
		'furl'        => home_url( '/payment-failed/' ),
		'udf1'        => $plan_slug,
		'udf2'        => '',
		'udf3'        => '',
		'udf4'        => '',
		'udf5'        => '',
	);
	$params['hash'] = olkil_payu_request_hash( $params );

	olkil_payu_save_order(
		array(
			'txnid'      => $txnid,
			'plan'       => $plan_slug,
			'amount'     => $plan['amount'],
			'email'      => $email,
			'firstname'  => $firstname,
			'phone'      => $phone,
			'status'     => 'pending',
			'created_at' => gmdate( 'c' ),
			'mode'       => $creds['mode'],
		)
	);

	$action = olkil_payu_payment_url();
	nocache_headers();
	status_header( 200 );
	?>
	<!DOCTYPE html>
	<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title><?php esc_html_e( 'Redirecting to PayU…', 'olkil' ); ?></title>
		<style>
			body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a0a0b;color:#fafafa;font-family:ui-sans-serif,system-ui,sans-serif}
			.box{text-align:center;padding:2rem}
			.spin{width:28px;height:28px;border:2px solid #333;border-top-color:#ff4d8d;border-radius:50%;margin:0 auto 1rem;animation:s .7s linear infinite}
			@keyframes s{to{transform:rotate(360deg)}}
			p{opacity:.7;font-size:.95rem}
		</style>
	</head>
	<body>
		<div class="box">
			<div class="spin" aria-hidden="true"></div>
			<p><?php esc_html_e( 'Taking you to secure PayU checkout…', 'olkil' ); ?></p>
		</div>
		<form id="payu" method="post" action="<?php echo esc_url( $action ); ?>">
			<?php foreach ( $params as $k => $v ) : ?>
				<input type="hidden" name="<?php echo esc_attr( $k ); ?>" value="<?php echo esc_attr( $v ); ?>" />
			<?php endforeach; ?>
			<input type="hidden" name="service_provider" value="payu_paisa" />
		</form>
		<script>document.getElementById('payu').submit();</script>
	</body>
	</html>
	<?php
	exit;
}
add_action( 'template_redirect', 'olkil_payu_maybe_start_payment', 0 );

/**
 * Replace checkout / result page bodies.
 *
 * @param string $content Content.
 */
function olkil_payu_render_pages( $content ) {
	if ( ! is_singular( 'page' ) || ! in_the_loop() || ! is_main_query() ) {
		return $content;
	}

	if ( is_page( 'checkout' ) ) {
		return olkil_payu_checkout_html();
	}
	if ( is_page( 'payment-success' ) ) {
		return olkil_payu_success_html();
	}
	if ( is_page( 'payment-failed' ) ) {
		return olkil_payu_failed_html();
	}
	if ( is_page( 'dashboard' ) ) {
		return olkil_payu_dashboard_html();
	}
	return $content;
}
add_filter( 'the_content', 'olkil_payu_render_pages', 20 );

function olkil_payu_checkout_html() {
	$plans     = olkil_payu_plans();
	$plan_slug = sanitize_key( wp_unslash( $_GET['plan'] ?? 'pro' ) ); // phpcs:ignore
	if ( ! isset( $plans[ $plan_slug ] ) ) {
		$plan_slug = 'pro';
	}
	$plan   = $plans[ $plan_slug ];
	$err    = ! empty( $_GET['err'] ); // phpcs:ignore
	$creds  = olkil_payu_credentials();
	$mode   = $creds['mode'];
	$amount = preg_replace( '/\.00$/', '', $plan['amount'] );

	ob_start();
	?>
	<div class="olkil-payu">
		<div class="olkil-payu__card">
			<?php if ( 'test' === $mode ) : ?>
				<p class="olkil-payu__badge">Test mode</p>
			<?php endif; ?>
			<p class="olkil-payu__eyebrow"><?php esc_html_e( 'OLKIL · Secure checkout', 'olkil' ); ?></p>
			<h1 class="olkil-payu__title"><?php echo esc_html( $plan['name'] ); ?></h1>
			<p class="olkil-payu__price"><span>₹</span><?php echo esc_html( number_format( (float) $amount ) ); ?><small>/ mo</small></p>
			<p class="olkil-payu__meta"><?php echo esc_html( $plan['tokens'] ); ?> · <?php esc_html_e( 'Digital delivery after payment', 'olkil' ); ?></p>

			<?php if ( $err ) : ?>
				<p class="olkil-payu__error"><?php esc_html_e( 'Please enter a valid name, email, and 10-digit mobile number.', 'olkil' ); ?></p>
			<?php endif; ?>

			<?php if ( '' === $creds['key'] || '' === $creds['salt'] ) : ?>
				<p class="olkil-payu__error"><?php esc_html_e( 'Payments are being configured. Please try again shortly.', 'olkil' ); ?></p>
			<?php else : ?>
			<form class="olkil-payu__form" method="post" action="">
				<?php wp_nonce_field( 'olkil_payu_checkout', 'olkil_payu_nonce' ); ?>
				<input type="hidden" name="olkil_payu_action" value="pay" />
				<input type="hidden" name="plan" value="<?php echo esc_attr( $plan_slug ); ?>" />

				<label>
					<span><?php esc_html_e( 'Full name', 'olkil' ); ?></span>
					<input type="text" name="firstname" required autocomplete="name" placeholder="Your name" />
				</label>
				<label>
					<span><?php esc_html_e( 'Email', 'olkil' ); ?></span>
					<input type="email" name="email" required autocomplete="email" placeholder="you@email.com" />
				</label>
				<label>
					<span><?php esc_html_e( 'Mobile', 'olkil' ); ?></span>
					<input type="tel" name="phone" required autocomplete="tel" inputmode="numeric" pattern="[0-9]{10,15}" placeholder="10-digit mobile" />
				</label>

				<button type="submit" class="olkil-payu__btn">
					<?php
					printf(
						/* translators: %s: amount */
						esc_html__( 'Pay ₹%s securely', 'olkil' ),
						esc_html( number_format( (float) $amount ) )
					);
					?>
				</button>
				<p class="olkil-payu__secure"><?php esc_html_e( 'UPI · Cards · Netbanking via PayU. You will be redirected to complete payment.', 'olkil' ); ?></p>
			</form>
			<?php endif; ?>

			<div class="olkil-payu__plans">
				<?php foreach ( $plans as $slug => $p ) : ?>
					<a class="<?php echo $slug === $plan_slug ? 'is-active' : ''; ?>" href="<?php echo esc_url( home_url( '/checkout/?plan=' . $slug ) ); ?>">
						<?php echo esc_html( str_replace( 'OLKIL ', '', $p['name'] ) ); ?>
						<span>₹<?php echo esc_html( number_format( (float) $p['amount'] ) ); ?></span>
					</a>
				<?php endforeach; ?>
			</div>
		</div>
	</div>
	<?php
	return (string) ob_get_clean();
}

function olkil_payu_success_html() {
	$email = isset( $_POST['email'] ) ? sanitize_email( wp_unslash( $_POST['email'] ) ) : ''; // phpcs:ignore
	$txnid = isset( $_POST['txnid'] ) ? sanitize_text_field( wp_unslash( $_POST['txnid'] ) ) : ( isset( $_GET['txnid'] ) ? sanitize_text_field( wp_unslash( $_GET['txnid'] ) ) : '' ); // phpcs:ignore
	$order = $txnid ? olkil_payu_get_order( $txnid ) : null;
	$plan  = sanitize_key( (string) ( $order['plan'] ?? ( $_POST['udf1'] ?? '' ) ) ); // phpcs:ignore
	$email = $email ?: sanitize_email( (string) ( $order['email'] ?? '' ) );
	$sub   = $email ? olkil_payu_get_subscription( $email ) : null;

	ob_start();
	?>
	<div class="olkil-payu">
		<div class="olkil-payu__card olkil-payu__card--result">
			<div class="olkil-payu__icon olkil-payu__icon--ok" aria-hidden="true">✓</div>
			<h1><?php esc_html_e( 'Payment successful', 'olkil' ); ?></h1>
			<p><?php esc_html_e( 'Your plan is active. Open Dashboard or Profile to see tokens, expiry, and usage.', 'olkil' ); ?></p>
			<?php if ( $sub && ! empty( $sub['is_paid'] ) ) : ?>
				<p class="olkil-payu__meta">
					<strong><?php echo esc_html( $sub['plan_name'] ); ?></strong>
					· <?php echo esc_html( $sub['tokens_total_label'] ); ?> tokens
					· <?php echo esc_html( $sub['expires_label'] ); ?>
				</p>
			<?php elseif ( $plan ) : ?>
				<p class="olkil-payu__meta"><strong><?php echo esc_html( strtoupper( $plan ) ); ?></strong><?php echo $txnid ? ' · ' . esc_html( $txnid ) : ''; ?></p>
			<?php endif; ?>
			<div class="olkil-payu__actions">
				<a class="olkil-payu__btn" href="<?php echo esc_url( home_url( '/dashboard/' ) ); ?>"><?php esc_html_e( 'Open Dashboard', 'olkil' ); ?></a>
				<a class="olkil-payu__link" href="<?php echo esc_url( home_url( '/profile/' ) ); ?>"><?php esc_html_e( 'View Profile', 'olkil' ); ?></a>
			</div>
			<p class="olkil-payu__secure"><?php esc_html_e( 'Sign in with the same Google/email used at checkout to see your plan badge.', 'olkil' ); ?></p>
		</div>
	</div>
	<?php
	return (string) ob_get_clean();
}

function olkil_payu_failed_html() {
	$txnid = isset( $_POST['txnid'] ) ? sanitize_text_field( wp_unslash( $_POST['txnid'] ) ) : ''; // phpcs:ignore
	ob_start();
	?>
	<div class="olkil-payu">
		<div class="olkil-payu__card olkil-payu__card--result">
			<div class="olkil-payu__icon olkil-payu__icon--fail" aria-hidden="true">!</div>
			<h1><?php esc_html_e( 'Payment not completed', 'olkil' ); ?></h1>
			<p><?php esc_html_e( 'No charge went through, or the payment was cancelled. You can try again anytime.', 'olkil' ); ?></p>
			<?php if ( $txnid ) : ?>
				<p class="olkil-payu__meta"><?php echo esc_html( $txnid ); ?></p>
			<?php endif; ?>
			<div class="olkil-payu__actions">
				<a class="olkil-payu__btn" href="<?php echo esc_url( home_url( '/checkout/?plan=pro' ) ); ?>"><?php esc_html_e( 'Try again', 'olkil' ); ?></a>
				<a class="olkil-payu__link" href="<?php echo esc_url( home_url( '/pricing/' ) ); ?>"><?php esc_html_e( 'Back to pricing', 'olkil' ); ?></a>
			</div>
		</div>
	</div>
	<?php
	return (string) ob_get_clean();
}

/**
 * Cursor-style overview dashboard (client fills via Firebase email).
 */
function olkil_payu_dashboard_html() {
	ob_start();
	?>
	<div class="olkil-dash" id="olkil-dash" data-api="<?php echo esc_url( rest_url( 'olkil-payu/v1/subscription' ) ); ?>">
		<div class="olkil-dash__guest" id="olkil-dash-guest">
			<h1><?php esc_html_e( 'Dashboard', 'olkil' ); ?></h1>
			<p><?php esc_html_e( 'Sign in to see your plan, credits, and billing overview.', 'olkil' ); ?></p>
			<a class="olkil-btn olkil-btn--primary" href="<?php echo esc_url( home_url( '/login/' ) ); ?>"><?php esc_html_e( 'Sign in', 'olkil' ); ?></a>
		</div>

		<div class="olkil-dash__main" id="olkil-dash-main" hidden>
			<header class="olkil-dash__top">
				<div>
					<p class="olkil-dash__eyebrow"><?php esc_html_e( 'Overview', 'olkil' ); ?></p>
					<h1 id="olkil-dash-hello"><?php esc_html_e( 'Welcome back', 'olkil' ); ?></h1>
				</div>
				<span class="olkil-plan-badge" id="olkil-dash-badge">Dazzlone</span>
			</header>

			<section class="olkil-dash__card olkil-dash__credits">
				<div class="olkil-dash__credits-head">
					<h2><?php esc_html_e( 'Credits', 'olkil' ); ?></h2>
					<p id="olkil-dash-credits-left">—</p>
				</div>
				<div class="olkil-dash__bar" aria-hidden="true">
					<span id="olkil-dash-bar-fill" style="width:0%"></span>
				</div>
				<p class="olkil-dash__credits-meta" id="olkil-dash-credits-meta"><?php esc_html_e( 'Usage refreshes with your billing period.', 'olkil' ); ?></p>
			</section>

			<section class="olkil-dash__grid">
				<article class="olkil-dash__card">
					<h3><?php esc_html_e( 'Current plan', 'olkil' ); ?></h3>
					<p class="olkil-dash__plan-name" id="olkil-dash-plan">Dazzlone</p>
					<p class="olkil-dash__muted" id="olkil-dash-expiry">—</p>
				</article>
				<article class="olkil-dash__card">
					<h3><?php esc_html_e( 'Token balance', 'olkil' ); ?></h3>
					<p class="olkil-dash__plan-name" id="olkil-dash-tokens">—</p>
					<p class="olkil-dash__muted" id="olkil-dash-tokens-sub"><?php esc_html_e( 'Used / total this month', 'olkil' ); ?></p>
				</article>
			</section>

			<section class="olkil-dash__upgrades">
				<a class="olkil-dash__upgrade" href="<?php echo esc_url( home_url( '/checkout/?plan=pro' ) ); ?>">
					<strong>Pro</strong>
					<span><?php esc_html_e( '350M tokens · ₹849/mo', 'olkil' ); ?></span>
					<em><?php esc_html_e( 'Upgrade', 'olkil' ); ?></em>
				</a>
				<a class="olkil-dash__upgrade" href="<?php echo esc_url( home_url( '/checkout/?plan=ultra' ) ); ?>">
					<strong>Ultra</strong>
					<span><?php esc_html_e( '2B tokens · ₹4,199/mo', 'olkil' ); ?></span>
					<em><?php esc_html_e( 'Upgrade', 'olkil' ); ?></em>
				</a>
			</section>

			<div class="olkil-dash__links">
				<a href="<?php echo esc_url( home_url( '/profile/' ) ); ?>"><?php esc_html_e( 'Profile', 'olkil' ); ?></a>
				<a href="<?php echo esc_url( home_url( '/pricing/' ) ); ?>"><?php esc_html_e( 'Pricing', 'olkil' ); ?></a>
				<a href="<?php echo esc_url( home_url( '/download/' ) ); ?>"><?php esc_html_e( 'Download', 'olkil' ); ?></a>
			</div>
		</div>
	</div>
	<?php
	return (string) ob_get_clean();
}

function olkil_payu_enqueue_assets() {
	$need_checkout = is_page( array( 'checkout', 'payment-success', 'payment-failed', 'dashboard' ) );

	if ( $need_checkout ) {
		wp_enqueue_style(
			'olkil-payu-checkout',
			OLKIL_PAYU_CHECKOUT_URL . 'assets/checkout.css',
			array(),
			OLKIL_PAYU_CHECKOUT_VERSION
		);
	}

	// Sitewide: header plan chip + profile/dashboard plan cards.
	wp_enqueue_style(
		'olkil-payu-account',
		OLKIL_PAYU_CHECKOUT_URL . 'assets/account-plan.css',
		array(),
		OLKIL_PAYU_CHECKOUT_VERSION
	);
	wp_enqueue_script(
		'olkil-payu-account',
		OLKIL_PAYU_CHECKOUT_URL . 'assets/account-plan.js',
		array( 'firebase-auth', 'olkil-account' ),
		OLKIL_PAYU_CHECKOUT_VERSION,
		true
	);
	wp_localize_script(
		'olkil-payu-account',
		'olkilPayuAccount',
		array(
			'api'       => esc_url_raw( rest_url( 'olkil-payu/v1/subscription' ) ),
			'dashboard' => home_url( '/dashboard/' ),
			'profile'   => home_url( '/profile/' ),
			'checkout'  => home_url( '/checkout/' ),
		)
	);
}
add_action( 'wp_enqueue_scripts', 'olkil_payu_enqueue_assets', 30 );

/**
 * Admin: Settings → OLKIL PayU (key/salt/mode). Salt never echoed fully.
 */
function olkil_payu_admin_menu() {
	add_options_page(
		'OLKIL PayU',
		'OLKIL PayU',
		'manage_options',
		'olkil-payu',
		'olkil_payu_admin_page'
	);
}
add_action( 'admin_menu', 'olkil_payu_admin_menu' );

function olkil_payu_admin_page() {
	if ( ! current_user_can( 'manage_options' ) ) {
		return;
	}
	if ( isset( $_POST['olkil_payu_save'] ) && check_admin_referer( 'olkil_payu_admin' ) ) {
		$key  = sanitize_text_field( wp_unslash( $_POST['key'] ?? '' ) );
		$salt = sanitize_text_field( wp_unslash( $_POST['salt'] ?? '' ) );
		$mode = sanitize_text_field( wp_unslash( $_POST['mode'] ?? 'test' ) );
		if ( $key ) {
			update_option( 'olkil_payu_merchant_key', $key, false );
		}
		if ( $salt ) {
			update_option( 'olkil_payu_merchant_salt', $salt, false );
		}
		update_option( 'olkil_payu_mode', ( 'live' === $mode ) ? 'live' : 'test', false );
		echo '<div class="updated"><p>Saved.</p></div>';
	}
	$creds = olkil_payu_credentials();
	$salt_mask = $creds['salt'] ? ( substr( $creds['salt'], 0, 4 ) . '…' . substr( $creds['salt'], -4 ) ) : '(not set)';
	?>
	<div class="wrap">
		<h1>OLKIL PayU</h1>
		<p>Credentials load from <code>PAYU_*</code> env, <code>OLKIL_PAYU_*</code> constants, <code>secrets.php</code>, or options below. Current mode: <strong><?php echo esc_html( $creds['mode'] ); ?></strong></p>
		<form method="post">
			<?php wp_nonce_field( 'olkil_payu_admin' ); ?>
			<table class="form-table">
				<tr>
					<th>Merchant Key</th>
					<td><input type="text" name="key" class="regular-text" value="<?php echo esc_attr( $creds['key'] ); ?>" autocomplete="off" /></td>
				</tr>
				<tr>
					<th>Merchant Salt</th>
					<td>
						<input type="password" name="salt" class="regular-text" value="" placeholder="Leave blank to keep: <?php echo esc_attr( $salt_mask ); ?>" autocomplete="new-password" />
					</td>
				</tr>
				<tr>
					<th>Mode</th>
					<td>
						<select name="mode">
							<option value="test" <?php selected( $creds['mode'], 'test' ); ?>>Test (test.payu.in)</option>
							<option value="live" <?php selected( $creds['mode'], 'live' ); ?>>Live (secure.payu.in)</option>
						</select>
					</td>
				</tr>
			</table>
			<p><button type="submit" class="button button-primary" name="olkil_payu_save" value="1">Save</button></p>
		</form>
		<p>Checkout: <a href="<?php echo esc_url( home_url( '/checkout/?plan=pro' ) ); ?>" target="_blank">/checkout/?plan=pro</a><br />
		Notify URL: <code><?php echo esc_html( rest_url( 'olkil-payu/v1/notify' ) ); ?></code></p>
	</div>
	<?php
}
