"""Isolated synthetic media test; never starts the user's Compose stack or tunnel.

Run: python3 tests/benchmark_streaming.py --output /tmp/streaming-benchmark.json
Requires Docker, local FFmpeg, and the existing MediaMTX 1.20.0 image.
"""
import argparse
import concurrent.futures
import json
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.request
import urllib.error
import uuid

ROOT = Path(__file__).resolve().parents[1]


def command(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.PIPE).strip()


def playlist(url):
    with urllib.request.urlopen(url, timeout=3) as response:
        data = response.read(262144).decode()
    if '#EXT-X-STREAM-INF:' in data:
        child = next(line for line in data.splitlines() if line and not line.startswith('#'))
        return playlist(url.rsplit('/', 1)[0] + '/' + child)
    if '#EXTINF:' not in data: raise ValueError('No completed video segment')
    return data


def wait_playlist(url, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try: return playlist(url)
        except (OSError, ValueError): time.sleep(.2)
    raise RuntimeError('HLS did not become playable')


def scenario(variant, gop):
    name = 'digdhrishti-audit-' + uuid.uuid4().hex[:10]
    publishers = []
    with tempfile.TemporaryDirectory(prefix='stream-audit-') as directory:
        logs = open(Path(directory) / 'ffmpeg.log', 'w')
        started = False
        try:
            command('docker', 'run', '-d', '--name', name,
                    '-p', '127.0.0.1::8554', '-p', '127.0.0.1::8888',
                    '-v', str(ROOT / 'mediamtx.yml') + ':/mediamtx.yml:ro',
                    '-e', 'MTX_HLSVARIANT=' + variant,
                    '-e', 'MTX_RTSPTRANSPORTS=tcp', '-e', 'MTX_RTMP=no',
                    '-e', 'MTX_WEBRTC=no', '-e', 'MTX_SRT=no',
                    'bluenviron/mediamtx:1.20.0')
            started = True
            rtsp = command('docker', 'port', name, '8554/tcp').split(':')[-1]
            hls = command('docker', 'port', name, '8888/tcp').split(':')[-1]
            time.sleep(.5)
            def publish(i):
                return subprocess.Popen(['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error',
                    '-re', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=15',
                    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
                    '-pix_fmt', 'yuv420p', '-g', str(gop), '-keyint_min', str(gop),
                    '-bf', '0', '-sc_threshold', '0', '-b:v', '900k', '-threads', '1',
                    '-f', 'rtsp', '-rtsp_transport', 'tcp',
                    f'rtsp://127.0.0.1:{rtsp}/audit/cam{i}'], stdout=logs, stderr=logs)
            start = time.monotonic()
            for i in range(4): publishers.append(publish(i))
            urls = [f'http://127.0.0.1:{hls}/audit/cam{i}/index.m3u8?cookieCheck=1' for i in range(4)]
            initial = [wait_playlist(url) for url in urls]
            startup = time.monotonic() - start
            decode_start = time.monotonic()
            decoded = subprocess.run(['ffmpeg','-nostdin','-hide_banner','-loglevel','error',
                       '-i',urls[0],'-frames:v','1','-f','null','-'],stdout=logs,stderr=logs,timeout=20)
            if decoded.returncode: raise RuntimeError('HLS frame decoding failed')
            decode_seconds = time.monotonic()-decode_start
            def read(i):
                start=time.monotonic(); playlist(urls[i % 4]); return (time.monotonic()-start)*1000
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                latencies=list(pool.map(read,range(80)))
            time.sleep(2.2)
            advancing = all(playlist(url) != old for url, old in zip(urls, initial))
            if not advancing: raise RuntimeError('A playlist stopped advancing')
            publishers[0].terminate();publishers[0].wait(5)
            disconnected = False
            deadline=time.monotonic()+5
            while time.monotonic()<deadline:
                try: playlist(urls[0])
                except OSError: disconnected=True;break
                time.sleep(.1)
            restart=time.monotonic(); publishers[0]=publish(0); wait_playlist(urls[0])
            recovery=time.monotonic()-restart
            return {'mode':variant,'gop_frames':gop,'fps':15,'cameras':4,
                    'all_playlists_startup_seconds':round(startup,3),
                    'startup_through_first_decoded_frame_seconds':round(startup+decode_seconds,3),
                    'warm_hls_decode_one_frame_seconds':round(decode_seconds,3),
                    'http_read_requests':80,'http_concurrency':8,'http_failures':0,
                    'playlist_read_p95_ms':round(sorted(latencies)[75],3),
                    'partial_segments_present':all('#EXT-X-PART:' in p for p in initial),
                    'all_playlists_advanced':advancing,'disconnect_detected':disconnected,
                    'publisher_restart_to_playlist_seconds':round(recovery,3),
                    'mediamtx_resources':command('docker','stats','--no-stream','--format','{{.CPUPerc}} CPU; {{.MemUsage}} memory',name)}
        finally:
            for p in publishers:
                if p.poll() is None:
                    p.terminate()
                    try: p.wait(5)
                    except subprocess.TimeoutExpired: p.kill();p.wait()
            if started: command('docker','rm','-f',name)
            logs.close()


if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    results=[]
    for variant,gop in [('fmp4',30),('lowLatency',15)]:
        print('Testing '+variant,flush=True)
        results.append(scenario(variant,gop))
    report={'scope':'Synthetic local 4-camera test; no WAN, browser render or glass-to-glass latency measurement.',
            'results':results}
    args.output.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,indent=2),flush=True)
