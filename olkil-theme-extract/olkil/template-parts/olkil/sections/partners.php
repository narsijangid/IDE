<?php
/**
 * Works with leading AI companies — logo marquee under the hero.
 * Official marks are local SVGs (no third-party logo API at runtime).
 *
 * @package OLKIL
 */
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

if ( ! function_exists( 'olkil_ai_company_logos' ) ) {
	/**
	 * @return array<int, array{name:string,file:string}>
	 */
	function olkil_ai_company_logos() {
		return array(
			array( 'name' => 'Google', 'file' => 'google.svg', 'on_dark' => false ),
			array( 'name' => 'NVIDIA', 'file' => 'nvidia.svg', 'on_dark' => false ),
			array( 'name' => 'OpenAI', 'file' => 'openai.svg', 'on_dark' => true ),
			array( 'name' => 'Anthropic', 'file' => 'anthropic.svg', 'on_dark' => false ),
			array( 'name' => 'xAI', 'file' => 'xai.svg', 'on_dark' => true ),
			array( 'name' => 'Microsoft', 'file' => 'microsoft.svg', 'on_dark' => false ),
			array( 'name' => 'DeepSeek', 'file' => 'deepseek.svg', 'on_dark' => false ),
			array( 'name' => 'Meta', 'file' => 'meta.svg', 'on_dark' => false ),
			array( 'name' => 'Mistral', 'file' => 'mistral.svg', 'on_dark' => false ),
			array( 'name' => 'Alibaba', 'file' => 'alibaba.svg', 'on_dark' => false ),
			array( 'name' => 'Qwen', 'file' => 'qwen.svg', 'on_dark' => false ),
			array( 'name' => 'Cohere', 'file' => 'cohere.svg', 'on_dark' => false ),
			array( 'name' => 'Perplexity', 'file' => 'perplexity.svg', 'on_dark' => false ),
			array( 'name' => 'Hugging Face', 'file' => 'huggingface.svg', 'on_dark' => false ),
			array( 'name' => 'Groq', 'file' => 'groq.svg', 'on_dark' => false ),
			array( 'name' => 'Poolside', 'file' => 'poolside.svg', 'on_dark' => true ),
		);
	}
}

$olkil_ai_logos = olkil_ai_company_logos();
$olkil_ai_loop  = array_merge( $olkil_ai_logos, $olkil_ai_logos );
$olkil_logo_uri = OLKIL_URI . 'assets/olkil/img/ai-logos/';
?>
<section class="olkil-ai-cos" aria-labelledby="olkil-ai-cos-title">
	<div class="olkil-wrap">
		<header class="olkil-section__head">
			<h2 id="olkil-ai-cos-title"><?php esc_html_e( 'Works with leading AI companies', 'olkil' ); ?></h2>
			<p><?php esc_html_e( "Access the world's leading AI models from a single IDE.", 'olkil' ); ?></p>
		</header>
	</div>
	<div class="olkil-ai-cos__viewport">
		<div class="olkil-ai-cos__track" aria-hidden="true">
			<?php foreach ( $olkil_ai_loop as $co ) : ?>
				<div class="olkil-ai-cos__chip">
					<span class="olkil-ai-cos__mark">
						<img
							class="olkil-ai-cos__logo<?php echo ! empty( $co['on_dark'] ) ? ' olkil-ai-cos__logo--on-dark' : ''; ?>"
							src="<?php echo esc_url( $olkil_logo_uri . $co['file'] ); ?>"
							alt=""
							width="32"
							height="32"
							decoding="async"
						/>
					</span>
					<span class="olkil-ai-cos__name"><?php echo esc_html( $co['name'] ); ?></span>
				</div>
			<?php endforeach; ?>
		</div>
	</div>
</section>
