import { parseModule, type ParsedModule } from '../src/index.js';

/** A minimal valid module around `body`. */
export function moduleText(body: string, version: '1' | '1.1' = '1.1'): string {
  return `module m {
  yang-version ${version};
  namespace "urn:m";
  prefix m;
${body}
}
`;
}

export function parse(body: string, version: '1' | '1.1' = '1.1'): ParsedModule {
  return parseModule(moduleText(body, version), { source: 'm.yang' });
}

/** The codes of the diagnostics, in order. */
export function codes(result: ParsedModule): string[] {
  return result.diagnostics.map((d) => d.code);
}
