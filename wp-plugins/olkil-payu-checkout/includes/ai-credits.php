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

/** Platform share of the payment (basis points). 1500 = 15%. */
function olkil_payu_platform_fee_bps() {
	return 1500;
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
		'lite'  => 3.0,
		'pro'   => 10.0,
		'ultra' => 49.0,
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

/** Prior 25%-fee credit totals — remap onto 15% fee keeping % used. */
function olkil_payu_previous_credit_budgets() {
	return array( 2250000, 7500000, 15000000, 36750000 );
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
 * USD per million tokens: [input, output, cache_read]. Conservative default = Sonnet.
 *
 * @return array{0:float,1:float,2:float}
 */
function olkil_payu_model_usd_per_million( $model ) {
	$slug = strtolower( trim( (string) $model ) );
	$slug = preg_replace( '/^openrouter:/', '', $slug );
	$table = array(
		'anthropic/claude-sonnet-5'   => array( 2.0, 10.0, 0.2 ),
		'anthropic/claude-opus-5'     => array( 5.0, 25.0, 0.5 ),
		'openai/gpt-5.6-sol'          => array( 2.0, 10.0, 0.2 ),
		'openai/gpt-5.6-luna'         => array( 0.2, 1.2, 0.02 ),
		'x-ai/grok-4.6'               => array( 2.0, 6.0, 0.5 ),
		'deepseek/deepseek-v4-flash'  => array( 0.09, 0.18, 0.018 ),
		'google/gemini-3.8-flash'     => array( 0.75, 3.75, 0.075 ),
		'google/gemini-3.5-flash'     => array( 1.5, 9.0, 0.15 ),
		'moonshotai/kimi-k2.7-code'   => array( 0.71, 3.5, 0.15 ),
	);
	if ( isset( $table[ $slug ] ) ) {
		return $table[ $slug ];
	}
	foreach ( $table as $id => $prices ) {
		if ( $slug && false !== strpos( $id, $slug ) ) {
			return $prices;
		}
	}
	return array( 2.0, 10.0, 0.2 );
}

/**
 * @param array<string,mixed> $meta Usage payload.
 * @param int                 $token_hint Combined tokens if cost missing.
 */
function olkil_payu_usage_to_credit_units( array $meta, $token_hint = 0 ) {
	$cost = (float) ( $meta['cost_usd'] ?? 0 );
	if ( $cost > 0 && $cost < 25 ) {
		return max( 1, (int) round( $cost * olkil_payu_usd_micros() ) );
	}

	$input  = max( 0, (int) ( $meta['input_tokens'] ?? 0 ) );
	$output = max( 0, (int) ( $meta['output_tokens'] ?? 0 ) );
	$hit    = max( 0, (int) ( $meta['prompt_cache_hit_tokens'] ?? 0 ) );
	$miss   = max( 0, (int) ( $meta['prompt_cache_miss_tokens'] ?? 0 ) );
	if ( $input < 1 && $output < 1 ) {
		$input = max( 0, (int) $token_hint );
	}
	if ( $miss < 1 && $hit > 0 && $input >= $hit ) {
		$miss = $input - $hit;
	} elseif ( $miss < 1 && $hit < 1 ) {
		$miss = $input;
	}

	$prices = olkil_payu_model_usd_per_million( (string) ( $meta['model'] ?? '' ) );
	$usd    = ( $miss / 1000000 ) * $prices[0] + ( $hit / 1000000 ) * $prices[2] + ( $output / 1000000 ) * $prices[1];
	$units  = (int) round( $usd * olkil_payu_usd_micros() );
	if ( $units < 1 && ( $input + $output ) > 0 ) {
		$units = 1;
	}
	$max = 8 * olkil_payu_usd_micros();
	if ( $units > $max ) {
		$units = $max;
	}
	return max( 0, $units );
}
