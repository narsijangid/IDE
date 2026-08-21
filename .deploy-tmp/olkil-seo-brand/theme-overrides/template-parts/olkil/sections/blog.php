<?php
/**
 * Latest blog posts
 *
 * @package Astra
 */
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

$query = new WP_Query(
	array(
		'posts_per_page'      => 3,
		'post_status'         => 'publish',
		'ignore_sticky_posts' => true,
		'no_found_rows'       => true,
	)
);

if ( ! $query->have_posts() ) {
	return;
}
?>
<section class="olkil-section olkil-section--tight" id="blog" aria-labelledby="olkil-blog-title">
	<div class="olkil-wrap">
		<div class="olkil-section__head olkil-reveal">
			<h2 id="olkil-blog-title"><?php esc_html_e( 'From the blog', 'astra' ); ?></h2>
			<p><?php esc_html_e( 'Product updates, AI workflows, and tips from the OLKIL team.', 'astra' ); ?></p>
		</div>

		<div class="olkil-posts">
			<?php
			while ( $query->have_posts() ) :
				$query->the_post();
				get_template_part( 'template-parts/olkil/post', 'card' );
			endwhile;
			wp_reset_postdata();
			?>
		</div>

		<p class="olkil-blog-more olkil-reveal">
			<a class="olkil-btn olkil-btn--ghost" href="<?php echo esc_url( olkil_blog_url() ); ?>"><?php esc_html_e( 'View all posts', 'astra' ); ?></a>
		</p>
	</div>
</section>
