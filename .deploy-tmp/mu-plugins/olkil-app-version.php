<?php
/**
 * Plugin Name: OLKIL App Version Override
 * Description: Forces desktop download URLs to Hostinger /downloads/ (GitHub repo is private).
 * Version: 1.3.26
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

add_filter( 'olkil_app_version', function () {
	return '1.3.26';
}, 99 );

add_filter( 'olkil_download_urls', function ( $urls ) {
	$ver = '1.3.26';
	return array(
		'windows'        => 'https://olkil.com/downloads/OLKIL-' . $ver . '.exe',
		'macos'          => 'https://olkil.com/downloads/OLKIL-' . $ver . '-arm64.dmg',
		'macos_intel'    => 'https://olkil.com/downloads/OLKIL-' . $ver . '-x64.dmg',
		'linux'          => 'https://olkil.com/downloads/OLKIL-' . $ver . '.AppImage',
		'linux_appimage' => 'https://olkil.com/downloads/OLKIL-' . $ver . '.AppImage',
	);
}, 99 );
