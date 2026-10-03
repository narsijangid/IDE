<?php
/**
 * Cloud model broker.
 *
 * The OpenRouter key stays on the server, AES-256-GCM encrypted.
 * Clients receive a short-lived olk1 grant and a broker URL. They never
 * receive the provider key, and the grant is useless on openrouter.ai.
 *
 * @package OLKIL
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

if ( ! function_exists( 'str_starts_with' ) ) {
	/**
	 * @param string $haystack Haystack.
	 * @param string $needle Needle.
	 */
	function str_starts_with( $haystack, $needle ) {
		return 0 === strncmp( (string) $haystack, (string) $needle, strlen( (string) $needle ) );
	}
}

if ( ! function_exists( 'str_contains' ) ) {
	/**
	 * @param string $haystack Haystack.
	 * @param string $needle Needle.
	 */
	function str_contains( $haystack, $needle ) {
		return false !== strpos( (string) $haystack, (string) $needle );
	}
}

/**
 * 32-byte key-encryption key. File is gitignored and denied over HTTP.
 *
 * @return string Raw key, or empty.
 */
function olkil_broker_kek() {
	static $kek = null;
	if ( null !== $kek ) {
		return $kek;
	}
	$kek  = '';
	$file = OLKIL_PAYU_CHECKOUT_DIR . 'engine-kek.php';
	if ( is_readable( $file ) ) {
		$encoded = include $file;
		$raw     = base64_decode( (string) $encoded, true );
		if ( is_string( $raw ) && 32 === strlen( $raw ) ) {
			$kek = $raw;
		}
	}
	return $kek;
}

/**
 * @return string
 */
function olkil_broker_mac_key() {
	$kek = olkil_broker_kek();
	if ( '' === $kek ) {
		return '';
	}
	return hash( 'sha256', 'olkil-broker-v1|' . $kek, true );
}

/**
 * Decrypt the OpenRouter key. Empty when the vault or KEK is missing.
 *
 * @return string
 */
function olkil_broker_openrouter_key() {
	static $plain = null;
	if ( null !== $plain ) {
		return $plain;
	}
	$plain = '';
	$kek   = olkil_broker_kek();
	$file  = OLKIL_PAYU_CHECKOUT_DIR . 'engine-vault.php';
	if ( '' === $kek || ! is_readable( $file ) ) {
		return $plain;
	}
	$vault = include $file;
	$blob  = is_array( $vault ) ? (string) ( $vault['openrouter'] ?? '' ) : '';
	$raw   = base64_decode( $blob, true );
	if ( ! is_string( $raw ) || strlen( $raw ) < 29 ) {
		return $plain;
	}
	$iv  = substr( $raw, 0, 12 );
	$tag = substr( $raw, 12, 16 );
	$ct  = substr( $raw, 28 );
	$got = openssl_decrypt( $ct, 'aes-256-gcm', $kek, OPENSSL_RAW_DATA, $iv, $tag );
	if ( is_string( $got ) && str_starts_with( $got, 'sk-or-v1-' ) ) {
		$plain = $got;
	}
	return $plain;
}

/**
 * @return string
 */
function olkil_broker_base_url() {
	return untrailingslashit( home_url( '/wp-json/olkil-payu/v1/broker/v1' ) );
}

/**
 * 12-hour grant. Bound to one email. Not an OpenRouter key.
 *
 * @param string $email Email.
 * @return string
 */
function olkil_broker_issue_grant( $email ) {
	$mac = olkil_broker_mac_key();
	if ( '' === $mac ) {
		return '';
	}
	$email = olkil_payu_email_key( $email );
	$body  = wp_json_encode(
		array(
			'e' => $email,
			'x' => time() + 12 * HOUR_IN_SECONDS,
		)
	);
	$body  = rtrim( strtr( base64_encode( (string) $body ), '+/', '-_' ), '=' );
	$sig   = rtrim( strtr( base64_encode( hash_hmac( 'sha256', $body, $mac, true ) ), '+/', '-_' ), '=' );
	return 'olk1.' . $body . '.' . $sig;
}

