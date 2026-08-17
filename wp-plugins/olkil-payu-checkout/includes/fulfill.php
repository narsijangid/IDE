<?php
/**
 * Idempotent payment fulfillment: verify, activate, invoice, email.
 *
 * @package OLKIL
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

function olkil_payu_is_success_status( $status ) {
	return in_array( strtolower( (string) $status ), array( 'success', 'captured', 'completed' ), true );
}

/**
 * @param array<string,string> $data   PayU fields.
 * @param string               $source notify|browser|firebase.
 * @return array{ok:bool,paid:bool,txnid:string}
 */
function olkil_payu_fulfill( array $data, $source = 'notify' ) {
	$txnid  = sanitize_text_field( (string) ( $data['txnid'] ?? '' ) );
	$status = strtolower( (string) ( $data['status'] ?? '' ) );
	if ( '' === $txnid ) {
		return array( 'ok' => false, 'paid' => false, 'txnid' => '' );
	}

	$ok = olkil_payu_verify_response( $data );
	if ( ! $ok ) {
		return array( 'ok' => false, 'paid' => false, 'txnid' => $txnid );
	}

	$existing = olkil_payu_get_order( $txnid );
	$order    = is_array( $existing ) ? $existing : array( 'txnid' => $txnid );
	$already  = ! empty( $order['fulfilled'] ) && olkil_payu_is_success_status( (string) ( $order['status'] ?? '' ) );

	$order = array_merge(
		$order,
		array(
			'status'        => $status,
			'payu_mihpayid' => sanitize_text_field( (string) ( $data['mihpayid'] ?? '' ) ),
			'verified'      => 1,
			'source'        => $source,
			'paid_at'       => gmdate( 'c' ),
			'raw'           => $data,
			'email'         => sanitize_email( (string) ( $data['email'] ?? ( $order['email'] ?? '' ) ) ),
			'firstname'     => sanitize_text_field( (string) ( $data['firstname'] ?? ( $order['firstname'] ?? '' ) ) ),
			'plan'          => sanitize_key( (string) ( $data['udf1'] ?? ( $order['plan'] ?? '' ) ) ),
			'amount'        => sanitize_text_field( (string) ( $data['amount'] ?? ( $order['amount'] ?? '' ) ) ),
		)
	);
	olkil_payu_save_order( $order );

	if ( ! olkil_payu_is_success_status( $status ) ) {
		if ( empty( $order['fail_mail_sent'] ) ) {
			olkil_payu_send_failed_mail( $data );
			$order['fail_mail_sent'] = 1;
			olkil_payu_save_order( $order );
		}
		return array( 'ok' => true, 'paid' => false, 'txnid' => $txnid );
	}

	if ( $already ) {
		return array( 'ok' => true, 'paid' => true, 'txnid' => $txnid );
	}

	olkil_payu_maybe_activate_from_payment( $data );
	$order = olkil_payu_ensure_invoice( $order, $data );
	$order['fulfilled'] = 1;
	olkil_payu_save_order( $order );
	olkil_payu_send_success_mail( $order );

	return array( 'ok' => true, 'paid' => true, 'txnid' => $txnid );
}
