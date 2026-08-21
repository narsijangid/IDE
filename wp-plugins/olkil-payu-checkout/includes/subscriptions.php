<?php
/**
 * OLKIL subscriptions / entitlements (email-keyed).
 *
 * Paid plans stack. Higher plan is current; lower unexpired plans stay on hold
 * with their remaining tokens. Each plan's 30-day window is independent — when
 * it ends, leftover tokens on that plan are gone. Spend highest leftover first.
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
function olkil_payu_format_tokens_exact( $n ) {
	return number_format( max( 0, (int) $n ), 0, '.', ',' );
}

/**
 * Compact label (350M). Used alongside exact counts so small usage is still visible.
 *
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
		return rtrim( rtrim( number_format( $v, 2, '.', '' ), '0' ), '.' ) . 'M';
	}
	if ( $n >= 1000 ) {
		return rtrim( rtrim( number_format( $n / 1000, 1, '.', '' ), '0' ), '.' ) . 'K';
	}
	return (string) (int) $n;
}

function olkil_payu_format_percent_left( $used, $total ) {
	$used  = max( 0, (int) $used );
	$total = max( 0, (int) $total );
	if ( $total <= 0 ) {
		return '100%';
	}
	if ( $used <= 0 ) {
		return '100%';
	}
	$left = max( 0, ( 1 - ( $used / $total ) ) * 100 );
	if ( $left >= 99.9999 ) {
		return '99.9999%';
	}
	if ( $left >= 99.99 ) {
		return number_format( $left, 4, '.', '' ) . '%';
	}
	if ( $left >= 99 ) {
		return number_format( $left, 2, '.', '' ) . '%';
	}
	return number_format( $left, 1, '.', '' ) . '%';
}

function olkil_payu_plan_rank( $plan ) {
	$map = array(
		'dazzlone' => 0,
		'lite'     => 1,
		'pro'      => 2,
		'max'      => 3,
		'ultra'    => 4,
	);
	$plan = sanitize_key( $plan );
	return isset( $map[ $plan ] ) ? (int) $map[ $plan ] : 0;
}

function olkil_payu_plan_display_name( $plan ) {
	$plans = function_exists( 'olkil_payu_plans' ) ? olkil_payu_plans() : array();
	$plan  = sanitize_key( $plan );
	if ( isset( $plans[ $plan ] ) ) {
		return str_replace( 'OLKIL ', '', $plans[ $plan ]['name'] );
	}
	return 'dazzlone' === $plan ? 'Dazzlone' : ucfirst( $plan );
}

/**
 * Free / default entitlement.
 *
 * @param string $email Email.
 * @return array<string,mixed>
 */
function olkil_payu_default_subscription( $email = '' ) {
	return array(
		'email'           => olkil_payu_email_key( $email ),
		'plan'            => 'dazzlone',
		'plan_name'       => 'Dazzlone',
		'status'          => 'active',
		'tokens_total'    => 0,
		'tokens_used'     => 0,
		'tokens_left'     => 0,
		'spendable_left'  => 0,
		'requests_used'   => 0,
		'percent_used'    => 0,
		'percent_left'    => 100,
		'started_at'      => '',
		'started_on'      => '',
		'expires_at'      => '',
		'expires_on'      => '',
		'expires_label'   => 'Never (free local)',
		'days_left'       => null,
		'txnid'           => '',
		'is_paid'         => false,
		'is_expired'      => false,
		'held_plans'      => array(),
		'entitlements'    => array(),
	);
}

function olkil_payu_entitlement_exp_ts( array $ent ) {
	$expires = (string) ( $ent['expires_at'] ?? '' );
	return $expires ? (int) strtotime( $expires ) : 0;
}

function olkil_payu_entitlement_expired( array $ent, $now = 0 ) {
	$now    = $now ? (int) $now : time();
	$exp_ts = olkil_payu_entitlement_exp_ts( $ent );
	return $exp_ts > 0 && $exp_ts < $now;
}

function olkil_payu_entitlement_left( array $ent, $now = 0 ) {
	if ( olkil_payu_entitlement_expired( $ent, $now ) ) {
		return 0;
	}
	$total = (int) ( $ent['tokens_total'] ?? 0 );
	$used  = max( 0, (int) ( $ent['tokens_used'] ?? 0 ) );
	return max( 0, $total - $used );
}

