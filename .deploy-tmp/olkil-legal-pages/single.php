<?php
/**
 * Single post — OLKIL reading view.
 *
 * @package Astra
 */

get_header();
?>
<main id="content" class="olkil-section" style="padding-top:2.5rem;">
	<div class="olkil-wrap" style="max-width:760px;">
		<?php
		while ( have_posts() ) :
			the_post();
			?>
			<article <?php post_class( 'olkil-article' ); ?> itemscope itemtype="https://schema.org/BlogPosting">
				<header class="olkil-article__header">
					<p class="olkil-eyebrow">
						<span class="olkil-eyebrow__dot" aria-hidden="true"></span>
						<span itemprop="datePublished"><?php echo esc_html( get_the_date() ); ?></span>
						<?php
						$cats = get_the_category();
						if ( ! empty( $cats ) ) :
							?>
							<span aria-hidden="true">·</span>
							<span itemprop="articleSection"><?php echo esc_html( $cats[0]->name ); ?></span>
						<?php endif; ?>
					</p>
					<h1 class="olkil-article__title" itemprop="headline"><?php the_title(); ?></h1>
					<p class="olkil-article__meta">
						<?php
						printf(
							/* translators: %s: author name */
							esc_html__( 'By %s', 'astra' ),
							'<span itemprop="author">' . esc_html( get_the_author() ) . '</span>'
						);
						?>
					</p>
				</header>

				<?php if ( has_post_thumbnail() ) : ?>
					<div class="olkil-article__thumb">
						<?php the_post_thumbnail( 'large', array( 'itemprop' => 'image' ) ); ?>
					</div>
				<?php endif; ?>

				<div class="entry-content olkil-prose" itemprop="articleBody">
					<?php
					the_content();
					wp_link_pages(
						array(
							'before' => '<nav class="olkil-page-links"><span>' . esc_html__( 'Pages:', 'astra' ) . '</span>',
							'after'  => '</nav>',
						)
					);
					?>
				</div>

				<?php
				$tags = get_the_tags();
				if ( $tags ) :
					?>
					<div class="olkil-article__tags" style="margin-top:1.5rem;display:flex;flex-wrap:wrap;gap:0.5rem;">
						<?php foreach ( $tags as $tag ) : ?>
							<a class="olkil-btn olkil-btn--ghost" style="padding:0.35rem 0.85rem;font-size:0.8rem;" href="<?php echo esc_url( get_tag_link( $tag->term_id ) ); ?>">
								#<?php echo esc_html( $tag->name ); ?>
							</a>
						<?php endforeach; ?>
					</div>
				<?php endif; ?>

				<footer class="olkil-article__footer">
					<a class="olkil-btn olkil-btn--ghost" href="<?php echo esc_url( olkil_blog_url() ); ?>">
						<?php esc_html_e( '← Back to blog', 'astra' ); ?>
					</a>
				</footer>
			</article>
			<?php
		endwhile;
		?>
	</div>
</main>
<?php
olkil_section( 'cta' );
get_footer();
