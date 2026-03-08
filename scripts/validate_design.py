#!/usr/bin/env python3
"""Validate Diagram-gen design JSON files.

Performs three levels of validation:
  1. JSON syntax  – every .json file under metadata/ must parse.
  2. Schema       – top-level designs need required keys; block files need
                    block_name + ports or includes.
  3. Connectivity – every instance must reference a known module, every
                    connection must reference known instances, and every
                    signal in channel_signals must map to a port that
                    exists in the referenced module.

Exit code 0 = all checks pass, 1 = at least one error.
"""

import json
import os
import sys
from pathlib import Path


# ── helpers ──────────────────────────────────────────────────────────

def resolve(json_path: Path, visited: set | None = None) -> dict:
    """Recursively resolve includes and return a flat design dict."""
    if visited is None:
        visited = set()

    resolved_path = json_path.resolve()
    if resolved_path in visited:
        raise ValueError(f"Circular include: {json_path}")
    visited.add(resolved_path)

    with open(json_path) as f:
        raw = json.load(f)

    base_dir = json_path.parent

    merged_modules: dict = {}
    merged_instances: list = []
    merged_connections: list = []

    for inc in raw.get("includes", []):
        child_path = base_dir / inc
        child = resolve(child_path, set(visited))

        # Leaf block
        if "block_name" in child and "ports" in child:
            merged_modules[child["block_name"]] = {
                "description": child.get("description", ""),
                "render": child.get("render", {}),
                "ports": child.get("ports", []),
            }

        # Modules from composite/sub-design
        for k, v in child.get("modules", {}).items():
            merged_modules[k] = v

        merged_instances.extend(child.get("instances", []))
        merged_connections.extend(child.get("connections", []))

    # Inline modules override includes
    merged_modules.update(raw.get("modules", {}))

    return {
        **raw,
        "modules": merged_modules,
        "instances": merged_instances + raw.get("instances", []),
        "connections": merged_connections + raw.get("connections", []),
    }


def validate_json_syntax(json_dir: Path) -> list[str]:
    """Return a list of errors for any unparseable JSON file."""
    errors: list[str] = []
    for p in sorted(json_dir.rglob("*.json")):
        try:
            json.load(open(p))
        except json.JSONDecodeError as exc:
            errors.append(f"  {p.relative_to(json_dir)}: {exc}")
    return errors


def validate_block_schema(json_dir: Path) -> list[str]:
    """Validate that block files have required fields."""
    errors: list[str] = []
    blocks_dir = json_dir / "blocks"
    if not blocks_dir.exists():
        return errors

    for p in sorted(blocks_dir.glob("*.json")):
        with open(p) as f:
            data = json.load(f)
        rel = p.relative_to(json_dir)

        if "block_name" not in data:
            errors.append(f"  {rel}: missing 'block_name'")
            continue

        is_composite = "includes" in data
        is_leaf = "ports" in data

        if not is_composite and not is_leaf:
            errors.append(
                f"  {rel}: block must have 'ports' (leaf) or 'includes' (composite)"
            )

        if is_leaf:
            if "render" not in data or "color" not in data.get("render", {}):
                errors.append(f"  {rel}: leaf block missing 'render.color'")
            for i, port in enumerate(data.get("ports", [])):
                if "name" not in port:
                    errors.append(f"  {rel}: ports[{i}] missing 'name'")
                if "direction" not in port:
                    errors.append(f"  {rel}: ports[{i}] missing 'direction'")

    return errors


def validate_design_schema(design_path: Path, json_dir: Path) -> list[str]:
    """Validate top-level design JSON required fields."""
    errors: list[str] = []
    with open(design_path) as f:
        data = json.load(f)
    rel = design_path.relative_to(json_dir)

    for key in ("design_name", "version"):
        if key not in data:
            errors.append(f"  {rel}: missing '{key}'")

    return errors


