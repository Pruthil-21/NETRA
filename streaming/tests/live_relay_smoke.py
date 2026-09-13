"""Exercise the built relay against a local synthetic organizer, never real credentials.

Requires images digdhrishti-stream-audit:local and bluenviron/mediamtx:1.20.0.
Run: python3 tests/live_relay_smoke.py
"""
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import urllib.request
import urllib.parse
import uuid
from benchmark_streaming import command, wait_playlist, ROOT


def main():
    prefix='digdhrishti-smoke-'+uuid.uuid4().hex[:8]
    password=uuid.uuid4().hex+uuid.uuid4().hex
    origin=prefix+'-media';relay=prefix+'-relay';network=prefix+'-network'
    containers=[];publisher=None;server=None
    command('docker','network','create',network)
    with tempfile.TemporaryDirectory(prefix='stream-smoke-') as directory:
        temp=Path(directory);log=open(temp/'publisher.log','w')
        try:
            command('docker','run','-d','--name',origin,'--network',network,
                    '-p','127.0.0.1::8554','-p','127.0.0.1::8888',
                    '-v',str(ROOT/'mediamtx.yml')+':/mediamtx.yml:ro',
                    '-e','MTX_AUTHINTERNALUSERS_2_USER=publisher',
                    '-e','MTX_AUTHINTERNALUSERS_2_PASS='+password,
                    '-e','MTX_AUTHINTERNALUSERS_2_PERMISSIONS_0_ACTION=publish',
                    '-e','MTX_HLSVARIANT=lowLatency','bluenviron/mediamtx:1.20.0')
            containers.append(origin)
            rtsp=command('docker','port',origin,'8554/tcp').split(':')[-1]
            hls=command('docker','port',origin,'8888/tcp').split(':')[-1]
            time.sleep(.5)
            publisher=subprocess.Popen(['ffmpeg','-nostdin','-hide_banner','-loglevel','error',
                '-re','-f','lavfi','-i','testsrc2=size=640x360:rate=15','-c:v','libx264',
                '-preset','ultrafast','-tune','zerolatency','-g','15','-bf','0','-threads','1',
                '-f','rtsp','-rtsp_transport','tcp',f'rtsp://publisher:{password}@127.0.0.1:{rtsp}/upstream/cam01'],stdout=log,stderr=log)
            wait_playlist(f'http://127.0.0.1:{hls}/upstream/cam01/index.m3u8?cookieCheck=1')
            class Handler(BaseHTTPRequestHandler):
                def log_message(self,*args): pass
                def respond(self,code,data=b'',cookie=False):
                    self.send_response(code);self.send_header('Content-Length',str(len(data)))
                    if cookie: self.send_header('Set-Cookie','session=fixture; Path=/; HttpOnly')
                    self.end_headers();self.wfile.write(data)
                def do_POST(self):
                    fields=urllib.parse.parse_qs(self.rfile.read(int(self.headers.get('Content-Length','0'))).decode())
                    valid=fields=={'email':['demo@example.invalid'],'password':['demo-only']}
                    self.respond(200 if valid else 401,cookie=valid)
                def do_GET(self):
                    if self.path=='/': self.respond(200);return
                    if 'session=fixture' not in self.headers.get('Cookie',''):
                        self.respond(401);return
                    if self.path=='/cameras.json':
                        self.respond(200,json.dumps([{'id':'cam01','name':'Synthetic'}]).encode());return
                    if not self.path.startswith('/cam01/'):
                        self.respond(404);return
                    path=self.path.replace('/cam01/','/upstream/cam01/',1)
                    if path.endswith('index.m3u8'): path+='?cookieCheck=1'
                    try:
                        with urllib.request.urlopen(f'http://127.0.0.1:{hls}'+path,timeout=5) as response:
                            self.respond(200,response.read())
                    except OSError: self.respond(502)
            server=ThreadingHTTPServer(('0.0.0.0',0),Handler)
            threading.Thread(target=server.serve_forever,daemon=True).start()
            (temp/'email').write_text('demo@example.invalid');(temp/'password').write_text('demo-only')
            command('docker','run','-d','--name',relay,'--network',network,'--init',
                    '-v',str(temp/'email')+':/run/secrets/organizer_email:ro',
                    '-v',str(temp/'password')+':/run/secrets/organizer_password:ro',
                    '-e',f'PORTAL_URL=http://host.docker.internal:{server.server_port}',
                    '-e','MEDIAMTX_HOST='+origin,'-e','CAMERA_LIMIT=30',
                    '-e','MEDIAMTX_PUBLISH_PASSWORD='+password,
                    '-e','RETRY_SECONDS=1','-e','TRANSCODE_CAMERAS=^cam01$',
                    'digdhrishti-stream-audit:local')
            containers.append(relay)
            deadline=time.monotonic()+60
            while time.monotonic()<deadline:
                result=subprocess.run(['docker','exec',relay,'/usr/local/bin/live-healthcheck'],capture_output=True)
                if result.returncode==0: break
                time.sleep(1)
            else:
                print(command('docker','logs',relay))
                raise RuntimeError('Synthetic organizer relay did not become healthy')
            wait_playlist(f'http://127.0.0.1:{hls}/stream/direct-cam01/index.m3u8?cookieCheck=1')
            command('docker','stop','--time','8',relay)
            code=int(command('docker','inspect','--format','{{.State.ExitCode}}',relay))
            assert code==143,code
            print('PASS: cookie login, one-camera manifest with limit 30, transcode, advancing HLS, health, and SIGTERM exit 143.')
        finally:
            for container in reversed(containers):
                subprocess.run(['docker','rm','-f',container],capture_output=True)
            if publisher and publisher.poll() is None:
                publisher.terminate()
                try: publisher.wait(5)
                except subprocess.TimeoutExpired: publisher.kill();publisher.wait()
            if server: server.shutdown();server.server_close()
            log.close()
            command('docker','network','rm',network)


if __name__=='__main__': main()
