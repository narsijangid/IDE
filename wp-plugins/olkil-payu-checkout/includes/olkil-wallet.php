<?php
/**
 * OLKIL per-user token wallet.
 *
 * The provider API key is a shared company pool. This file never touches it.
 * Each signed-in user has their own Lite/Pro/Ultra allowance on their account.
 * Every metered request subtracts OLKIL-counted tokens from THAT user only.
 *
 * @package OLKIL
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * OLKIL token count from text (UTF-8 bytes / 4). Same formula as the IDE.
 *
 * @param string $text Text.
 */
function olkil_count_tokens( $text ) {
	$text = (string) $text;
	if ( '' === $text ) {
		return 0;
	}
	$bytes = strlen( $text );
	return (int) ceil( $bytes / 4 );
}

/**
 * Next paid plan to upgrade into (Cursor-style).
 *
 * @param string $plan Current slug.
 */
function olkil_payu_next_plan_slug( $plan ) {
	$plan = sanitize_key( $plan );
	$map  = array(
		'dazzlone' => 'lite',
		'lite'     => 'pro',
		'pro'      => 'ultra',
		'max'      => 'ultra',
		'ultra'    => '',
	);
	return isset( $map[ $plan ] ) ? $map[ $plan ] : 'lite';
}

function olkil_payu_firebase_web_api_key() {
	if ( function_exists( 'olkil_payu_load_dotenv' ) ) {
		olkil_payu_load_dotenv();
	}
	$env = getenv( 'OLKIL_FIREBASE_WEB_API_KEY' );
	if ( $env ) {
		return (string) $env;
	}
	return 'AIzaSyA3z0FDMJrfskddGj4Iair9D2XH3K_IS2k';
}

/**
 * @param string $id_token Firebase ID token.
 * @return array{email:string,uid:string}|WP_Error
 */
function olkil_payu_verify_firebase_id_token( $id_token ) {
	$id_token = trim( (string) $id_token );
	if ( '' === $id_token || substr_count( $id_token, '.' ) < 2 ) {
		return new WP_Error( 'invalid_token', 'invalid_token', array( 'status' => 401 ) );
	}

	$cache_key = 'olkil_payu_tok_' . md5( $id_token );
	$cached    = get_transient( $cache_key );
	if ( is_array( $cached ) && ! empty( $cached['email'] ) ) {
		return $cached;
	}

	$res = wp_remote_post(
		'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' . rawurlencode( olkil_payu_firebase_web_api_key() ),
		array(
			'timeout' => 8,
			'headers' => array( 'Content-Type' => 'application/json' ),
			'body'    => wp_json_encode( array( 'idToken' => $id_token ) ),
		)
	);
	if ( is_wp_error( $res ) ) {
		return new WP_Error( 'token_verify_failed', 'token_verify_failed', array( 'status' => 401 ) );
	}
	$code = (int) wp_remote_retrieve_response_code( $res );
	$data = json_decode( (string) wp_remote_retrieve_body( $res ), true );
	if ( $code >= 400 || ! is_array( $data ) || empty( $data['users'][0] ) ) {
		return new WP_Error( 'unauthorized', 'unauthorized', array( 'status' => 401 ) );
	}
	$email = olkil_payu_email_key( (string) ( $data['users'][0]['email'] ?? '' ) );
	if ( '' === $email || ! is_email( $email ) ) {
		return new WP_Error( 'email_required', 'email_required', array( 'status' => 401 ) );
	}
	$out = array(
		'email' => $email,
		'uid'   => (string) ( $data['users'][0]['localId'] ?? '' ),
	);
	set_transient( $cache_key, $out, 4 * MINUTE_IN_SECONDS );
	return $out;
}

function olkil_payu_request_bearer( WP_REST_Request $request ) {
	$hdr = (string) $request->get_header( 'authorization' );
	if ( 0 === stripos( $hdr, 'bearer ' ) ) {
		return trim( substr( $hdr, 7 ) );
	}
	$token = trim( (string) $request->get_param( 'id_token' ) );
	if ( $token ) {
		return $token;
	}
	$json = $request->get_json_params();
	if ( is_array( $json ) && ! empty( $json['id_token'] ) ) {
		return trim( (string) $json['id_token'] );
	}
	return '';
}

/**
 * @param WP_REST_Request $request Request.
 * @return string|WP_Error
 */
