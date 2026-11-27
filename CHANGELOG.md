# Changelog

Newest first, one section per day.

## 2026-11-27

- The Docker image is published to Docker Hub as `axeriano/aranet2mqtt`, for arm64 and amd64, whenever a version tag (`v1.2.3`) is pushed: tagged `1.2.3`, `1.2` and `latest`. amd64 is new; until now the image was built for arm64 only. The tag must be `v` plus the `version` in `package.json`, or the Publish workflow stops; the README's new Release section has the steps. The README's `docker run` and Compose examples use the published image instead of a locally built `aranet2mqtt:<version>`; building it yourself still works.

## 2026-11-26

- The repository has a Sponsor button: GitHub Sponsors and Ko-fi.
- The Docker image runs Node 26 (LTS) instead of Node 22, which reaches end of life in April 2027. CI tests on Node 26 too.
- CI on pull requests (drafts skipped until marked ready for review): lint, typecheck, tests and build, and the Docker image is built and smoke-tested. Dependabot also keeps the workflow's actions current.
- Dependabot checks the npm packages and the Docker base images weekly.
- The web UI no longer has a password, and `ARANET2MQTT_PASSWORD` is ignored. Like Zigbee2MQTT's frontend, access control belongs in front of the port (a reverse proxy with authentication, a firewall).
- The sensor's CO₂ light is published as Zigbee2MQTT's `air_quality` instead of `co2_status`: green → `excellent`, yellow → `moderate`, red → `poor`, and `unknown` when the sensor reports an error, as homey-z2m's `docs/air-quality.md` says a Z2M-format bridge should. homey-z2m shows it as Homey's built-in air quality level. The web UI shows the word next to the CO₂ reading.
- This changelog, backfilled.

## 2026-11-25

- `bridge/info.version` reports a Zigbee2MQTT version, 2.14.2 by default and set under Settings, because clients may require a minimum. aranet2mqtt's own version moved to `coordinator.meta.revision`.
- First version.
  - Readings from the sensors' Bluetooth broadcasts through the upstream `aranet` CLI (cameronrye/aranet `e6410de`), run as `aranet watch --passive`, plus `aranet scan` now and then to learn each sensor's address. Nothing is paired or connected to.
  - Zigbee2MQTT 2.x topics under a base topic of its own: `bridge/state` (with the last will), `bridge/info`, `bridge/devices`, `bridge/event`, each sensor's state and availability. Requests: `permit_join`, `health_check`, `device/rename`, `device/remove` and `restart`; any other gets an error at once.
  - A sensor's IEEE address comes from its Bluetooth name, so it survives restarts and a lost configuration. A reading is published when a value changes, and at least every 5 minutes.
  - Web UI behind a password: devices and the sensors heard nearby, every MQTT broker option with a connection test, Bluetooth timing, availability timeout, log level and logs. Settings are saved to `configuration.yaml` (mode 0600).
  - Docker image with the upstream CLI built in, for linux/arm64.
