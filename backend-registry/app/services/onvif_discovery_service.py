"""ONVIF network auto-discovery (WS-Discovery, ONVIF's own device-discovery
protocol) — finds ONVIF-capable cameras on the local network automatically
instead of requiring every camera to be typed in by hand. The same
mechanism real deployed VMS platforms (Milestone XProtect's "Scan for
hardware", Genetec Security Center's auto-discovery) use for onboarding, not
something invented for this feature.

Two stages:
  1. scan_network() — a UDP multicast WS-Discovery Probe (239.255.255.250:3702),
     collecting every ProbeMatch within a timeout window. Finds *that* a
     device exists and its ONVIF service URL.
  2. scan_and_enrich() — additionally calls each discovered device's
     GetDeviceInformation (unauthenticated, best-effort) for manufacturer/
     model/firmware. A device that requires ONVIF auth still comes back as
     a discovered candidate with its IP/service URL; discovery's job is
     "prove this exists and where it is", not "log into it" — an officer
     supplies credentials/stream URL manually for those, same as the
     existing Add Camera path.

Pure stdlib (socket/asyncio/xml.etree) + httpx (already a dependency) — no
new package. WS-Discovery XML is parsed by local tag name rather than a
strict namespace-prefixed path, since real ONVIF devices from different
vendors are inconsistent about which prefix they use for the same
namespace URI — matching only by namespace URI (ElementTree's
`{uri}localname` form) but ignoring the vendor's chosen prefix survives that
variance; a bare-string find() keyed to one specific prefix would not.
"""
import asyncio
import socket
import uuid
import xml.etree.ElementTree as ET

import httpx

_MULTICAST_ADDR = "239.255.255.250"
_MULTICAST_PORT = 3702
_DEFAULT_TIMEOUT_SECONDS = 4.0


def _local_tag(tag: str) -> str:
    """'{http://...}XAddrs' -> 'XAddrs' — strips the namespace URI so
    parsing doesn't depend on which prefix a given vendor's firmware used."""
    return tag.rsplit("}", 1)[-1]


def _build_probe_message() -> bytes:
    message_id = f"uuid:{uuid.uuid4()}"
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"
            xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing"
            xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"
            xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
  <e:Header>
    <w:MessageID>{message_id}</w:MessageID>
    <w:To e:mustUnderstand="1">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>
    <w:Action e:mustUnderstand="1">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>
  </e:Header>
  <e:Body>
    <d:Probe>
      <d:Types>dn:NetworkVideoTransmitter</d:Types>
    </d:Probe>
  </e:Body>
</e:Envelope>""".encode()


class _ProbeProtocol(asyncio.DatagramProtocol):
    """Collects every UDP datagram that arrives on the probe socket for the
    duration of the scan window -- WS-Discovery ProbeMatch replies are
    unicast back to the sender, but there's no way to know in advance how
    many devices will answer or when the last one will, so this just
    gathers everything until the caller's timeout elapses."""

    def __init__(self):
        self.responses: list[tuple[bytes, tuple]] = []

    def datagram_received(self, data, addr):
        self.responses.append((data, addr))

    def error_received(self, exc):  # pragma: no cover -- defensive only
        pass


def _parse_probe_match(data: bytes) -> dict | None:
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        return None

    xaddrs: list[str] | None = None
    device_uuid: str | None = None
    for el in root.iter():
        tag = _local_tag(el.tag)
        if tag == "XAddrs" and el.text:
            xaddrs = el.text.strip().split()
        elif tag == "Address" and el.text and el.text.strip().startswith("urn:uuid:"):
            device_uuid = el.text.strip()[len("urn:uuid:"):]
    if not xaddrs:
        return None
    # A device can advertise several XAddrs (one per network interface) --
    # the first is the one it expects a client to actually use.
    return {"xaddr": xaddrs[0], "device_uuid": device_uuid}


