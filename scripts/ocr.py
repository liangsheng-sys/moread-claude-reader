# 本机文字识别：python scripts/ocr.py <pdf> <页码,页码,...>
# 由 server/ocr.js 启动。每识别完一页输出一行 JSON：
#   {"page": 12, "lines": [{"t": "文字", "b": [x0, y0, x1, y1], "s": 0.98}, ...]}
# b 是相对整页的比例坐标（左上角为原点）。全程在本机运行，不联网。
import json
import sys

import pypdfium2 as pdfium
from rapidocr import RapidOCR

sys.stdout.reconfigure(encoding='utf-8')
SCALE = 2  # 约 144 DPI：中文正文识别得清楚，再高也不更准，只会更慢


def main():
    path, pages = sys.argv[1], [int(p) for p in sys.argv[2].split(',') if p]
    engine = RapidOCR()
    pdf = pdfium.PdfDocument(path)
    for n in pages:
        page = pdf[n - 1]
        img = page.render(scale=SCALE).to_pil()
        w, h = img.size
        r = engine(img)
        lines = []
        for box, text, score in zip(r.boxes if r.boxes is not None else [], r.txts or [], r.scores or []):
            xs, ys = [float(p[0]) for p in box], [float(p[1]) for p in box]
            lines.append({'t': text, 'b': [round(min(xs) / w, 4), round(min(ys) / h, 4), round(max(xs) / w, 4), round(max(ys) / h, 4)], 's': round(float(score), 3)})
        page.close()
        print(json.dumps({'page': n, 'lines': lines}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
