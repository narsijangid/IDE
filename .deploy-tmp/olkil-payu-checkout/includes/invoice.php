<?php
/**
 * Tax invoice + payment receipt HTML.
 *
 * @package OLKIL
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

function olkil_payu_biz_invoice() {
	$b = function_exists( 'olkil_payu_biz' ) ? olkil_payu_biz() : array();
	return array(
		'legal_name' => $b['trade_name'] ?? 'OLKIL',
		'trade_name' => $b['trade_name'] ?? 'OLKIL',
		'address'    => $b['address'] ?? 'Rajasthan, India - 341503',
		'email'      => $b['email'] ?? 'narsi@olkil.com',
		'website'    => $b['website'] ?? 'https://olkil.com',
		'gstin'      => (string) get_option( 'olkil_payu_gstin', '' ),
		'sac'        => '998439',
	);
}

function olkil_payu_next_invoice_no() {
	$year = (int) gmdate( 'Y' );
	$state = get_option( 'olkil_payu_invoice_counter', array() );
	if ( ! is_array( $state ) || (int) ( $state['year'] ?? 0 ) !== $year ) {
		$state = array( 'year' => $year, 'seq' => 0 );
	}
	$state['seq'] = (int) $state['seq'] + 1;
	update_option( 'olkil_payu_invoice_counter', $state, false );
	return sprintf( 'OLK-%d-%05d', $year, $state['seq'] );
}

function olkil_payu_inr( $amount ) {
	return '₹' . number_format( (float) $amount, 2, '.', ',' );
}

function olkil_payu_doc_wrap( $title, $body, $mode = 'test', $badge = '' ) {
	$test = ( 'live' !== $mode )
		? '<p style="margin:0 0 16px;padding:8px 12px;background:#fff8e1;border:1px solid #f5d76e;border-radius:8px;color:#7a5b00;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase">Test mode — not a live charge</p>'
		: '';
	$badge_html = $badge ? '<p style="margin:8px 0 0;font-size:13px;opacity:.85">' . esc_html( $badge ) . '</p>' : '';
	$b = olkil_payu_biz_invoice();
	return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>' . esc_html( $title ) . '</title></head>
<body style="margin:0;background:#f4f4f5;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#18181b">
<div style="max-width:640px;margin:24px auto;padding:0 16px">
<div style="background:#fff;border:1px solid #e4e4e7;border-radius:16px;overflow:hidden">
<div style="padding:22px 28px;background:linear-gradient(135deg,#18181b,#27272a);color:#fff">
<div style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;opacity:.7">OLKIL</div>
<h1 style="margin:6px 0 0;font-size:22px">' . esc_html( $title ) . '</h1>' . $badge_html . '
</div>
<div style="padding:28px">' . $test . $body . '</div>
</div>
<p style="text-align:center;color:#71717a;font-size:12px;margin:16px 0 8px">' . esc_html( $b['trade_name'] ) . ' · <a href="' . esc_url( $b['website'] ) . '" style="color:#71717a">' . esc_html( $b['website'] ) . '</a></p>
</div></body></html>';
}

/**
 * @param array<string,mixed> $inv Invoice payload.
 */
