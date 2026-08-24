<?php
/**
 * Country detection + PayU charge quote.
 * Site always displays USD. PayU India settles in INR; other countries
 * get DCC / international cards in their local currency.
 *
 * @package OLKIL
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

function olkil_payu_country_currency_map() {
	return array(
		'IN' => 'INR', 'US' => 'USD', 'GB' => 'GBP', 'AE' => 'AED', 'AU' => 'AUD',
		'CA' => 'CAD', 'SG' => 'SGD', 'EU' => 'EUR', 'DE' => 'EUR', 'FR' => 'EUR',
		'IT' => 'EUR', 'ES' => 'EUR', 'NL' => 'EUR', 'IE' => 'EUR', 'PT' => 'EUR',
		'BE' => 'EUR', 'AT' => 'EUR', 'FI' => 'EUR', 'GR' => 'EUR',
		'CH' => 'CHF', 'SE' => 'SEK', 'NO' => 'NOK', 'DK' => 'DKK', 'PL' => 'PLN',
		'JP' => 'JPY', 'KR' => 'KRW', 'CN' => 'CNY', 'HK' => 'HKD', 'NZ' => 'NZD',
		'MY' => 'MYR', 'TH' => 'THB', 'ID' => 'IDR', 'PH' => 'PHP', 'VN' => 'VND',
		'SA' => 'SAR', 'QA' => 'QAR', 'KW' => 'KWD', 'BH' => 'BHD', 'OM' => 'OMR',
		'ZA' => 'ZAR', 'NG' => 'NGN', 'KE' => 'KES', 'EG' => 'EGP', 'BR' => 'BRL',
		'MX' => 'MXN', 'AR' => 'ARS', 'CL' => 'CLP', 'CO' => 'COP', 'TR' => 'TRY',
		'IL' => 'ILS', 'RU' => 'RUB', 'UA' => 'UAH', 'PK' => 'PKR', 'BD' => 'BDT',
		'LK' => 'LKR', 'NP' => 'NPR', 'MM' => 'MMK', 'TW' => 'TWD',
	);
}

function olkil_payu_normalize_country( $code ) {
	$code = strtoupper( preg_replace( '/[^A-Za-z]/', '', (string) $code ) );
	if ( strlen( $code ) !== 2 ) {
		return '';
	}
	if ( in_array( $code, array( 'XX', 'T1', 'A1', 'A2', 'O1' ), true ) ) {
		return '';
	}
	return $code;
}

function olkil_payu_detect_country( $posted = '' ) {
	$posted = olkil_payu_normalize_country( $posted );
	if ( $posted ) {
		return $posted;
	}

	$headers = array(
		'HTTP_CF_IPCOUNTRY',
		'HTTP_X_COUNTRY_CODE',
		'HTTP_X_APPENGINE_COUNTRY',
		'HTTP_CLOUDFRONT_VIEWER_COUNTRY',
		'GEOIP_COUNTRY_CODE',
		'HTTP_X_GEO_COUNTRY',
	);
	foreach ( $headers as $key ) {
		if ( empty( $_SERVER[ $key ] ) ) { // phpcs:ignore WordPress.Security.ValidatedSanitizedInput
			continue;
		}
		$got = olkil_payu_normalize_country( wp_unslash( $_SERVER[ $key ] ) ); // phpcs:ignore
		if ( $got ) {
			return $got;
		}
	}

	$ip = olkil_payu_client_ip();
	if ( $ip ) {
		$cached = get_transient( 'olkil_payu_geo_' . md5( $ip ) );
		if ( is_string( $cached ) && $cached ) {
			return $cached;
		}
		$geo = olkil_payu_geo_lookup( $ip );
		if ( $geo ) {
			set_transient( 'olkil_payu_geo_' . md5( $ip ), $geo, DAY_IN_SECONDS );
			return $geo;
		}
	}

	return 'IN';
}

function olkil_payu_client_ip() {
	$keys = array( 'HTTP_CF_CONNECTING_IP', 'HTTP_X_REAL_IP', 'HTTP_X_FORWARDED_FOR', 'REMOTE_ADDR' );
	foreach ( $keys as $key ) {
		if ( empty( $_SERVER[ $key ] ) ) { // phpcs:ignore
			continue;
		}
		$raw = (string) wp_unslash( $_SERVER[ $key ] ); // phpcs:ignore
		$ip  = trim( explode( ',', $raw )[0] );
		if ( filter_var( $ip, FILTER_VALIDATE_IP ) ) {
			return $ip;
		}
	}
	return '';
}

function olkil_payu_geo_lookup( $ip ) {
	if ( ! $ip || ! filter_var( $ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE ) ) {
		return '';
	}
	$res = wp_remote_get(
		'https://ipapi.co/' . rawurlencode( $ip ) . '/country/',
		array(
			'timeout' => 2,
			'headers' => array( 'User-Agent' => 'OLKIL-PayU/1.0' ),
		)
	);
	if ( is_wp_error( $res ) ) {
		return '';
	}
	$code = olkil_payu_normalize_country( wp_remote_retrieve_body( $res ) );
	return $code;
}

function olkil_payu_currency_for_country( $country ) {
	$map = olkil_payu_country_currency_map();
	$country = olkil_payu_normalize_country( $country ) ?: 'IN';
	return $map[ $country ] ?? ( 'IN' === $country ? 'INR' : 'USD' );
}

/**
 * Charge quote. Website displays USD; PayU amount is INR for India settlement.
 * International customers get transactionCurrency for DCC / local-currency charge.
 *
 * @param array  $plan    Plan row.
 * @param string $country ISO country.
 * @return array{amount:string,currency:string,transactionCurrency:string,country:string,usd:string}
 */
function olkil_payu_quote( array $plan, $country = '' ) {
	$country = olkil_payu_detect_country( $country );
	$ccy     = olkil_payu_currency_for_country( $country );
	$inr     = (string) ( $plan['amount'] ?? '0.00' );
	$usd     = (string) ( $plan['usd'] ?? '0' );

	return array(
		'amount'               => $inr,
		'currency'             => 'INR',
		'transactionCurrency'  => $ccy,
		'country'              => $country,
		'usd'                  => $usd,
	);
}
