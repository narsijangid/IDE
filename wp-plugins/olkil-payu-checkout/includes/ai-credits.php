<?php
/**
 * Paid-plan AI credit: user pays USD, OLKIL keeps a platform share,
 * the rest is real OpenRouter spend (Trae/Cursor-style).
 *
 * Internal unit = USD microdollar (1 USD = 1,000,000). Entitlement fields
 * stay named tokens_* for storage compatibility.
 *
 * @package OLKIL
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/** Platform share of the payment (basis points). 2500 = 25%. User wallet = 75%. */
function olkil_payu_platform_fee_bps() {
	return 2500;
}

function olkil_payu_usd_micros() {
	return 1000000;
}

/**
 * AI wallet for a plan, in micros.
 *
 * @param string $plan Slug.
 */
function olkil_payu_ai_credit_micros( $plan ) {
	$plan     = sanitize_key( $plan );
	$defaults = array(
		'lite'  => 10.0,
		'pro'   => 20.0,
		'ultra' => 100.0,
		'max'   => 20.0,
	);
	$usd      = isset( $defaults[ $plan ] ) ? (float) $defaults[ $plan ] : 0.0;
	$plans    = function_exists( 'olkil_payu_plans' ) ? olkil_payu_plans() : array();
	if ( isset( $plans[ $plan ]['usd'] ) && '' !== (string) $plans[ $plan ]['usd'] ) {
		$usd = (float) $plans[ $plan ]['usd'];
	}
	if ( $usd <= 0 ) {
		return 0;
	}
	$keep = ( 10000 - olkil_payu_platform_fee_bps() ) / 10000;
	return (int) round( $usd * olkil_payu_usd_micros() * $keep );
}

/**
 * @param int $micros Credit micros.
 */
function olkil_payu_format_usd_micros( $micros ) {
	$micros = (int) $micros;
	$usd    = $micros / olkil_payu_usd_micros();
	if ( abs( $usd ) >= 1 ) {
		return '$' . number_format( $usd, 2, '.', '' );
	}
	if ( abs( $usd ) >= 0.01 ) {
		return '$' . number_format( $usd, 2, '.', '' );
	}
	return '$' . number_format( $usd, 4, '.', '' );
}

function olkil_payu_legacy_token_budgets() {
	return array( 100000000, 350000000, 1000000000, 2000000000 );
}

/** Prior fee credit totals — remap onto the current 25% fee, keeping % used. */
function olkil_payu_previous_credit_budgets() {
	return array(
		2250000,
		7500000,
		15000000,
		36750000,
		2550000,
		8500000,
		17000000,
		41650000,
	);
}

/**
 * Convert an old 100M-token entitlement onto the AI-credit scale, keeping % used.
 *
 * @param array<string,mixed> $ent Entitlement.
 * @return array<string,mixed>
 */
function olkil_payu_entitlement_to_ai_credits( array $ent ) {
	$plan      = sanitize_key( (string) ( $ent['plan'] ?? '' ) );
	$new_total = olkil_payu_ai_credit_micros( $plan );
	$old_total = (int) ( $ent['tokens_total'] ?? 0 );
	if ( $new_total < 1 ) {
		return $ent;
	}
	if ( $old_total === $new_total ) {
		return $ent;
	}
	$legacy = in_array( $old_total, olkil_payu_legacy_token_budgets(), true )
		|| in_array( $old_total, olkil_payu_previous_credit_budgets(), true )
		|| $old_total >= 50000000;
	if ( ! $legacy ) {
		if ( $old_total < 1 ) {
			$ent['tokens_total'] = $new_total;
			$ent['tokens_used']  = 0;
		}
		return $ent;
	}
	$used = max( 0, (int) ( $ent['tokens_used'] ?? 0 ) );
	$pct  = $old_total > 0 ? min( 1, $used / $old_total ) : 0;
	$ent['tokens_total'] = $new_total;
	$ent['tokens_used']  = (int) min( $new_total, round( $pct * $new_total ) );
	return $ent;
}

/**
 * Live USD-per-token rates for one OpenRouter model id.
 * The catalog is every model OpenRouter lists, cached for a few hours.
 *
 * @return array{prompt:float,completion:float,cache_read:float,cache_write:float,reasoning:float}|null
 */
