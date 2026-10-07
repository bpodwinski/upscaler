from pathlib import Path
from PIL import Image, ImageChops, ImageStat
import json

upstream = Path('D:/Dev/upscaler/bench/results/windows-local/core-baseline')
fork = Path('bench/results/windows-local/core-extracted')
results = []
for original in upstream.glob('*.png'):
    candidate = fork / original.name
    if not candidate.exists():
        continue
    a, b = Image.open(original).convert('RGBA'), Image.open(candidate).convert('RGBA')
    if a.size != b.size:
        raise RuntimeError('Different viewport dimensions')
    difference = ImageChops.difference(a, b)
    statistics = ImageStat.Stat(difference)
    maximum = max(high for low, high in difference.getextrema())
    rms = max(statistics.rms)
    results.append({'capture': original.name, 'maxChannelDifference': maximum, 'maxChannelRms': rms, 'pass': maximum <= 1 and rms <= 0.25})
output = fork / 'upstream-comparison.json'
output.write_text(json.dumps(results, indent=2), encoding='utf-8')
print(json.dumps(results, indent=2))
if not results or not all(r['pass'] for r in results):
    raise RuntimeError('Upstream comparison failed')
