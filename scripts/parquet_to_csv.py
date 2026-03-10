from pathlib import Path
import sys
import pandas as pd

inp = Path(sys.argv[1])
out = Path(sys.argv[2]) if len(sys.argv) > 2 else inp.with_suffix(".csv")

df = pd.read_parquet(inp)
df.to_csv(out, index=False)

print(f"Saved {out}")