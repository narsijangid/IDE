<?php
/**
 * Product demo — interactive OLKIL IDE widget.
 *
 * The widget CSS/JS are not part of the initial page load: a tiny inline loader fetches
 * them only when the section is about to scroll into view. The skeleton below reserves
 * the exact widget height so nothing shifts when it mounts.
 *
 * @package OLKIL
 */
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

$ide_ver  = '1.0.3';
$ide_base = OLKIL_URI . 'assets/olkil/ide-demo/';
?>
<section class="olkil-demo olkil-section olkil-section--tight" id="demo" aria-labelledby="olkil-demo-title">
	<style id="olkil-ide-ph-css">
		.olkil-demo__ide{width:100%;max-width:1180px;margin:0 auto;line-height:normal}
		.olkil-ide-ph{box-sizing:border-box;height:641px;border:1px solid #2a2a2f;border-radius:12px;box-shadow:0 30px 80px rgba(0,0,0,.5);background:linear-gradient(#111113,#111113) 0 0/100% 36px no-repeat,linear-gradient(#111113,#111113) 0 36px/48px 100% no-repeat,linear-gradient(#161618,#161618) 48px 36px/240px 100% no-repeat,linear-gradient(#161618,#161618) 100% 36px/350px 100% no-repeat,#1b1b1e}
		@media (max-width:900px){.olkil-ide-ph{height:761px;background:linear-gradient(#111113,#111113) 0 0/100% 36px no-repeat,#1b1b1e}}
	</style>
	<div class="olkil-wrap">
		<header class="olkil-section__head">
			<h2 id="olkil-demo-title"><?php esc_html_e( 'See OLKIL in action', 'olkil' ); ?></h2>
			<p><?php esc_html_e( 'Try the IDE right here — explorer, editor, terminal and the OLKIL agent. Click around, it is live.', 'olkil' ); ?></p>
		</header>
		<div
			class="olkil-demo__ide"
			id="olkil-ide-mount"
			data-css="<?php echo esc_url( $ide_base . 'ide-demo.css?ver=' . $ide_ver ); ?>"
			data-js="<?php echo esc_url( $ide_base . 'ide-demo.js?ver=' . $ide_ver ); ?>"
			data-logo="<?php echo esc_url( $ide_base . 'olkil-logo.png?ver=' . $ide_ver ); ?>"
		>
			<div class="olkil-ide-ph" role="img" aria-label="<?php esc_attr_e( 'OLKIL IDE demo loading', 'olkil' ); ?>"></div>
		</div>
	</div>
	<script>
	(function () {
		var m = document.getElementById('olkil-ide-mount');
		if (!m) return;
		var started = false;
		function load() {
			if (started) return;
			started = true;
			var css = new Promise(function (done) {
				var l = document.createElement('link');
				l.rel = 'stylesheet';
				l.href = m.getAttribute('data-css');
				l.onload = l.onerror = done;
				document.head.appendChild(l);
			});
			var js = new Promise(function (done, fail) {
				var s = document.createElement('script');
				s.src = m.getAttribute('data-js');
				s.async = true;
				s.onload = done;
				s.onerror = fail;
				document.body.appendChild(s);
			});
			Promise.all([css, js]).then(function () {
				requestAnimationFrame(function () {
					if (window.olkilIdeMount) window.olkilIdeMount(m, m.getAttribute('data-logo'));
				});
			}).catch(function () { started = false; });
		}
		if ('IntersectionObserver' in window) {
			var io = new IntersectionObserver(function (entries) {
				for (var i = 0; i < entries.length; i++) {
					if (entries[i].isIntersecting) { io.disconnect(); load(); return; }
				}
			}, { rootMargin: '600px 0px' });
			io.observe(m);
		} else {
			window.addEventListener('load', function () { setTimeout(load, 1500); });
		}
	})();
	</script>
</section>