function olkil_payu_authenticated_email( WP_REST_Request $request ) {
	$secret = function_exists( 'olkil_payu_internal_secret' ) ? olkil_payu_internal_secret() : '';
	$hdr    = (string) $request->get_header( 'x-olkil-internal' );
	if ( $secret && $hdr && hash_equals( $secret, $hdr ) ) {
		$email = olkil_payu_email_key( sanitize_email( (string) $request->get_param( 'email' ) ) );
		return ( $email && is_email( $email ) ) ? $email : new WP_Error( 'email_required', 'email_required', array( 'status' => 400 ) );
	}
	$auth = olkil_payu_verify_firebase_id_token( olkil_payu_request_bearer( $request ) );
	if ( is_wp_error( $auth ) ) {
		return $auth;
	}
	return $auth['email'];
}

function olkil_payu_quota_reason( array $sub ) {
	$spendable = (int) ( $sub['spendable_left'] ?? $sub['tokens_left'] ?? 0 );
	if ( $spendable > 0 ) {
		return 'ok';
	}
	if ( ! empty( $sub['is_paid'] ) || ! empty( $sub['held_plans'] ) ) {
		return 'quota_exceeded';
	}
	return ! empty( $sub['is_expired'] ) ? 'expired' : 'plan_required';
}

function olkil_payu_quota_message( $reason, array $sub ) {
	$plan      = (string) ( $sub['plan_name'] ?? 'Dazzlone' );
	$next      = (string) ( $sub['next_plan_name'] ?? 'Pro' );
	$next_slug = (string) ( $sub['next_plan'] ?? 'pro' );
	if ( 'ok' === $reason ) {
		return '';
	}
	if ( 'quota_exceeded' === $reason ) {
		$again = (string) ( $sub['plan_name'] ?? 'Lite' );
		$msg   = 'You have used all ' . ( $sub['tokens_total_label'] ?? '' ) . ' tokens on ' . $plan . ' this period. Buy ' . $again . ' again for a fresh allowance and a new 30-day window from today.';
		if ( $next_slug ) {
			$msg .= ' Or upgrade to ' . $next . ' for a larger quota.';
		}
		return $msg;
	}
	if ( 'expired' === $reason ) {
		return 'Your paid plan has expired. You are on free Dazzlone (local models). Renew or upgrade at olkil.com/pricing.';
	}
	return 'Cloud models need an OLKIL Lite, Pro, or Ultra plan. You are on ' . $plan . '. Upgrade at olkil.com/pricing, or use Dazzlone / local Ollama.';
}

function olkil_payu_usage_lock( $email ) {
	$name    = '_olkil_payu_ulock_' . md5( olkil_payu_email_key( $email ) );
	$now     = time();
	$timeout = 8;
	for ( $i = 0; $i < 30; $i++ ) {
		if ( add_option( $name, (string) $now, '', 'no' ) ) {
			return $name;
		}
		$existing = (int) get_option( $name, 0 );
		if ( $existing > 0 && ( $now - $existing ) > $timeout ) {
			update_option( $name, (string) $now, false );
			return $name;
		}
		usleep( 40000 );
	}
	return $name;
}

function olkil_payu_usage_unlock( $lock_name ) {
	if ( $lock_name ) {
		delete_option( $lock_name );
	}
}

function olkil_payu_raw_subscription_row( $email ) {
	$key = olkil_payu_email_key( $email );
	$all = get_option( 'olkil_payu_subscriptions', array() );
	if ( ! is_array( $all ) || empty( $all[ $key ] ) || ! is_array( $all[ $key ] ) ) {
		return array(
			'email'         => $key,
			'plan'          => 'dazzlone',
			'status'        => 'active',
			'tokens_total'  => 0,
			'tokens_used'   => 0,
			'requests_used' => 0,
		);
	}
	$row          = $all[ $key ];
	$row['email'] = $key;
	return $row;
}

function olkil_payu_put_subscription_row( $email, array $row ) {
	$key = olkil_payu_email_key( $email );
	$all = get_option( 'olkil_payu_subscriptions', array() );
	if ( ! is_array( $all ) ) {
		$all = array();
	}
	$row['email']      = $key;
	$row['updated_at'] = gmdate( 'c' );
	$all[ $key ]       = $row;
	update_option( 'olkil_payu_subscriptions', $all, false );
}

function olkil_payu_check_quota( $email ) {
	$sub     = olkil_payu_get_subscription( $email );
	$reason  = olkil_payu_quota_reason( $sub );
	$allowed = 'ok' === $reason;
	return array(
		'ok'            => true,
		'allowed'       => $allowed,
		'cloud_allowed' => $allowed,
		'reason'        => $reason,
		'message'       => olkil_payu_quota_message( $reason, $sub ),
		'upgrade_url'   => (string) ( $sub['upgrade_url'] ?? '' ),
		'next_plan'     => (string) ( $sub['next_plan'] ?? '' ),
		'subscription'  => $sub,
	);
}

