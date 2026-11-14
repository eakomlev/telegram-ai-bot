#!/bin/sh
set -eu
task_tmp=$(mktemp -d)
trap 'rm -rf "$task_tmp"' EXIT INT TERM
yt-dlp --version
gallery-dl --version
python3 - <<'PYEXTRACTORS'
from yt_dlp import YoutubeDL
ydl = YoutubeDL({'allowed_extractors': ['youtube.*', 'tiktok.*', 'vm.tiktok.*', 'instagram.*', 'vk.*'], 'quiet': True})
for key in ['Youtube', 'TikTok', 'TikTokVM', 'Instagram', 'VK']:
    assert key in ydl._ies, key
assert 'Generic' not in ydl._ies
print('Supported video extractors check passed')
PYEXTRACTORS
# Synthetic clip exercises the exact Telegram output codec and scaling options.
ffmpeg -nostdin -v error -f lavfi -i testsrc2=size=1080x1920:rate=10 -f lavfi -i sine=frequency=440 -t 1 -c:v libx264 -threads 2 -pix_fmt yuv420p -c:a aac "$task_tmp/source.mp4"
ffmpeg -nostdin -v error -i "$task_tmp/source.mp4" -map 0:v:0 -map '0:a:0?' \
  -vf "scale='if(gte(iw\,ih)\,min(720\,iw)\,-2)':'if(lt(iw\,ih)\,min(720\,ih)\,-2)',setsar=1" \
  -c:v libx264 -threads 2 -preset veryfast -crf 26 -pix_fmt yuv420p \
  -c:a aac -b:a 128k -movflags +faststart -fs 47185921 -y "$task_tmp/video.mp4"
ffprobe -v error -show_entries stream=codec_name,width,height -show_entries format=duration -of json "$task_tmp/video.mp4" > "$task_tmp/probe.json"
python3 - "$task_tmp/probe.json" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
video = next(s for s in data['streams'] if s['codec_name'] == 'h264')
assert 0 < video['width'] <= 720 and 0 < video['height'] <= 720
assert any(s['codec_name'] == 'aac' for s in data['streams'])
assert abs(float(data['format']['duration']) - 1) < .2
print('Video processing smoke check passed')
PY

# Decode image formats and normalize extreme aspect ratios for Telegram photo albums.
ffmpeg -nostdin -v error -f lavfi -i color=c=blue:s=1920x20 -frames:v 1 -threads 1 "$task_tmp/image.png"
ffmpeg -nostdin -v error -i "$task_tmp/image.png" -frames:v 1 \
  -vf "scale=w='min(1920,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease,pad=w='ceil(max(iw,ih/20)/2)*2':h='ceil(max(ih,iw/20)/2)*2':x='(ow-iw)/2':y='(oh-ih)/2'" \
  -threads 1 -q:v 3 -y "$task_tmp/photo.jpg"
ffprobe -v error -show_entries stream=width,height -of json "$task_tmp/photo.jpg" > "$task_tmp/photo.json"
python3 - "$task_tmp/photo.json" <<'PYIMAGE'
import json, sys
from gallery_dl import extractor
for url in ['https://www.instagram.com/p/ABC123/', 'https://x.com/test/status/1234567890', 'https://www.reddit.com/r/test/comments/abc123/title/', 'https://www.pixiv.net/en/artworks/123456', 'https://imgur.com/a/ABC123']:
    assert extractor.find(url) is not None, url
with open(sys.argv[1]) as f:
    image = json.load(f)['streams'][0]
w, h = image['width'], image['height']
assert w + h <= 10000 and max(w/h, h/w) <= 20
print('Gallery extractors and image processing smoke check passed')
PYIMAGE
