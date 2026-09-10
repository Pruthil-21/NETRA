"""Render a six-replay, single-node hackathon pilot. No organizer ingestion."""
import json
import os
from pathlib import Path
import secrets
import yaml
from render_fleet import render

ROOT = Path(__file__).resolve().parent
paths = ['demo-cam67', 'demo-cam88', 'demo-cam142', 'demo-cam161', 'demo-cam180', 'demo-railway-exit']
env_path = ROOT / '.env.local'
env = dict(line.split('=', 1) for line in env_path.read_text().splitlines() if '=' in line and not line.startswith('#'))
for name in ('RECORDING_SERVICE_KEY', 'PLAYBACK_SIGNING_KEY', 'POSTGRES_PASSWORD', 'RUNTIME_DB_PASSWORD', 'AWS_SECRET_ACCESS_KEY'):
    if not env.get(name) or env[name].startswith('REPLACE'):
        env[name] = secrets.token_hex(32)
env.update(DATABASE_URL=f"postgresql://recording_runtime:{env['RUNTIME_DB_PASSWORD']}@recording-postgres:5432/recording",
           S3_ENDPOINT_URL='http://recording-s3:9000', S3_BUCKET='digdhrishti-anand',
           AWS_ACCESS_KEY_ID='anand-recorder', AWS_DEFAULT_REGION='us-east-1',
           PUBLIC_PLAYBACK_URL=env.get('PUBLIC_PLAYBACK_URL', 'http://127.0.0.1:8097'),
           RECORDING_PATH_ALIASES=json.dumps({'demo-cam67':'stream/demo-cam67'}),
           WEBHOOK_PATH_ALIASES=json.dumps({'stream/demo-cam67':'demo-cam67'}),
           MIN_FREE_BYTES=str(1024**3), HOT_BUFFER_SECONDS='3600')
if 'REPLACE' in env['PUBLIC_PLAYBACK_URL']:
    env['PUBLIC_PLAYBACK_URL'] = 'http://127.0.0.1:8097'

