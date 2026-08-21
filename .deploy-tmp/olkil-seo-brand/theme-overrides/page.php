<?php
/**
 * Pages — OLKIL branded. Blog slug shows posts grid.
 *
 * @package Astra
 */

get_header();

$is_blog_page = is_page( 'blog' ) && ! is_front_page();

if ( $is_blog_page ) {
	$paged = max( 1, (int) get_query_var( 'paged' ), (int) get_query_var( 'page' ) );
	// Show latest posts even if this page isn't set as Posts page yet.
	$blog_query = new WP_Query(
		array(
			'post_type'           => 'post',
			'post_status'         => 'publish',
			'posts_per_page'      => 6,
			'ignore_sticky_posts' => true,
			'paged'               => $paged,
		)
	);
	?>
	<main id="content" class="olkil-section">
		<header class="olkil-page-hero" style="padding-top:2rem;padding-bottom:1rem;">
			<div class="olkil-wrap">
				<p class="olkil-eyebrow" style="justify-content:center;">
					<span class="olkil-eyebrow__dot" aria-hidden="true"></span>
					<?php esc_html_e( 'Blog', 'astra' ); ?>
				</p>
				<h1><?php the_title(); ?></h1>
				<p><?php esc_html_e( 'Updates, AI workflows, and notes from the team behind the free AI IDE.', 'astra' ); ?></p>
			</div>
		</header>
		<div class="olkil-wrap">
			<?php if ( $blog_query->have_posts() ) : ?>
				<div class="olkil-posts olkil-posts--archive">
					<?php
					while ( $blog_query->have_posts() ) :
						$blog_query->the_post();
						get_template_part( 'template-parts/olkil/post', 'card' );
					endwhile;
					wp_reset_postdata();
					?>
				</div>

				<?php if ( (int) $blog_query->max_num_pages > 1 ) : ?>
					<nav class="olkil-pagination olkil-reveal" aria-label="<?php esc_attr_e( 'Posts pagination', 'astra' ); ?>">
						<?php
						echo paginate_links(
							array(
								'total'     => (int) $blog_query->max_num_pages,
								'current'   => $paged,
								'mid_size'  => 2,
								'prev_text' => esc_html__( '← Newer', 'astra' ),
								'next_text' => esc_html__( 'Older →', 'astra' ),
							)
						);
						?>
					</nav>
				<?php endif; ?>
			<?php else : ?>
				<p style="text-align:center;color:var(--olkil-text-muted);"><?php esc_html_e( 'No posts yet. Publish your first article in WordPress.', 'astra' ); ?></p>
			<?php endif; ?>
		</div>
	</main>
	<?php
	get_footer();
	return;
}
?>
<main id="content" class="olkil-section" style="padding-top:2.5rem;">
	<div class="olkil-wrap" style="max-width:760px;">
		<?php
		while ( have_posts() ) :
			the_post();
			?>
			<article <?php post_class( 'olkil-article' ); ?>>
				<header class="olkil-article__header">
					<p class="olkil-eyebrow">
						<span class="olkil-eyebrow__dot" aria-hidden="true"></span>
						<?php esc_html_e( 'Page', 'astra' ); ?>
					</p>
					<h1 class="olkil-article__title"><?php the_title(); ?></h1>
				</header>

				<?php if ( has_post_thumbnail() ) : ?>
					<div class="olkil-article__thumb">
						<?php the_post_thumbnail( 'large' ); ?>
					</div>
				<?php endif; ?>

				<div class="entry-content olkil-prose">
					<?php the_content(); ?>
				</div>
			</article>
			<?php
		endwhile;
		?>
	</div>
</main>
<?php
get_footer();
