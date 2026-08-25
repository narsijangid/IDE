<?php
/**
 * Transactional billing email (invoice + receipt).
 *
 * @package OLKIL
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

function olkil_payu_mail_from() {
	return array(
		'email' => 'hi@olkil.com',
		'name'  => 'OLKIL',
	);
}

function olkil_payu_force_mail_from() {
	return olkil_payu_mail_from()['email'];
}

function olkil_payu_force_mail_from_name() {
	return olkil_payu_mail_from()['name'];
}

function olkil_payu_phpmailer_from( $phpmailer ) {
	$from = olkil_payu_mail_from();
	$phpmailer->setFrom( $from['email'], $from['name'], false );
	$phpmailer->Sender = $from['email'];
}

function olkil_payu_mail_headers() {
	$from = olkil_payu_mail_from();
	return array(
		'Content-Type: text/html; charset=UTF-8',
		'From: ' . sprintf( '%s <%s>', $from['name'], $from['email'] ),
		'Reply-To: ' . $from['email'],
		'Bcc: ' . $from['email'],
	);
}

function olkil_payu_html_mail_content_type() {
	return 'text/html';
}

function olkil_payu_send_html_mail( $to, $subject, $html ) {
	if ( ! is_email( $to ) || '' === $html ) {
		return false;
	}
	add_filter( 'wp_mail_content_type', 'olkil_payu_html_mail_content_type' );
	add_filter( 'wp_mail_from', 'olkil_payu_force_mail_from' );
	add_filter( 'wp_mail_from_name', 'olkil_payu_force_mail_from_name' );
	add_action( 'phpmailer_init', 'olkil_payu_phpmailer_from' );
	$ok = wp_mail( $to, $subject, $html, olkil_payu_mail_headers() );
	remove_action( 'phpmailer_init', 'olkil_payu_phpmailer_from' );
	remove_filter( 'wp_mail_from_name', 'olkil_payu_force_mail_from_name' );
	remove_filter( 'wp_mail_from', 'olkil_payu_force_mail_from' );
	remove_filter( 'wp_mail_content_type', 'olkil_payu_html_mail_content_type' );
	return $ok;
}

/**
 * @param array<string,mixed> $order Order with invoice HTML.
 */
function olkil_payu_send_success_mail( array $order ) {
	if ( ! empty( $order['mail_sent'] ) ) {
		return true;
	}
	$email = sanitize_email( (string) ( $order['email'] ?? '' ) );
	$inv   = is_array( $order['invoice'] ?? null ) ? $order['invoice'] : array();
	$html  = ! empty( $inv )
		? olkil_payu_receipt_html( $inv ) . olkil_payu_invoice_html( $inv )
		: (string) ( $order['receipt_html'] ?? '' ) . (string) ( $order['invoice_html'] ?? '' );
	if ( ! $email || '' === $html ) {
		return false;
	}
	$live    = function_exists( 'olkil_payu_is_live' ) ? olkil_payu_is_live() : true;
	$prefix  = $live ? '' : '[TEST] ';
	$receipt = (string) ( $inv['receipt_no'] ?? $order['txnid'] ?? '' );
	$plan    = (string) ( $inv['plan_name'] ?? 'OLKIL' );
	$ok      = olkil_payu_send_html_mail(
		$email,
		$prefix . 'OLKIL ' . $plan . ' — payment receipt ' . $receipt,
		$html
	);
	if ( $ok ) {
		$order['mail_sent'] = 1;
		$order['mail_at']   = gmdate( 'c' );
		olkil_payu_save_order( $order );
	}
	return $ok;
}

function olkil_payu_send_failed_mail( array $data ) {
	$email = sanitize_email( (string) ( $data['email'] ?? '' ) );
	if ( ! $email ) {
		return false;
	}
	$name  = sanitize_text_field( (string) ( $data['firstname'] ?? 'there' ) );
	$txnid = sanitize_text_field( (string) ( $data['txnid'] ?? '' ) );
	$plan  = sanitize_key( (string) ( $data['udf1'] ?? 'pro' ) );
	$live  = function_exists( 'olkil_payu_is_live' ) ? olkil_payu_is_live() : true;
	$mode  = $live ? 'live' : 'test';
	$html  = olkil_payu_doc_wrap(
		'Payment not completed',
		'<p>Hi ' . esc_html( $name ) . ',</p><p>Your OLKIL payment did not complete. No amount was captured for this attempt.</p><p style="font-size:13px;color:#52525b">Reference: ' . esc_html( $txnid ) . '</p><p><a href="' . esc_url( home_url( '/checkout/?plan=' . $plan ) ) . '" style="color:#fe019a;font-weight:600">Try checkout again</a></p>',
		$mode
	);
	$prefix = $live ? '' : '[TEST] ';
	return olkil_payu_send_html_mail( $email, $prefix . 'OLKIL payment not completed', $html );
}

function olkil_payu_verify_internal_signature( $raw ) {
	$secret = olkil_payu_internal_secret();
	$sig    = (string) ( $_SERVER['HTTP_X_OLKIL_SIGNATURE'] ?? '' ); // phpcs:ignore
	if ( ! $secret || ! $sig ) {
		return false;
	}
	$calc = hash_hmac( 'sha256', (string) $raw, $secret );
	return hash_equals( $calc, $sig );
}