async def scan_network(timeout_seconds: float = _DEFAULT_TIMEOUT_SECONDS) -> list[dict]:
    """Sends one WS-Discovery Probe and returns every distinct device that
    answered within timeout_seconds, as [{"xaddr", "device_uuid",
    "source_ip"}, ...]. Runs on the asyncio event loop's own datagram
    transport (not a blocking socket call), consistent with this service's
    existing async I/O convention (see stream_health_service.check_hls_reachable)."""
    loop = asyncio.get_running_loop()
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
    sock.bind(("0.0.0.0", 0))

    transport, protocol = await loop.create_datagram_endpoint(_ProbeProtocol, sock=sock)
    try:
        transport.sendto(_build_probe_message(), (_MULTICAST_ADDR, _MULTICAST_PORT))
        await asyncio.sleep(timeout_seconds)
    finally:
        transport.close()

    seen: set[str] = set()
    matches = []
    for data, addr in protocol.responses:
        parsed = _parse_probe_match(data)
        if parsed is None or parsed["xaddr"] in seen:
            continue
        seen.add(parsed["xaddr"])
        matches.append({**parsed, "source_ip": addr[0]})
    return matches


_GET_DEVICE_INFO_BODY = b"""<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">
  <s:Body>
    <GetDeviceInformation xmlns="http://www.onvif.org/ver10/device/wsdl"/>
  </s:Body>
</s:Envelope>"""

_INFO_TAG_MAP = {"Manufacturer": "manufacturer", "Model": "model", "FirmwareVersion": "firmware_version"}


async def _fetch_device_information(client: httpx.AsyncClient, xaddr: str) -> dict:
    """Best-effort, unauthenticated ONVIF GetDeviceInformation call. Many
    cameras answer this without credentials even when their video streams
    require auth; ones that don't just come back with a clear
    reachable_detail explaining why, not an exception that drops the whole
    device from the scan results."""
    try:
        resp = await client.post(
            xaddr,
            content=_GET_DEVICE_INFO_BODY,
            headers={"Content-Type": "application/soap+xml; charset=utf-8"},
            timeout=3.0,
        )
    except httpx.HTTPError as e:
        return {"reachable_detail": f"unreachable: {e.__class__.__name__}"}

    if resp.status_code == 401:
        return {"reachable_detail": "device requires ONVIF authentication — enter credentials manually"}
    if resp.status_code != 200:
        return {"reachable_detail": f"device returned HTTP {resp.status_code} to GetDeviceInformation"}

    try:
        root = ET.fromstring(resp.content)
    except ET.ParseError:
        return {"reachable_detail": "device responded, but not with valid SOAP/XML"}

    info: dict = {}
    for el in root.iter():
        field = _INFO_TAG_MAP.get(_local_tag(el.tag))
        if field and el.text:
            info[field] = el.text.strip()
    info["reachable_detail"] = "device information retrieved"
    return info


async def scan_and_enrich(timeout_seconds: float = _DEFAULT_TIMEOUT_SECONDS) -> list[dict]:
    """Full discovery pass backing POST /cameras/discover: WS-Discovery,
    then best-effort enrichment of every match. Returns dicts shaped to
    match schemas.DiscoveredCamera exactly."""
    matches = await scan_network(timeout_seconds)
    if not matches:
        return []

    async with httpx.AsyncClient() as client:
        enrichments = await asyncio.gather(
            *(_fetch_device_information(client, m["xaddr"]) for m in matches),
            return_exceptions=True,
        )

    devices = []
    for match, enrichment in zip(matches, enrichments):
        if isinstance(enrichment, BaseException):
            enrichment = {"reachable_detail": f"probe error: {enrichment.__class__.__name__}"}
        devices.append({
            "ip_address": match["source_ip"],
            "onvif_service_url": match["xaddr"],
            "device_uuid": match.get("device_uuid"),
            "manufacturer": enrichment.get("manufacturer"),
            "model": enrichment.get("model"),
            "firmware_version": enrichment.get("firmware_version"),
            # Getting a real stream URI needs an authenticated ONVIF Media
            # service call against a specific profile token -- deliberately
            # out of scope for an unauthenticated discovery pass; an officer
            # fills this in (same as today's manual Add Camera flow) once
            # they've identified the device from the fields above.
            "stream_uri": None,
            "ptz_capable": None,
            "reachable_detail": enrichment.get("reachable_detail"),
        })
    return devices
