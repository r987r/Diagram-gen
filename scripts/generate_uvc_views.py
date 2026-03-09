#!/usr/bin/env python3
"""Generate individual UVC design JSON files from a shared config.

Reads ``metadata/uvc_config.json`` and emits one design JSON per UVC
entry (e.g. ``metadata/uvm_cpu_uvc.json``).  All structural data — instance
layout, connections, groups, modules — is computed from the config so that
there is a **single source of truth** for the common AXI4 env pattern.

Usage:
    python scripts/generate_uvc_views.py           # default metadata dir
    python scripts/generate_uvc_views.py metadata/  # explicit dir
"""

import json
import sys
from pathlib import Path


def build_uvc_design(key: str, uvc: dict, common: dict) -> dict:
    """Return a fully-populated design dict for one UVC."""

    role = uvc["role"]            # "master" or "slave"
    label = uvc["label"]          # e.g. "CPU"
    env_color = uvc["env_color"]  # e.g. "#1565C0"
    channels = common["channels"]
    layout = common["agent_layout"]
    extra = common["extra_positions"]

    # ── Description ──────────────────────────────────────────────
    desc = (
        f"Individual view of the {label} AXI4 Env \u2014 each per-channel "
        f"agent (AW, W, B, AR, R) is expanded to show its internal "
        f"sequencer, driver, and monitor. Per-channel virtual interfaces "
        f"connect agents to the DUT."
    )

    # ── Instances ────────────────────────────────────────────────
    instances = []
    for ch in channels:
        pos = layout[ch]
        instances.append({"instance_name": f"{ch}_sqr", "module": "uvm_sequencer", "position": pos["sqr"]})
        instances.append({"instance_name": f"{ch}_drv", "module": "uvm_driver",    "position": pos["drv"]})
        instances.append({"instance_name": f"{ch}_mon", "module": "uvm_monitor",   "position": pos["mon"]})
        instances.append({"instance_name": f"{ch}_vif", "module": "axi4_vif",      "position": pos["vif"]})

    instances.append({"instance_name": "dut_stub",  "module": "axi4_interconnect", "position": extra["dut_stub"]})
    instances.append({"instance_name": "read_seq",  "module": "uvm_sequence",      "position": extra["read_seq"]})
    instances.append({"instance_name": "write_seq", "module": "uvm_sequence",      "position": extra["write_seq"]})
    instances.append({"instance_name": "read_sb",   "module": "uvm_read_scoreboard",  "position": extra["read_sb"]})
    instances.append({"instance_name": "write_sb",  "module": "uvm_write_scoreboard", "position": extra["write_sb"]})

    # ── Connections ──────────────────────────────────────────────
    connections: list[dict] = []

    # Clock / reset fanout — only to VIFs and DUT (not to UVM components)
    clk_targets = [{"instance": f"{ch}_vif", "port": "clk"} for ch in channels]
    clk_targets.append({"instance": "dut_stub", "port": "clk"})
    rst_targets = [{"instance": f"{ch}_vif", "port": "rst_n"} for ch in channels]
    rst_targets.append({"instance": "dut_stub", "port": "rst_n"})

    connections.append({
        "id": "clk_fanout", "type": "clock",
        "description": "System clock to all VIFs and DUT",
        "from": {"instance": "tb_top", "port": "clk"},
        "to": clk_targets,
    })
    connections.append({
        "id": "rst_fanout", "type": "reset",
        "description": "Active-low reset to all VIFs and DUT",
        "from": {"instance": "tb_top", "port": "rst_n"},
        "to": rst_targets,
    })

    # Per-channel agent wiring: sqr→drv, drv→vif, mon→vif, mon→sb
    for ch in channels:
        connections.append({
            "id": f"{ch}_sqr_to_drv", "type": "tlm",
            "label": f"{ch.upper()} sqr→drv",
            "description": f"{ch.upper()} sequencer to driver",
            "from_instance": f"{ch}_sqr", "to_instance": f"{ch}_drv",
            "channel_signals": {
                "TLM": [{"from_port": "seq_item_port", "wire": f"{ch}_seq_item", "to_port": "seq_item_port"}]
            },
        })
        connections.append({
            "id": f"{ch}_drv_to_vif", "type": "vif",
            "label": f"{ch.upper()} drv→vif",
            "description": f"{ch.upper()} driver to virtual interface",
            "from_instance": f"{ch}_drv", "to_instance": f"{ch}_vif",
            "channel_signals": {
                "VIF": [{"from_port": "vif", "wire": f"{ch}_drv_vif", "to_port": "driver_mp"}]
            },
        })
        connections.append({
            "id": f"{ch}_mon_to_vif", "type": "vif",
            "label": f"{ch.upper()} mon→vif",
            "description": f"{ch.upper()} monitor to virtual interface",
            "from_instance": f"{ch}_mon", "to_instance": f"{ch}_vif",
            "channel_signals": {
                "VIF": [{"from_port": "vif", "wire": f"{ch}_mon_vif", "to_port": "monitor_mp"}]
            },
        })

    # Monitor → scoreboard (read: AR+R, write: AW+W+B)
    for ch, sb in [("ar", "read_sb"), ("r", "read_sb"),
                    ("aw", "write_sb"), ("w", "write_sb"), ("b", "write_sb")]:
        connections.append({
            "id": f"{ch}_mon_to_{sb}", "type": "tlm",
            "label": f"{ch.upper()} mon→SB",
            "description": f"{ch.upper()} monitor analysis to {sb.replace('_', ' ')}",
            "from_instance": f"{ch}_mon", "to_instance": sb,
            "channel_signals": {
                "TLM": [{"from_port": "analysis_port", "wire": f"{ch}_mon_ap", "to_port": "analysis_export"}]
            },
        })

    # Sequence → sequencer
    connections.append({
        "id": "read_seq_to_ar", "type": "tlm",
        "label": "Read seq→AR",
        "description": "Read sequence generates AR channel transactions",
        "from_instance": "read_seq", "to_instance": "ar_sqr",
        "channel_signals": {
            "TLM": [{"from_port": "seq_item_port", "wire": "read_seq_out", "to_port": "seq_item_port"}]
        },
    })
    connections.append({
        "id": "write_seq_to_aw", "type": "tlm",
        "label": "Write seq→AW",
        "description": "Write sequence generates AW channel transactions",
        "from_instance": "write_seq", "to_instance": "aw_sqr",
        "channel_signals": {
            "TLM": [{"from_port": "seq_item_port", "wire": "write_seq_out", "to_port": "seq_item_port"}]
        },
    })

    # VIF ↔ DUT connections (direction depends on master/slave role)
    for ch in channels:
        if role == "master":
            connections.append({
                "id": f"{ch}_vif_to_dut", "type": "axi4_bus",
                "label": f"{ch.upper()} vif \u2192 DUT",
                "description": f"{ch.upper()} virtual interface connects to DUT",
                "from_instance": f"{ch}_vif", "to_instance": "dut_stub",
                "channel_signals": {
                    "VIF": [{"from_port": "dut_mp", "wire": "vif_handle", "to_port": ch}]
                },
            })
        else:
            connections.append({
                "id": f"dut_to_{ch}_vif", "type": "axi4_bus",
                "label": f"DUT \u2192 {ch.upper()} vif",
                "description": f"DUT connects to {ch.upper()} virtual interface",
                "from_instance": "dut_stub", "to_instance": f"{ch}_vif",
                "channel_signals": {
                    "VIF": [{"from_port": ch, "wire": "vif_handle", "to_port": "dut_mp"}]
                },
            })

    # ── Groups ───────────────────────────────────────────────────
    agent_members_all: list[str] = []
    groups: list[dict] = []
    for ch in channels:
        members = [f"{ch}_sqr", f"{ch}_drv", f"{ch}_mon", f"{ch}_vif"]
        agent_members_all.extend(members)
        groups.append({
            "name": f"{ch}_agent",
            "label": f"{ch.upper()} Agent",
            "description": f"AXI4 {ch.upper()} channel agent (sequencer + driver + monitor + VIF)",
            "color": "#42A5F5",
            "padding": 0.8,
            "members": members,
        })

    # Env encapsulation group (all agents + sequences + scoreboards)
    env_members = agent_members_all + ["read_seq", "write_seq", "read_sb", "write_sb"]
    groups.append({
        "name": "axi4_env",
        "label": f"AXI4 Env ({label})",
        "description": (
            f"AXI4 Env ({label}) \u2014 5 per-channel agents "
            f"(AW, W, B for write; AR, R for read), sequences, and scoreboards."
        ),
        "color": env_color,
        "padding": 1.5,
        "members": env_members,
    })

    # ── Assemble design ─────────────────────────────────────────
    modules = {"axi4_interconnect": common["dut_module"]}
    modules.update(common["scoreboard_modules"])

    tb = dict(common["testbench"])
    tb["description"] = f"Testbench for {label} AXI4 Env debug view."

    return {
        "design_name": f"{key}_axi4_env_view",
        "version": common["version"],
        "description": desc,
        "includes": list(common["includes"]),
        "parameters": dict(common["parameters"]),
        "testbench": tb,
        "connection_types": dict(common["connection_types"]),
        "modules": modules,
        "instances": instances,
        "connections": connections,
        "groups": groups,
    }


def main() -> int:
    if len(sys.argv) > 1:
        meta_dir = Path(sys.argv[1])
    else:
        meta_dir = Path(__file__).resolve().parent.parent / "metadata"

    config_path = Path(__file__).resolve().parent / "uvc_config.json"
    if not config_path.exists():
        print(f"ERROR: config not found: {config_path}", file=sys.stderr)
        return 1

    with open(config_path) as f:
        config = json.load(f)

    common = config["common"]
    uvcs = config["uvcs"]

    generated = 0
    for key, uvc in uvcs.items():
        design = build_uvc_design(key, uvc, common)
        out_path = meta_dir / f"uvm_{key}_uvc.json"
        with open(out_path, "w") as f:
            json.dump(design, f, indent=2)
            f.write("\n")
        print(f"  Generated {out_path.name}")
        generated += 1

    print(f"\n{generated} UVC view(s) generated from {config_path.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