/**
 * @param array<int,array<string,mixed>> $ents Entitlements.
 * @return array<int,array<string,mixed>>
 */
function olkil_payu_prune_entitlements( array $ents, $now = 0 ) {
	$now  = $now ? (int) $now : time();
	$keep = array();
	foreach ( $ents as $ent ) {
		if ( ! is_array( $ent ) ) {
			continue;
		}
		$plan = sanitize_key( (string) ( $ent['plan'] ?? '' ) );
		if ( ! $plan || 'dazzlone' === $plan ) {
			continue;
		}
		if ( olkil_payu_entitlement_expired( $ent, $now ) ) {
			continue;
		}
		$keep[] = $ent;
	}
	return array_values( $keep );
}

/**
 * Highest unexpired plan (current purchased plan).
 *
 * @param array<int,array<string,mixed>> $ents Entitlements.
 * @return array<string,mixed>|null
 */
function olkil_payu_highest_entitlement( array $ents ) {
	$best      = null;
	$best_rank = -1;
	foreach ( $ents as $ent ) {
		$rank = olkil_payu_plan_rank( $ent['plan'] ?? '' );
		if ( $rank > $best_rank ) {
			$best_rank = $rank;
			$best      = $ent;
		}
	}
	return $best;
}

/**
 * Highest plan that still has remaining tokens (what cloud requests spend).
 *
 * @param array<int,array<string,mixed>> $ents Entitlements.
 * @return array<string,mixed>|null
 */
function olkil_payu_drawing_entitlement( array $ents, $now = 0 ) {
	$best      = null;
	$best_rank = -1;
	foreach ( $ents as $ent ) {
		if ( olkil_payu_entitlement_left( $ent, $now ) <= 0 ) {
			continue;
		}
		$rank = olkil_payu_plan_rank( $ent['plan'] ?? '' );
		if ( $rank > $best_rank ) {
			$best_rank = $rank;
			$best      = $ent;
		}
	}
	return $best;
}

/**
 * @param array<string,mixed> $row Raw option row.
 * @return array<string,mixed>
 */
function olkil_payu_migrate_entitlements_row( array $row ) {
	if ( ! empty( $row['entitlements'] ) && is_array( $row['entitlements'] ) ) {
		return $row;
	}
	$plan  = sanitize_key( (string) ( $row['plan'] ?? 'dazzlone' ) );
	$total = (int) ( $row['tokens_total'] ?? 0 );
	if ( $plan && 'dazzlone' !== $plan && $total > 0 ) {
		$row['entitlements'] = array(
			array(
				'plan'          => $plan,
				'tokens_total'  => $total,
				'tokens_used'   => max( 0, (int) ( $row['tokens_used'] ?? 0 ) ),
				'requests_used' => max( 0, (int) ( $row['requests_used'] ?? 0 ) ),
				'started_at'    => (string) ( $row['started_at'] ?? '' ),
				'expires_at'    => (string) ( $row['expires_at'] ?? '' ),
				'txnid'         => (string) ( $row['txnid'] ?? '' ),
				'status'        => 'active',
			),
		);
	} else {
		$row['entitlements'] = array();
	}
	return $row;
}

/**
 * Mirror drawing/highest entitlement onto legacy single-plan fields.
 *
 * @param array<string,mixed> $row Raw.
 * @return array<string,mixed>
 */
function olkil_payu_sync_legacy_plan_fields( array $row ) {
	$ents = isset( $row['entitlements'] ) && is_array( $row['entitlements'] ) ? $row['entitlements'] : array();
	$ents = olkil_payu_prune_entitlements( $ents );
	$row['entitlements'] = $ents;

	$current = olkil_payu_highest_entitlement( $ents );
	if ( ! $current ) {
		$prev                = sanitize_key( (string) ( $row['plan'] ?? 'dazzlone' ) );
		$row['plan']         = 'dazzlone';
		$row['status']       = ( $prev && 'dazzlone' !== $prev ) ? 'expired' : 'active';
		$row['tokens_total'] = 0;
		$row['tokens_used']  = 0;
		$row['started_at']   = '';
		if ( $prev && 'dazzlone' !== $prev ) {
			$row['expired_plan'] = $prev;
		}
		return $row;
	}

	$row['plan']         = sanitize_key( (string) ( $current['plan'] ?? 'dazzlone' ) );
	$row['status']       = 'active';
	$row['tokens_total'] = (int) ( $current['tokens_total'] ?? 0 );
	$row['tokens_used']  = max( 0, (int) ( $current['tokens_used'] ?? 0 ) );
	$row['started_at']   = (string) ( $current['started_at'] ?? '' );
	$row['expires_at']   = (string) ( $current['expires_at'] ?? '' );
	$row['txnid']        = (string) ( $current['txnid'] ?? '' );
	$req                 = 0;
	foreach ( $ents as $ent ) {
		$req += max( 0, (int) ( $ent['requests_used'] ?? 0 ) );
	}
	if ( $req > 0 ) {
		$row['requests_used'] = $req;
	}
	return $row;
}

