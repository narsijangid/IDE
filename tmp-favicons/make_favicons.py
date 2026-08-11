from PIL import Image
from pathlib import Path

src = Image.open(r"c:\zzzzzz\OLU\tmp-favicons\icon-192.png").convert("RGBA")
out_dir = Path(r"c:\zzzzzz\OLU\wp-plugins\olkil-seo-brand\brand")
out_dir.mkdir(parents=True, exist_ok=True)

for size in (48, 96, 144, 192, 512):
    img = src.resize((size, size), Image.Resampling.LANCZOS)
    path = out_dir / f"favicon-{size}.png"
    img.save(path, format="PNG", optimize=True)
    print("wrote", path, path.stat().st_size)

ico_sizes = [(16, 16), (32, 32), (48, 48), (64, 64)]
ico_images = [src.resize(s, Image.Resampling.LANCZOS) for s in ico_sizes]
ico_path = out_dir / "favicon.ico"
ico_images[0].save(ico_path, format="ICO", sizes=ico_sizes)
print("wrote", ico_path, ico_path.stat().st_size)

src.resize((180, 180), Image.Resampling.LANCZOS).save(
    out_dir / "apple-touch-icon.png", format="PNG", optimize=True
)
print("done")
