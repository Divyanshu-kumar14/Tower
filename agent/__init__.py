"""TOWER agent package (T-04 infrastructure).

Empty marker making ``agent`` a regular package so ``mypy agent/``
resolves ``agent.tower.*`` / ``agent.graph.*`` to a single canonical
module name (without this, mypy reports "Source file found twice under
different module names: tower vs agent.tower"). No runtime logic here.
"""