/**
 * @param string $grant Grant.
 * @return string|WP_Error Email.
 */
function olkil_broker_verify_grant( $grant ) {
	$grant = trim( (string) $grant );
	$parts = explode( '.', $grant );
	if ( 3 !== count( $parts ) || 'olk1' !== $parts[0] ) {
		return new WP_Error( 'unauthorized', 'unauthorized', array( 'status' => 401 ) );
	}
	$mac = olkil_broker_mac_key();
	if ( '' === $mac ) {
		return new WP_Error( 'engine_unconfigured', 'engine_unconfigured', array( 'status' => 503 ) );
	}
	$expect = rtrim( strtr( base64_encode( hash_hmac( 'sha256', $parts[1], $mac, true ) ), '+/', '-_' ), '=' );
	if ( ! hash_equals( $expect, $parts[2] ) ) {
		return new WP_Error( 'unauthorized', 'unauthorized', array( 'status' => 401 ) );
	}
	$json = base64_decode( strtr( $parts[1], '-_', '+/' ), true );
	$data = is_string( $json ) ? json_decode( $json, true ) : null;
	$email = is_array( $data ) ? olkil_payu_email_key( (string) ( $data['e'] ?? '' ) ) : '';
	$exp   = is_array( $data ) ? (int) ( $data['x'] ?? 0 ) : 0;
	if ( '' === $email || ! is_email( $email ) || $exp < time() ) {
		return new WP_Error( 'unauthorized', 'unauthorized', array( 'status' => 401 ) );
	}
	return $email;
}

/**
 * @param WP_REST_Request $request Request.
 * @return string|WP_Error
 */
function olkil_broker_email_from_request( WP_REST_Request $request ) {
	$header = (string) $request->get_header( 'authorization' );
	$grant  = '';
	if ( stripos( $header, 'bearer ' ) === 0 ) {
		$grant = trim( substr( $header, 7 ) );
	}
	if ( '' === $grant ) {
		$grant = trim( (string) $request->get_param( 'key' ) );
	}
	return olkil_broker_verify_grant( $grant );
}

/**
 * @param string $email Email.
 * @return true|WP_Error
 */
function olkil_broker_allow( $email ) {
	$quota = olkil_payu_check_quota( $email );
	if ( ! empty( $quota['allowed'] ) || ! empty( $quota['cloud_allowed'] ) ) {
		return true;
	}
	$reason = (string) ( $quota['reason'] ?? 'plan_required' );
	$code   = ( 'quota_exceeded' === $reason ) ? 402 : 403;
	return new WP_Error( $reason, (string) ( $quota['message'] ?? $reason ), array( 'status' => $code ) );
}

/**
 * @param string $path Upstream path.
 * @return bool
 */
function olkil_broker_path_allowed( $path ) {
	return (bool) preg_match( '#^(chat/completions|models|generation)$#', $path );
}

/**
 * Pull token and dollar usage out of a JSON or SSE body.
 *
 * @param string $body Body or tail.
 * @return array<string,mixed>
 */