function olkil_payu_invoice_html( array $inv ) {
	$b      = olkil_payu_biz_invoice();
	$gstin  = $b['gstin'] ? 'GSTIN: ' . esc_html( $b['gstin'] ) : 'GSTIN: Unregistered';
	$gstnote = $b['gstin']
		? 'GST as applicable is included as per registered GSTIN.'
		: 'Supplier is unregistered under GST. No GST has been charged on this invoice.';
	$body = '<table style="width:100%;border-collapse:collapse;margin-bottom:18px;font-size:13px;table-layout:fixed"><tr>
<td style="vertical-align:top;width:55%;word-wrap:break-word"><strong>' . esc_html( $b['trade_name'] ) . '</strong><br>' . esc_html( $b['address'] ) . '<br>' . $gstin . '<br>SAC: ' . esc_html( $b['sac'] ) . '<br>Email: ' . esc_html( $b['email'] ) . '</td>
<td style="vertical-align:top;text-align:right">
<div><strong>Invoice</strong> ' . esc_html( (string) ( $inv['invoice_no'] ?? '' ) ) . '</div>
<div>Date: ' . esc_html( (string) ( $inv['issued_on'] ?? '' ) ) . '</div>
<div>Receipt: ' . esc_html( (string) ( $inv['receipt_no'] ?? '' ) ) . '</div>
<div>PayU ID: ' . esc_html( (string) ( $inv['mihpayid'] ?? '—' ) ) . '</div>
<div>Txn: ' . esc_html( (string) ( $inv['txnid'] ?? '' ) ) . '</div>
</td></tr></table>
<p style="font-size:13px;margin:0 0 16px"><strong>Bill to</strong><br>' . esc_html( (string) ( $inv['firstname'] ?? '' ) ) . '<br>' . esc_html( (string) ( $inv['email'] ?? '' ) ) . '<br>' . esc_html( (string) ( $inv['phone'] ?? '' ) ) . '</p>
<table style="width:100%;border-collapse:collapse;font-size:13px">
<thead><tr><th style="text-align:left;border-bottom:1px solid #e4e4e7;padding:8px 0">Description</th><th style="text-align:right;border-bottom:1px solid #e4e4e7;padding:8px 0">Amount</th></tr></thead>
<tbody><tr><td style="padding:10px 0">' . esc_html( (string) ( $inv['plan_name'] ?? 'OLKIL plan' ) ) . ' — 30-day digital subscription<br><span style="color:#71717a">' . esc_html( (string) ( $inv['tokens'] ?? '' ) ) . '</span></td>
<td style="text-align:right;padding:10px 0">' . esc_html( olkil_payu_inr( $inv['amount'] ?? 0 ) ) . '</td></tr></tbody>
<tfoot><tr><td style="padding:10px 0;border-top:1px solid #e4e4e7"><strong>Total payable (INR)</strong></td>
<td style="text-align:right;padding:10px 0;border-top:1px solid #e4e4e7"><strong>' . esc_html( olkil_payu_inr( $inv['amount'] ?? 0 ) ) . '</strong></td></tr></tfoot>
</table>
<p style="font-size:12px;color:#52525b;margin:16px 0 0">' . esc_html( $gstnote ) . ' Amount: ' . esc_html( olkil_payu_inr( $inv['amount'] ?? 0 ) ) . ' only.</p>
<p style="font-size:12px;color:#52525b;margin:8px 0 0">Period: ' . esc_html( (string) ( $inv['period_start'] ?? '' ) ) . ' → ' . esc_html( (string) ( $inv['period_end'] ?? '' ) ) . '. Digital delivery — no physical shipment.</p>';
	$mode = (string) ( $inv['mode'] ?? 'test' );
	return olkil_payu_doc_wrap( 'Tax Invoice', $body, $mode, 'live' === $mode ? 'PAID' : 'TEST INVOICE' );
}

/**
 * @param array<string,mixed> $inv Invoice payload.
 */
function olkil_payu_receipt_html( array $inv ) {
	$name = (string) ( $inv['firstname'] ?? 'there' );
	$body = '<p style="margin:0 0 16px;font-size:15px">Hi ' . esc_html( $name ) . ',</p>
<p style="margin:0 0 16px;font-size:14px;line-height:1.55">We received your payment for <strong>' . esc_html( (string) ( $inv['plan_name'] ?? 'OLKIL' ) ) . '</strong>. Your plan is active and tokens are ready to use.</p>
<table style="width:100%;border-collapse:collapse;font-size:13px;background:#fafafa;border-radius:12px">
<tr><td style="padding:10px 14px;color:#71717a">Amount paid</td><td style="padding:10px 14px;text-align:right"><strong>' . esc_html( olkil_payu_inr( $inv['amount'] ?? 0 ) ) . '</strong></td></tr>
<tr><td style="padding:10px 14px;color:#71717a">Receipt no.</td><td style="padding:10px 14px;text-align:right">' . esc_html( (string) ( $inv['receipt_no'] ?? '' ) ) . '</td></tr>
<tr><td style="padding:10px 14px;color:#71717a">Invoice no.</td><td style="padding:10px 14px;text-align:right">' . esc_html( (string) ( $inv['invoice_no'] ?? '' ) ) . '</td></tr>
<tr><td style="padding:10px 14px;color:#71717a">PayU transaction</td><td style="padding:10px 14px;text-align:right">' . esc_html( (string) ( $inv['mihpayid'] ?? $inv['txnid'] ?? '' ) ) . '</td></tr>
<tr><td style="padding:10px 14px;color:#71717a">Method</td><td style="padding:10px 14px;text-align:right">' . esc_html( (string) ( $inv['payment_mode'] ?? 'PayU' ) ) . '</td></tr>
<tr><td style="padding:10px 14px;color:#71717a">Valid until</td><td style="padding:10px 14px;text-align:right">' . esc_html( (string) ( $inv['period_end'] ?? '' ) ) . '</td></tr>
</table>
<p style="margin:18px 0 0"><a href="' . esc_url( (string) ( $inv['invoice_url'] ?? home_url( '/invoice/' ) ) ) . '" style="display:inline-block;background:#fe019a;color:#fff;text-decoration:none;padding:10px 16px;border-radius:10px;font-weight:600">View invoice</a>
<a href="' . esc_url( home_url( '/dashboard/' ) ) . '" style="display:inline-block;margin-left:8px;color:#fe019a;padding:10px 8px;font-weight:600">Open dashboard</a></p>
<p style="margin:18px 0 0;font-size:12px;color:#71717a">Need help? Email <a href="mailto:' . esc_attr( olkil_payu_biz_invoice()['email'] ) . '">' . esc_html( olkil_payu_biz_invoice()['email'] ) . '</a>.</p>';
	return olkil_payu_doc_wrap( 'Payment receipt', $body, (string) ( $inv['mode'] ?? 'test' ), 'Thank you for your purchase' );
}