function olkil_payu_openrouter_token_rates( $model ) {
	$slug = strtolower( trim( (string) $model ) );
	$slug = preg_replace( '/^openrouter:/', '', $slug );
	if ( '' === $slug ) {
		return null;
	}
	$all = get_transient( 'olkil_or_token_rates' );
	if ( ! is_array( $all ) ) {
		$res = wp_remote_get(
			'https://openrouter.ai/api/v1/models',
			array(
				'timeout' => 20,
				'headers' => array(
					'HTTP-Referer' => 'https://olkil.com',
					'X-Title'      => 'OLKIL',
				),
			)
		);
		if ( is_wp_error( $res ) ) {
			return null;
		}
		$json = json_decode( (string) wp_remote_retrieve_body( $res ), true );
		$rows = is_array( $json['data'] ?? null ) ? $json['data'] : array();
		$all  = array();
		foreach ( $rows as $row ) {
			if ( ! is_array( $row ) ) {
				continue;
			}
			$id = strtolower( trim( (string) ( $row['id'] ?? '' ) ) );
			$p  = $row['pricing'] ?? null;
			if ( '' === $id || ! is_array( $p ) ) {
				continue;
			}
			$prompt     = (float) ( $p['prompt'] ?? 0 );
			$completion = (float) ( $p['completion'] ?? 0 );
			if ( $prompt <= 0 && $completion <= 0 ) {
				continue;
			}
			$all[ $id ] = array(
				'prompt'      => $prompt,
				'completion'  => $completion,
				'cache_read'  => (float) ( $p['input_cache_read'] ?? 0 ),
				'cache_write' => (float) ( $p['input_cache_write'] ?? 0 ),
				'reasoning'   => (float) ( $p['internal_reasoning'] ?? 0 ),
			);
		}
		if ( $all ) {
			set_transient( 'olkil_or_token_rates', $all, 6 * HOUR_IN_SECONDS );
		}
	}
	return isset( $all[ $slug ] ) && is_array( $all[ $slug ] ) ? $all[ $slug ] : null;
}

/**
 * @param array<string,mixed> $meta Usage payload.
 * @param int                 $token_hint Combined tokens if cost missing.
 */
function olkil_payu_usage_to_credit_units( array $meta, $token_hint = 0 ) {
	$cost = (float) ( $meta['cost_usd'] ?? 0 );
	if ( $cost > 0 && $cost < 500 ) {
		return max( 1, (int) round( $cost * olkil_payu_usd_micros() ) );
	}

	$input  = max( 0, (int) ( $meta['input_tokens'] ?? 0 ) );
	$output = max( 0, (int) ( $meta['output_tokens'] ?? 0 ) );
	$hit    = max( 0, (int) ( $meta['prompt_cache_hit_tokens'] ?? 0 ) );
	if ( $input < 1 && $output < 1 ) {
		$input = max( 0, (int) $token_hint );
	}

	$rates = olkil_payu_openrouter_token_rates( (string) ( $meta['model'] ?? '' ) );
	if ( ! is_array( $rates ) ) {
		return 0;
	}
	$cache_read = min( $hit, $input );
	$room       = max( 0, $input - $cache_read );
	$write      = $rates['cache_write'] > 0 ? min( max( 0, (int) ( $meta['cache_write_tokens'] ?? 0 ) ), $room ) : 0;
	$fresh      = $room - $write;
	$reasoning  = max( 0, (int) ( $meta['reasoning_tokens'] ?? 0 ) );
	$read_rate  = $rates['cache_read'] > 0 ? $rates['cache_read'] : $rates['prompt'];
	$output_usd = 0.0;
	if ( $rates['reasoning'] > 0 && $reasoning > 0 && $reasoning <= $output ) {
		$output_usd = ( ( $output - $reasoning ) * $rates['completion'] ) + ( $reasoning * $rates['reasoning'] );
	} elseif ( $reasoning > $output ) {
		$reason_rate = $rates['reasoning'] > 0 ? $rates['reasoning'] : $rates['completion'];
		$output_usd  = ( $output * $rates['completion'] ) + ( $reasoning * $reason_rate );
	} else {
		$billed     = $output > 0 ? $output : $reasoning;
		$output_usd = $billed * $rates['completion'];
	}
	$usd = ( $fresh * $rates['prompt'] ) + ( $cache_read * $read_rate ) + ( $write * $rates['cache_write'] ) + $output_usd;
	if ( $usd <= 0 || $usd >= 500 ) {
		return 0;
	}
	$units  = (int) round( $usd * olkil_payu_usd_micros() );
	if ( $units < 1 && ( $input + $output ) > 0 ) {
		$units = 1;
	}
	return max( 0, $units );
}