function olkil_payu_entitlement_txnids( array $ents ) {
	$ids = array();
	foreach ( $ents as $ent ) {
		$txn = (string) ( $ent['txnid'] ?? '' );
		if ( $txn ) {
			$ids[ $txn ] = true;
		}
	}
	return $ids;
}

/**
 * Repair missing upgrades from paid orders (e.g. Pro paid while Lite stayed current).
 *
 * @param string               $email Email.
 * @param array<string,mixed>  $row   Raw row.
 * @return array<string,mixed>
 */
function olkil_payu_ingest_paid_orders_into_row( $email, array $row ) {
	$email = olkil_payu_email_key( $email );
	$plans = function_exists( 'olkil_payu_plans' ) ? olkil_payu_plans() : array();
	$all   = get_option( 'olkil_payu_orders', array() );
	if ( ! is_array( $all ) || ! $email ) {
		return $row;
	}

	$row  = olkil_payu_migrate_entitlements_row( $row );
	$ents = isset( $row['entitlements'] ) && is_array( $row['entitlements'] ) ? $row['entitlements'] : array();
	$ents = olkil_payu_prune_entitlements( $ents );
	$seen = olkil_payu_entitlement_txnids( $ents );
	$now  = time();
	$added = false;

	foreach ( $all as $order ) {
		if ( ! is_array( $order ) ) {
			continue;
		}
		if ( olkil_payu_email_key( (string) ( $order['email'] ?? '' ) ) !== $email ) {
			continue;
		}
		$status = strtolower( (string) ( $order['status'] ?? '' ) );
		if ( ! in_array( $status, array( 'success', 'captured', 'completed' ), true ) && empty( $order['fulfilled'] ) ) {
			continue;
		}
		$plan = sanitize_key( (string) ( $order['plan'] ?? '' ) );
		if ( ! $plan || ! isset( $plans[ $plan ] ) ) {
			continue;
		}
		$txnid = (string) ( $order['txnid'] ?? '' );
		if ( ! $txnid || isset( $seen[ $txnid ] ) ) {
			continue;
		}
		$paid_raw = $order['paid_at'] ?? $order['created_at'] ?? '';
		$paid_ts  = $paid_raw ? (int) strtotime( (string) $paid_raw ) : 0;
		if ( $paid_ts < 1 ) {
			continue;
		}
		if ( ( $paid_ts + ( 30 * DAY_IN_SECONDS ) ) < $now ) {
			continue;
		}
		$ents = olkil_payu_upsert_entitlement(
			$ents,
			$plan,
			$txnid,
			$paid_ts
		);
		if ( $txnid ) {
			$seen[ $txnid ] = true;
		}
		$added = true;
	}

	if ( $added ) {
		$row['entitlements'] = $ents;
		$row                 = olkil_payu_sync_legacy_plan_fields( $row );
	}
	return $row;
}

/**
 * @param array<int,array<string,mixed>> $ents  Existing.
 * @param string                         $plan  Slug.
 * @param string                         $txnid Txn.
 * @param int                            $started_ts Unix start.
 * @return array<int,array<string,mixed>>
 */
