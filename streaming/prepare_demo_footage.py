"""Prepare the six replay files sequentially. Originals are never modified."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess

SOURCES = {
    'demo-cam67': '67_MOTA BAZAR.AVI',
    'demo-cam88': '88_RAGHUVEER CIRCLE.AVI',
    'demo-cam142': '142_TOWNHALL.AVI',
    'demo-cam161': '161_APC CIRCLE.AVI',
    'demo-cam180': '180_SAMARKHA CHOKDI.AVI',
    'demo-railway-exit': 'RAILWAY STATION EXIT.AVI',
}

def probe(path):
    return json.loads(subprocess.check_output([
        'ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(path)
    ], stderr=subprocess.DEVNULL))

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--footage-dir', type=Path, default=Path.home()/'Downloads/Demo_Footage')
    parser.add_argument('--allow-shorter', action='store_true', help='Accept recoverable footage shorter than a damaged AVI header; record the mismatch')
    parser.add_argument('--encoder', choices=['h264_videotoolbox', 'libx264'], default='libx264')
    args = parser.parse_args()
    output = args.footage_dir/'prepared'
    output.mkdir(exist_ok=True)
    for camera, filename in SOURCES.items():
        source = args.footage_dir/filename
        stat = source.stat()
        fingerprint = {'source_size': stat.st_size, 'source_mtime_ns': stat.st_mtime_ns, 'profile': 1}
        target = output/(camera+'.mp4')
        receipt = output/(camera+'.json')
        if target.exists() and receipt.exists() and all(json.loads(receipt.read_text()).get(k) == v for k, v in fingerprint.items()):
            print(camera+': already prepared', flush=True)
            continue
        duration = float(probe(source)['format']['duration'])
        if shutil.disk_usage(output).free < duration*200000 + 1024**3:
            raise RuntimeError('Insufficient free space to prepare '+camera)
        temporary = output/(camera+'.preparing.mp4')
        command = ['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
                   '-threads', '2', '-fflags', '+genpts+discardcorrupt', '-err_detect', 'ignore_err',
                   '-i', str(source), '-map', '0:v:0', '-an', '-filter_threads', '1',
                   '-vf', 'scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2:black,fps=15,format=yuv420p',
                   '-c:v', args.encoder, '-b:v', '900k', '-maxrate', '1100k', '-bufsize', '1800k',
                   '-g', '15', '-bf', '0']
        if args.encoder == 'libx264':
            command += ['-preset', 'veryfast', '-threads', '2', '-sc_threshold', '0']
        else:
            command += ['-allow_sw', '0']
        command += ['-movflags', '+faststart', str(temporary)]
        print(camera+': preparing full footage', flush=True)
        with (output/(camera+'.prepare.log')).open('w') as log:
            subprocess.run(command, stdout=log, stderr=log, check=True)
        result = probe(temporary)
        video = next(s for s in result['streams'] if s['codec_type'] == 'video')
        actual = float(result['format']['duration'])
        mismatch = abs(actual-duration) > max(5, duration*.01)
        if video['codec_name'] != 'h264' or actual <= 0 or (mismatch and not args.allow_shorter) or actual > duration + max(5, duration*.01):
            raise RuntimeError('Prepared video failed codec/duration validation: '+camera)
        if mismatch:
            print(f'{camera}: WARNING source header {duration:.1f}s; recovered {actual:.1f}s', flush=True)
        fingerprint.update(declared_duration=duration, prepared_duration=actual, duration_mismatch=mismatch)
        os.replace(temporary, target)
        receipt.write_text(json.dumps(fingerprint)+'\n')
        print(camera+': ready ('+str(round(actual))+' seconds)', flush=True)

if __name__ == '__main__':
    main()
