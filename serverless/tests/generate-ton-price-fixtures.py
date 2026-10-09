"""Rebuild portable decoder parity cases from public TON fixtures, offline.

Run from the repository root with its pinned development Python environment:
  .venv/Scripts/python.exe serverless/tests/generate-ton-price-fixtures.py
The JavaScript tests consume the committed output and do not require Python.
"""
from __future__ import annotations

import base64
import copy
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))
from pytoniq_core import Address, Builder, Cell
from marketapp_rent.addresses import canonical_address
from marketapp_rent.ton_decoder import decode_contract

FIXTURES = ROOT / "tests" / "fixtures" / "ton"
OUT = ROOT / "serverless" / "tests" / "fixtures" / "ton-price-parity.json"
WHEN = "2026-10-08T14:40:00+00:00"
WALLET = "UQC3PX8rXmcy22kJazMuSSXTzeIISgB4fXBo-_6GH60EObwF"


def read(name):
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


def replace_ref(account, index, new_ref):
    data = Cell.one_from_boc(account["data_boc"])
    refs = list(data.refs)
    refs[index] = new_ref
    update_data(account, Cell(data.bits, refs))


def update_data(account, cell):
    account["data_boc"] = base64.b64encode(cell.to_boc()).decode()
    account["data_hash"] = cell.hash.hex()


def identity(account, **overrides):
    source = Cell.one_from_boc(account["data_boc"]).refs[0].begin_parse()
    values = {"owner": source.load_address(), "nft": source.load_address(), "marketplace": source.load_address(),
              "created_at": source.load_uint(64), "role": source.load_uint(2)}
    values.update(overrides)
    builder = Builder().store_address(values["owner"]).store_address(values["nft"]).store_address(values["marketplace"])
    replace_ref(account, 0, builder.store_uint(values["created_at"], 64).store_uint(values["role"], 2).end_cell())


cases = []


def append(name, account, nft, code_fixture, when=WHEN):
    account = {key: copy.deepcopy(account[key]) for key in ("address", "status", "code_hash", "data_hash", "data_boc", "last_transaction_lt")}
    account["code_boc"] = (FIXTURES / code_fixture).read_text().strip()
    expected = decode_contract(account, nft, WALLET, when)
    del account["code_boc"]
    cases.append({"name": name, "account": account, "nft": nft, "wallet": WALLET, "observed_at": when,
                  "code_fixture": code_fixture, "expected": expected})


accounts = read("holder-states")["body"]["accounts"]
for sample in read("verified-samples")["samples"]:
    account = next(a for a in accounts if canonical_address(a["address"]) == canonical_address(sample["holding_contract"]))
    append(sample["label"], account, sample["nft_address"], "observed-code.boc.base64")
for name in ("7f44-idle", "7f44-rented"):
    saved = read(name)
    append(name, saved["account"], saved["nft_before"]["address"], saved["code_fixture"], saved["account_observed_at"])

baseline = copy.deepcopy(cases[0])
for name, value in (("owner", Address("0:" + "11" * 32)), ("nft", Address("0:" + "11" * 32)),
                    ("marketplace", Address("0:" + "11" * 32)), ("role", 2), ("owner", None)):
    account = copy.deepcopy(baseline["account"])
    identity(account, **{name: value})
    append(f"identity-{name}-{value}", account, baseline["nft"], baseline["code_fixture"])
for kind in ("anycast", "external", "variable", "workchain"):
    account = copy.deepcopy(baseline["account"])
    source = Cell.one_from_boc(account["data_boc"]).refs[0].begin_parse()
    address = source.load_address()
    if kind == "anycast":
        builder = Builder().store_bits("101").store_uint(1, 5).store_uint(0, 1).store_int(0, 8).store_bytes(address.hash_part)
    elif kind == "external":
        builder = Builder().store_bits("01").store_uint(256, 9).store_bytes(address.hash_part)
    elif kind == "variable":
        builder = Builder().store_bits("110").store_uint(256, 9).store_int(0, 32).store_bytes(address.hash_part)
    else:
        builder = Builder().store_bits("100").store_int(2, 8).store_bytes(address.hash_part)
    replace_ref(account, 0, builder.store_slice(source).end_cell())
    append(f"identity-address-{kind}", account, baseline["nft"], baseline["code_fixture"])
for ref in range(4):
    for mutation in ("trailing-bit", "trailing-ref", "truncated"):
        account = copy.deepcopy(baseline["account"])
        cell = Cell.one_from_boc(account["data_boc"]).refs[ref]
        if mutation == "truncated":
            changed = Cell(cell.bits[:-1], [])
        else:
            builder = Builder().store_slice(cell.begin_parse())
            changed = (builder.store_uint(0, 1) if mutation == "trailing-bit" else builder.store_ref(Builder().end_cell())).end_cell()
        replace_ref(account, ref, changed)
        append(f"ref-{ref}-{mutation}", account, baseline["nft"], baseline["code_fixture"])
for mutation in ("root-bits", "root-refs"):
    account = copy.deepcopy(baseline["account"])
    cell = Cell.one_from_boc(account["data_boc"])
    update_data(account, Cell(cell.bits[:-1] if mutation == "root-bits" else cell.bits,
                              cell.refs[:-1] if mutation == "root-refs" else cell.refs))
    append(mutation, account, baseline["nft"], baseline["code_fixture"])

# Same supported identity, but an unrecognized role/status state is explicitly
# unknown even if owner verification succeeds. Pricing must not use that state.
account = copy.deepcopy(baseline["account"])
state = Cell.one_from_boc(account["data_boc"]).refs[1]
bits = state.bits.copy()
bits[0] = 1
replace_ref(account, 1, Cell(bits, []))
append("unknown-status", account, baseline["nft"], baseline["code_fixture"])

# Large VarUInteger16 coin values must remain exact decimal strings.
account = copy.deepcopy(baseline["account"])
source = Cell.one_from_boc(account["data_boc"]).refs[2].begin_parse()
builder = Builder().store_uint(source.load_uint(1), 1).store_uint(source.load_uint(32), 32).store_uint(source.load_uint(32), 32)
source.load_coins()
builder.store_coins((1 << 120) - 1).store_slice(source)
replace_ref(account, 2, builder.end_cell())
append("exact-max-coins", account, baseline["nft"], baseline["code_fixture"])

OUT.write_text(json.dumps({"source": "Public tests/fixtures/ton snapshots; expected evidence from src/marketapp_rent/ton_decoder.py", "cases": cases}, indent=2) + "\n", encoding="utf-8")
print(f"Wrote {len(cases)} cases to {OUT}")
