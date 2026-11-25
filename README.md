# aranet2mqtt

Aranet4 CO₂ sensors on MQTT, presented as one more Zigbee2MQTT instance. A Zigbee2MQTT client on the same broker (such as homey-z2m, a Homey app) finds them through `<base>/bridge/info` and adds them like Zigbee devices.

```text
Aranet4s ──Bluetooth broadcasts──▶ aranet2mqtt ──▶ Mosquitto ◀── zigbee2mqtt (z2m/...)
                                   (aranet/...)        │
                                                       ▼
                                          subscriber sees both bridges
```

- **Bluetooth:** the upstream [`aranet`](https://github.com/cameronrye/aranet) CLI, unmodified and pinned in the [Dockerfile](Dockerfile), run as `aranet watch --passive`. It only listens to broadcasts and never connects, so nothing is paired. Each sensor needs **Smart Home integration** switched on in the Aranet Home app.
- **MQTT:** Zigbee2MQTT 2.x message shapes, under a base topic of its own (default `aranet`).
- **Web UI:** broker settings, sensors, timing and logs, password-protected. Everything is saved to `configuration.yaml` in the data directory.

## Topics

| Topic                        | Retained | Payload                                                                                                                 |
| ---------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `aranet/bridge/state`        | yes      | `{"state":"online"}`; `offline` as the last will                                                                        |
| `aranet/bridge/info`         | yes      | `version`, `coordinator.ieee_address` (the bridge's identity), `permit_join`, `config.availability.enabled: true`       |
| `aranet/bridge/devices`      | yes      | the coordinator plus one `EndDevice` per sensor, with `definition.exposes`                                              |
| `aranet/<name>`              | setting  | `{"co2":812,"temperature":22.4,"humidity":41,"pressure":1009.3,"air_quality":"excellent","battery":93,"last_seen":"…"}` |
| `aranet/<name>/availability` | yes      | `{"state":"online"}`, or `offline` when not heard for the availability timeout (15 min)                                 |
| `aranet/bridge/response/<p>` | no       | answers to `aranet/bridge/request/<p>`                                                                                  |
| `aranet/bridge/event`        | no       | `device_joined`, `device_interview`, `device_leave`                                                                     |

`version` is the Zigbee2MQTT version clients see, because some of them require a minimum. It defaults to 2.14.2, the Zigbee2MQTT release whose messages aranet2mqtt was matched against, and can be changed under **Settings**. aranet2mqtt's own version is in `coordinator.meta.revision`.

`air_quality` is the sensor's CO₂ light on Zigbee2MQTT's air quality ladder, as its three-step CO₂ devices report it: green → `excellent`, yellow → `moderate`, red → `poor`, and `unknown` when the sensor reports an error. The thresholds are the sensor's own (by default 1000 and 1400 ppm).

Requests: `permit_join` (sensors heard while it is open are added), `health_check`, `device/rename`, `device/remove` and `restart`. Any other request gets an error at once.

A sensor's IEEE address is derived from its Bluetooth name, which holds its serial ("Aranet4 1A2B3"). It stays the same across restarts, broker changes and a lost configuration file. A reading is published when a value changes, and at least every 5 minutes otherwise.

## Run

The container needs a Linux host running BlueZ, with its system D-Bus mounted. On Ubuntu, Docker's default AppArmor profile blocks D-Bus, hence `apparmor=unconfined`:

```sh
docker run -d --name aranet2mqtt --restart unless-stopped \
  -e ARANET2MQTT_PASSWORD=<web UI password> \
  -p 8081:8080 \
  -v /srv/aranet2mqtt:/data \
  -v /run/dbus:/run/dbus:ro \
  --security-opt apparmor=unconfined \
  aranet2mqtt:0.1.2
```

Then open the web UI, log in with any user name and the password, and fill in the broker under **MQTT**. **Test connection** checks the settings before **Save and reconnect** applies them.

| Variable               | Default  | Meaning                                                   |
| ---------------------- | -------- | --------------------------------------------------------- |
| `ARANET2MQTT_PASSWORD` | (none)   | web UI password; the UI answers 503 until it is set       |
| `ARANET2MQTT_PORT`     | `8080`   | web UI port inside the container                          |
| `ARANET2MQTT_DATA`     | `/data`  | holds `configuration.yaml` (mode 0600)                    |
| `ARANET2MQTT_SOURCE`   | `aranet` | `fake` makes up two sensors, for working away from the Pi |
| `ARANET_BIN`           | `aranet` | the upstream CLI                                          |

The same with Docker Compose, the password in a `.env` file next to it (`ARANET2MQTT_PASSWORD=…`):

```yaml
services:
  aranet2mqtt:
    image: aranet2mqtt:0.1.2
    pull_policy: never # built locally, see "Build"
    container_name: aranet2mqtt
    restart: unless-stopped
    env_file: .env
    ports:
      - "8081:8080"
    volumes:
      - ./data:/data
      - /run/dbus:/run/dbus:ro
    security_opt:
      - apparmor=unconfined # Ubuntu's docker-default profile blocks D-Bus
```

## Build

```sh
docker build -t aranet2mqtt:<version> .
```

Build on an arm64 machine (an Apple-silicon Mac, or the Pi) or with `docker buildx --platform linux/arm64`. The first build compiles the upstream CLI in Rust and takes a few minutes. To ship it to the Pi:

```sh
docker save aranet2mqtt:<version> | gzip -1 | ssh <pi> 'gunzip | sudo docker load'
```

## Develop

```sh
pnpm install
pnpm test          # parsers, payloads (checked against ../homey-z2m's parser if present), the bridge on an in-process broker
pnpm lint && pnpm typecheck
pnpm build         # dist/server and dist/ui

# Fake sensors, API on 8080, UI with hot reload on 5173:
ARANET2MQTT_SOURCE=fake ARANET2MQTT_DATA=./data ARANET2MQTT_PASSWORD=dev pnpm dev
pnpm dev:ui
```

Layout: [src/source/](src/source/) runs and parses the upstream CLI, [src/bridge/](src/bridge/) builds the Zigbee2MQTT topics and owns the broker connection, [src/web/](src/web/) is the API, and [ui/](ui/) is the Preact web UI.

## Limits

- Aranet4 only. Aranet2, Aranet Radiation and Aranet Radon are heard but not offered for adding.
- No signal strength (`linkquality`): the upstream CLI reports none on BlueZ.
- A reading is only as fresh as the sensor's own interval (1 to 10 minutes, set in the Aranet Home app).
