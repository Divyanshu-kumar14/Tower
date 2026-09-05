"""TOWER observability package — stubs only (T-04).

Full OTel wiring (emitter, batching, retry) lands in T-06. This stub
exposes tracer/meter handles plus a no-op emit interface so T-04 tool
code can import without pulling network dependencies.
"""