function olkil_payu_upsert_entitlement( array $ents, $plan, $txnid = '', $started_ts = 0 ) {
	$plan       = sanitize_key( $plan );
	$budgets    = olkil_payu_token_budgets();
	$started_ts = $started_ts ? (int) $started_ts : time();
	$fresh      = array(
		'plan'          => $plan,
		'tokens_total'  => (int) ( $budgets[ $plan ] ?? 0 ),
		'tokens_used'   => 0,
		'requests_used' => 0,
		'started_at'    => gmdate( 'c', $started_ts ),
		'expires_at'    => gmdate( 'c', $started_ts + ( 30 * DAY_IN_SECONDS ) ),
		'txnid'         => (string) $txnid,
		'status'        => 'active',
	);

	$replaced = false;
	foreach ( $ents as $i => $ent ) {
		if ( sanitize_key( (string) ( $ent['plan'] ?? '' ) ) !== $plan ) {
			continue;
		}
		$existing_txn = (string) ( $ent['txnid'] ?? '' );
		if ( $txnid && $existing_txn === $txnid ) {
			return $ents;
		}
		$existing_ts = ! empty( $ent['started_at'] ) ? (int) strtotime( (string) $ent['started_at'] ) : 0;
		if ( $existing_ts > 0 && $started_ts <= $existing_ts ) {
			return $ents;
		}
		$ents[ $i ] = $fresh;
		$replaced   = true;
		break;
	}
	if ( ! $replaced ) {
		$ents[] = $fresh;
	}

	$highest = olkil_payu_highest_entitlement( $ents );
	$hplan   = $highest ? sanitize_key( (string) ( $highest['plan'] ?? '' ) ) : '';
	foreach ( $ents as $i => $ent ) {
		$p = sanitize_key( (string) ( $ent['plan'] ?? '' ) );
		$ents[ $i ]['status'] = ( $p === $hplan ) ? 'active' : 'held';
	}
	return array_values( $ents );
}

/**
 * Normalize + enrich subscription for API/UI.
 *
 * @param array<string,mixed> $sub Raw.
 * @return array<string,mixed>
 */
