<?php
/**
 * Firebase PayU backend client. KEY/SALT never leave Cloud Functions / Firestore internal/.
 *
 * @package OLKIL
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

function olkil_payu_firebase_url() {
	if ( function_exists( 'olkil_payu_load_dotenv' ) ) {
		olkil_payu_load_dotenv();
	}
	$env = getenv( 'OLKIL_PAYU_FIREBASE_URL' );
	if ( $env ) {
		return untrailingslashit( (string) $env );
	}
	$url = (string) get_option( 'olkil_payu_firebase_url', '' );
	if ( '' === $url ) {
		$url = 'https://asia-south1-olkil-2c8ac.cloudfunctions.net/olkilPayuApi';
	}
	return untrailingslashit( $url );
}

function olkil_payu_internal_secret() {
	if ( function_exists( 'olkil_payu_load_dotenv' ) ) {
		olkil_payu_load_dotenv();
	}
	if ( defined( 'OLKIL_PAYU_INTERNAL_SECRET' ) && OLKIL_PAYU_INTERNAL_SECRET ) {
		return (string) OLKIL_PAYU_INTERNAL_SECRET;
	}
	$env = getenv( 'OLKIL_PAYU_INTERNAL_SECRET' );
	if ( $env ) {
		return (string) $env;
	}
	$secrets_file = OLKIL_PAYU_CHECKOUT_DIR . 'secrets.php';
	if ( file_exists( $secrets_file ) ) {
		$s = include $secrets_file;
		if ( is_array( $s ) && ! empty( $s['internal_secret'] ) ) {
			return (string) $s['internal_secret'];
		}
	}
	return (string) get_option( 'olkil_payu_internal_secret', '' );
}

function olkil_payu_backend_request( $path, $args = array() ) {
	$method  = strtoupper( (string) ( $args['method'] ?? 'GET' ) );
	$body    = $args['body'] ?? null;
	$headers = array(
		'Accept' => 'application/json',
	);
	$secret = olkil_payu_internal_secret();
	if ( $secret ) {
		$headers['X-OLKIL-Internal'] = $secret;
	}
	if ( ! empty( $args['id_token'] ) ) {
		$headers['Authorization'] = 'Bearer ' . $args['id_token'];
	}
	if ( null !== $body ) {
		$headers['Content-Type'] = 'application/json';
	}

	$res = wp_remote_request(
		olkil_payu_firebase_url() . $path,
		array(
			'method'  => $method,
			'timeout' => isset( $args['timeout'] ) ? (int) $args['timeout'] : 12,
			'headers' => $headers,
			'body'    => null !== $body ? wp_json_encode( $body ) : null,
		)
	);

	if ( is_wp_error( $res ) ) {
		return $res;
	}
	$code = (int) wp_remote_retrieve_response_code( $res );
	$raw  = (string) wp_remote_retrieve_body( $res );
	$data = json_decode( $raw, true );
	if ( $code >= 400 ) {
		return new WP_Error(
			'firebase_backend',
			is_array( $data ) && ! empty( $data['error'] ) ? (string) $data['error'] : 'backend_http_' . $code,
			array(
				'status' => $code,
				'body'   => $data,
			)
		);
	}
	return is_array( $data ) ? $data : array();
}

function olkil_payu_backend_health() {
	$cached = get_transient( 'olkil_payu_fb_health' );
	if ( is_array( $cached ) ) {
		return $cached;
	}
	$res = olkil_payu_backend_request( '/v1/health', array( 'timeout' => 4 ) );
	if ( is_wp_error( $res ) ) {
		$out = array(
			'ok'    => false,
			'error' => $res->get_error_message(),
		);
		set_transient( 'olkil_payu_fb_health', $out, 30 );
		return $out;
	}
	$res['ok'] = ! empty( $res['ok'] );
	set_transient( 'olkil_payu_fb_health', $res, 60 );
	return $res;
}

function olkil_payu_backend_up() {
	$h = olkil_payu_backend_health();
	return ! empty( $h['ok'] );
}
