import hashlib
import io
import pathlib
import urllib.request
import zipfile

root = pathlib.Path(__file__).resolve().parent.parent
tools = root / '.tools'
tools.mkdir(exist_ok=True)
archive = tools / 'sing-box-1.13.21-windows-amd64.zip'
expected = 'a03291793d3a3c6e266447a58140657ac099ff278abf3b8ff678932356a62ced'
if not archive.exists() or hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
    with urllib.request.urlopen('https://github.com/SagerNet/sing-box/releases/download/v1.13.21/sing-box-1.13.21-windows-amd64.zip', timeout=90) as response:
        archive.write_bytes(response.read())
data = archive.read_bytes()
if hashlib.sha256(data).hexdigest() != expected:
    raise RuntimeError('Core checksum mismatch')
with zipfile.ZipFile(io.BytesIO(data)) as package:
    member = next(name for name in package.namelist() if name.endswith('/sing-box.exe'))
    (tools / 'sing-box.exe').write_bytes(package.read(member))
print('Verified official Windows x64 sing-box archive')
