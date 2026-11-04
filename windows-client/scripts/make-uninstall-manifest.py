"""Remove only packaged files; never recursively delete a user-selected folder."""
import pathlib
import sys

app = pathlib.Path(sys.argv[1]).resolve()
output = pathlib.Path(sys.argv[2])
files = sorted(p for p in app.rglob('*') if p.is_file())
directories = sorted((p for p in app.rglob('*') if p.is_dir()), key=lambda p: len(p.parts), reverse=True)
def relative(path):
    value = str(path.relative_to(app)).replace('/', '\\')
    if '"' in value or '$' in value or '\n' in value:
        raise ValueError('Unexpected package filename')
    return value
lines = ['Delete "$INSTDIR\\' + relative(p) + '"' for p in files]
lines += ['Delete "$INSTDIR\\Uninstall.exe"']
lines += ['RMDir "$INSTDIR\\' + relative(p) + '"' for p in directories]
lines += ['RMDir "$INSTDIR"']
output.write_text('\n'.join(lines) + '\n', encoding='utf-8-sig')
