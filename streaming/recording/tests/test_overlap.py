import asyncio
from contextlib import contextmanager
from datetime import timedelta
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core import playback_plan, has_overlap, utc, digest

class OverlapTests(unittest.TestCase):
    def test_nested_intervals_and_half_open_boundary(self):
        start=utc('2026-09-12T16:42:00Z')
        rows=[{'start_at':start+timedelta(seconds=a),'end_at':start+timedelta(seconds=b)} for a,b in [(0,4),(1,2),(2.15,6.15)]]
        plan=playback_plan(rows,start,start+timedelta(seconds=6.15))
        self.assertTrue(has_overlap(rows))
        self.assertEqual([p['index'] for p in plan],[0,2])
        self.assertEqual(plan[0]['end'],plan[1]['start'])
        self.assertAlmostEqual(plan[1]['offset'],1.85)
        self.assertAlmostEqual(sum(p['duration'] for p in plan),6.15)
        self.assertFalse(has_overlap([rows[0],{'start_at':rows[0]['end_at'],'end_at':rows[-1]['end_at']}]))

    @unittest.skipUnless(shutil.which('ffmpeg'), 'FFmpeg required')
    def test_real_export_trims_overlap_without_duplicate_frames(self):
        import api
        from starlette.requests import Request
        start=utc('2026-09-12T16:42:00Z')
        with tempfile.TemporaryDirectory() as folder:
            rows=[]
            for i,color in enumerate(['red','blue']):
                file=Path(folder)/f'{i}.mp4'
                subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i',f'color={color}:s=160x90:r=20','-t','4','-c:v','libx264','-threads','1','-g','20','-bf','0',str(file)],check=True)
                a=start+timedelta(seconds=2.15*i)
                rows.append({'start_at':a,'end_at':a+timedelta(seconds=4),'object_key':str(file),'sha256':digest(file),'bytes':file.stat().st_size})
            class DB:
                @contextmanager
                def connection(self): yield self
            class Storage:
                def download_file(self,bucket,key,target):shutil.copyfile(key,target)
            request=Request({'type':'http','headers':[(b'x-service-key',b'b'*40),(b'x-actor-id',b'test')],'query_string':b''})
            with patch.dict(os.environ,{'RECORDING_SERVICE_KEY':'b'*40,'S3_BUCKET':'test','PLAYBACK_SIGNING_KEY':'c'*40,'PUBLIC_PLAYBACK_URL':'http://test'}),patch.object(api,'pool',DB()),patch.object(api,'s3',Storage()),patch.object(api,'query',return_value=rows),patch.object(api,'audit'):
                spans=api.recordings(request,'stream/test',start.isoformat(),rows[-1]['end_at'].isoformat())
                self.assertEqual(len(spans),1)
                for format in ['mp4','fmp4']:
                    response=api.playback(request,'stream/test',spans[0]['start'],spans[0]['duration'],format)
                    try:
                        raw=subprocess.check_output(['ffmpeg','-v','error','-i',str(response.path),'-vf','scale=1:1','-pix_fmt','rgb24','-f','rawvideo','-'])
                        frames=[raw[i:i+3] for i in range(0,len(raw),3)]
                        self.assertEqual(len(frames),123)
                        self.assertTrue(all(f[0]>200 and f[2]<40 for f in frames[:80]))
                        self.assertTrue(all(f[2]>200 and f[0]<40 for f in frames[80:]))
                    finally:asyncio.run(response.background())
                gap=[rows[0],dict(rows[1],start_at=start+timedelta(seconds=5))]
                with patch.object(api,'query',return_value=gap),self.assertRaises(api.HTTPException) as error:
                    api.playback(request,'stream/test',start.isoformat(),6.15,'mp4')
                self.assertEqual(error.exception.status_code,409)
