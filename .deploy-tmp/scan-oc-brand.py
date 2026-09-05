import os

p = os.path.join(os.environ["USERPROFILE"], r".olkil\opencode-bin\opencode.exe")
data = open(p, "rb").read()

idx = data.find(b"OpenCode includes free")
print("includes idx", idx)
print(repr(data[idx : idx + 240]))
print("---")
idx = data.find(b"sidebar.gettingStarted")
print(repr(data[idx : idx + 400]))
print("--- pickle ---")
idx = data.find(b"Big Pickle")
print("Big Pickle count", data.count(b"Big Pickle"), "idx", idx)
if idx >= 0:
    print(repr(data[idx - 50 : idx + 90]))
idx = data.find(b"name:\"Big Pickle\"")
print("json name idx", idx)
u = "OpenCode".encode("utf-16le")
print("utf16le OpenCode", data.count(u))
for s in [
    b"setTerminalTitle",
    b"OpenCode ({{version}})",
    b"You are OpenCode",
    b"I am OpenCode",
    b"powered by",
    b"opencode/big-pickle",
]:
    print(s, "count", data.count(s), "idx", data.find(s))

# Print every unique ascii string that starts with OpenCode and is short
import re

pat = re.compile(rb"OpenCode[^\x00]{0,80}")
seen = set()
for m in pat.finditer(data):
    s = m.group()
    if all(32 <= b < 127 for b in s) and s not in seen and len(s) < 90:
        seen.add(s)
        if b"http" not in s.lower() and b"schema" not in s.lower():
            print("OCSTR", len(s), s.decode())
