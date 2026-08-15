<?php
/**
 * OLKIL subscriptions / entitlements (email-keyed).
 *
 * @package OLKIL
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Token budgets per plan.
 *
 * @return array<string,int>
 */
function olkil_payu_token_budgets() {
	return array(
		'dazzlone' => 0,
		'lite'     => 100000000,
		'pro'      => 350000000,
		'max'      => 1000000000,
		'ultra'    => 2000000000,
	);
}

/**
 * @param string $email Email.
 */
function olkil_payu_email_key( $email ) {
	return strtolower( trim( (string) $email ) );
}

/**
 * @param int $n Token count.
 */
function olkil_payu_format_tokens( $n ) {
	$n = (float) $n;
	if ( $n <= 0 ) {
		return '0';
	}
	if ( $n >= 1000000000 ) {
		$v = $n / 1000000000;
		return rtrim( rtrim( number_format( $v, 2, '.', '' ), '0' ), '.' ) . 'B';
	}
	if ( $n >= 1000000 ) {
		$v = $n / 1000000;
		return rtrim( rtrim( number_format( $v, 1, '.', '' ), '0' ), '.' ) . 'M';
	}
	if ( $n >= 1000 ) {
		return number_format( $n / 1000, 0 ) . 'K';
	}
	return (string) (int) $n;
}

/**
 * Free / default entitlement.
 *
 * @param string $email Email.
 * @return array<string,mixed>
 */
function olkil_payu_default_subscription( $email = '' ) {
	return array(
		'email'         => olkil_payu_email_key( $email ),
		'plan'          => 'dazzlone',
		'plan_name'     => 'Dazzlone',
		'status'        => 'active',
		'tokens_total'  => 0,
		'tokens_used'   => 0,
		'tokens_left'   => 0,
		'percent_used'  => 0,
		'percent_left'  => 100,
		'started_at'    => '',
		'expires_at'    => '',
		'expires_label' => 'Never (free local)',
		'days_left'     => null,
		'txnid'         => '',
		'is_paid'       => false,
		'is_expired'    => false,
	);
}

/**
 * Normalize + enrich subscription for API/UI.
 *
 * @param array<string,mixed> $sub Raw.
 * @return array<string,mixed>
 */
function olkil_payu_enrich_subscription( array $sub ) {
	$plans   = olkil_payu_plans();
	$plan    = sanitize_key( (string) ( $sub['plan'] ?? 'dazzlone' ) );
	$budgets = olkil_payu_token_budgets();
	$total   = isset( $sub['tokens_total'] ) ? (int) $sub['tokens_total'] : (int) ( $budgets[ $plan ] ?? 0 );
	$used    = max( 0, (int) ( $sub['tokens_used'] ?? 0 ) );
	$left    = max( 0, $total - $used );
	$expires = (string) ( $sub['expires_at'] ?? '' );
	$now     = time();
	$exp_ts  = $expires ? strtotime( $expires ) : 0;
	$expired = $exp_ts > 0 && $exp_ts < $now;

	if ( $expired || ( ! empty( $sub['status'] ) && 'expired' === $sub['status'] ) ) {
		$out               = olkil_payu_default_subscription( (string) ( $sub['email'] ?? '' ) );
		$out['is_expired'] = true;
		$out['expired_plan'] = $plan;
		$out['expires_at'] = $expires;
		$out['expires_label'] = $expires ? gmdate( 'M j, Y', $exp_ts ) . ' (expired)' : 'Expired';
		return $out;
	}

	$pct_used = $total > 0 ? (int) min( 100, round( ( $used / $total ) * 100 ) ) : 0;
	$pct_left = 100 - $pct_used;
	$days     = null;
	$label    = 'Never (free local)';
	if ( $exp_ts > 0 ) {
		$days  = (int) max( 0, ceil( ( $exp_ts - $now ) / DAY_IN_SECONDS ) );
		$label = gmdate( 'M j, Y', $exp_ts );
		if ( null !== $days ) {
			$label .= ' · ' . $days . ' day' . ( 1 === $days ? '' : 's' ) . ' left';
		}
	}

	$plan_name = isset( $plans[ $plan ] ) ? str_replace( 'OLKIL ', '', $plans[ $plan ]['name'] ) : ( 'dazzlone' === $plan ? 'Dazzlone' : ucfirst( $plan ) );

	return array(
		'email'              => olkil_payu_email_key( (string) ( $sub['email'] ?? '' ) ),
		'plan'               => $plan,
		'plan_name'          => $plan_name,
		'status'             => (string) ( $sub['status'] ?? 'active' ),
		'tokens_total'       => $total,
		'tokens_used'        => $used,
		'tokens_left'        => $left,
		'tokens_total_label' => olkil_payu_format_tokens( $total ),
		'tokens_used_label'  => olkil_payu_format_tokens( $used ),
		'tokens_left_label'  => olkil_payu_format_tokens( $left ),
		'percent_used'       => $pct_used,
		'percent_left'       => $pct_left,
		'started_at'         => (string) ( $sub['started_at'] ?? '' ),
		'expires_at'         => $expires,
		'expires_label'      => $label,
		'days_left'          => $days,
		'txnid'              => (string) ( $sub['txnid'] ?? '' ),
		'is_paid'            => 'dazzlone' !== $plan && $total > 0,
		'is_expired'         => false,
	);
}

