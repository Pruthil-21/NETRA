"""Read-only inventory adapters. No upstream configuration or video is modified."""
import json
import os
from urllib.parse import quote

import httpx

from .models import Camera, Source


def camera_id(source_id, external_id):
    return f"{source_id}:{quote(str(external_id), safe='')}"


async def fetch_json(client, url, headers, params=None):
    # Bound memory use and never follow redirects carrying source credentials.
    async with client.stream("GET", url, headers=headers, params=params) as response:
        response.raise_for_status()
        content = bytearray()
        async for chunk in response.aiter_bytes():
            content.extend(chunk)
            if len(content) > 4_000_000:
                raise ValueError("Inventory exceeds size limit")
        return json.loads(content)


async def discover(source: Source, client: httpx.AsyncClient):
    headers = json.loads(os.environ.get(source.headers_env, "{}")) if source.headers_env else {}
    cameras = []
    if source.adapter == "organizer":
        if source.login_url:
            email = os.environ.get(source.login_email_env, "")
            password = os.environ.get(source.login_password_env, "")
            if not email or not password:
                raise ValueError("Organizer credentials are missing")
            # Same-origin cookie login used by the existing live-relay adapter.
            # Redirects are not followed; a redirect-to-dashboard can be a successful login.
            from urllib.parse import urlsplit
            parsed = urlsplit(source.login_url)
            response = await client.get(f"{parsed.scheme}://{parsed.netloc}/", headers=headers)
            if response.status_code >= 400:
                response.raise_for_status()
            response = await client.post(source.login_url, data={"email": email, "password": password}, headers=headers)
            if response.status_code >= 400:
                response.raise_for_status()
        rows = await fetch_json(client, source.inventory_url, headers)
        if not isinstance(rows, list) or len(rows) > 10000:
            raise ValueError("Expected a bounded organizer camera array")
        for row in rows:
            external = str(row["id"])
            encoded = quote(external, safe="")
            relative = source.playback_template.format(id=encoded).lstrip("/")
            cameras.append(Camera(
                id=camera_id(source.id, external), source_id=source.id,
                external_id=external, name=str(row.get("name") or external),
                location=row.get("location"), latitude=row.get("lat"), longitude=row.get("long"),
                playback_url=f"{source.playback_base}/{relative}" if source.playback_available else None,
                # Width and upstream 'status' are NOT proof that HLS is playable.
                status="unknown", status_basis="inventory_only",
                representative=source.representative,
            ))
    else:
        for page in range(100):
            payload = await fetch_json(client, source.inventory_url, headers, {"page": page, "itemsPerPage": 100})
            rows = payload["items"]
            if not isinstance(rows, list):
                raise ValueError("Invalid MediaMTX paths response")
            for row in rows:
                external = row["name"]
                if not external.startswith(source.path_prefix):
                    continue
                # Encode each path segment; MediaMTX paths contain slashes.
                path = "/".join(quote(p, safe="") for p in external.split("/"))
                cameras.append(Camera(
                    id=camera_id(source.id, external), source_id=source.id,
                    external_id=external, name=external,
                    playback_url=f"{source.playback_base}/{path}/index.m3u8" if source.playback_available else None,
                    status="ready" if row.get("ready") is True else "not_ready",
                    status_basis="mediamtx_publisher_not_playback_probe",
                    representative=source.representative,
                ))
            if page + 1 >= int(payload["pageCount"]):
                break
        else:
            raise ValueError("MediaMTX pagination exceeds limit")
    if len({c.id for c in cameras}) != len(cameras):
        raise ValueError("Duplicate camera IDs in source inventory")
    return cameras