function olkil_broker_extract_usage( $body ) {
	$out = array(
		'model'            => '',
		'prompt'           => 0,
		'completion'       => 0,
		'total'            => 0,
		'cost_usd'         => 0.0,
		'cache_hit'        => 0,
		'cache_miss'       => 0,
		'reasoning'        => 0,
	);
	$pieces = preg_split( "/\r?\n/", (string) $body );
	if ( ! is_array( $pieces ) ) {
		return $out;
	}
	foreach ( $pieces as $line ) {
		$line = trim( (string) $line );
		if ( str_starts_with( $line, 'data:' ) ) {
			$line = trim( substr( $line, 5 ) );
		}
		if ( '' === $line || '[DONE]' === $line || '{' !== $line[0] ) {
			continue;
		}
		$row = json_decode( $line, true );
		if ( ! is_array( $row ) ) {
			continue;
		}
		if ( ! empty( $row['model'] ) ) {
			$out['model'] = (string) $row['model'];
		}
		$usage = array();
		if ( isset( $row['usage'] ) && is_array( $row['usage'] ) ) {
			$usage = $row['usage'];
		} elseif ( isset( $row['data'] ) && is_array( $row['data'] ) ) {
			$usage = $row['data'];
		}
		if ( ! $usage ) {
			continue;
		}
		$out['prompt']     = max( $out['prompt'], (int) ( $usage['prompt_tokens'] ?? $usage['native_tokens_prompt'] ?? 0 ) );
		$out['completion'] = max( $out['completion'], (int) ( $usage['completion_tokens'] ?? $usage['native_tokens_completion'] ?? 0 ) );
		$out['total']      = max( $out['total'], (int) ( $usage['total_tokens'] ?? 0 ) );
		$out['cache_hit']  = max( $out['cache_hit'], (int) ( $usage['prompt_cache_hit_tokens'] ?? $usage['native_tokens_cached'] ?? 0 ) );
		$out['reasoning']  = max( $out['reasoning'], (int) ( $usage['reasoning_tokens'] ?? 0 ) );
		$cost              = $usage['cost'] ?? $usage['total_cost'] ?? $row['total_cost'] ?? 0;
		if ( (float) $cost > $out['cost_usd'] ) {
			$out['cost_usd'] = (float) $cost;
		}
	}
	if ( $out['total'] < 1 ) {
		$out['total'] = $out['prompt'] + $out['completion'];
	}
	return $out;
}

/**
 * Proxy one OpenAI-compatible call. The provider key is attached here only.
 *
 * @param WP_REST_Request $request Request.
 * @return void
 */
