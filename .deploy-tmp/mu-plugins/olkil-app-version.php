<?php
/**
 * Plugin Name: OLKIL App Version Override
 * Description: Forces desktop download version to match latest GitHub release.
 * Version: 1.3.23
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

add_filter( 'olkil_app_version', function () {
	return '1.3.23';
}, 99 );

add_filter( 'olkil_download_urls', function ( $urls ) {
	$v  = '1.3.23';
	$gh = 'https://github.com/narsijangid/IDE/releases/download/v' . $v;
	return array(
		'windows'        => 'https://olkil.com/downloads/OLKIL-' . $v . '.exe',
		'macos'          => $gh . '/OLKIL-' . $v . '-arm64.dmg',
		'macos_intel'    => $gh . '/OLKIL-' . $v . '-x64.dmg',
		'linux'          => $gh . '/OLKIL-' . $v . '.deb',
		'linux_appimage' => $gh . '/OLKIL-' . $v . '.AppImage',
	);
}, 99 );