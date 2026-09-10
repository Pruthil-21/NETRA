import hmac
import os
from contextlib import asynccontextmanager
from fastapi import FastAPI, Depends, Header, HTTPException, Query
from pydantic import BaseModel, Field, ValidationError
from redis import Redis
from .models import Source
from .store import Store


class Mapping(BaseModel):
    camera_id: str = Field(min_length=1, max_length=512)
    registry_camera_id: int = Field(gt=0)
    actor: str = Field(min_length=1, max_length=128)


def create_app():
    key = os.environ['FEDERATION_SERVICE_KEY']
    if len(key) < 32: raise ValueError('Service key must be at least 32 characters')
    @asynccontextmanager
    async def lifespan(app):
        app.state.store = Store()
        yield
        app.state.store.pool.close()
    app = FastAPI(title='DIGDRISHTI Inventory Federation', lifespan=lifespan, docs_url=None, redoc_url=None)
    def auth(x_service_key: str = Header('')):
        if not hmac.compare_digest(x_service_key, key): raise HTTPException(401, 'Service authentication required')
    @app.get('/health')
    def health(): return {'service': 'inventory-federation', 'status': 'running'}
    @app.get('/ready', dependencies=[Depends(auth)])
    def ready():
        try:
            with app.state.store.pool.connection() as db: db.execute('SELECT 1')
            with Redis.from_url(os.environ['FEDERATION_BROKER_URL'], socket_timeout=2) as client: client.ping()
        except Exception: raise HTTPException(503, 'Storage or queue unavailable')
        return {'database': 'ready', 'broker': 'ready'}
    @app.get('/api/cameras', dependencies=[Depends(auth)])
    def cameras(after: str = Query('', max_length=512), limit: int = Query(100, ge=1, le=500), source_id: str | None = None):
        return app.state.store.cameras(after, limit, source_id)
    @app.get('/api/sources', dependencies=[Depends(auth)])
    def sources(): return {'items': app.state.store.sources()}
    @app.get('/api/sources/{source_id}', dependencies=[Depends(auth)])
    def get_source(source_id: str):
        config = app.state.store.source_config(source_id)
        if config is None: raise HTTPException(404, 'Unknown source')
        return config
    @app.put('/api/sources/{source_id}', dependencies=[Depends(auth)])
    def upsert_source(source_id: str, body: dict):
        # id always comes from the path, never the body -- a mismatched or
        # missing id in the JSON payload can't silently write under a
        # different id than the URL says it's editing.
        try:
            source = Source(**{**body, 'id': source_id})
        except ValidationError as exc:
            raise HTTPException(422, exc.errors())
        app.state.store.upsert_source(source)
        return {'status': 'ok', 'id': source.id}
    @app.delete('/api/sources/{source_id}', dependencies=[Depends(auth)])
    def delete_source(source_id: str):
        if not app.state.store.disable_source(source_id):
            raise HTTPException(404, 'Unknown source')
        return {'status': 'disabled'}
    @app.post('/api/sources/{source_id}/sync', dependencies=[Depends(auth)])
    def sync(source_id: str):
        with app.state.store.pool.connection() as db:
            if not db.execute('UPDATE fed_sources SET next_due=now() WHERE id=%s AND enabled RETURNING id', (source_id,)).fetchone():
                raise HTTPException(404, 'Unknown source')
        return {'status': 'scheduled'}
    @app.put('/api/mappings', dependencies=[Depends(auth)])
    def mapping(body: Mapping):
        try: app.state.store.mapping(body.camera_id, body.registry_camera_id, body.actor)
        except ValueError as exc: raise HTTPException(404, str(exc))
        return {'status': 'mapped'}
    return app