function olkil_payu_enrich_subscription( array $sub ) {
	$sub     = olkil_payu_migrate_entitlements_row( $sub );
	$ents    = olkil_payu_prune_entitlements( isset( $sub['entitlements'] ) && is_array( $sub['entitlements'] ) ? $sub['entitlements'] : array() );
	$email   = olkil_payu_email_key( (string) ( $sub['email'] ?? '' ) );
	$now     = time();
	$current = olkil_payu_highest_entitlement( $ents );
	$drawing = olkil_payu_drawing_entitlement( $ents, $now );

	if ( ! $current ) {
		$out                 = olkil_payu_default_subscription( $email );
		$had_paid            = ( ! empty( $sub['expired_plan'] ) && 'dazzlone' !== sanitize_key( (string) $sub['expired_plan'] ) )
			|| ( ! empty( $sub['plan'] ) && 'dazzlone' !== sanitize_key( (string) $sub['plan'] ) );
		$out['is_expired']   = (bool) $had_paid;
		$out['expired_plan'] = sanitize_key( (string) ( $sub['expired_plan'] ?? $sub['plan'] ?? '' ) );
		$out['expires_at']   = (string) ( $sub['expires_at'] ?? '' );
		$exp_ts              = $out['expires_at'] ? strtotime( $out['expires_at'] ) : 0;
		$out['expires_on']   = $exp_ts ? gmdate( 'M j, Y', $exp_ts ) : '';
		$out['expires_label'] = $out['is_expired']
			? ( $out['expires_on'] ? $out['expires_on'] . ' (expired)' : 'Expired' )
			: 'Never (free local)';
		$out['next_plan']      = 'lite';
		$out['next_plan_name'] = 'Lite';
		$out['upgrade_url']    = home_url( '/checkout/?plan=lite' );
		$out['renew_url']      = home_url( '/checkout/?plan=lite' );
		$out['quota_reason']   = $out['is_expired'] ? 'expired' : 'plan_required';
		if ( $email && $out['is_expired'] && 'dazzlone' !== sanitize_key( (string) ( $sub['plan'] ?? 'dazzlone' ) ) ) {
			olkil_payu_downgrade_to_free( $email, $sub );
		}
		return $out;
	}

	$plan    = sanitize_key( (string) ( $current['plan'] ?? 'dazzlone' ) );
	$total   = (int) ( $current['tokens_total'] ?? 0 );
	$used    = max( 0, (int) ( $current['tokens_used'] ?? 0 ) );
	$left    = max( 0, $total - $used );
	$expires = (string) ( $current['expires_at'] ?? '' );
	$exp_ts  = $expires ? strtotime( $expires ) : 0;
	$spendable = 0;
	foreach ( $ents as $ent ) {
		$spendable += olkil_payu_entitlement_left( $ent, $now );
	}

	$pct_used = $total > 0 ? ( ( $used / $total ) * 100 ) : 0;
	$pct_left = max( 0, 100 - $pct_used );
	$days     = null;
	$label    = 'Never (free local)';
	if ( $exp_ts > 0 ) {
		$days  = (int) max( 0, ceil( ( $exp_ts - $now ) / DAY_IN_SECONDS ) );
		$label = gmdate( 'M j, Y', $exp_ts );
		if ( null !== $days ) {
			$label .= ' · ' . $days . ' day' . ( 1 === $days ? '' : 's' ) . ' left';
		}
	}

	$plan_name = olkil_payu_plan_display_name( $plan );
	$next_slug = function_exists( 'olkil_payu_next_plan_slug' ) ? olkil_payu_next_plan_slug( $plan ) : '';
	$next_name = $next_slug ? olkil_payu_plan_display_name( $next_slug ) : '';

	$held = array();
	foreach ( $ents as $ent ) {
		$eplan = sanitize_key( (string) ( $ent['plan'] ?? '' ) );
		if ( $eplan === $plan ) {
			continue;
		}
		$e_left = olkil_payu_entitlement_left( $ent, $now );
		$e_exp  = olkil_payu_entitlement_exp_ts( $ent );
		$held[] = array(
			'plan'               => $eplan,
			'plan_name'          => olkil_payu_plan_display_name( $eplan ),
			'tokens_total'       => (int) ( $ent['tokens_total'] ?? 0 ),
			'tokens_used'        => max( 0, (int) ( $ent['tokens_used'] ?? 0 ) ),
			'tokens_left'        => $e_left,
			'tokens_left_label'  => olkil_payu_format_tokens_exact( $e_left ),
			'tokens_used_label'  => olkil_payu_format_tokens_exact( max( 0, (int) ( $ent['tokens_used'] ?? 0 ) ) ),
			'tokens_total_label' => olkil_payu_format_tokens_exact( (int) ( $ent['tokens_total'] ?? 0 ) ),
			'expires_at'         => (string) ( $ent['expires_at'] ?? '' ),
			'expires_on'         => $e_exp ? gmdate( 'M j, Y', $e_exp ) : '',
			'status'             => $e_left > 0 ? 'held' : 'exhausted',
		);
	}

	$quota_reason = 'ok';
	if ( $spendable <= 0 ) {
		$quota_reason = 'quota_exceeded';
	}

	$drawing_plan = $drawing ? sanitize_key( (string) ( $drawing['plan'] ?? '' ) ) : '';

	return array(
		'email'               => $email,
		'plan'                => $plan,
		'plan_name'           => $plan_name,
		'status'              => 'active',
		'tokens_total'        => $total,
		'tokens_used'         => $used,
		'tokens_left'         => $left,
		'spendable_left'      => $spendable,
		'spendable_left_label'=> olkil_payu_format_tokens_exact( $spendable ),
		'drawing_plan'        => $drawing_plan,
		'drawing_plan_name'   => $drawing_plan ? olkil_payu_plan_display_name( $drawing_plan ) : '',
		'tokens_total_label'  => olkil_payu_format_tokens_exact( $total ),
		'tokens_used_label'   => olkil_payu_format_tokens_exact( $used ),
		'tokens_left_label'   => olkil_payu_format_tokens_exact( $left ),
		'tokens_total_compact'=> olkil_payu_format_tokens( $total ),
		'percent_left_label'  => olkil_payu_format_percent_left( $used, $total ),
		'requests_used'       => max( 0, (int) ( $sub['requests_used'] ?? 0 ) ),
		'percent_used'        => $pct_used,
		'percent_left'        => $pct_left,
		'started_at'          => (string) ( $current['started_at'] ?? '' ),
		'started_on'          => ! empty( $current['started_at'] ) ? gmdate( 'M j, Y', strtotime( (string) $current['started_at'] ) ) : '',
		'expires_at'          => $expires,
		'expires_on'          => $exp_ts ? gmdate( 'M j, Y', $exp_ts ) : '',
		'expires_label'       => $label,
		'days_left'           => $days,
		'txnid'               => (string) ( $current['txnid'] ?? '' ),
		'is_paid'             => $total > 0 || $spendable > 0,
		'is_expired'          => false,
		'quota_reason'        => $quota_reason,
		'next_plan'           => $next_slug,
		'next_plan_name'      => $next_name,
		'upgrade_url'         => $next_slug ? home_url( '/checkout/?plan=' . rawurlencode( $next_slug ) ) : '',
		'renew_plan'          => $plan,
		'renew_plan_name'     => $plan_name,
		'renew_url'           => home_url( '/checkout/?plan=' . rawurlencode( $plan ) ),
		'held_plans'          => $held,
		'entitlements'        => array_map(
			static function ( $ent ) use ( $now, $plan ) {
				$eplan = sanitize_key( (string) ( $ent['plan'] ?? '' ) );
				$left  = olkil_payu_entitlement_left( $ent, $now );
				return array(
					'plan'              => $eplan,
					'plan_name'         => olkil_payu_plan_display_name( $eplan ),
					'tokens_total'      => (int) ( $ent['tokens_total'] ?? 0 ),
					'tokens_used'       => max( 0, (int) ( $ent['tokens_used'] ?? 0 ) ),
					'tokens_left'       => $left,
					'tokens_left_label' => olkil_payu_format_tokens_exact( $left ),
					'expires_at'        => (string) ( $ent['expires_at'] ?? '' ),
					'status'            => $eplan === $plan ? 'active' : ( $left > 0 ? 'held' : 'exhausted' ),
				);
			},
			$ents
		),
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
	$original = olkil_payu_raw_subscription_row( $key );
	$row      = olkil_payu_ingest_paid_orders_into_row( $key, $original );
	$row      = olkil_payu_sync_legacy_plan_fields( $row );
	if ( wp_json_encode( $row ) !== wp_json_encode( $original ) ) {
		olkil_payu_put_subscription_row( $key, $row );
	}
	return olkil_payu_enrich_subscription( $row );
}

/**
 * Activate / renew a paid plan for 30 days from purchase.
 * Same plan again: reset that plan's tokens and start a new 30-day window.
 * Higher plan: becomes current; lower unexpired plans go on hold with leftover tokens.
 *
 * @param string $email Email.
 * @param string $plan  Plan slug.
 * @param string $txnid Txn id.
 * @param int    $started_ts Optional unix start (for order backfill).
 */
function olkil_payu_activate_subscription( $email, $plan, $txnid = '', $started_ts = 0 ) {
	$key   = olkil_payu_email_key( $email );
	$plan  = sanitize_key( $plan );
	$plans = olkil_payu_plans();
	if ( '' === $key || ! isset( $plans[ $plan ] ) ) {
		return false;
	}

	$all = get_option( 'olkil_payu_subscriptions', array() );
	if ( ! is_array( $all ) ) {
		$all = array();
	}

	$row  = isset( $all[ $key ] ) && is_array( $all[ $key ] ) ? $all[ $key ] : array( 'email' => $key );
	$row  = olkil_payu_migrate_entitlements_row( $row );
	$ents = olkil_payu_prune_entitlements( isset( $row['entitlements'] ) && is_array( $row['entitlements'] ) ? $row['entitlements'] : array() );
	$ents = olkil_payu_upsert_entitlement( $ents, $plan, $txnid, $started_ts );

	$row['email']        = $key;
	$row['entitlements'] = $ents;
	$row['usage_ids']    = isset( $row['usage_ids'] ) && is_array( $row['usage_ids'] ) ? $row['usage_ids'] : array();
	$row                 = olkil_payu_sync_legacy_plan_fields( $row );
	$all[ $key ]         = $row;
	update_option( 'olkil_payu_subscriptions', $all, false );
	return true;
}

/**
 * Paid plan ended → persist Dazzlone (free) like Cursor downgrade.
 *
 * @param string              $email    Email.
 * @param array<string,mixed> $previous Previous row.
 */
function olkil_payu_downgrade_to_free( $email, array $previous = array() ) {
	$key = olkil_payu_email_key( $email );
	if ( '' === $key || ! is_email( $key ) ) {
		return;
	}
	$all = get_option( 'olkil_payu_subscriptions', array() );
	if ( ! is_array( $all ) ) {
		$all = array();
	}
	$row  = isset( $all[ $key ] ) && is_array( $all[ $key ] ) ? $all[ $key ] : $previous;
	$row  = olkil_payu_migrate_entitlements_row( $row );
	$ents = olkil_payu_prune_entitlements( isset( $row['entitlements'] ) && is_array( $row['entitlements'] ) ? $row['entitlements'] : array() );
	if ( ! empty( $ents ) ) {
		$row['entitlements'] = $ents;
		$row                 = olkil_payu_sync_legacy_plan_fields( $row );
		$all[ $key ]         = $row;
		update_option( 'olkil_payu_subscriptions', $all, false );
		return;
	}

	$prev_plan = sanitize_key( (string) ( $previous['plan'] ?? ( $row['plan'] ?? '' ) ) );
	if ( 'dazzlone' === $prev_plan && ( ( $row['status'] ?? '' ) === 'expired' ) ) {
		return;
	}
	$all[ $key ] = array(
		'email'         => $key,
		'plan'          => 'dazzlone',
		'status'        => 'expired',
		'tokens_total'  => 0,
		'tokens_used'   => 0,
		'entitlements'  => array(),
		'started_at'    => '',
		'expires_at'    => (string) ( $previous['expires_at'] ?? ( $row['expires_at'] ?? '' ) ),
		'expired_plan'  => $prev_plan && 'dazzlone' !== $prev_plan ? $prev_plan : (string) ( $row['expired_plan'] ?? '' ),
		'txnid'         => (string) ( $previous['txnid'] ?? ( $row['txnid'] ?? '' ) ),
		'updated_at'    => gmdate( 'c' ),
	);
	update_option( 'olkil_payu_subscriptions', $all, false );
}

function olkil_payu_cron_expire_plans() {
	$all = get_option( 'olkil_payu_subscriptions', array() );
	if ( ! is_array( $all ) ) {
		return;
	}
	foreach ( $all as $key => $sub ) {
		if ( ! is_array( $sub ) ) {
			continue;
		}
		$sub  = olkil_payu_migrate_entitlements_row( $sub );
		$ents = olkil_payu_prune_entitlements( isset( $sub['entitlements'] ) && is_array( $sub['entitlements'] ) ? $sub['entitlements'] : array() );
		if ( empty( $ents ) ) {
			$plan = sanitize_key( (string) ( $sub['plan'] ?? 'dazzlone' ) );
			if ( 'dazzlone' === $plan ) {
				continue;
			}
			olkil_payu_downgrade_to_free( $key, $sub );
			continue;
		}
		$sub['entitlements'] = $ents;
		$sub                 = olkil_payu_sync_legacy_plan_fields( $sub );
		$all[ $key ]         = $sub;
	}
	update_option( 'olkil_payu_subscriptions', $all, false );
}

function olkil_payu_schedule_expiry_cron() {
	if ( ! wp_next_scheduled( 'olkil_payu_expire_plans' ) ) {
		wp_schedule_event( time() + 60, 'hourly', 'olkil_payu_expire_plans' );
	}
}

/**
 * Apply successful PayU payload to subscription.
 *
 * @param array<string,string> $data PayU fields.
 */
function olkil_payu_maybe_activate_from_payment( array $data ) {
	$status = strtolower( (string) ( $data['status'] ?? '' ) );
	if ( ! in_array( $status, array( 'success', 'captured', 'completed' ), true ) ) {
		return;
	}
	$email = sanitize_email( (string) ( $data['email'] ?? '' ) );
	$plan  = sanitize_key( (string) ( $data['udf1'] ?? '' ) );
	$txnid = sanitize_text_field( (string) ( $data['txnid'] ?? '' ) );

	if ( $txnid ) {
		$order = olkil_payu_get_order( $txnid );
		if ( $order ) {
			$email = $email ?: sanitize_email( (string) ( $order['email'] ?? '' ) );
			if ( ! empty( $order['plan'] ) ) {
				$plan = sanitize_key( (string) $order['plan'] );
			}
		}
	}

	if ( $email && $plan ) {
		olkil_payu_activate_subscription( $email, $plan, $txnid );
	}
}