/**
 * Clean invoice HTML for on-screen view + PDF (no nested document wrappers).
 *
 * @param array<string,mixed> $inv Invoice payload.
 * @param bool                $with_receipt Include receipt block.
 */
function olkil_payu_invoice_screen_html( array $inv, $with_receipt = true ) {
	$b       = olkil_payu_biz_invoice();
	$gstin   = $b['gstin'] ? 'GSTIN: ' . esc_html( $b['gstin'] ) : 'GSTIN: Unregistered';
	$gstnote = $b['gstin']
		? 'GST as applicable is included as per registered GSTIN.'
		: 'Supplier is unregistered under GST. No GST has been charged on this invoice.';
	$mode  = (string) ( $inv['mode'] ?? 'test' );
	$badge = ( 'live' === $mode ) ? 'PAID' : 'TEST INVOICE';
	$test  = ( 'live' !== $mode )
		? '<p class="olkil-inv-note olkil-inv-note--test">Test mode — not a live charge</p>'
		: '';

	$invoice = '<section class="olkil-inv-sheet">'
		. '<header class="olkil-inv-head"><span class="olkil-inv-brand">OLKIL</span><h1>Tax Invoice</h1><p>' . esc_html( $badge ) . '</p></header>'
		. '<div class="olkil-inv-body">' . $test
		. '<table class="olkil-inv-meta"><tr>'
		. '<td><strong>' . esc_html( $b['trade_name'] ) . '</strong><br>' . esc_html( $b['address'] ) . '<br>' . $gstin . '<br>SAC: ' . esc_html( $b['sac'] ) . '<br>Email: ' . esc_html( $b['email'] ) . '</td>'
		. '<td class="olkil-inv-meta__right">'
		. '<div><strong>Invoice</strong> ' . esc_html( (string) ( $inv['invoice_no'] ?? '' ) ) . '</div>'
		. '<div>Date: ' . esc_html( (string) ( $inv['issued_on'] ?? '' ) ) . '</div>'
		. '<div>Receipt: ' . esc_html( (string) ( $inv['receipt_no'] ?? '' ) ) . '</div>'
		. '<div>PayU ID: ' . esc_html( (string) ( $inv['mihpayid'] ?? '—' ) ) . '</div>'
		. '<div>Txn: ' . esc_html( (string) ( $inv['txnid'] ?? '' ) ) . '</div>'
		. '</td></tr></table>'
		. '<p class="olkil-inv-bill"><strong>Bill to</strong><br>' . esc_html( (string) ( $inv['firstname'] ?? '' ) ) . '<br>' . esc_html( (string) ( $inv['email'] ?? '' ) ) . '<br>' . esc_html( (string) ( $inv['phone'] ?? '' ) ) . '</p>'
		. '<table class="olkil-inv-lines"><thead><tr><th>Description</th><th>Amount</th></tr></thead>'
		. '<tbody><tr><td>' . esc_html( (string) ( $inv['plan_name'] ?? 'OLKIL plan' ) ) . ' — 30-day digital subscription<br><span>' . esc_html( (string) ( $inv['tokens'] ?? '' ) ) . '</span></td>'
		. '<td>' . esc_html( olkil_payu_inr( $inv['amount'] ?? 0 ) ) . '</td></tr></tbody>'
		. '<tfoot><tr><td><strong>Total payable (INR)</strong></td><td><strong>' . esc_html( olkil_payu_inr( $inv['amount'] ?? 0 ) ) . '</strong></td></tr></tfoot></table>'
		. '<p class="olkil-inv-foot">' . esc_html( $gstnote ) . ' Amount: ' . esc_html( olkil_payu_inr( $inv['amount'] ?? 0 ) ) . ' only.</p>'
		. '<p class="olkil-inv-foot">Period: ' . esc_html( (string) ( $inv['period_start'] ?? '' ) ) . ' → ' . esc_html( (string) ( $inv['period_end'] ?? '' ) ) . '. Digital delivery — no physical shipment.</p>'
		. '</div></section>';

	if ( ! $with_receipt ) {
		return $invoice;
	}

	$name    = (string) ( $inv['firstname'] ?? 'there' );
	$receipt = '<section class="olkil-inv-sheet olkil-inv-sheet--receipt">'
		. '<header class="olkil-inv-head"><span class="olkil-inv-brand">OLKIL</span><h1>Payment receipt</h1><p>Thank you for your purchase</p></header>'
		. '<div class="olkil-inv-body">'
		. '<p>Hi ' . esc_html( $name ) . ',</p>'
		. '<p>We received your payment for <strong>' . esc_html( (string) ( $inv['plan_name'] ?? 'OLKIL' ) ) . '</strong>. Your plan is active and tokens are ready to use.</p>'
		. '<table class="olkil-inv-lines olkil-inv-lines--compact"><tbody>'
		. '<tr><td>Amount paid</td><td><strong>' . esc_html( olkil_payu_inr( $inv['amount'] ?? 0 ) ) . '</strong></td></tr>'
		. '<tr><td>Receipt no.</td><td>' . esc_html( (string) ( $inv['receipt_no'] ?? '' ) ) . '</td></tr>'
		. '<tr><td>Invoice no.</td><td>' . esc_html( (string) ( $inv['invoice_no'] ?? '' ) ) . '</td></tr>'
		. '<tr><td>PayU transaction</td><td>' . esc_html( (string) ( $inv['mihpayid'] ?? $inv['txnid'] ?? '' ) ) . '</td></tr>'
		. '<tr><td>Method</td><td>' . esc_html( (string) ( $inv['payment_mode'] ?? 'PayU' ) ) . '</td></tr>'
		. '<tr><td>Valid until</td><td>' . esc_html( (string) ( $inv['period_end'] ?? '' ) ) . '</td></tr>'
		. '</tbody></table>'
		. '</div></section>';

	return $invoice . $receipt;
}

