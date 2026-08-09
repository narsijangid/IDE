<?php
/**
 * Archives — category, tag, author, date.
 *
 * @package Astra
 */

get_header();

$title = get_the_archive_title();
$desc  = get_the_archive_description();
?>
<main id="content" class="olkil-section">
	<header class="olkil-page-hero" style="padding-top:2rem;padding-bottom:1rem;">
		<div class="olkil-wrap">
			<p class="olkil-eyebrow" style="justify-content:center;">
				<span class="olkil-eyebrow__dot" aria-hidden="true"></span>
				<?php esc_html_e( 'Archive', 'astra' ); ?>
			</p>
			<h1><?php echo wp_kses_post( $title ); ?></h1>
			<?php if ( $desc ) : ?>
				<div style="color:var(--olkil-text-muted);max-width:36rem;margin:0.75rem auto 0;"><?php echo wp_kses_post( $desc ); ?></div>
			<?php endif; ?>
		</div>
	</header>
	<?php get_template_part( 'template-parts/olkil/posts', 'loop' ); ?>
</main>
<?php
get_footer();