def private_write(path, value):
    fd = os.open(path, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write(value)

private_write(env_path, ''.join(k+'='+v+'\n' for k,v in env.items()))
cameras = [{'path': 'stream/'+p, 'source':'rtsp://host.docker.internal:8554/stream/'+p,'codec':'copy'} for p in paths]
private_write(ROOT/'inventory.local.json', json.dumps(cameras, indent=2)+'\n')
docs, _ = render(cameras, ['anand-0'], 'digdhrishti-recording:anand-pilot', 'standard', pilot=True, capacity=6)
# kind is a single-node PILOT: its local provisioner supports RWO, not production RWOP.
for d in docs:
    if d['kind'] == 'StatefulSet':
        d['spec']['volumeClaimTemplates'][0]['spec']['accessModes'] = ['ReadWriteOnce']
        d['spec']['volumeClaimTemplates'][0]['spec']['resources']['requests']['storage'] = '20Gi'
        d['spec']['template']['spec']['volumes'].append({'name':'record-config','configMap':{'name':'anand-record-config'}})
        c = d['spec']['template']['spec']['containers'][0]
        c['volumeMounts'].append({'name':'record-config','mountPath':'/app/mediamtx.yml','subPath':'mediamtx.yml','readOnly':True})
        c['resources'] = {'requests': {'cpu':'250m','memory':'512Mi'}, 'limits': {'cpu':'2','memory':'2Gi'}}
    if d['kind'] in ('Deployment', 'StatefulSet'):
        for c in d['spec']['template']['spec']['containers']:
            c['imagePullPolicy'] = 'IfNotPresent'
            if d['kind'] == 'Deployment':
                c['resources'] = {'requests':{'cpu':'100m','memory':'256Mi'}, 'limits':{'cpu':'2','memory':'2Gi'}}
        # Keep health detection active; deliver only the explicitly authorized test event.
        if d['metadata']['name'] == 'recording-monitor':
            d['spec']['replicas'] = 1
            c['env'] = [{'name':'NOTIFICATION_DELIVERY_ENABLED','value':'false'}]
    if d['kind'] == 'Service' and d['metadata']['name'] == 'recording-api':
        d['spec']['type'] = 'NodePort'
        d['spec']['ports'][0]['nodePort'] = 30097

def meta(name):
    return {'name':name,'namespace':'recording'}

def service(name, port):
    return {'apiVersion':'v1','kind':'Service','metadata':meta(name),
            'spec':{'selector':{'app':name},'ports':[{'port':port}]}}

def pvc(name, size):
    return {'apiVersion':'v1','kind':'PersistentVolumeClaim','metadata':meta(name),
            'spec':{'accessModes':['ReadWriteOnce'],'storageClassName':'standard', 'resources':{'requests':{'storage':size}}}}

def deployment(name, container, volumes):
    return {'apiVersion':'apps/v1','kind':'Deployment','metadata':meta(name),
        'spec':{'replicas':1,'strategy':{'type':'Recreate'},'selector':{'matchLabels':{'app':name}},
                'template':{'metadata':{'labels':{'app':name}},'spec':{'automountServiceAccountToken':False,
                             'containers':[container],'volumes':volumes}}}}

runtime = {k:v for k,v in env.items() if k not in ('POSTGRES_PASSWORD','RUNTIME_DB_PASSWORD')}
docs += [{'apiVersion':'v1','kind':'Secret','metadata':meta('recording-infra'),'stringData':runtime},
         {'apiVersion':'v1','kind':'Secret','metadata':meta('recording-migration'),'stringData':{
          'DATABASE_URL':f"postgresql://postgres:{env['POSTGRES_PASSWORD']}@recording-postgres:5432/recording",
          'RUNTIME_DB_PASSWORD':env['RUNTIME_DB_PASSWORD'], **{k:env[k] for k in ('S3_ENDPOINT_URL','S3_BUCKET','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_DEFAULT_REGION')}}},
         {'apiVersion':'v1','kind':'Secret','metadata':meta('recording-postgres'),'stringData':{
          'POSTGRES_PASSWORD':env['POSTGRES_PASSWORD'],'POSTGRES_DB':'recording','PGDATA':'/var/lib/postgresql/data/pgdata'}},
         pvc('postgres-data','5Gi'), pvc('s3-data','30Gi')]
docs += [service('recording-postgres',5432), deployment('recording-postgres',{
    'name':'postgres','image':'postgres:16-alpine','envFrom':[{'secretRef':{'name':'recording-postgres'}}],
    'volumeMounts':[{'name':'data','mountPath':'/var/lib/postgresql/data'}],
    'readinessProbe':{'exec':{'command':['pg_isready','-U','postgres']},'periodSeconds':5}},
    [{'name':'data','persistentVolumeClaim':{'claimName':'postgres-data'}}])]
docs += [service('recording-s3',9000), deployment('recording-s3',{
    'name':'s3','image':'quay.io/minio/minio:RELEASE.2025-04-22T22-12-26Z','args':['server','/data'],
    'env':[{'name':'MINIO_ROOT_USER','value':env['AWS_ACCESS_KEY_ID']},
           {'name':'MINIO_ROOT_PASSWORD','valueFrom':{'secretKeyRef':{'name':'recording-infra','key':'AWS_SECRET_ACCESS_KEY'}}}],
    'volumeMounts':[{'name':'data','mountPath':'/data'}],
    'readinessProbe':{'httpGet':{'path':'/minio/health/ready','port':9000},'periodSeconds':5}},
    [{'name':'data','persistentVolumeClaim':{'claimName':'s3-data'}}])]
source_config = {'logLevel':'warn','rtspAddress':':8554','rtspTransports':['tcp'], 'rtmp':False,'hls':False,
                 'webrtc':False,'srt':False,'moq':False,'paths':{'all_others':{}}}
docs += [{'apiVersion':'v1','kind':'ConfigMap','metadata':meta('anand-record-config'),'data':{'mediamtx.yml':(ROOT/'mediamtx.yml').read_text()}},
         {'apiVersion':'v1','kind':'ConfigMap','metadata':meta('anand-source'),
          'data':{'mediamtx.yml':yaml.safe_dump(source_config)}}]
docs += [service('anand-source',8554), deployment('anand-source',{'name':'mediamtx','image':'bluenviron/mediamtx:1.20.0',
    'volumeMounts':[{'name':'config','mountPath':'/mediamtx.yml','subPath':'mediamtx.yml'}]},
    [{'name':'config','configMap':{'name':'anand-source'}}])]
docs += [deployment('anand-replay',{'name':'replay','image':'netra-live-demo-replay:latest','imagePullPolicy':'Never',
    'env':[{'name':'MEDIAMTX_HOST','value':'anand-source'}],
    'resources':{'requests':{'cpu':'250m','memory':'256Mi'},'limits':{'cpu':'3','memory':'2Gi'}},
    'volumeMounts':[{'name':'footage','mountPath':'/demo-footage','readOnly':True}]},
    [{'name':'footage','hostPath':{'path':'/anand-footage','type':'Directory'}}])]
# Keep legacy source deployments stopped; recording reads the shared live relay.
for document in docs:
    if document['kind'] == 'Deployment' and document['metadata']['name'] in ('anand-replay', 'anand-source'):
        document['spec']['replicas'] = 0
# Database and S3 stay private; the shared RTSP relay is reached through the host.
docs.append({'apiVersion':'networking.k8s.io/v1','kind':'NetworkPolicy','metadata':meta('pilot-internal'),
             'spec':{'podSelector':{},'policyTypes':['Ingress'],'ingress':[{'from':[{'podSelector':{}}]}]}})
docs.append({'apiVersion':'networking.k8s.io/v1','kind':'NetworkPolicy','metadata':meta('pilot-gateway'),
             'spec':{'podSelector':{'matchLabels':{'app':'recording-api'}},'policyTypes':['Ingress'],
                     'ingress':[{'ports':[{'port':8097,'protocol':'TCP'}]}]}})
private_write(ROOT/'anand.local.yaml', yaml.safe_dump_all(docs, sort_keys=False))
print('Rendered six Anand cameras; private secrets written, health monitoring active; automatic webhook delivery paused.')
