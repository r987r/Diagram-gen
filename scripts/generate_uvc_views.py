#!/usr/bin/env python3
"""Generate UVC design JSON files for each protocol from a shared config.

Reads ``scripts/uvc_config.json`` and emits one design JSON per protocol
(e.g. ``metadata/uvc_axi4.json``, ``metadata/uvc_ahb.json``).  All structural
data — instance layout, connections, groups, modules — is computed from the
config so that there is a **single source of truth** for each protocol's UVC
pattern.

Usage:
    python scripts/generate_uvc_views.py           # default metadata dir
    python scripts/generate_uvc_views.py metadata/  # explicit dir
"""

import json
import sys
from pathlib import Path


def build_uvc_design(proto_key: str, proto: dict) -> dict:
    """Return a fully-populated design dict for one protocol UVC."""

    label = proto["label"]
    channels = proto["channels"]
    layout = proto["agent_layout"]
    extra = proto["extra_positions"]
    clk = proto["clk_name"]
    rst = proto["rst_name"]
    bus_type = proto["bus_type"]
    bus_color = proto["bus_color"]
    env_color = proto["env_color"]
    vif_block = proto["vif_block"]
    dut_block = proto["dut_block"]
    sequences = proto["sequences"]
    scoreboards = proto["scoreboards"]

    ch_list = ", ".join(ch.upper() for ch in channels)
    desc = (
        f"{label} UVC \u2014 per-channel agents ({ch_list}) with "
        f"sequencers, drivers, monitors, and virtual interfaces."
    )

    # ── Instances ────────────────────────────────────────────────
    instances = []
    for ch in channels:
        pos = layout[ch]
        instances.append({"instance_name": f"{ch}_sqr", "module": "uvm_sequencer", "position": pos["sqr"]})
        instances.append({"instance_name": f"{ch}_drv", "module": "uvm_driver",    "position": pos["drv"]})
        instances.append({"instance_name": f"{ch}_mon", "module": "uvm_monitor",   "position": pos["mon"]})
        instances.append({"instance_name": f"{ch}_vif", "module": vif_block,       "position": pos["vif"]})

    instances.append({"instance_name": "dut_stub", "module": dut_block, "position": extra["dut_stub"]})

    for seq_name, seq_cfg in sequences.items():
        instances.append({"instance_name": seq_name, "module": "uvm_sequence", "position": extra[seq_name]})

    for sb_name, sb_cfg in scoreboards.items():
        instances.append({"instance_name": sb_name, "module": "uvm_scoreboard", "position": extra[sb_name]})

    # ── Connections ──────────────────────────────────────────────
    connections: list[dict] = []

    # Clock / reset fanout — only to VIFs and DUT
    clk_targets = [{"instance": f"{ch}_vif", "port": clk} for ch in channels]
    clk_targets.append({"instance": "dut_stub", "port": clk})
    rst_targets = [{"instance": f"{ch}_vif", "port": rst} for ch in channels]
    rst_targets.append({"instance": "dut_stub", "port": rst})

    connections.append({
        "id": "clk_fanout", "type": "clock",
        "description": f"{label} clock to all VIFs and DUT",
        "from": {"instance": "tb_top", "port": clk},
        "to": clk_targets,
    })
    connections.append({
        "id": "rst_fanout", "type": "reset",
        "description": f"{label} reset to all VIFs and DUT",
        "from": {"instance": "tb_top", "port": rst},
        "to": rst_targets,
    })

    # Per-channel agent wiring: sqr→drv, drv→vif, mon→vif
    for ch in channels:
        connections.append({
            "id": f"{ch}_sqr_to_drv", "type": "tlm",
            "label": f"{ch.upper()} sqr\u2192drv",
            "description": f"{ch.upper()} sequencer to driver",
            "from_instance": f"{ch}_sqr", "to_instance": f"{ch}_drv",
            "channel_signals": {
                "TLM": [{"from_port": "seq_item_port", "wire": f"{ch}_seq_item", "to_port": "seq_item_port"}]
            },
        })
        connections.append({
            "id": f"{ch}_drv_to_vif", "type": "vif",
            "label": f"{ch.upper()} drv\u2192vif",
            "description": f"{ch.upper()} driver to virtual interface",
            "from_instance": f"{ch}_drv", "to_instance": f"{ch}_vif",
            "channel_signals": {
                "VIF": [{"from_port": "vif", "wire": f"{ch}_drv_vif", "to_port": "driver_mp"}]
            },
        })
        connections.append({
            "id": f"{ch}_mon_to_vif", "type": "vif",
            "label": f"{ch.upper()} mon\u2192vif",
            "description": f"{ch.upper()} monitor to virtual interface",
            "from_instance": f"{ch}_mon", "to_instance": f"{ch}_vif",
            "channel_signals": {
                "VIF": [{"from_port": "vif", "wire": f"{ch}_mon_vif", "to_port": "monitor_mp"}]
            },
        })

    # Monitor → scoreboard
    for sb_name, sb_cfg in scoreboards.items():
        for ch in sb_cfg["channels"]:
            connections.append({
                "id": f"{ch}_mon_to_{sb_name}", "type": "tlm",
                "label": f"{ch.upper()} mon\u2192SB",
                "description": f"{ch.upper()} monitor analysis to {sb_cfg['label']}",
                "from_instance": f"{ch}_mon", "to_instance": sb_name,
                "channel_signals": {
                    "TLM": [{"from_port": "analysis_port", "wire": f"{ch}_mon_ap", "to_port": "analysis_export"}]
                },
            })

    # Sequence → sequencer
    for seq_name, seq_cfg in sequences.items():
        target_ch = seq_cfg["target_channel"]
        connections.append({
            "id": f"{seq_name}_to_{target_ch}", "type": "tlm",
            "label": seq_cfg["label"],
            "description": f"Sequence generates {target_ch.upper()} channel transactions",
            "from_instance": seq_name, "to_instance": f"{target_ch}_sqr",
            "channel_signals": {
                "TLM": [{"from_port": "seq_item_port", "wire": f"{seq_name}_out", "to_port": "seq_item_port"}]
            },
        })

    # VIF → DUT connections
    for ch in channels:
        connections.append({
            "id": f"{ch}_vif_to_dut", "type": bus_type,
            "label": f"{ch.upper()} vif \u2192 DUT",
            "description": f"{ch.upper()} virtual interface connects to DUT",
            "from_instance": f"{ch}_vif", "to_instance": "dut_stub",
            "channel_signals": {
                "VIF": [{"from_port": "dut_mp", "wire": "vif_handle", "to_port": ch}]
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
            "description": f"{ch.upper()} channel agent (sequencer + driver + monitor + VIF)",
            "color": "#42A5F5",
            "padding": 0.8,
            "members": members,
        })

    # Env encapsulation group
    env_members = agent_members_all + list(sequences.keys()) + list(scoreboards.keys())
    groups.append({
        "name": f"{proto_key}_env",
        "label": f"{label} Env",
        "description": (
            f"{label} Env \u2014 {len(channels)} per-channel agents "
            f"({ch_list}), sequences, and scoreboards."
        ),
        "color": env_color,
        "padding": 1.5,
        "members": env_members,
    })

    # ── Assemble design ─────────────────────────────────────────
    # DUT stub is included via block file; no need to redefine inline

    return {
        "design_name": f"uvc_{proto_key}",
        "version": proto["version"],
        "description": desc,
        "includes": list(proto["includes"]),
        "parameters": {},
        "testbench": {
            "module_name": "tb_top",
            "description": f"Testbench for {label} UVC.",
            "global_signals": [
                {"name": clk, "width": 1, "type": "reg", "description": f"{label} clock.", "render": {"face": "bottom", "color": "#00E676"}},
                {"name": rst, "width": 1, "type": "reg", "description": f"{label} reset.", "render": {"face": "top", "color": "#FF5252"}},
            ]
        },
        "connection_types": {
            bus_type: {"color": bus_color, "description": f"{label} Bus"},
            "vif":    {"color": "#795548", "description": "Virtual Interface"},
            "tlm":    {"color": "#E91E63", "description": "TLM Analysis Port"},
        },
        "modules": {},
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

    protocols = config["protocols"]

    generated = 0
    for key, proto in protocols.items():
        design = build_uvc_design(key, proto)
        out_path = meta_dir / f"uvc_{key}.json"
        with open(out_path, "w") as f:
            json.dump(design, f, indent=2)
            f.write("\n")
        print(f"  Generated {out_path.name}")
        generated += 1

    print(f"\n{generated} UVC view(s) generated from {config_path.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
