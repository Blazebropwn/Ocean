import json
import os
from pathlib import Path
import sys
from io import BytesIO
from urllib.parse import parse_qs, urlsplit

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "research"))
from compare_pairs import STEP, SYMBOLS, aligned_bars, download_sol, run, yearly_returns


def snapshots(tmp_path, count=250):
    paths = {}
    for symbol in SYMBOLS:
        path = tmp_path / f"{symbol}.json"
        path.write_text(json.dumps([[i * STEP, "100", "101", "99", "100", "0", (i + 1) * STEP - 1]
                                    for i in range(count)]))
        paths[symbol] = path
    return paths


def protocol(end=250 * STEP):
    return {"train_start_ms": 0, "train_end_ms": end, "test_start_ms": end}


def test_comparison_uses_common_start_and_excludes_holdout_before_signals(tmp_path):
    paths = snapshots(tmp_path, 260)
    sol = json.loads(paths["SOLUSDC"].read_text())[20:]
    # Invalid candles after the cutoff must not enter validation or indicators.
    sol[-1][4] = "NaN"
    paths["SOLUSDC"].write_text(json.dumps(sol))
    before = {s: p.read_bytes() for s, p in paths.items()}
    bars = aligned_bars(paths, protocol())
    assert {len(v) for v in bars.values()} == {230}
    for values in bars.values():
        assert values[0]["t"] == 20 * STEP
        assert values[-1]["t"] + STEP == 250 * STEP
    assert {s: p.read_bytes() for s, p in paths.items()} == before


@pytest.mark.parametrize("mutation", ["gap", "duplicate", "invalid_price"])
def test_bad_interior_candles_are_rejected_not_intersected_away(tmp_path, mutation):
    paths = snapshots(tmp_path)
    rows = json.loads(paths["SOLUSDC"].read_text())
    if mutation == "gap":
        del rows[220]
    elif mutation == "duplicate":
        rows.insert(220, rows[220])
    else:
        rows[220][4] = "NaN"
    paths["SOLUSDC"].write_text(json.dumps(rows))
    with pytest.raises(ValueError):
        aligned_bars(paths, protocol())


def test_candle_unfinished_when_cached_remains_excluded(tmp_path):
    paths = snapshots(tmp_path)
    captured = (249 * STEP + STEP / 2) / 1000
    os.utime(paths["SOLUSDC"], (captured, captured))
    bars = aligned_bars(paths, protocol())
    assert {len(v) for v in bars.values()} == {249}


def test_holdout_boundary_overrides_later_training_end(tmp_path):
    paths = snapshots(tmp_path, 260)
    config = {"train_start_ms": 0, "train_end_ms": 260 * STEP, "test_start_ms": 240 * STEP}
    bars = aligned_bars(paths, config)
    assert {len(v) for v in bars.values()} == {240}


def test_warmup_only_period_is_rejected(tmp_path):
    paths = snapshots(tmp_path, 209)
    with pytest.raises(ValueError, match="warmup"):
        aligned_bars(paths, protocol())


@pytest.mark.parametrize("capital", [float("nan"), float("inf"), 0, -100])
def test_invalid_capital_fails_before_reading_data(tmp_path, capital):
    with pytest.raises(ValueError, match="finite and positive"):
        run({}, tmp_path / "unused.json", (capital,))


def test_download_preserves_existing_snapshot_without_network(tmp_path):
    path = tmp_path / "snapshot.json"
    path.write_text("original")
    with pytest.raises(FileExistsError):
        download_sol(path, protocol())
    assert path.read_text() == "original"


def test_download_requests_only_public_pre_holdout_candles(tmp_path, monkeypatch):
    rows = [[i * STEP, "100", "101", "99", "100", "0", (i + 1) * STEP - 1] for i in range(240)]
    calls = []
    def public_get(url, timeout):
        parsed = urlsplit(url)
        assert parsed.scheme == "https" and parsed.netloc == "api.binance.com"
        assert parsed.path == "/api/v3/klines"
        params = parse_qs(parsed.query)
        assert params == {"symbol": ["SOLUSDC"], "interval": ["4h"], "startTime": ["0"],
                          "endTime": [str(240 * STEP - 1)], "limit": ["1000"]}
        calls.append(url)
        return BytesIO(json.dumps(rows).encode())
    monkeypatch.setattr("compare_pairs.urllib.request.urlopen", public_get)
    monkeypatch.setattr("compare_pairs.time.sleep", lambda _: None)
    path = tmp_path / "downloaded.json"
    download_sol(path, {"train_start_ms": 0, "train_end_ms": 260 * STEP, "test_start_ms": 240 * STEP})
    assert len(calls) == 1
    assert json.loads(path.read_text()) == rows


def test_year_boundaries_retain_previous_equity():
    curve = [(1703980800000, 1), (1704067199999, 1.1), (1704153599999, .99)]
    result = yearly_returns(curve)
    assert result[2023]["total_return"] == pytest.approx(.1)
    assert result[2024]["total_return"] == pytest.approx(-.1)