/**
 * Charge OLKIL tokens to one user account only.
 *
 * @param string              $email Email.
 * @param int                 $tokens Combined input+output OLKIL tokens.
 * @param array<string,mixed> $meta  request_id, model, provider, input_tokens, output_tokens.
 * @return array<string,mixed>
 */
function olkil_payu_charge_user_tokens( $email, $tokens, array $meta = array() ) {
	$tokens      = (int) $tokens;
	$request_id  = sanitize_text_field( (string) ( $meta['request_id'] ?? '' ) );
	$model       = sanitize_text_field( (string) ( $meta['model'] ?? '' ) );
	$provider    = sanitize_key( (string) ( $meta['provider'] ?? '' ) );
	$input_tok   = max( 0, (int) ( $meta['input_tokens'] ?? 0 ) );
	$output_tok  = max( 0, (int) ( $meta['output_tokens'] ?? 0 ) );

	if ( $tokens < 1 && ( $input_tok + $output_tok ) > 0 ) {
		$tokens = $input_tok + $output_tok;
	}
	if ( $tokens < 0 ) {
		$tokens = 0;
	}
	if ( $tokens > 50000000 ) {
		$tokens = 50000000;
	}

	$lock = olkil_payu_usage_lock( $email );
	$out  = null;
	try {
		$row = olkil_payu_raw_subscription_row( $email );
		$row = olkil_payu_ingest_paid_orders_into_row( $email, $row );
		$row = olkil_payu_migrate_entitlements_row( $row );
		$sub = olkil_payu_enrich_subscription( array_merge( $row, array( 'email' => olkil_payu_email_key( $email ) ) ) );
		$ids = isset( $row['usage_ids'] ) && is_array( $row['usage_ids'] ) ? $row['usage_ids'] : array();

		if ( $request_id && isset( $ids[ $request_id ] ) ) {
			$out = array(
				'ok'           => true,
				'deduped'      => true,
				'consumed'     => 0,
				'allowed'      => 'ok' === olkil_payu_quota_reason( $sub ),
				'reason'       => olkil_payu_quota_reason( $sub ),
				'message'      => olkil_payu_quota_message( olkil_payu_quota_reason( $sub ), $sub ),
				'upgrade_url'  => (string) ( $sub['upgrade_url'] ?? '' ),
				'subscription' => $sub,
			);
		} elseif ( 'ok' !== olkil_payu_quota_reason( $sub ) ) {
			$reason = olkil_payu_quota_reason( $sub );
			$out    = array(
				'ok'           => false,
				'consumed'     => 0,
				'allowed'      => false,
				'reason'       => $reason,
				'message'      => olkil_payu_quota_message( $reason, $sub ),
				'upgrade_url'  => (string) ( $sub['upgrade_url'] ?? '' ),
				'subscription' => $sub,
			);
		} elseif ( $tokens < 1 ) {
			$out = array(
				'ok'           => true,
				'consumed'     => 0,
				'allowed'      => true,
				'reason'       => 'ok',
				'message'      => '',
				'subscription' => $sub,
			);
		} else {
			$row  = olkil_payu_migrate_entitlements_row( $row );
			$ents = olkil_payu_prune_entitlements( isset( $row['entitlements'] ) && is_array( $row['entitlements'] ) ? $row['entitlements'] : array() );
			$order = array();
			foreach ( $ents as $i => $ent ) {
				$order[] = array(
					'i'    => $i,
					'rank' => olkil_payu_plan_rank( $ent['plan'] ?? '' ),
				);
			}
			usort(
				$order,
				static function ( $a, $b ) {
					return (int) $b['rank'] - (int) $a['rank'];
				}
			);
			$left_to_charge = $tokens;
			foreach ( $order as $item ) {
				if ( $left_to_charge < 1 ) {
					break;
				}
				$i    = (int) $item['i'];
				$slot = olkil_payu_entitlement_left( $ents[ $i ] );
				if ( $slot < 1 ) {
					continue;
				}
				$take                         = min( $left_to_charge, $slot );
				$ents[ $i ]['tokens_used']    = max( 0, (int) ( $ents[ $i ]['tokens_used'] ?? 0 ) ) + $take;
				$ents[ $i ]['requests_used']  = max( 0, (int) ( $ents[ $i ]['requests_used'] ?? 0 ) ) + ( $take === $left_to_charge || $take === $slot ? 1 : 0 );
				$left_to_charge              -= $take;
			}
			if ( $left_to_charge > 0 && ! empty( $order ) ) {
				$i                         = (int) $order[0]['i'];
				$ents[ $i ]['tokens_used'] = max( 0, (int) ( $ents[ $i ]['tokens_used'] ?? 0 ) ) + $left_to_charge;
			}
			$row['entitlements']  = $ents;
			$row['requests_used'] = max( 0, (int) ( $row['requests_used'] ?? 0 ) ) + 1;
			$row                  = olkil_payu_sync_legacy_plan_fields( $row );
			if ( $request_id ) {
				$ids[ $request_id ] = $tokens;
				if ( count( $ids ) > 80 ) {
					$ids = array_slice( $ids, -40, null, true );
				}
				$row['usage_ids'] = $ids;
			}
			$log   = isset( $row['usage_log'] ) && is_array( $row['usage_log'] ) ? $row['usage_log'] : array();
			$log[] = array(
				'at'       => gmdate( 'c' ),
				'tokens'   => $tokens,
				'model'    => $model,
				'provider' => $provider,
			);
			$row['usage_log'] = array_slice( $log, -40 );
			olkil_payu_put_subscription_row( $email, $row );
			$sub    = olkil_payu_enrich_subscription( array_merge( $row, array( 'email' => olkil_payu_email_key( $email ) ) ) );
			$reason = olkil_payu_quota_reason( $sub );
			$out    = array(
				'ok'           => true,
				'consumed'     => $tokens,
				'allowed'      => 'ok' === $reason,
				'reason'       => $reason,
				'message'      => olkil_payu_quota_message( $reason, $sub ),
				'upgrade_url'  => (string) ( $sub['upgrade_url'] ?? '' ),
				'subscription' => $sub,
			);
		}
	} finally {
		olkil_payu_usage_unlock( $lock );
	}

	return is_array( $out ) ? $out : array(
		'ok'      => false,
		'reason'  => 'error',
		'message' => 'usage_failed',
	);
}

