"""Shared TSV encoding between the Python checks and the C test harness."""
import datetime as dt
import os

EPOCH = dt.datetime(1899, 12, 30)


def serial(v):
    """Excel serial number for dates/times; anything else unchanged."""
    if isinstance(v, dt.datetime):
        return (v - EPOCH).total_seconds() / 86400
    if isinstance(v, dt.date):
        return (dt.datetime(v.year, v.month, v.day) - EPOCH).days
    if isinstance(v, dt.time):
        return (v.hour * 3600 + v.minute * 60 + v.second) / 86400
    return v


def enc(v):
    v = serial(v)
    if v is None or v == "":
        return ""
    if isinstance(v, bool):
        return f"n:{int(v)}"
    if isinstance(v, (int, float)):
        return f"n:{v!r}"
    return "s:" + str(v).replace("\\", "\\\\").replace("\t", "\\t").replace("\n", "\\n")


def write_block(work, name, rows):
    with open(os.path.join(work, f"in_{name}.tsv"), "w", encoding="utf-8") as f:
        f.write(f"{len(rows)} {len(rows[0])}\n")
        for row in rows:
            f.write("\t".join(enc(v) for v in row) + "\n")


def read_out(work, name):
    with open(os.path.join(work, f"out_{name}.tsv"), encoding="utf-8") as f:
        r, _ = map(int, f.readline().split())
        out = []
        for line in f:
            row = []
            for x in line.rstrip("\n").split("\t"):
                if x.startswith("n:"):
                    row.append(float(x[2:]))
                elif x.startswith("s:"):
                    row.append(x[2:].replace("\\t", "\t").replace("\\n", "\n").replace("\\\\", "\\"))
                else:
                    row.append("")
            out.append(row)
        assert len(out) == r
        return out
