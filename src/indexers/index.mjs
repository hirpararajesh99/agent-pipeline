import { analyzeDotnet } from './dotnet.mjs';

// Add future analyzers here (node, python, java, php). Every analyzer returns
// the shared { nodes, edges } shape, so prompts and dashboard stay stack-agnostic.
const BUILTIN = { dotnet: analyzeDotnet };

export function analyzeProject({ root, records, cfg }) {
  const names = cfg.knowledge.adapters ?? Object.keys(BUILTIN);
  const nodes = [];
  const edges = [];
  for (const name of names) {
    const analyzer = BUILTIN[name];
    if (!analyzer) continue;
    const result = analyzer({ root, records });
    nodes.push(...(result.nodes ?? []));
    edges.push(...(result.edges ?? []));
  }
  return { nodes, edges };
}
