"""Dump pyang's statement tree for every .yang file under a directory, as JSON.

Run by scripts/pyang-oracle.sh inside a container; not a project dependency.
Output: {"relative/path.yang": [keyword, argument, [children...]] or null}.

With --yin OUT_DIR instead, write every file as YIN (pyang -f yin) to
OUT_DIR/relative/path.yin, resolving imports across the whole directory so
extension arguments are known. One process, one context per file.
"""
import json
import os
import sys

from pyang import context, error, repository, yang_parser


def tree(s):
    kw = s.raw_keyword
    if isinstance(kw, tuple):
        kw = f"{kw[0]}:{kw[1]}"
    return [kw, s.arg, [tree(c) for c in s.substmts]]


SKIP = ('.git', 'pyang-yin', 'yanglint', 'netopeer2')


def main(root, out_path):
    ctx = context.Context(repository.FileRepository('', use_env=False))
    out = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP)
        for name in sorted(filenames):
            if not name.endswith('.yang'):
                continue
            path = os.path.join(dirpath, name)
            with open(path, encoding='utf-8') as f:
                st = yang_parser.YangParser().parse(ctx, error.Position(path), f.read())
            out[os.path.relpath(path, root)] = tree(st) if st is not None else None
    with open(out_path, 'w') as f:
        json.dump(out, f)
    print(f'{len(out)} modules')


class YinOptions:
    yin_canonical = False
    yin_pretty_strings = False


def yin(root, out_dir):
    import io
    from pyang.translators import yin as yin_translator
    dirs = []
    files = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP)
        names = sorted(n for n in filenames if n.endswith('.yang'))
        if names:
            dirs.append(dirpath)
        files.extend(os.path.join(dirpath, n) for n in names)
    path = ':'.join(dirs)
    written = 0
    for f in files:
        ctx = context.Context(repository.FileRepository(path, use_env=False))
        ctx.opts = YinOptions()
        with open(f, encoding='utf-8') as fd:
            text = fd.read()
        try:
            m = ctx.add_module(f, text)
            if m is None:
                continue
            ctx.validate()
            buf = io.StringIO()
            yin_translator.emit_yin(ctx, m, buf)
        except Exception as e:  # a module pyang can't handle is skipped, not fatal
            print(f'skip {f}: {e}', file=sys.stderr)
            continue
        target = os.path.join(out_dir, os.path.relpath(f, root)[:-len('.yang')] + '.yin')
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, 'w', encoding='utf-8') as out:
            out.write(buf.getvalue())
        written += 1
    print(f'{written} YIN files')


if sys.argv[1] == '--yin':
    yin(sys.argv[3], sys.argv[2])
else:
    main(sys.argv[1], sys.argv[2])
