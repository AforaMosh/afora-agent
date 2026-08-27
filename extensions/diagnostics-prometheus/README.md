# @afora/diagnostics-prometheus

Official Prometheus diagnostics exporter for Afora.

This plugin exposes Afora Gateway runtime metrics in Prometheus text format for Prometheus, Grafana, VictoriaMetrics, and compatible scrapers.

## Install

```bash
afora plugins install @afora/diagnostics-prometheus
```

Restart the Gateway after installing or updating the plugin.

## Configure

Enable the plugin and set the scrape endpoint options in `plugins.entries.diagnostics-prometheus.config`.

The full config surface, metric names, and scrape examples live in the docs:

- https://docs.afora.ai/gateway/prometheus

## Package

- Plugin id: `diagnostics-prometheus`
- Package: `@afora/diagnostics-prometheus`
- Minimum Afora host: `2026.4.25`
