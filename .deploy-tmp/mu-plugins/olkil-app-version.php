<?php
/**
 * Plugin Name: OLKIL App Version Override
 * Description: Forces desktop download URLs to Hostinger /downloads/ (GitHub repo is private).
 * Version: 1.3.25
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

add_filter( 'olkil_app_version', function () {
	return '1.3.25';
}, 99 );

add_filter( 'olkil_download_urls', function ( $urls ) {
	$win = '1.3.25';
	$mac = '1.3.22';
	return array(
		'windows'        => 'https://olkil.com/downloads/OLKIL-' . $win . '.exe',
		'macos'          => 'https://olkil.com/downloads/OLKIL-' . $mac . '-arm64.dmg',
		'macos_intel'    => 'https://olkil.com/downloads/OLKIL-' . $mac . '-x64.dmg',
		'linux'          => 'https://olkil.com/downloads/OLKIL-' . $mac . '.AppImage',
		'linux_appimage' => 'https://olkil.com/downloads/OLKIL-' . $mac . '.AppImage',
	);
}, 99 );
