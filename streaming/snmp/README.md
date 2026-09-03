# NETRA SNMP monitoring

This container runs in **mock mode** because the Organizer provides HLS feeds but does not provide CCTV, NVR, or switch SNMP endpoints.

It does not claim to poll real SNMP devices. It simulates health data through a local API so NETRA can integrate device-health displays now.

## Start

```bash
docker compose -f streaming/compose.recorded.yaml -f streaming/compose.snmp.yaml up -d --build snmp-monitor
```

## Local API

- `GET http://127.0.0.1:9116/healthz`
- `GET http://127.0.0.1:9116/v1/devices`
- `GET http://127.0.0.1:9116/v1/devices/cam01`

The API is bound to localhost and is not exposed through Cloudflare.

## Mock configuration

The default configuration is `targets.example.json`. To simulate an offline camera locally:

1. Copy `targets.example.json` to `targets.json`.
2. Change a camera value in `mock_states` to `offline`.
3. Start with the custom configuration:

```bash
SNMP_TARGETS_CONFIG=./snmp/targets.json docker compose -f streaming/compose.recorded.yaml -f streaming/compose.snmp.yaml up -d --build snmp-monitor
```

`targets.json` is ignored by Git. It is the future location for private SNMPv3 device addresses and credentials.

## Real SNMP later

When approved CCTV/NVR network access is available, add authenticated and encrypted SNMPv3 polling. Do not use default community strings, UPnP, or public Internet exposure.
