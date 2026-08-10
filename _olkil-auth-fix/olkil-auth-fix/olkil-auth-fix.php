<?php
/**
 * Plugin Name: OLKIL Auth Fix
 * Description: Patches IDE auth success UI (loopback callback) until theme deploy catches up.
 * Version: 1.0.3
 * Author: OLKIL
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'OLKIL_AUTH_FIX_VERSION', '1.0.3' );
define( 'OLKIL_AUTH_FIX_URL', plugin_dir_url( __FILE__ ) );

add_action( 'wp_enqueue_scripts', function () {
	$load = is_page_template( 'page-templates/template-auth-ide.php' )
		|| is_page( array( 'auth', 'ide', 'auth-ide', 'login' ) )
		|| ( isset( $_SERVER['REQUEST_URI'] ) && false !== strpos( $_SERVER['REQUEST_URI'], '/auth/ide' ) );
	if ( ! $load ) {
		return;
	}

	// Replace theme script with fixed bridge (prevents double-callback / can't-find page).
	wp_dequeue_script( 'olkil-auth' );
	wp_deregister_script( 'olkil-auth' );
	wp_enqueue_script(
		'olkil-auth',
		OLKIL_AUTH_FIX_URL . 'assets/olkil-auth.js',
		array( 'firebase-auth' ),
		OLKIL_AUTH_FIX_VERSION,
		true
	);
}, 100 );

add_action( 'wp_footer', function () {
	$load = is_page_template( 'page-templates/template-auth-ide.php' )
		|| is_page( array( 'auth', 'ide', 'auth-ide', 'login' ) )
		|| ( isset( $_SERVER['REQUEST_URI'] ) && false !== strpos( $_SERVER['REQUEST_URI'], '/auth/ide' ) );
	if ( ! $load ) {
		return;
	}
	?>
	<style>
		.olkil-auth-done{display:grid;gap:.75rem;margin:0 0 1.25rem}
		.olkil-auth-done[hidden]{display:none!important}
		.olkil-auth-done .olkil-btn{width:100%;justify-content:center}
	</style>
	<script>
	(function(){
	  if(document.getElementById('olkil-auth-done')) return;
	  var card=document.querySelector('.olkil-auth-card');
	  if(!card) return;
	  var wrap=document.createElement('div');
	  wrap.id='olkil-auth-done';
	  wrap.className='olkil-auth-done';
	  wrap.hidden=true;
	  wrap.innerHTML='<a class="olkil-btn olkil-btn--primary olkil-btn--lg" href="olkil://auth/done">Open OLKIL</a><button type="button" class="olkil-btn olkil-btn--ghost olkil-btn--lg" id="olkil-auth-close">Close this tab</button>';
	  var foot=card.querySelector('.olkil-auth-footnote');
	  if(foot) card.insertBefore(wrap, foot); else card.appendChild(wrap);
	  var btn=document.getElementById('olkil-auth-close');
	  if(btn) btn.addEventListener('click', function(){ try{ window.close(); }catch(e){} });
	})();
	</script>
	<?php
}, 5 );