/**
 * @param string $email Email.
 * @return array<string,mixed>
 */
function olkil_payu_get_subscription( $email ) {
	$key = olkil_payu_email_key( $email );
	if ( '' === $key || ! is_email( $key ) ) {
		return olkil_payu_enrich_subscription( olkil_payu_default_subscription() );
	}
	$all = get_option( 'olkil_payu_subscriptions', array() );
	if ( ! is_array( $all ) || empty( $all[ $key ] ) || ! is_array( $all[ $key ] ) ) {
		return olkil_payu_enrich_subscription( olkil_payu_default_subscription( $key ) );
	}
	$sub          = $all[ $key ];
	$sub['email'] = $key;
	return olkil_payu_enrich_subscription( $sub );
}

/**
 * Activate / renew a paid plan for 30 days.
 *
 * @param string $email Email.
 * @param string $plan  Plan slug.
 * @param string $txnid Txn id.
 */
function olkil_payu_activate_subscription( $email, $plan, $txnid = '' ) {
	$key   = olkil_payu_email_key( $email );
	$plan  = sanitize_key( $plan );
	$plans = olkil_payu_plans();
	if ( '' === $key || ! isset( $plans[ $plan ] ) ) {
		return false;
	}

	$budgets = olkil_payu_token_budgets();
	$all     = get_option( 'olkil_payu_subscriptions', array() );
	if ( ! is_array( $all ) ) {
		$all = array();
	}

	$started = gmdate( 'c' );
	$expires = gmdate( 'c', time() + ( 30 * DAY_IN_SECONDS ) );

	$all[ $key ] = array(
		'email'        => $key,
		'plan'         => $plan,
		'status'       => 'active',
		'tokens_total' => (int) ( $budgets[ $plan ] ?? 0 ),
		'tokens_used'  => 0,
		'started_at'   => $started,
		'expires_at'   => $expires,
		'txnid'        => (string) $txnid,
		'updated_at'   => $started,
	);

	update_option( 'olkil_payu_subscriptions', $all, false );
	return true;
}

/**
 * Apply successful PayU payload to subscription.
 *
 * @param array<string,string> $data PayU fields.
 */
function olkil_payu_maybe_activate_from_payment( array $data ) {
	$status = strtolower( (string) ( $data['status'] ?? '' ) );
	if ( ! in_array( $status, array( 'success', 'captured' ), true ) ) {
		return;
	}
	$email = sanitize_email( (string) ( $data['email'] ?? '' ) );
	$plan  = sanitize_key( (string) ( $data['udf1'] ?? '' ) );
	$txnid = sanitize_text_field( (string) ( $data['txnid'] ?? '' ) );

	if ( ! $plan && $txnid ) {
		$order = olkil_payu_get_order( $txnid );
		if ( $order ) {
			$plan  = sanitize_key( (string) ( $order['plan'] ?? '' ) );
			$email = $email ?: sanitize_email( (string) ( $order['email'] ?? '' ) );
		}
	}

	if ( $email && $plan ) {
		olkil_payu_activate_subscription( $email, $plan, $txnid );
	}
}