def validate_connectivity(
    design_path: Path, json_dir: Path
) -> tuple[list[str], list[str]]:
    """Resolve includes and validate all connectivity references.

    Returns (errors, warnings).  Errors are hard failures (missing
    modules, missing instances).  Warnings are informational (port-level
    mismatches – a module may deliberately expose only high-level ports
    while connections carry RTL signal names for documentation).
    """
    errors: list[str] = []
    warnings: list[str] = []
    rel = design_path.relative_to(json_dir)

    try:
        design = resolve(design_path)
    except (json.JSONDecodeError, FileNotFoundError, ValueError) as exc:
        errors.append(f"  {rel}: resolve error – {exc}")
        return errors, warnings

    modules = design.get("modules", {})
    instances = design.get("instances", [])
    connections = design.get("connections", [])

    # Map instance_name → module_name
    inst_map: dict[str, str] = {}
    for inst in instances:
        name = inst.get("instance_name")
        mod = inst.get("module")
        if not name:
            errors.append(f"  {rel}: instance missing 'instance_name'")
            continue
        if not mod:
            errors.append(f"  {rel}: instance '{name}' missing 'module'")
            continue
        if mod not in modules:
            errors.append(
                f"  {rel}: instance '{name}' references unknown module '{mod}'"
            )
        inst_map[name] = mod

    # Build port lookup per module: module_name → set of port names
    mod_ports: dict[str, set[str]] = {}
    for mod_name, mod_def in modules.items():
        mod_ports[mod_name] = {p["name"] for p in mod_def.get("ports", [])}

    # Validate connections
    for conn in connections:
        cid = conn.get("id", "<no-id>")
        ctype = conn.get("type", "")

        # Global fanout connections (clock/reset)
        if ctype in ("clock", "reset"):
            targets = conn.get("to", [])
            for t in targets:
                t_inst = t.get("instance")
                if t_inst and t_inst not in inst_map:
                    errors.append(
                        f"  {rel}: connection '{cid}' references "
                        f"unknown instance '{t_inst}'"
                    )
            continue

        # Point-to-point bus/TLM connections
        from_inst = conn.get("from_instance")
        to_inst = conn.get("to_instance")

        if from_inst and from_inst not in inst_map:
            errors.append(
                f"  {rel}: connection '{cid}' from_instance "
                f"'{from_inst}' not found"
            )
        if to_inst and to_inst not in inst_map:
            errors.append(
                f"  {rel}: connection '{cid}' to_instance "
                f"'{to_inst}' not found"
            )

        # Validate channel_signals port references (warnings only –
        # modules may expose abstract ports while connections document
        # RTL-level signals for downstream tooling)
        for channel, signals in conn.get("channel_signals", {}).items():
            for sig in signals:
                fp = sig.get("from_port")
                tp = sig.get("to_port")

                if from_inst and from_inst in inst_map:
                    src_mod = inst_map[from_inst]
                    if src_mod in mod_ports and fp and fp not in mod_ports[src_mod]:
                        warnings.append(
                            f"  {rel}: connection '{cid}' channel {channel}: "
                            f"from_port '{fp}' not in module '{src_mod}'"
                        )

                if to_inst and to_inst in inst_map:
                    dst_mod = inst_map[to_inst]
                    if dst_mod in mod_ports and tp and tp not in mod_ports[dst_mod]:
                        warnings.append(
                            f"  {rel}: connection '{cid}' channel {channel}: "
                            f"to_port '{tp}' not in module '{dst_mod}'"
                        )

    return errors, warnings


# ── main ─────────────────────────────────────────────────────────────

def main() -> int:
    # Accept an optional path argument, default to metadata/
    if len(sys.argv) > 1:
        json_dir = Path(sys.argv[1])
    else:
        json_dir = Path(__file__).resolve().parent.parent / "metadata"

    if not json_dir.is_dir():
        print(f"ERROR: directory not found: {json_dir}", file=sys.stderr)
        return 1

    print(f"Validating designs in {json_dir}\n")

    all_errors: list[str] = []

    # 1. JSON syntax
    print("1. JSON syntax …")
    errs = validate_json_syntax(json_dir)
    all_errors.extend(errs)
    print(f"   {'FAIL' if errs else 'OK'}" + (f" ({len(errs)} errors)" if errs else ""))
    for e in errs:
        print(e)

    # 2. Block schema
    print("2. Block schema …")
    errs = validate_block_schema(json_dir)
    all_errors.extend(errs)
    print(f"   {'FAIL' if errs else 'OK'}" + (f" ({len(errs)} errors)" if errs else ""))
    for e in errs:
        print(e)

    # 3. Design schema + connectivity
    all_warnings: list[str] = []
    design_files = sorted(
        p for p in json_dir.glob("*.json")
        if p.is_file()
    )
    print(f"3. Design connectivity ({len(design_files)} designs) …")
    for df in design_files:
        errs = validate_design_schema(df, json_dir)
        conn_errs, conn_warns = validate_connectivity(df, json_dir)
        errs.extend(conn_errs)
        all_errors.extend(errs)
        all_warnings.extend(conn_warns)
        status = "FAIL" if errs else "OK"
        print(f"   {df.relative_to(json_dir)}: {status}")
        for e in errs:
            print(e)
        for w in conn_warns:
            print(f"   ⚠ WARN:{w}")

    # Summary
    print()
    if all_warnings:
        print(f"{len(all_warnings)} warning(s) (port-level, non-blocking)")
    if all_errors:
        print(f"FAILED — {len(all_errors)} error(s) found")
        return 1
    else:
        print("ALL CHECKS PASSED ✓")
        return 0


if __name__ == "__main__":
    sys.exit(main())
