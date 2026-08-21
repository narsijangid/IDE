<?php
/**
 * Plugin Name: OLKIL PayU Checkout
 * Description: Professional PayU checkout — Firebase-held KEY/SALT, webhook, invoices, receipts, email.
 * Version: 2.4.1
 * Author: OLKIL
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'OLKIL_PAYU_CHECKOUT_VERSION', '2.4.1' );
define( 'OLKIL_PAYU_CHECKOUT_DIR', plugin_dir_path( __FILE__ ) );
define( 'OLKIL_PAYU_CHECKOUT_URL', plugin_dir_url( __FILE__ ) );

require_once OLKIL_PAYU_CHECKOUT_DIR . 'includes/subscriptions.php';
require_once OLKIL_PAYU_CHECKOUT_DIR . 'includes/firebase-backend.php';
require_once OLKIL_PAYU_CHECKOUT_DIR . 'includes/olkil-wallet.php';
require_once OLKIL_PAYU_CHECKOUT_DIR . 'includes/invoice.php';
require_once OLKIL_PAYU_CHECKOUT_DIR . 'includes/mail.php';
require_once OLKIL_PAYU_CHECKOUT_DIR . 'includes/fulfill.php';

add_action( 'olkil_payu_expire_plans', 'olkil_payu_cron_expire_plans' );
add_action( 'init', 'olkil_payu_schedule_expiry_cron', 20 );

add_filter(
	'body_class',
	static function ( $classes ) {
		if ( is_page( 'dashboard' ) ) {
			$classes[] = 'olkil-dash-page';
		}
		return $classes;
	}
);
add_action(
	'wp_head',
	static function () {
		if ( is_page( 'dashboard' ) ) {
			echo '<script>document.documentElement.classList.add("olkil-dash-page");</script>';
		}
	},
	0
);

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
 * Verify PayU reverse hash (surl/furl + S2S webhook).
 * salt|status|udf10|udf9|udf8|udf7|udf6|udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key
 *
 * @param array<string,string> $data Posted response.
 */
function olkil_payu_verify_response( array $data ) {
	$creds = olkil_payu_credentials();
	if ( '' === $creds['key'] || '' === $creds['salt'] ) {
		return false;
	}

	$posted = strtolower( (string) ( $data['hash'] ?? '' ) );
	$key    = (string) ( $data['key'] ?? '' );
	if ( '' === $posted ) {
		return false;
	}
	if ( $key && $key !== $creds['key'] ) {
		return false;
	}

	$seq = $creds['salt'] . '|' .
		(string) ( $data['status'] ?? '' ) . '|' .
		(string) ( $data['udf10'] ?? '' ) . '|' .
		(string) ( $data['udf9'] ?? '' ) . '|' .
		(string) ( $data['udf8'] ?? '' ) . '|' .
		(string) ( $data['udf7'] ?? '' ) . '|' .
		(string) ( $data['udf6'] ?? '' ) . '|' .
		(string) ( $data['udf5'] ?? '' ) . '|' .
		(string) ( $data['udf4'] ?? '' ) . '|' .
		(string) ( $data['udf3'] ?? '' ) . '|' .
		(string) ( $data['udf2'] ?? '' ) . '|' .
		(string) ( $data['udf1'] ?? '' ) . '|' .
		(string) ( $data['email'] ?? '' ) . '|' .
		(string) ( $data['firstname'] ?? '' ) . '|' .
		(string) ( $data['productinfo'] ?? '' ) . '|' .
		(string) ( $data['amount'] ?? '' ) . '|' .
		(string) ( $data['txnid'] ?? '' ) . '|' .
		$creds['key'];

	$additional = (string) ( $data['additionalCharges'] ?? '' );
	if ( $additional ) {
		$seq = $additional . '|' . $seq;
	}

	return hash_equals( strtolower( hash( 'sha512', $seq ) ), $posted );
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
		'invoice'          => array(
			'title'   => 'Invoice',
			'content' => '<!-- OLKIL Invoice -->',
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
	olkil_payu_schedule_expiry_cron();
	flush_rewrite_rules();
} );

add_action( 'init', function () {
	if ( ! get_option( 'olkil_payu_merchant_key' ) ) {
		olkil_payu_import_secrets_to_options();
	}
}, 1 );

