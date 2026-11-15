"""OpenTelemetry traces for gateway requests, when an OTLP endpoint is configured.

Each request becomes one trace:
  chat.completions                 the whole request, with key name, model, backend, route and token counts
    ├─ gateway.queue               waiting for a backend slot
    ├─ backend.prefill             slot acquired → first token
    └─ backend.decode              first token → last token

Spans are created after the request finishes, with the measured start and end times, so the hot path does no
tracing work. Without the optional `tracing` extra or an endpoint, this module does nothing and the same phases
are still stored in SQLite.
"""

from __future__ import annotations

import logging

log = logging.getLogger("ibench.gateway")


class Tracer:
    def __init__(self, endpoint: str, service: str = "ibench-gateway"):
        self.enabled = False
        self.error: str | None = None
        if not endpoint:
            return
        try:
            from opentelemetry import trace
            from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
            from opentelemetry.sdk.resources import Resource
            from opentelemetry.sdk.trace import TracerProvider
            from opentelemetry.sdk.trace.export import BatchSpanProcessor, ConsoleSpanExporter
        except ImportError:
            self.error = "OpenTelemetry not installed: pip install -e '.[tracing]'"
            log.warning(self.error)
            return
        provider = TracerProvider(resource=Resource.create({"service.name": service}))
        exporter = ConsoleSpanExporter() if endpoint == "console" else OTLPSpanExporter(endpoint=endpoint.rstrip("/") + "/v1/traces")
        provider.add_span_processor(BatchSpanProcessor(exporter))
        self._trace = trace
        self._tracer = provider.get_tracer("ibench.gateway")
        self._provider = provider
        self.enabled = True

    def record(self, row: dict, t0_ns: int, acquired_ns: int | None, first_ns: int | None, end_ns: int) -> str | None:
        """Emit the spans for one finished request. Returns the trace id (hex), or None when tracing is off."""
        if not self.enabled:
            return None
        attrs = {k: v for k, v in {
            "ibench.request_id": row["id"], "ibench.key_name": row.get("key_name"),
            "gen_ai.request.model": row.get("model_requested"), "gen_ai.response.model": row.get("model"),
            "ibench.backend": row.get("backend"), "ibench.route_reason": row.get("route_reason"),
            "gen_ai.usage.input_tokens": row.get("prompt_tokens"), "gen_ai.usage.output_tokens": row.get("completion_tokens"),
            "ibench.cached_tokens": row.get("cached_tokens"), "ibench.stream": bool(row.get("stream")),
            "ibench.status": row.get("status"),
        }.items() if v is not None}
        root = self._tracer.start_span("chat.completions", start_time=t0_ns, attributes=attrs)
        ctx = self._trace.set_span_in_context(root)
        acq = acquired_ns or end_ns
        self._tracer.start_span("gateway.queue", context=ctx, start_time=t0_ns).end(end_time=acq)
        if acquired_ns:
            first = first_ns or end_ns
            self._tracer.start_span("backend.prefill", context=ctx, start_time=acquired_ns,
                                    attributes={"ibench.backend": row.get("backend")}).end(end_time=first)
            if first_ns:
                self._tracer.start_span("backend.decode", context=ctx, start_time=first_ns,
                                        attributes={"gen_ai.usage.output_tokens": row.get("completion_tokens") or 0}).end(end_time=end_ns)
        if row.get("status") != "ok":
            root.set_status(self._trace.Status(self._trace.StatusCode.ERROR, row.get("error") or "error"))
        root.end(end_time=end_ns)
        return format(root.get_span_context().trace_id, "032x")

    def shutdown(self) -> None:
        if self.enabled:
            self._provider.shutdown()