/**
 * Build + persist invoice on first successful payment.
 *
 * @param array<string,mixed> $order Order row.
 * @param array<string,mixed> $data  PayU payload.
 * @return array<string,mixed>
 */
function olkil_payu_ensure_invoice( array $order, array $data ) {
	if ( ! empty( $order['invoice'] ) && is_array( $order['invoice'] ) ) {
		return $order;
	}
	$plans = olkil_payu_plans();
	$plan  = sanitize_key( (string) ( $order['plan'] ?? $data['udf1'] ?? '' ) );
	$start = gmdate( 'j M Y' );
	$end   = gmdate( 'j M Y', time() + ( 30 * DAY_IN_SECONDS ) );
	$txnid = (string) ( $order['txnid'] ?? $data['txnid'] ?? '' );
	$inv   = array(
		'invoice_no'   => olkil_payu_next_invoice_no(),
		'receipt_no'   => 'RCT-' . $txnid,
		'txnid'        => $txnid,
		'mihpayid'     => (string) ( $data['mihpayid'] ?? $order['payu_mihpayid'] ?? '' ),
		'email'        => sanitize_email( (string) ( $order['email'] ?? $data['email'] ?? '' ) ),
		'firstname'    => sanitize_text_field( (string) ( $order['firstname'] ?? $data['firstname'] ?? '' ) ),
		'phone'        => sanitize_text_field( (string) ( $order['phone'] ?? $data['phone'] ?? '' ) ),
		'plan'         => $plan,
		'plan_name'    => isset( $plans[ $plan ] ) ? $plans[ $plan ]['name'] : 'OLKIL',
		'tokens'       => isset( $plans[ $plan ] ) ? $plans[ $plan ]['tokens'] : '',
		'amount'       => (string) ( $order['amount'] ?? $data['amount'] ?? '' ),
		'mode'         => (string) ( $order['mode'] ?? 'test' ),
		'payment_mode' => sanitize_text_field( (string) ( $data['mode'] ?? $data['PG_TYPE'] ?? 'PayU' ) ),
		'issued_on'    => $start,
		'period_start' => $start,
		'period_end'   => $end,
		'invoice_url'  => home_url( '/invoice/?txnid=' . rawurlencode( $txnid ) ),
	);
	$order['invoice']      = $inv;
	$order['invoice_html'] = olkil_payu_invoice_html( $inv );
	$order['receipt_html'] = olkil_payu_receipt_html( $inv );
	olkil_payu_save_order( $order );
	return $order;
}
