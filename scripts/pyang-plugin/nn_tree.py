"""A pyang output plugin, `-f nn-tree` (pyang loads every file in this directory as a plugin): the compiled schema tree as JSON.

Run by scripts/pyang-oracle.sh inside a container; not a project dependency.
For every module given, every top-level node (data, rpc, notification),
recursively: [kind, name, namespace module, config, base type, keys,
mandatory, default, children]. Implicit empty input/output are left out.
"""
import json

from pyang import plugin

DATA = {'container', 'list', 'leaf', 'leaf-list', 'choice', 'case', 'anydata', 'anyxml',
        'rpc', 'action', 'input', 'output', 'notification'}


def pyang_plugin_init():
    plugin.register_plugin(NNTreePlugin())


class NNTreePlugin(plugin.PyangPlugin):
    def add_output_format(self, fmts):
        self.multiple_modules = True
        fmts['nn-tree'] = self

    def emit(self, ctx, modules, fd):
        out = {}
        for m in modules:
            out[m.arg] = [node(c) for c in getattr(m, 'i_children', []) if c.keyword in DATA]
        json.dump(out, fd)


def base_type(s):
    t = s.search_one('type')
    while t is not None and getattr(t, 'i_typedef', None) is not None:
        t = t.i_typedef.search_one('type')
    return t.arg if t is not None else None


def node(s):
    kind = s.keyword
    children = [node(c) for c in getattr(s, 'i_children', []) if c.keyword in DATA]
    children = [c for c in children if not (c[0] in ('input', 'output') and not c[8])]
    keys = [k.arg for k in getattr(s, 'i_key', None) or []] if kind == 'list' else None
    mandatory = s.search_one('mandatory')
    default = s.search_one('default')
    return [
        kind,
        s.arg if kind not in ('input', 'output') else kind,
        s.i_module.i_modulename,
        getattr(s, 'i_config', None),
        base_type(s) if kind in ('leaf', 'leaf-list') else None,
        keys,
        mandatory.arg == 'true' if mandatory is not None else False,
        default.arg if default is not None and kind == 'leaf' else None,
        children,
    ]