function olkil_broker_proxy( WP_REST_Request $request ) {
	$email = olkil_broker_email_from_request( $request );
	if ( is_wp_error( $email ) ) {
		status_header( (int) ( $email->get_error_data()['status'] ?? 401 ) );
		wp_send_json( array( 'error' => $email->get_error_code() ) );
	}
	$allowed = olkil_broker_allow( $email );
	if ( is_wp_error( $allowed ) ) {
		status_header( (int) ( $allowed->get_error_data()['status'] ?? 403 ) );
		wp_send_json( array( 'error' => $allowed->get_error_code(), 'message' => $allowed->get_error_message() ) );
	}

	$key = olkil_broker_openrouter_key();
	if ( '' === $key ) {
		status_header( 503 );
		wp_send_json( array( 'error' => 'engine_unconfigured' ) );
	}

	$path = ltrim( (string) $request->get_param( 'path' ), '/' );
	if ( ! olkil_broker_path_allowed( $path ) ) {
		status_header( 404 );
		wp_send_json( array( 'error' => 'not_found' ) );
	}

	$bucket = 'olkil_brk_' . md5( $email );
	$hits   = (int) get_transient( $bucket );
	if ( $hits > 60 ) {
		status_header( 429 );
		wp_send_json( array( 'error' => 'rate_limited' ) );
	}
	set_transient( $bucket, $hits + 1, MINUTE_IN_SECONDS );

	$method = strtoupper( (string) $request->get_method() );
	$body   = (string) $request->get_body();
	if ( strlen( $body ) > 8 * 1024 * 1024 ) {
		status_header( 413 );
		wp_send_json( array( 'error' => 'body_too_large' ) );
	}
	if ( 'POST' === $method && str_contains( $path, 'chat/completions' ) && '' !== $body ) {
		$decoded = json_decode( $body, true );
		if ( is_array( $decoded ) ) {
			unset( $decoded['api_key'], $decoded['apiKey'] );
			if ( ! empty( $decoded['stream'] ) ) {
				$decoded['stream_options'] = array( 'include_usage' => true );
			}
			$body = (string) wp_json_encode( $decoded );
		}
	}

	$query = $request->get_query_params();
	unset( $query['key'], $query['rest_route'] );
	$url = 'https://openrouter.ai/api/v1/' . $path;
	if ( $query ) {
		$url .= '?' . http_build_query( $query );
	}

	$upstream_type = 'application/json';
	$status        = 502;
	$tail          = '';
	$headers_sent  = false;

	while ( ob_get_level() > 0 ) {
		ob_end_clean();
	}
	if ( function_exists( 'set_time_limit' ) ) {
		set_time_limit( 300 );
	}

	$send_headers = static function () use ( &$headers_sent, &$status, &$upstream_type ) {
		if ( $headers_sent ) {
			return;
		}
		$headers_sent = true;
		status_header( $status >= 100 ? $status : 502 );
		header( 'Content-Type: ' . ( $upstream_type ? $upstream_type : 'application/json' ) );
		header( 'Cache-Control: no-store' );
		header( 'X-Accel-Buffering: no' );
	};
	$header_fn = static function ( $ch, $header ) use ( &$upstream_type, &$status ) {
		unset( $ch );
		$len  = strlen( $header );
		$trim = trim( $header );
		if ( preg_match( '#^HTTP/\S+\s+(\d+)#', $trim, $m ) ) {
			$status = (int) $m[1];
		} elseif ( stripos( $trim, 'content-type:' ) === 0 ) {
			$upstream_type = trim( substr( $trim, strlen( 'content-type:' ) ) );
		}
		return $len;
	};
	$write_fn = static function ( $ch, $data ) use ( &$tail, $send_headers ) {
		unset( $ch );
		$send_headers();
		echo $data;
		if ( function_exists( 'flush' ) ) {
			flush();
		}
		$tail .= $data;
		if ( strlen( $tail ) > 250000 ) {
			$tail = substr( $tail, -250000 );
		}
		return strlen( $data );
	};

	$ch = curl_init( $url );
	if ( false === $ch ) {
		status_header( 502 );
		wp_send_json( array( 'error' => 'upstream_unavailable' ) );
	}
	$headers = array(
		'Authorization: Bearer ' . $key,
		'Content-Type: application/json',
		'HTTP-Referer: https://olkil.com',
		'X-Title: OLKIL',
		'X-OpenRouter-Title: OLKIL',
	);
	$opts = array(
		CURLOPT_CUSTOMREQUEST  => $method,
		CURLOPT_HTTPHEADER     => $headers,
		CURLOPT_HEADERFUNCTION => $header_fn,
		CURLOPT_WRITEFUNCTION  => $write_fn,
		CURLOPT_TIMEOUT        => 300,
		CURLOPT_CONNECTTIMEOUT => 15,
	);
	if ( 'POST' === $method || 'PUT' === $method ) {
		$opts[ CURLOPT_POSTFIELDS ] = $body;
	}
	curl_setopt_array( $ch, $opts );

	$ok = curl_exec( $ch );
	if ( false === $ok && ! $headers_sent ) {
		status_header( 502 );
		echo wp_json_encode( array( 'error' => 'upstream_unavailable' ) );
		curl_close( $ch );
		exit;
	}
	curl_close( $ch );
	if ( ! $headers_sent ) {
		$send_headers();
	}

	if ( 'POST' === $method && 'chat/completions' === $path ) {
		$usage = olkil_broker_extract_usage( $tail );
		if ( $usage['total'] > 0 || $usage['cost_usd'] > 0 ) {
			olkil_payu_charge_user_tokens(
				$email,
				(int) $usage['total'],
				array(
					'request_id'               => 'brk_' . md5( $email . '|' . microtime( true ) . '|' . wp_rand() ),
					'model'                    => $usage['model'] ? $usage['model'] : 'openrouter',
					'provider'                 => 'openrouter',
					'input_tokens'             => $usage['prompt'],
					'output_tokens'            => $usage['completion'],
					'cost_usd'                 => $usage['cost_usd'],
					'prompt_cache_hit_tokens'  => $usage['cache_hit'],
					'prompt_cache_miss_tokens' => $usage['cache_miss'],
					'reasoning_tokens'         => $usage['reasoning'],
				)
			);
		}
	}
	exit;
}