function olkil_payu_rest_quota( WP_REST_Request $request ) {
	$email = olkil_payu_authenticated_email( $request );
	if ( is_wp_error( $email ) ) {
		return $email;
	}
	$response = new WP_REST_Response( olkil_payu_check_quota( $email ), 200 );
	$response->header( 'Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0' );
	$response->header( 'X-LiteSpeed-Cache-Control', 'no-cache' );
	return $response;
}

function olkil_payu_request_value( WP_REST_Request $request, $key, $default = '' ) {
	$json = $request->get_json_params();
	if ( is_array( $json ) && array_key_exists( $key, $json ) ) {
		return $json[ $key ];
	}
	$v = $request->get_param( $key );
	return ( null === $v || '' === $v ) ? $default : $v;
}

function olkil_payu_rest_usage( WP_REST_Request $request ) {
	$email = olkil_payu_authenticated_email( $request );
	if ( is_wp_error( $email ) ) {
		return $email;
	}

	$input_text  = (string) olkil_payu_request_value( $request, 'input_text' );
	$output_text = (string) olkil_payu_request_value( $request, 'output_text' );
	$input_tok   = (int) olkil_payu_request_value( $request, 'input_tokens', 0 );
	$output_tok  = (int) olkil_payu_request_value( $request, 'output_tokens', 0 );
	$tokens      = (int) olkil_payu_request_value( $request, 'tokens', 0 );

	if ( $input_text ) {
		$input_tok = max( $input_tok, olkil_count_tokens( $input_text ) );
	}
	if ( $output_text ) {
		$output_tok = max( $output_tok, olkil_count_tokens( $output_text ) );
	}
	if ( $tokens < 1 ) {
		$tokens = $input_tok + $output_tok;
	}

	$result = olkil_payu_charge_user_tokens(
		$email,
		$tokens,
		array(
			'model'         => (string) olkil_payu_request_value( $request, 'model' ),
			'provider'      => (string) olkil_payu_request_value( $request, 'provider' ),
			'request_id'    => (string) olkil_payu_request_value( $request, 'request_id' ),
			'input_tokens'  => $input_tok,
			'output_tokens' => $output_tok,
		)
	);
	$code = ! empty( $result['ok'] ) || ! empty( $result['deduped'] ) ? 200 : ( 'quota_exceeded' === ( $result['reason'] ?? '' ) ? 402 : 403 );
	$response = new WP_REST_Response( $result, $code );
	$response->header( 'Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0' );
	$response->header( 'X-LiteSpeed-Cache-Control', 'no-cache' );
	return $response;
}