/** Sync profile + dashboard templates into active OLKIL theme. */
function olkil_payu_sync_profile_template() {
	if ( get_option( 'olkil_payu_profile_sync' ) === OLKIL_PAYU_CHECKOUT_VERSION ) {
		return;
	}
	$dir  = trailingslashit( get_theme_root() ) . 'olkil/page-templates/';
	$map  = array(
		'page-templates/template-profile.php'   => 'template-profile.php',
		'page-templates/template-dashboard.php' => 'template-dashboard.php',
	);
	$ok = true;
	foreach ( $map as $rel => $name ) {
		$src  = OLKIL_PAYU_CHECKOUT_DIR . 'theme-overrides/' . $rel;
		$dest = $dir . $name;
		if ( ! file_exists( $src ) || ! is_dir( $dir ) ) {
			$ok = false;
			continue;
		}
		if ( ! @copy( $src, $dest ) ) {
			$ok = false;
		}
	}
	if ( $ok ) {
		update_option( 'olkil_payu_profile_sync', OLKIL_PAYU_CHECKOUT_VERSION, false );
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
		'dashboard'        => 'page-templates/template-dashboard.php',
		'checkout'         => '',
		'payment-success'  => '',
		'payment-failed'   => '',
		'invoice'          => '',
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
		'/invoices',
		array(
			'methods'             => 'GET',
			'callback'            => 'olkil_payu_rest_invoices',
			'permission_callback' => '__return_true',
			'args'                => array(
				'email' => array(
					'required' => true,
					'type'     => 'string',
				),
			),
		)
	);
	register_rest_route(
		'olkil-payu/v1',
		'/mail',
		array(
			'methods'             => 'POST',
			'callback'            => 'olkil_payu_handle_mail_relay',
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
	register_rest_route(
		'olkil-payu/v1',
		'/quota',
		array(
			'methods'             => array( 'GET', 'POST' ),
			'callback'            => 'olkil_payu_rest_quota',
			'permission_callback' => '__return_true',
		)
	);
	register_rest_route(
		'olkil-payu/v1',
		'/usage',
		array(
			'methods'             => 'POST',
			'callback'            => 'olkil_payu_rest_usage',
			'permission_callback' => '__return_true',
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
			header( 'Cache-Control: no-store, no-cache, must-revalidate, max-age=0' );
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
	$response = new WP_REST_Response( olkil_payu_get_subscription( $email ), 200 );
	$response->header( 'Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0' );
	return $response;
}

function olkil_payu_rest_invoices( WP_REST_Request $request ) {
	$email = olkil_payu_email_key( sanitize_email( (string) $request->get_param( 'email' ) ) );
	if ( ! $email ) {
		return new WP_REST_Response( array( 'error' => 'email_required' ), 400 );
	}
	$all = get_option( 'olkil_payu_orders', array() );
	$out = array();
	if ( is_array( $all ) ) {
		foreach ( $all as $order ) {
			if ( ! is_array( $order ) ) {
				continue;
			}
			if ( olkil_payu_email_key( (string) ( $order['email'] ?? '' ) ) !== $email ) {
				continue;
			}
			if ( empty( $order['invoice'] ) || ! is_array( $order['invoice'] ) ) {
				continue;
			}
			$inv   = $order['invoice'];
			$issued = (int) ( $inv['issued_at'] ?? $order['paid_at'] ?? $order['created_at'] ?? 0 );
			$out[]  = array(
				'txnid'      => (string) ( $order['txnid'] ?? '' ),
				'invoice_no' => (string) ( $inv['invoice_no'] ?? '' ),
				'receipt_no' => (string) ( $inv['receipt_no'] ?? '' ),
				'amount'     => (string) ( $inv['amount'] ?? $order['amount'] ?? '' ),
				'plan'       => (string) ( $inv['plan_name'] ?? $order['plan'] ?? '' ),
				'url'        => home_url( '/invoice/?txnid=' . rawurlencode( (string) ( $order['txnid'] ?? '' ) ) ),
				'status'     => (string) ( $order['status'] ?? '' ),
				'issued_at'  => $issued,
				'issued_on'  => $issued ? gmdate( 'M j, Y', $issued ) : '—',
			);
		}
	}
	$out = array_reverse( $out );
	return new WP_REST_Response( array( 'invoices' => array_slice( $out, 0, 25 ) ), 200 );
}

function olkil_payu_handle_notify( WP_REST_Request $request ) {
	$data = array_map( 'sanitize_text_field', (array) $request->get_params() );
	if ( empty( $data ) ) {
		$data = array_map( 'sanitize_text_field', wp_unslash( $_POST ) ); // phpcs:ignore
	}

	// Prefer Firebase S2S fulfillment (credentials live there).
	if ( olkil_payu_backend_up() ) {
		$fb = olkil_payu_backend_request(
			'/v1/webhook',
			array(
				'method' => 'POST',
				'body'   => $data,
			)
		);
		if ( ! is_wp_error( $fb ) ) {
			olkil_payu_fulfill( $data, 'notify-firebase' );
			return new WP_REST_Response( array( 'ok' => true, 'via' => 'firebase' ), 200 );
		}
	}

	$result = olkil_payu_fulfill( $data, 'notify' );
	return new WP_REST_Response( $result, 200 );
}

function olkil_payu_handle_mail_relay( WP_REST_Request $request ) {
	$raw = $request->get_body();
	if ( ! olkil_payu_verify_internal_signature( $raw ) ) {
		return new WP_REST_Response( array( 'ok' => false, 'error' => 'unauthorized' ), 401 );
	}
	$payload = json_decode( (string) $raw, true );
	if ( ! is_array( $payload ) ) {
		return new WP_REST_Response( array( 'ok' => false, 'error' => 'invalid' ), 400 );
	}
	$to      = sanitize_email( (string) ( $payload['to'] ?? '' ) );
	$subject = sanitize_text_field( (string) ( $payload['subject'] ?? 'OLKIL billing' ) );
	$html    = (string) ( $payload['html'] ?? '' );
	$ok      = olkil_payu_send_html_mail( $to, $subject, $html );
	return new WP_REST_Response( array( 'ok' => $ok ), $ok ? 200 : 500 );
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
	olkil_payu_fulfill( $data, 'browser' );
	$txnid = (string) ( $data['txnid'] ?? '' );
	if ( $txnid ) {
		set_transient( 'olkil_payu_last_' . md5( $txnid . wp_salt() ), $data, HOUR_IN_SECONDS );
	}
}
add_action( 'template_redirect', 'olkil_payu_capture_browser_return', 1 );

function olkil_payu_html_body_fragment( $html ) {
	if ( ! is_string( $html ) || '' === $html ) {
		return '';
	}
	if ( preg_match( '/<body[^>]*>(.*)<\/body>/is', $html, $matches ) ) {
		return trim( $matches[1] );
	}
	return $html;
}

function olkil_payu_print_sanitize_fragment( $html ) {
	if ( ! is_string( $html ) || '' === $html ) {
		return '';
	}
	// Flatten nested invoice wrappers so PDF capture doesn't clip left/right.
	$html = preg_replace( '/max-width:\s*640px/i', 'max-width:100%', $html );
	$html = preg_replace( '/margin:\s*24px auto/i', 'margin:0', $html );
	$html = preg_replace( '/padding:\s*0 16px/i', 'padding:0', $html );
	return $html;
}

function olkil_payu_maybe_print_invoice() {
	if ( ! is_page( 'invoice' ) ) {
		return;
	}
	$txnid = isset( $_GET['txnid'] ) ? sanitize_text_field( wp_unslash( $_GET['txnid'] ) ) : ''; // phpcs:ignore
	if ( ! $txnid ) {
		return;
	}
	$order = olkil_payu_get_order( $txnid );
	if ( ! $order || empty( $order['invoice'] ) || ! is_array( $order['invoice'] ) ) {
		return;
	}
	$invoice_html = olkil_payu_invoice_screen_html( $order['invoice'], true );
	nocache_headers();
	status_header( 200 );
	echo '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OLKIL Invoice</title>';
	echo '<style>'
		. '*{box-sizing:border-box}'
		. 'body{margin:0;background:#f4f4f5;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#18181b}'
		. '#olkil-invoice-root{width:100%;max-width:760px;margin:0 auto;padding:16px 12px 8px}'
		. '.olkil-inv-sheet{background:#fff;border:1px solid #e4e4e7;border-radius:16px;overflow:hidden;margin:0 0 20px}'
		. '.olkil-inv-head{padding:20px 24px;background:linear-gradient(135deg,#18181b,#27272a);color:#fff}'
		. '.olkil-inv-brand{display:block;font-size:12px;letter-spacing:.12em;text-transform:uppercase;opacity:.75}'
		. '.olkil-inv-head h1{margin:6px 0 0;font-size:22px;line-height:1.2}'
		. '.olkil-inv-head p{margin:8px 0 0;font-size:13px;opacity:.85}'
		. '.olkil-inv-body{padding:24px;font-size:13px;line-height:1.5}'
		. '.olkil-inv-note{margin:0 0 16px;padding:8px 12px;border-radius:8px;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase}'
		. '.olkil-inv-note--test{background:#fff8e1;border:1px solid #f5d76e;color:#7a5b00}'
		. '.olkil-inv-meta,.olkil-inv-lines{width:100%;border-collapse:collapse;table-layout:fixed}'
		. '.olkil-inv-meta td,.olkil-inv-lines th,.olkil-inv-lines td{padding:8px 0;vertical-align:top;word-wrap:break-word;overflow-wrap:anywhere}'
		. '.olkil-inv-meta__right{text-align:right}'
		. '.olkil-inv-bill{margin:0 0 16px}'
		. '.olkil-inv-lines th,.olkil-inv-lines td{border-bottom:1px solid #e4e4e7}'
		. '.olkil-inv-lines th{text-align:left;font-weight:600}'
		. '.olkil-inv-lines td:last-child,.olkil-inv-lines th:last-child{text-align:right;width:34%}'
		. '.olkil-inv-lines span{color:#71717a}'
		. '.olkil-inv-lines tfoot td{border-top:1px solid #e4e4e7;border-bottom:0;padding-top:10px}'
		. '.olkil-inv-lines--compact td{border:0;padding:10px 14px;background:#fafafa}'
		. '.olkil-inv-lines--compact tr:first-child td{border-radius:12px 12px 0 0}'
		. '.olkil-inv-lines--compact tr:last-child td{border-radius:0 0 12px 12px}'
		. '.olkil-inv-foot{margin:12px 0 0;font-size:12px;color:#52525b}'
		. '@media print{body{background:#fff}#olkil-invoice-root{max-width:none;padding:0}.olkil-inv-sheet{break-inside:avoid;page-break-inside:avoid;border-radius:0;border:0;margin:0 0 12px}}'
		. '</style></head><body>';
	echo '<div id="olkil-invoice-root">';
	echo $invoice_html; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
	echo '</div>';
	echo '<p style="text-align:center;margin:16px 0 40px"><button type="button" id="olkil-download-pdf" style="padding:10px 18px;border:0;border-radius:10px;background:#fe019a;color:#fff;font-weight:600;cursor:pointer">Download PDF</button></p>';
	echo '<script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js"></script>';
	echo '<script>(function(){var btn=document.getElementById("olkil-download-pdf");if(!btn)return;btn.addEventListener("click",function(){var el=document.getElementById("olkil-invoice-root");if(!el||typeof html2pdf==="undefined")return;btn.disabled=true;btn.textContent="Preparing…";window.scrollTo(0,0);html2pdf().set({margin:[8,8,8,8],filename:"olkil-invoice.pdf",image:{type:"jpeg",quality:0.98},html2canvas:{scale:2,useCORS:true,scrollX:0,scrollY:-window.scrollY,windowWidth:document.documentElement.clientWidth},jsPDF:{unit:"mm",format:"a4",orientation:"portrait"},pagebreak:{mode:["css","legacy"]}}).from(el).save().then(function(){btn.disabled=false;btn.textContent="Download PDF";}).catch(function(){btn.disabled=false;btn.textContent="Download PDF";});});})();</script>';
	echo '</body></html>';
	exit;
}
add_action( 'template_redirect', 'olkil_payu_maybe_print_invoice', 2 );

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

	$creds  = olkil_payu_credentials();
	$params = null;
	$action = '';
	$mode   = $creds['mode'];

	$fb = new WP_Error( 'skip', 'offline' );
	if ( olkil_payu_backend_up() ) {
		$fb = olkil_payu_backend_request(
			'/v1/checkout',
			array(
				'method' => 'POST',
				'body'   => array(
					'plan'      => $plan_slug,
					'firstname' => $firstname,
					'email'     => $email,
					'phone'     => $phone,
				),
			)
		);
	}

	if ( ! is_wp_error( $fb ) && ! empty( $fb['params'] ) && ! empty( $fb['action'] ) ) {
		$params = (array) $fb['params'];
		$action = (string) $fb['action'];
		$mode   = (string) ( $fb['mode'] ?? $mode );
		$txnid  = (string) ( $params['txnid'] ?? olkil_payu_new_txnid() );
	} else {
		if ( '' === $creds['key'] || '' === $creds['salt'] ) {
			wp_die( esc_html__( 'Payment gateway is not configured yet.', 'olkil' ) );
		}
		$txnid  = olkil_payu_new_txnid();
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
			'notifyurl'   => rest_url( 'olkil-payu/v1/notify' ),
			'udf1'        => $plan_slug,
			'udf2'        => '',
			'udf3'        => $mode,
			'udf4'        => '',
			'udf5'        => '',
		);
		$params['hash'] = olkil_payu_request_hash( $params );
		$action         = olkil_payu_payment_url();
	}

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
			'mode'       => $mode,
			'via'        => is_wp_error( $fb ) ? 'local' : 'firebase',
		)
	);
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
	if ( is_page( 'invoice' ) ) {
		return olkil_payu_invoice_page_html();
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
	$health = olkil_payu_backend_health();
	$ready  = ( ! empty( $health['ok'] ) ) || ( '' !== $creds['key'] && '' !== $creds['salt'] );
	$mode   = ! empty( $health['mode'] ) ? (string) $health['mode'] : $creds['mode'];
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

			<?php if ( ! $ready ) : ?>
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
				<p class="olkil-payu__secure"><?php esc_html_e( 'UPI · Cards · Netbanking via PayU. You will be redirected to complete payment. Invoice and receipt are emailed after success.', 'olkil' ); ?></p>
			</form>
			<?php if ( 'test' === $mode ) : ?>
				<details class="olkil-payu__test">
					<summary><?php esc_html_e( 'Test mode cards (PayU sandbox)', 'olkil' ); ?></summary>
					<ul>
						<li>Visa: <code>4012001037141112</code> · CVV 123 · Exp 05/30 · OTP 123456</li>
						<li>Mastercard: <code>5123456789012346</code> · CVV 123 · Exp 05/30 · OTP 123456</li>
						<li>UPI: <code>anything@payu</code></li>
						<li>Netbanking: user <code>payu</code> / pass <code>payu</code> · OTP 123456</li>
					</ul>
				</details>
			<?php endif; ?>
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
	$inv   = is_array( $order['invoice'] ?? null ) ? $order['invoice'] : null;

	ob_start();
	?>
	<div class="olkil-payu">
		<div class="olkil-payu__card olkil-payu__card--result">
			<div class="olkil-payu__icon olkil-payu__icon--ok" aria-hidden="true">✓</div>
			<h1><?php esc_html_e( 'Payment successful', 'olkil' ); ?></h1>
			<p><?php esc_html_e( 'Your plan is active. A tax invoice and payment receipt have been emailed to you.', 'olkil' ); ?></p>
			<?php if ( $inv ) : ?>
				<p class="olkil-payu__meta">
					<strong><?php echo esc_html( (string) $inv['invoice_no'] ); ?></strong>
					· <?php echo esc_html( (string) $inv['receipt_no'] ); ?>
					<?php echo $txnid ? ' · ' . esc_html( $txnid ) : ''; ?>
				</p>
			<?php elseif ( $sub && ! empty( $sub['is_paid'] ) ) : ?>
				<p class="olkil-payu__meta">
					<strong><?php echo esc_html( $sub['plan_name'] ); ?></strong>
					· <?php echo esc_html( $sub['tokens_total_label'] ); ?> tokens
					· <?php echo esc_html( $sub['expires_label'] ); ?>
				</p>
			<?php elseif ( $plan ) : ?>
				<p class="olkil-payu__meta"><strong><?php echo esc_html( strtoupper( $plan ) ); ?></strong><?php echo $txnid ? ' · ' . esc_html( $txnid ) : ''; ?></p>
			<?php endif; ?>
			<div class="olkil-payu__actions">
				<?php if ( $txnid ) : ?>
					<a class="olkil-payu__btn" href="<?php echo esc_url( home_url( '/invoice/?txnid=' . rawurlencode( $txnid ) ) ); ?>"><?php esc_html_e( 'View invoice & receipt', 'olkil' ); ?></a>
				<?php endif; ?>
				<a class="olkil-payu__btn" href="<?php echo esc_url( home_url( '/dashboard/' ) ); ?>"><?php esc_html_e( 'Open Dashboard', 'olkil' ); ?></a>
				<a class="olkil-payu__link" href="<?php echo esc_url( home_url( '/profile/' ) ); ?>"><?php esc_html_e( 'View Profile', 'olkil' ); ?></a>
			</div>
			<p class="olkil-payu__secure"><?php esc_html_e( 'Sign in with the same Google/email used at checkout to see your plan badge.', 'olkil' ); ?></p>
		</div>
	</div>
	<?php
	return (string) ob_get_clean();
}

function olkil_payu_invoice_page_html() {
	$txnid = isset( $_GET['txnid'] ) ? sanitize_text_field( wp_unslash( $_GET['txnid'] ) ) : ''; // phpcs:ignore
	$order = $txnid ? olkil_payu_get_order( $txnid ) : null;
	if ( ! $order || empty( $order['invoice_html'] ) ) {
		return '<div class="olkil-payu"><div class="olkil-payu__card olkil-payu__card--result"><h1>' . esc_html__( 'Invoice not found', 'olkil' ) . '</h1><p>' . esc_html__( 'This invoice is not ready yet, or the transaction id is invalid.', 'olkil' ) . '</p><a class="olkil-payu__btn" href="' . esc_url( home_url( '/dashboard/' ) ) . '">Dashboard</a></div></div>';
	}
	return (string) $order['invoice_html'] . (string) ( $order['receipt_html'] ?? '' );
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
	$plans     = olkil_payu_plans();
	$login_url = home_url( '/login/' );
	$logo_url  = trailingslashit( get_theme_root_uri() ) . 'olkil/assets/olkil/img/logo-mark.png';
	ob_start();
	?>
	<div class="olkil-app" id="olkil-dash" data-api="<?php echo esc_url( rest_url( 'olkil-payu/v1/subscription' ) ); ?>">
		<aside class="olkil-app__nav" aria-label="<?php esc_attr_e( 'Account', 'olkil' ); ?>">
			<div class="olkil-app__nav-top">
				<a class="olkil-app__back" href="<?php echo esc_url( home_url( '/' ) ); ?>"><?php esc_html_e( '← Back to site', 'olkil' ); ?></a>
			</div>
			<div class="olkil-app__brand-block">
				<p class="olkil-app__brand">
					<img class="olkil-app__brand-icon" src="<?php echo esc_url( $logo_url ); ?>" width="22" height="22" alt="" decoding="async" />
					<span class="olkil-app__brand-text">OLKIL</span>
				</p>
			</div>
			<nav class="olkil-app__nav-links">
				<a class="is-active" data-view="overview" href="#overview">
					<span class="olkil-app__nav-icon" aria-hidden="true">◈</span>
					<?php esc_html_e( 'Overview', 'olkil' ); ?>
				</a>
				<a data-view="usage" href="#usage">
					<span class="olkil-app__nav-icon" aria-hidden="true">◷</span>
					<?php esc_html_e( 'Usage', 'olkil' ); ?>
				</a>
				<a data-view="invoices" href="#invoices">
					<span class="olkil-app__nav-icon" aria-hidden="true">◫</span>
					<?php esc_html_e( 'Invoices', 'olkil' ); ?>
				</a>
				<a class="olkil-app__nav-external" href="<?php echo esc_url( home_url( '/download/' ) ); ?>">
					<span class="olkil-app__nav-icon" aria-hidden="true">↓</span>
					<?php esc_html_e( 'Download', 'olkil' ); ?>
				</a>
			</nav>
			<div class="olkil-app__user">
				<div class="olkil-app__user-avatar" aria-hidden="true"></div>
				<div class="olkil-app__user-info">
					<strong id="olkil-dash-user-name">Account</strong>
					<span id="olkil-dash-user-plan">Dazzlone</span>
				</div>
			</div>
		</aside>

		<div class="olkil-app__main">
			<div class="olkil-app__canvas">
				<div class="olkil-app__guest" id="olkil-dash-guest">
					<div class="olkil-app__guest-card">
						<p class="olkil-app__kicker"><?php esc_html_e( 'Account', 'olkil' ); ?></p>
						<h1><?php esc_html_e( 'Sign in to your dashboard', 'olkil' ); ?></h1>
						<p><?php esc_html_e( 'Use the same Google or email account you paid with to see plan, usage, expiry, and invoices.', 'olkil' ); ?></p>
						<a class="olkil-app__btn" href="<?php echo esc_url( $login_url ); ?>"><?php esc_html_e( 'Sign in', 'olkil' ); ?></a>
					</div>
				</div>

				<div id="olkil-dash-main" hidden>
					<div class="olkil-app__view" id="olkil-view-overview">
						<header class="olkil-app__head">
							<p class="olkil-app__kicker"><?php esc_html_e( 'Overview', 'olkil' ); ?></p>
							<h1 id="olkil-dash-hello"><?php esc_html_e( 'Welcome back', 'olkil' ); ?></h1>
						</header>

						<section class="olkil-app__hero-card">
							<div class="olkil-app__hero-top">
								<div>
									<h2><?php esc_html_e( 'Usage this period', 'olkil' ); ?></h2>
									<p id="olkil-dash-credits-meta"><?php esc_html_e( 'Your OLKIL plan token allowance for cloud models.', 'olkil' ); ?></p>
								</div>
								<p class="olkil-app__stat" id="olkil-dash-credits-left">—</p>
							</div>
							<div class="olkil-dash__bar" aria-hidden="true"><span id="olkil-dash-bar-fill" style="width:0%"></span></div>
							<p class="olkil-app__upgrade" id="olkil-dash-upgrade" hidden></p>
							<div class="olkil-app__metrics">
								<div class="olkil-app__metric">
									<span class="olkil-app__metric-label"><?php esc_html_e( 'Current plan', 'olkil' ); ?></span>
									<span class="olkil-app__metric-value" id="olkil-dash-plan">Dazzlone</span>
									<span class="olkil-app__metric-hint" id="olkil-dash-plan-note"><?php esc_html_e( 'Free local models', 'olkil' ); ?></span>
								</div>
								<div class="olkil-app__metric">
									<span class="olkil-app__metric-label"><?php esc_html_e( 'Expires', 'olkil' ); ?></span>
									<span class="olkil-app__metric-value" id="olkil-dash-expiry-date">—</span>
									<span class="olkil-app__metric-hint" id="olkil-dash-expiry"><?php esc_html_e( 'Never on the free plan', 'olkil' ); ?></span>
								</div>
							</div>
						</section>

						<section class="olkil-app__section olkil-app__section--plans">
							<div class="olkil-app__section-head">
								<h2><?php esc_html_e( 'Available plans', 'olkil' ); ?></h2>
								<p><?php esc_html_e( 'Upgrade anytime for cloud model tokens.', 'olkil' ); ?></p>
							</div>
							<div class="olkil-dash-plans" id="olkil-dash-plan-cards">
								<?php foreach ( $plans as $slug => $p ) : ?>
									<?php
									$label = str_replace( 'OLKIL ', '', $p['name'] );
									?>
									<div class="olkil-dash-plan" data-plan="<?php echo esc_attr( $slug ); ?>">
										<div class="olkil-dash-plan__body">
											<h3 class="olkil-dash-plan__name"><?php echo esc_html( $label ); ?></h3>
											<p class="olkil-dash-plan__price">₹<?php echo esc_html( number_format( (float) $p['amount'] ) ); ?><span>/mo</span></p>
											<p class="olkil-dash-plan__tokens"><?php echo esc_html( $p['tokens'] ); ?></p>
										</div>
										<div class="olkil-dash-plan__foot">
											<a class="olkil-dash-plan__btn" href="<?php echo esc_url( home_url( '/checkout/?plan=' . $slug ) ); ?>">
												<?php echo esc_html( sprintf( __( 'Upgrade to %s', 'olkil' ), $label ) ); ?>
											</a>
											<span class="olkil-dash-plan__current" hidden><?php esc_html_e( 'Current plan', 'olkil' ); ?></span>
										</div>
									</div>
								<?php endforeach; ?>
							</div>
						</section>

						<section class="olkil-app__section olkil-app__section--compact">
							<div class="olkil-app__section-head olkil-app__section-head--inline">
								<div>
									<h2><?php esc_html_e( 'Billing', 'olkil' ); ?></h2>
									<p><?php esc_html_e( 'Tax invoices after a successful PayU payment.', 'olkil' ); ?></p>
								</div>
								<button class="olkil-app__btn olkil-app__btn--ghost" type="button" data-view="invoices"><?php esc_html_e( 'View invoices', 'olkil' ); ?></button>
							</div>
						</section>
					</div>

					<div class="olkil-app__view" id="olkil-view-usage" hidden>
						<header class="olkil-app__head">
							<p class="olkil-app__kicker"><?php esc_html_e( 'Usage', 'olkil' ); ?></p>
							<h1><?php esc_html_e( 'Token usage', 'olkil' ); ?></h1>
						</header>
						<section class="olkil-app__hero-card">
							<div class="olkil-app__usage-grid">
								<div class="olkil-app__metric">
									<span class="olkil-app__metric-label"><?php esc_html_e( 'Used', 'olkil' ); ?></span>
									<span class="olkil-app__metric-value" id="olkil-usage-used">—</span>
								</div>
								<div class="olkil-app__metric">
									<span class="olkil-app__metric-label"><?php esc_html_e( 'Remaining', 'olkil' ); ?></span>
									<span class="olkil-app__metric-value olkil-app__metric-value--accent" id="olkil-usage-left">—</span>
								</div>
								<div class="olkil-app__metric">
									<span class="olkil-app__metric-label"><?php esc_html_e( 'Plan quota', 'olkil' ); ?></span>
									<span class="olkil-app__metric-value" id="olkil-usage-total">—</span>
								</div>
							</div>
							<div class="olkil-dash__bar olkil-dash__bar--lg" aria-hidden="true"><span id="olkil-usage-fill" style="width:0%"></span></div>
							<p class="olkil-app__hint" id="olkil-usage-note"><?php esc_html_e( 'Sign in to load this billing period.', 'olkil' ); ?></p>
						</section>
						<section class="olkil-app__panel--table">
							<table class="olkil-app__table">
								<thead>
									<tr>
										<th><?php esc_html_e( 'Resource', 'olkil' ); ?></th>
										<th><?php esc_html_e( 'Used', 'olkil' ); ?></th>
										<th><?php esc_html_e( 'Remaining', 'olkil' ); ?></th>
										<th><?php esc_html_e( 'Quota', 'olkil' ); ?></th>
									</tr>
								</thead>
								<tbody>
									<tr>
										<td><?php esc_html_e( 'OLKIL tokens (this period)', 'olkil' ); ?></td>
										<td id="olkil-usage-row-used">—</td>
										<td id="olkil-usage-row-left">—</td>
										<td id="olkil-usage-row-total">—</td>
									</tr>
									<tr>
										<td><?php esc_html_e( 'Requests (this period)', 'olkil' ); ?></td>
										<td id="olkil-usage-req-used">—</td>
										<td>—</td>
										<td><?php esc_html_e( 'All cloud models', 'olkil' ); ?></td>
									</tr>
								</tbody>
							</table>
						</section>
					</div>

					<div class="olkil-app__view" id="olkil-view-invoices" hidden>
						<header class="olkil-app__head">
							<p class="olkil-app__kicker"><?php esc_html_e( 'Billing', 'olkil' ); ?></p>
							<h1><?php esc_html_e( 'Invoice history', 'olkil' ); ?></h1>
						</header>
						<section class="olkil-app__panel--table">
							<table class="olkil-app__table" id="olkil-invoice-table">
								<thead>
									<tr>
										<th><?php esc_html_e( 'Date', 'olkil' ); ?></th>
										<th><?php esc_html_e( 'Invoice', 'olkil' ); ?></th>
										<th><?php esc_html_e( 'Plan', 'olkil' ); ?></th>
										<th><?php esc_html_e( 'Amount', 'olkil' ); ?></th>
										<th><?php esc_html_e( 'Status', 'olkil' ); ?></th>
										<th></th>
									</tr>
								</thead>
								<tbody id="olkil-invoice-body">
									<tr><td colspan="6"><?php esc_html_e( 'No invoices yet.', 'olkil' ); ?></td></tr>
								</tbody>
							</table>
						</section>
					</div>
				</div>
			</div>
		</div>
	</div>
	<?php
	return (string) ob_get_clean();
}

function olkil_payu_enqueue_assets() {
	$need_checkout = is_page( array( 'checkout', 'payment-success', 'payment-failed', 'dashboard', 'invoice' ) );

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
			'invoice'   => home_url( '/invoice/' ),
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
		$mode = sanitize_text_field( wp_unslash( $_POST['mode'] ?? 'test' ) );
		update_option( 'olkil_payu_mode', ( 'live' === $mode ) ? 'live' : 'test', false );
		$fb = esc_url_raw( wp_unslash( $_POST['firebase_url'] ?? '' ) );
		if ( $fb ) {
			update_option( 'olkil_payu_firebase_url', untrailingslashit( $fb ), false );
		}
		$gstin = sanitize_text_field( wp_unslash( $_POST['gstin'] ?? '' ) );
		update_option( 'olkil_payu_gstin', $gstin, false );
		$secret = sanitize_text_field( wp_unslash( $_POST['internal_secret'] ?? '' ) );
		if ( $secret ) {
			update_option( 'olkil_payu_internal_secret', $secret, false );
		}
		delete_transient( 'olkil_payu_fb_health' );
		echo '<div class="updated"><p>Saved. PayU KEY/SALT stay in Firebase — they are not stored from this screen.</p></div>';
	}
	$creds  = olkil_payu_credentials();
	$health = olkil_payu_backend_health();
	$key_hint = $creds['key'] ? ( substr( $creds['key'], 0, 3 ) . '…' ) : '(local fallback empty)';
	?>
	<div class="wrap">
		<h1>OLKIL PayU</h1>
		<p><strong>Credentials live in Firebase</strong> (<code>internal/payuCredentials</code> + Cloud Functions env). WordPress never needs the salt for checkout when Firebase is healthy.</p>
		<table class="widefat striped" style="max-width:720px;margin:1rem 0">
			<tr><th>Firebase backend</th><td><?php echo ! empty( $health['ok'] ) ? '<span style="color:green">online</span>' : '<span style="color:#b32d2e">offline — local secrets.php fallback</span>'; ?></td></tr>
			<tr><th>Mode</th><td><?php echo esc_html( (string) ( $health['mode'] ?? $creds['mode'] ) ); ?></td></tr>
			<tr><th>Key hint</th><td><code><?php echo esc_html( (string) ( $health['keyHint'] ?? $key_hint ) ); ?></code></td></tr>
			<tr><th>Salt</th><td><?php echo ! empty( $health['saltSet'] ) || $creds['salt'] ? 'set (hidden)' : 'missing'; ?></td></tr>
		</table>
		<form method="post">
			<?php wp_nonce_field( 'olkil_payu_admin' ); ?>
			<table class="form-table">
				<tr>
					<th>Firebase Functions URL</th>
					<td><input type="url" name="firebase_url" class="regular-text" value="<?php echo esc_attr( olkil_payu_firebase_url() ); ?>" /></td>
				</tr>
				<tr>
					<th>Internal relay secret</th>
					<td><input type="password" name="internal_secret" class="regular-text" value="" placeholder="Leave blank to keep" autocomplete="new-password" /></td>
				</tr>
				<tr>
					<th>GSTIN (optional)</th>
					<td><input type="text" name="gstin" class="regular-text" value="<?php echo esc_attr( (string) get_option( 'olkil_payu_gstin', '' ) ); ?>" /></td>
				</tr>
				<tr>
					<th>Mode (local fallback)</th>
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
		<p>
			Checkout: <a href="<?php echo esc_url( home_url( '/checkout/?plan=pro' ) ); ?>" target="_blank">/checkout/?plan=pro</a><br />
			WordPress notify (backup): <code><?php echo esc_html( rest_url( 'olkil-payu/v1/notify' ) ); ?></code><br />
			PayU webhook (primary): <code><?php echo esc_html( olkil_payu_firebase_url() . '/v1/webhook' ); ?></code>
		</p>
		<p>In PayU Dashboard → Test mode → Developer → Webhooks, paste the Firebase webhook URL. Also set it as <code>notifyurl</code> (already sent with each payment).</p>
	</div>
	<?php
}
