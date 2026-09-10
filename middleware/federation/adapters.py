"""Bounded downloads; paged sources commit their checkpoint only after completion."""
import json
import os
from tempfile import SpooledTemporaryFile
from urllib.parse import quote, urlsplit
import httpx
import ijson
from app.models import Camera


def camera_id(source, external):
    if external is None or isinstance(external, bool) or not str(external):
        raise ValueError('Missing camera ID')
    return source.id + ':' + quote(str(external), safe='')


def normalize(source, row):
    external = row['name'] if source.adapter == 'mediamtx' else row['id']
    ident = camera_id(source, external)
    external = str(external)
    path = ('/'.join(quote(p, safe='') for p in external.split('/')) + '/index.m3u8'
            if source.adapter == 'mediamtx' else source.playback_template.format(id=quote(external, safe='')).lstrip('/'))
    return Camera(id=ident, source_id=source.id, external_id=external,
                  name=str(row.get('name') or external), location=row.get('location'),
                  latitude=row.get('lat'), longitude=row.get('long'),
                  playback_url=source.playback_base + '/' + path if source.playback_available else None,
                  status=('ready' if row.get('ready') is True else 'not_ready') if source.adapter == 'mediamtx' else 'unknown',
                  status_basis='mediamtx_publisher_not_playback_probe' if source.adapter == 'mediamtx' else 'inventory_only',
                  representative=source.representative).model_dump()


def read_page(source, state, emit, transport=None):
    headers = json.loads(os.environ[source.headers_env]) if source.headers_env else {}
    params = {}
    if source.adapter == 'organizer':
        if state.get('etag'): headers['If-None-Match'] = state['etag']
        if state.get('modified'): headers['If-Modified-Since'] = state['modified']
    elif source.adapter == 'mediamtx':
        params = {'page': int(state.get('page', 0)), 'itemsPerPage': source.page_size}
    else:
        params = {'limit': source.page_size, 'full': str(state['full']).lower()}
        if state.get('page'): params['cursor'] = state['page']
        if not state['full']: params['since'] = state['checkpoint']
    transport = transport or (httpx.HTTPTransport(local_address='0.0.0.0') if source.force_ipv4 else None)
    with httpx.Client(transport=transport, timeout=httpx.Timeout(15, connect=5), trust_env=False) as client:
        if source.login_url:
            parsed = urlsplit(source.login_url)
            # Cookie/CSRF warm-up only -- an auth-gated site normally 302s
            # this unauthenticated root request to its login page, so a
            # redirect here is expected, not a failure to raise on.
            client.get(f'{parsed.scheme}://{parsed.netloc}/', headers=headers)
            response = client.post(source.login_url, headers=headers, data={
                'email': os.environ[source.login_email_env], 'password': os.environ[source.login_password_env]})
            if response.status_code >= 400: response.raise_for_status()
        with client.stream('GET', source.inventory_url, params=params, headers=headers) as response:
            if response.status_code == 304 and source.adapter == 'organizer':
                return {'unchanged': True, 'etag': state.get('etag'), 'modified': state.get('modified')}
            response.raise_for_status()
            with SpooledTemporaryFile(max_size=1_000_000) as file:
                size = 0
                for chunk in response.iter_bytes():
                    size += len(chunk)
                    if size > source.max_response_bytes: raise ValueError('Response byte budget exceeded')
                    file.write(chunk)
                file.seek(0)
                if source.adapter == 'organizer':
                    if next(ijson.parse(file), (None, None))[1] != 'start_array':
                        raise ValueError('Expected camera array')
                    file.seek(0)
                    batch = []
                    for row in ijson.items(file, 'item', use_float=True):
                        batch.append(normalize(source, row))
                        if len(batch) >= source.page_size: emit(batch); batch = []
                    if batch: emit(batch)
                    return {'etag': response.headers.get('etag'), 'modified': response.headers.get('last-modified')}
                payload = json.load(file)
    rows = payload['items']
    if not isinstance(rows, list) or len(rows) > source.page_size: raise ValueError('Invalid page size')
    emit([normalize(source, row) for row in rows if source.adapter != 'mediamtx' or row['name'].startswith(source.path_prefix)])
    if source.adapter == 'mediamtx':
        page = int(state.get('page', 0))
        count = int(payload['pageCount'])
        if count < 0: raise ValueError('Invalid page count')
        result = {'next': str(page + 1) if page + 1 < count else None}
    else:
        deleted = payload.get('deleted', [])
        if not isinstance(deleted, list) or len(deleted) > source.page_size: raise ValueError('Invalid deletions')
        result = {'next': payload.get('next_cursor'), 'checkpoint': payload.get('version'),
                  'deleted': [camera_id(source, value) for value in deleted]}
        if result['next'] is not None and (not isinstance(result['next'], str) or not result['next']):
            raise ValueError('Invalid cursor')
        if not result['next'] and (not isinstance(result['checkpoint'], str) or not result['checkpoint']):
            raise ValueError('Final delta page requires version')
    if result.get('next') and (result['next'] == state.get('page') or state.get('pages', 0) + 1 >= source.max_pages):
        raise ValueError('Pagination did not terminate within configured budget')
    return result
