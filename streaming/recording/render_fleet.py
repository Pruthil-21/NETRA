"""Render an explicit, reviewable Kubernetes fleet; never deploy or expose credentials."""
import argparse
import json
import os
from pathlib import Path
import re
import yaml
from core import Ring, stream_path


def render(cameras, shards, image, storage_class, pilot=False, capacity=500):
    ring = Ring(shards)
    assigned = {s: [] for s in shards}
    seen = set()
    for camera in cameras:
        path = stream_path(camera['path'])
        if path in seen:
            raise ValueError('Duplicate stream path')
        seen.add(path)
        if not camera['source'].startswith(('rtsp://', 'rtsps://', 'http://', 'https://')):
            raise ValueError('Unsupported source')
        assigned[ring.owner(path)].append(camera)
    if max(map(len, assigned.values()), default=0) > capacity:
        raise ValueError('Shard capacity exceeded; add shards or explicitly change measured capacity')
    namespace = 'recording'
    docs = [{'apiVersion': 'v1', 'kind': 'Namespace', 'metadata': {'name': namespace}}]
    def metadata(name, app):
        return {'name': name, 'namespace': namespace, 'labels': {'app': app}}
    def pod(app, containers, volumes=None):
        spec = {'automountServiceAccountToken': False, 'terminationGracePeriodSeconds': 120,
            'securityContext': {'runAsUser': 10001, 'runAsGroup': 10001, 'fsGroup': 10001,
                                'runAsNonRoot': True, 'seccompProfile': {'type': 'RuntimeDefault'}},
            'containers': containers,
            'topologySpreadConstraints': [{'maxSkew': 1, 'topologyKey': 'kubernetes.io/hostname',
               'whenUnsatisfiable': 'ScheduleAnyway' if pilot else 'DoNotSchedule',
               'labelSelector': {'matchLabels': {'app': app}}}]}
        if volumes:
            spec['volumes'] = volumes
        return {'metadata': {'labels': {'app': app}}, 'spec': spec}
    def container(name, command):
        return {'name': name, 'image': image, 'command': command,
            'envFrom': [{'secretRef': {'name': 'recording-infra'}}],
            'securityContext': {'allowPrivilegeEscalation': False, 'capabilities': {'drop': ['ALL']}},
            'resources': {'requests': {'cpu': '1', 'memory': '1Gi'}, 'limits': {'cpu': '4', 'memory': '4Gi'}}}
    for name, rows in assigned.items():
        if not re.fullmatch(r'[a-z][a-z0-9-]{0,40}', name):
            raise ValueError('Invalid shard name')
        docs.append({'apiVersion': 'v1', 'kind': 'Secret', 'metadata': metadata(name+'-cameras', 'recorder'),
                     'stringData': {'cameras.json': json.dumps(rows)}})
        c = container('recorder', ['python', 'worker.py'])
        c['env'] = [{'name': 'SHARD_ID', 'value': name}, {'name': 'MAX_CAMERAS_PER_SHARD', 'value': str(capacity)}]
        c['resources'] = {'requests': {'cpu': '2', 'memory': '2Gi'}, 'limits': {'cpu': '8', 'memory': '16Gi'}}
        c['volumeMounts'] = [{'name': 'spool', 'mountPath': '/spool'}, {'name': 'cameras', 'mountPath': '/config', 'readOnly': True}]
        probe = {'exec': {'command': ['python', '-c', "import time; assert time.time()-float(open('/spool/worker.ready').read())<40"]},
                 'periodSeconds': 10, 'timeoutSeconds': 3, 'failureThreshold': 6}
        c['readinessProbe'] = probe
        # Low disk should fail readiness and alert, not restart endlessly.
        c['livenessProbe'] = {'exec': {'command': ['python', '-c', "import time; assert time.time()-float(open('/spool/worker.alive').read())<60"]},
                              'periodSeconds': 15, 'timeoutSeconds': 3, 'failureThreshold': 4}
        c['startupProbe'] = {**c['livenessProbe'], 'failureThreshold': 120}
        docs.append({'apiVersion': 'v1', 'kind': 'Service', 'metadata': metadata(name, 'recorder'),
            'spec': {'clusterIP': 'None', 'selector': {'shard': name}, 'ports': [{'name': 'metrics', 'port': 9998}]}})
        template = pod('recorder', [c], [{'name': 'cameras', 'secret': {'secretName': name+'-cameras'}}])
        template['metadata']['labels']['shard'] = name
        docs.append({'apiVersion': 'apps/v1', 'kind': 'StatefulSet', 'metadata': metadata(name, 'recorder'),
            'spec': {'serviceName': name, 'replicas': 1, 'selector': {'matchLabels': {'shard': name}},
                'template': template, 'volumeClaimTemplates': [{'metadata': {'name': 'spool'},
                  'spec': {'accessModes': ['ReadWriteOncePod'], 'storageClassName': storage_class,
                           'resources': {'requests': {'storage': '1Ti'}}}}]}})
    for name, command in [('recording-api', ['uvicorn', 'api:app', '--host', '0.0.0.0', '--port', '8097', '--no-access-log']),
                          ('recording-monitor', ['python', 'monitor.py'])]:
        c = container(name, command)
        if name == 'recording-api':
            c['readinessProbe'] = {'httpGet': {'path': '/readyz', 'port': 8097}, 'periodSeconds': 15, 'timeoutSeconds': 10}
            c['livenessProbe'] = {'httpGet': {'path': '/healthz', 'port': 8097}, 'periodSeconds': 15}
            c['volumeMounts'] = [{'name': 'scratch', 'mountPath': '/tmp'}]
        else:
            c['livenessProbe'] = {'exec': {'command': ['python', '-c', "import time; assert time.time()-float(open('/tmp/monitor.alive').read())<180"]},
                                  'periodSeconds': 30, 'timeoutSeconds': 3}
            c['readinessProbe'] = c['livenessProbe']
            c['startupProbe'] = {**c['livenessProbe'], 'failureThreshold': 20}
        docs.append({'apiVersion': 'apps/v1', 'kind': 'Deployment', 'metadata': metadata(name, name),
            'spec': {'replicas': 1 if pilot else 2, 'selector': {'matchLabels': {'app': name}},
                     'template': pod(name, [c], [{'name': 'scratch', 'emptyDir': {'sizeLimit': '16Gi'}}] if name == 'recording-api' else None)}})
        docs.append({'apiVersion': 'policy/v1', 'kind': 'PodDisruptionBudget', 'metadata': metadata(name, name),
                      'spec': {'maxUnavailable': 1, 'selector': {'matchLabels': {'app': name}}}})
    docs.append({'apiVersion': 'v1', 'kind': 'Service', 'metadata': metadata('recording-api', 'recording-api'),
                 'spec': {'selector': {'app': 'recording-api'}, 'ports': [{'port': 8097, 'name': 'http'}]}})
    docs += [
        {'apiVersion': 'networking.k8s.io/v1', 'kind': 'NetworkPolicy', 'metadata': metadata('private-ingress', 'recording'),
         'spec': {'podSelector': {}, 'policyTypes': ['Ingress'], 'ingress': []}},
        {'apiVersion': 'networking.k8s.io/v1', 'kind': 'NetworkPolicy', 'metadata': metadata('archive-clients', 'recording-api'),
         'spec': {'podSelector': {'matchLabels': {'app': 'recording-api'}}, 'policyTypes': ['Ingress'],
                  'ingress': [{'from': [{'namespaceSelector': {'matchLabels': {'recording-client': 'true'}}}],
                               'ports': [{'protocol': 'TCP', 'port': 8097}]}]}},
        {'apiVersion': 'networking.k8s.io/v1', 'kind': 'NetworkPolicy', 'metadata': metadata('prometheus', 'recorder'),
         'spec': {'podSelector': {'matchLabels': {'app': 'recorder'}}, 'policyTypes': ['Ingress'],
                  'ingress': [{'from': [{'namespaceSelector': {'matchLabels': {'recording-monitoring': 'true'}}}],
                               'ports': [{'protocol': 'TCP', 'port': 9998}]}]}}]
    migration = container('partition-manager', ['python', 'migrate.py'])
    migration['envFrom'] = [{'secretRef': {'name': 'recording-migration'}}]
    migration_pod = pod('partition-manager', [migration])
    migration_pod['spec']['restartPolicy'] = 'OnFailure'
    docs.append({'apiVersion': 'batch/v1', 'kind': 'CronJob',
        'metadata': metadata('recording-partitions', 'partition-manager'),
        'spec': {'schedule': '17 */6 * * *', 'concurrencyPolicy': 'Forbid',
                 'jobTemplate': {'spec': {'backoffLimit': 3, 'template': migration_pod}}}})
    return docs, {n: len(rows) for n, rows in assigned.items()}

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--inventory', required=True)
    parser.add_argument('--shards', required=True, help='Comma-separated stable shard IDs')
    parser.add_argument('--image', required=True)
    parser.add_argument('--storage-class', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--capacity', type=int, default=500)
    parser.add_argument('--pilot', action='store_true')
    args = parser.parse_args()
    docs, counts = render(json.loads(Path(args.inventory).read_text()), args.shards.split(','),
                         args.image, args.storage_class, args.pilot, args.capacity)
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, 'w') as f:
        yaml.safe_dump_all(docs, f, sort_keys=False)
    print(json.dumps({'cameras_per_shard': counts, 'total': sum(counts.values())}))
