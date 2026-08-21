<?php
/**
 * Product demo — full-width video
 *
 * @package OLKIL
 */
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

$video_url = OLKIL_URI . 'assets/olkil/video/IDEdemo.mp4';
?>
<section class="olkil-demo olkil-section olkil-section--tight" id="demo" aria-label="<?php esc_attr_e( 'OLKIL product demo', 'olkil' ); ?>">
	<div class="olkil-wrap">
		<div class="olkil-demo__frame olkil-reveal">
			<video
				class="olkil-demo__video"
				src="<?php echo esc_url( $video_url ); ?>"
				autoplay
				muted
				loop
				playsinline
				preload="auto"
				fetchpriority="high"
				disablePictureInPicture
				aria-label="<?php esc_attr_e( 'OLKIL IDE demo', 'olkil' ); ?>"
			></video>
		</div>
	</div>
</section>
