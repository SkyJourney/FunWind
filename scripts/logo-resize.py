#!/usr/bin/env python3
"""LOGO 入池预处理（M10.5 LOGO 池配套）：
透明边裁剪 → 方形画布居中 → LANCZOS 缩放出 112/224px 两档。
用法：python3 scripts/logo-resize.py <源图> [<源图>...]（输出到 apps/web/public/logo/）
"""
import sys
from pathlib import Path

from PIL import Image

# 仓库根 = 脚本上两级（scripts/ 在仓库根）
DST = Path(__file__).resolve().parent.parent / "apps/web/public/logo"
SIZES = (112, 224)


def process(path: Path) -> None:
    im = Image.open(path).convert("RGBA")
    bbox = im.getbbox()
    if bbox:
        im = im.crop(bbox)
    side = max(im.size)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(im, ((side - im.width) // 2, (side - im.height) // 2))
    stem = path.stem.lower().replace(" ", "-")
    for px in SIZES:
        out = DST / f"{stem}-{px}.png"
        canvas.resize((px, px), Image.LANCZOS).save(out, optimize=True)
        print(f"{out} ({out.stat().st_size // 1024}KB)")


if __name__ == "__main__":
    DST.mkdir(parents=True, exist_ok=True)
    for arg in sys.argv[1:]:
        process(Path(arg))
