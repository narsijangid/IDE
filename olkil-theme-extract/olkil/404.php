<?php
/**
 * 404 — OLKIL branded.
 *
 * @package Astra
 */

get_header();
?>
<main id="content" class="olkil-section">
	<header class="olkil-page-hero">
		<div class="olkil-wrap">
			<p class="olkil-eyebrow" style="justify-content:center;">
				<span class="olkil-eyebrow__dot" aria-hidden="true"></span>
				404
			</p>
			<h1><?php esc_html_e( 'Page not found', 'astra' ); ?></h1>
			<p><?php esc_html_e( 'That link doesn’t exist. Head home or browse the blog.', 'astra' ); ?></p>
			<p style="margin-top:1.75rem;display:flex;gap:0.75rem;justify-content:center;flex-wrap:wrap;">
				<a class="olkil-btn olkil-btn--primary" href="<?php echo esc_url( home_url( '/' ) ); ?>"><?php esc_html_e( 'Go home', 'astra' ); ?></a>
				<a class="olkil-btn olkil-btn--ghost" href="<?php echo esc_url( olkil_blog_url() ); ?>"><?php esc_html_e( 'Blog', 'astra' ); ?></a>
			</p>
		</div>
	</header>
</main>
<?php
get_footer();
