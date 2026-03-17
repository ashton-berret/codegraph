# CodeGraph — Complete Specification

> **Version:** 1.1
> **Last Updated:** 2026-03-17
> **Status:** Phase 1 Complete
> **Author:** Ashton Berret
>
> **See also:** [`progress.md`](./progress.md) — per-phase implementation plans, decisions, and status

---

## 1. Mission

CodeGraph is an internal developer tool that automatically maps the structure and relationships within a TypeScript / SvelteKit / Prisma codebase by parsing source code at the AST level. It extracts every meaningful symbol — functions, classes, components, Prisma models, imports, call sites, type definitions — and builds a knowledge graph that captures how all those pieces connect. On top of the raw graph it runs community detection, process tracing, and impact analysis to give developers and AI tools deep architectural awareness without reading every file.

**Design constraint:** CodeGraph must function as a fully standalone, open-sourceable project (own repo, own CLI, own web UI) while also integrating cleanly into Dev-Connect with zero duplicated code.

---

## 2. Architecture Overview

CodeGraph is a **monorepo** that publishes **three npm packages**. A fourth package (the standalone web app) exists in the monorepo but is not published — it's an application, not a library.

```
codegraph/                          # Monorepo root
├── package.json                    # npm workspaces config
├── tsconfig.base.json              # Shared TS config (strict, ESM)
├── turbo.json                      # Turborepo build orchestration
│
├── packages/
│   ├── core/                       # Published as "codegraph-core"
│   ├── ui/                         # Published as "codegraph-ui"
│   ├── cli/                        # Published as "codegraph-cli"
│   └── web/                        # Standalone SvelteKit app (NOT published)
│
└── .codegraph/                     # Local data directory (gitignored)
    └── graphs/                     # JSON-serialized graph files (one per repo)
```

### Package dependency graph

```
codegraph-core          ← zero framework dependencies, pure TypeScript
    ↑           ↑
codegraph-cli   codegraph-ui        ← cli depends on core; ui depends on core
    ↑               ↑
    │           codegraph-web       ← standalone app depends on core + ui
    │               ↑
    └───────────────┘
```

### Consumer integration model

Any SvelteKit application (Dev-Connect, or any future consumer) integrates by adding two dependencies:

```json
{
  "dependencies": {
    "codegraph-core": "...",
    "codegraph-ui": "..."
  }
}
```

During development, before publishing to npm, use local file references:

```json
{
  "dependencies": {
    "codegraph-core": "file:../codegraph/packages/core",
    "codegraph-ui": "file:../codegraph/packages/ui"
  }
}
```

The consumer creates its own routes that import components from `codegraph-ui` and data functions from `codegraph-core`. The consumer provides its own layout, navigation, and authentication. CodeGraph provides the engine and the visual components.

---

## 3. Package: `codegraph-core`

**Purpose:** Pure TypeScript engine. Takes a repo path, parses it, builds a knowledge graph, and returns it as an in-memory data structure. Also provides analysis and search functions that operate on the graph. **Has no database dependency, no framework dependency, no storage opinion.**

```
packages/core/
├── package.json                    # "codegraph-core"
├── tsconfig.json                   # Extends ../../tsconfig.base.json
├── vitest.config.ts
│
├── src/
│   ├── index.ts                    # Public API barrel export ✅
│   │
│   ├── config/
│   │   ├── languages.ts            # Language registry (ts, svelte, prisma) ✅
│   │   └── ignore.ts               # .gitignore + custom ignore pattern handling ✅
│   │
│   ├── walker/
│   │   └── filesystem.ts           # Repo scanner — walks files, respects ignores,
│   │                               # chunks by byte budget, yields { path, size, lang } ✅
│   │
│   ├── parser/
│   │   ├── tree-sitter.ts          # Tree-sitter init, grammar loading, AST caching ✅
│   │   ├── extract.ts              # Unified extraction coordinator — routes each file
│   │   │                           # to the correct query set, returns ExtractedSymbols ✅
│   │   └── queries/
│   │       ├── typescript.ts       # TS/JS extraction (see 3.2) ✅
│   │       ├── svelte.ts           # Svelte extraction (see 3.3)
│   │       └── prisma.ts           # Prisma extraction (see 3.4)
│   │
│   ├── resolution/
│   │   ├── symbol-table.ts         # Global symbol registry — every symbol indexed
│   │   │                           # by name, file, kind for O(1) lookup
│   │   ├── import-resolver.ts      # Import path resolution (see 3.5)
│   │   ├── call-resolver.ts        # Call target resolution with confidence (see 3.6)
│   │   ├── heritage-resolver.ts    # extends/implements resolution for classes
│   │   ├── svelte-resolver.ts      # Component imports, prop bindings, stores, events
│   │   ├── prisma-resolver.ts      # Model relations, model→TypeScript client mapping
│   │   ├── sveltekit-resolver.ts   # SvelteKit convention resolution (see 3.7)
│   │   └── tsconfig-loader.ts      # Parses tsconfig.json/jsconfig.json for path aliases
│   │
│   ├── graph/
│   │   ├── types.ts                # Node and edge type enums, interfaces (see 3.8)
│   │   ├── knowledge-graph.ts      # In-memory graph — adjacency maps, O(1) lookups,
│   │   │                           # iterators, serialize/deserialize
│   │   └── builder.ts              # Orchestrator: walk → parse → resolve → graph
│   │
│   ├── analysis/
│   │   ├── community.ts            # Community detection (Louvain via graphology)
│   │   ├── process.ts              # Execution flow tracing from entry points
│   │   ├── impact.ts               # Blast radius analysis
│   │   └── changes.ts              # Git diff → affected symbols → affected processes
│   │
│   └── search/
│       ├── bm25.ts                 # BM25 keyword index over symbol names + content
│       ├── hybrid.ts               # RRF merge of BM25 + semantic results
│       └── semantic.ts             # Embedding-based search (stub for v2)
│
└── test/
    ├── fixtures/                   # Small synthetic repos
    │   ├── sveltekit-app/          # Minimal SvelteKit project
    │   │   ├── src/routes/+page.svelte
    │   │   ├── src/routes/+page.ts
    │   │   ├── src/lib/stores.ts
    │   │   └── prisma/schema.prisma
    │   └── ts-library/             # Plain TS with imports/exports
    │       ├── src/auth/service.ts      # Class with visibility, static, async, type-only import
    │       ├── src/auth/validate.ts     # Exported function with params + return type
    │       ├── src/models/types.ts      # Interfaces, type aliases, enums, variables, arrow fns
    │       ├── src/models/index.ts      # Re-exports and type-only re-exports
    │       └── src/index.ts             # Barrel exports, export const
    ├── parser/
    │   ├── typescript.test.ts
    │   ├── svelte.test.ts
    │   └── prisma.test.ts
    ├── resolution/
    │   ├── import-resolver.test.ts
    │   ├── call-resolver.test.ts
    │   └── sveltekit-resolver.test.ts
    └── analysis/
        ├── community.test.ts
        ├── process.test.ts
        └── impact.test.ts
```

### 3.1 Public API

The barrel export (`index.ts`) exposes these top-level functions and types:

```typescript
// === Build ===
buildGraph(repoPath: string, options?: BuildOptions): Promise<KnowledgeGraph>

// === Analyze ===
detectCommunities(graph: KnowledgeGraph): CommunityResult[]
traceProcesses(graph: KnowledgeGraph): ProcessTrace[]
analyzeImpact(graph: KnowledgeGraph, target: string, direction?: 'upstream' | 'downstream' | 'both'): ImpactResult
analyzeChanges(graph: KnowledgeGraph, repoPath: string, diff?: string): ChangeImpact

// === Search ===
searchSymbols(graph: KnowledgeGraph, query: string): SearchResult[]

// === Serialize ===
serializeGraph(graph: KnowledgeGraph): SerializedGraph   // → JSON-safe plain object
deserializeGraph(data: SerializedGraph): KnowledgeGraph   // → hydrated graph instance

// === Types (re-exported) ===
KnowledgeGraph, GraphNode, GraphEdge, NodeType, EdgeType,
CommunityResult, ProcessTrace, ImpactResult, ChangeImpact,
SearchResult, BuildOptions, SerializedGraph,
// Extraction types (Phase 1)
ExtractedDeclaration, ExtractedImport, ExtractedExport, ExtractedCall,
ParamInfo, TypeScriptExtractionResult
```

`BuildOptions`:
```typescript
interface BuildOptions {
  languages?: ('typescript' | 'svelte' | 'prisma')[]  // default: all
  ignorePatterns?: string[]                             // additional ignore globs
  maxFileSize?: number                                  // skip files larger than N bytes
  followSymlinks?: boolean                              // default: false
}
```

### 3.2 TypeScript / JavaScript Extraction

**Status: Fully implemented** in `packages/core/src/parser/queries/typescript.ts`.

Tree-sitter AST walking extracts the following symbol kinds:

| Symbol Kind | What's Captured |
|---|---|
| Function | name, params (names + types + optional?), return type, exported?, async?, line range |
| Class | name, exported?, heritage (extends/implements), line range |
| Method | name, parent class, visibility (public/private/protected), static?, async?, params, returnType, line range |
| Interface | name, exported?, extends list, properties with types, line range |
| TypeAlias | name, exported?, underlying type text (RHS of `=`), line range |
| Enum | name, exported?, member names, line range |
| Variable | name, exported?, annotated type, const?, line range |
| Import | source path, imported names (named/default/namespace), is type-only? |
| Export | local name, exported name, re-export source, direct declaration exports |
| Call site | callee name/expression, arguments count, containing symbol, line |

Arrow functions assigned to `const`/`let` are extracted as `kind: 'function'` with `isConst: true`, including params and returnType.

#### Extraction Interfaces

```typescript
interface ParamInfo {
    name: string
    type?: string
    optional?: boolean
}

interface ExtractedDeclaration {
    id: string                          // `${filePath}#${kind}:${name}:${startLine}`
    kind: 'function' | 'class' | 'method' | 'interface' | 'type_alias' | 'enum' | 'variable'
    name: string
    filePath: string
    startLine: number
    endLine: number
    exported: boolean
    async?: boolean                     // functions/methods — AST-based, not string matching
    parentName?: string                 // methods — parent class name
    params?: ParamInfo[]                // functions/methods — parameter metadata
    returnType?: string                 // functions/methods — return type annotation
    heritage?: {                        // classes — extends/implements
        extends?: string
        implements?: string[]
    }
    visibility?: 'public' | 'private' | 'protected'   // methods
    isStatic?: boolean                  // methods
    interfaceExtends?: string[]         // interfaces — extended interfaces
    properties?: { name: string; type?: string }[]     // interfaces — property signatures
    typeText?: string                   // type aliases — RHS text
    members?: string[]                  // enums — member names
    varType?: string                    // variables — type annotation
    isConst?: boolean                   // variables/arrow functions
}

interface ExtractedImport {
    id: string
    kind: 'import'
    filePath: string
    startLine: number
    endLine: number
    source: string
    defaultImport?: string
    namespaceImport?: string
    namedImports: string[]
    isTypeOnly?: boolean                // `import type { ... }`
}

interface ExtractedExport {
    id: string
    kind: 'export'
    filePath: string
    startLine: number
    endLine: number
    name: string
    exportedName?: string
    source?: string
    isDefault: boolean
    isReExport: boolean
}

interface ExtractedCall {
    id: string
    kind: 'call'
    filePath: string
    startLine: number
    endLine: number
    callee: string
    containingSymbol?: string           // e.g. "ClassName.methodName" or "functionName"
    argumentsCount?: number
}
```

#### Implementation Details

- **AST-based async detection:** Uses `hasUnnamedChild(node, 'async')` instead of string matching, preventing false positives (e.g., a method named `asyncTask` is not detected as async).
- **`containingSymbol` tracking:** The `walkNode` function tracks the current container through class method bodies, so `validate(token)` inside `AuthService.login()` gets `containingSymbol: "AuthService.login"`.
- **Export records for direct declarations:** `export function foo()`, `export class Bar`, `export const X`, `export interface I`, `export enum E`, and `export type T` all generate proper `ExtractedExport` records in addition to their declaration records.
- **Arrow function detection:** `const fn = (x: number): string => { ... }` is extracted as `kind: 'function'` with `isConst: true`, params, and returnType. The walker recurses into arrow function bodies for nested call extraction.

### 3.3 Svelte Extraction

In addition to TypeScript extraction on `<script>` blocks:

| Symbol Kind | What's Captured |
|---|---|
| Component | file path (serves as component name), props, events, slots |
| Props | name, type, default value, required? (from `$props()` or `export let`) |
| Reactive declaration | `$:` statement content, dependencies referenced |
| Store subscription | `$storeName` references → store symbol |
| Event dispatch | `dispatch('eventName')` calls → event names |
| Slot definition | default slot, named slots |
| Component usage | `<ComponentName>` in template → renders edge |
| Prop binding | `prop={value}` on component usage → binds_prop edge |

### 3.4 Prisma Extraction

| Symbol Kind | What's Captured |
|---|---|
| Model | name, fields with types + attributes, `@@` attributes |
| Field | name, type, required?, list?, relation info, `@default`, `@unique` |
| Enum | name, values |
| Relation | field-level `@relation`, implicit many-to-many |
| Index | `@@index`, `@@unique` compound indexes |

### 3.5 Import Resolution

Resolves import source paths to actual files. Handles:

1. **Relative paths** — `./foo` → `./foo.ts`, `./foo/index.ts`
2. **tsconfig `paths`** — `$lib/foo` → `src/lib/foo.ts` (reads `tsconfig.json`)
3. **Barrel files** — `import { x } from './utils'` where `utils/index.ts` re-exports `x` from `utils/helpers.ts` → resolves through to `helpers.ts`
4. **Extension inference** — tries `.ts`, `.js`, `.svelte`, `/index.ts`, `/index.js` in order
5. **Package imports** — `import { z } from 'zod'` → marked as external (not resolved into the graph, but recorded as an external dependency edge)

### 3.6 Call Resolution — Confidence Cascade

When a call site `foo()` is found, the resolver tries to identify the target function:

| Strategy | Confidence | When |
|---|---|---|
| Same-file definition | 1.0 | `foo` is defined in the same file |
| Import-resolved | 0.9 | `foo` is imported and the import resolved to a file where `foo` is exported |
| Re-export chain | 0.8 | Resolved through one or more barrel re-exports |
| Method on known type | 0.85 | `obj.foo()` where `obj`'s type is known and has method `foo` |
| Constructor/`this` resolution | 0.85 | `this.foo()` inside a class → resolves to method `foo` on the same class or parent |
| Fuzzy global match (unique) | 0.5 | One symbol named `foo` exists globally in the project |
| Fuzzy global match (ambiguous) | 0.3 | Multiple symbols named `foo` exist — best guess by proximity |
| Unresolved | 0.0 | Cannot determine target — edge still created but marked unresolved |

All edges carry their confidence score. Analysis and UI can filter by confidence threshold.

#### Constructor and `this`/`self` Resolution

Class method calls through `this` require special handling:

1. **`this.method()` inside a class body** — Resolve `method` against the current class's own methods first, then walk up the `extends` chain. Confidence 0.85 (slightly lower than import-resolved because of dynamic dispatch).
2. **`new ClassName()` → constructor** — Creates a `CALLS` edge from the call site to the class's constructor/class node. If the class is imported, follows the import resolution chain first.
3. **Method calls on `new` expressions** — `new Foo().bar()` → resolve `Foo` via import/symbol table, then resolve `bar` as a method on `Foo`.
4. **Super calls** — `super.method()` → resolve against the parent class in the `extends` chain.

This matters particularly for SvelteKit patterns where classes are less common but service patterns (`new AuthService().validate()`) do appear.

### 3.7 SvelteKit Convention Resolution

Resolves SvelteKit file-based routing conventions:

| Pattern | What It Produces |
|---|---|
| `+page.svelte` + `+page.ts` in same dir | `LOADS_DATA` edge from load function → page component |
| `+page.server.ts` | `LOADS_DATA` edge from server load → page, server-only flag |
| `+layout.svelte` + `+layout.ts` | `INHERITS_LAYOUT` edge from child pages → layout |
| `+server.ts` | `ServerEndpoint` node with HTTP method handlers |
| `+page.ts` calling other functions | Standard `CALLS` edges from the load function |
| Form actions in `+page.server.ts` | `FormAction` nodes with `HANDLES_ACTION` edges |
| Route groups `(group)/` | Captured in node metadata, no special edges |
| Route params `[param]/` | Captured in Route node metadata |

### 3.8 Node Types

```
SHARED (all languages)          SVELTE-SPECIFIC              PRISMA-SPECIFIC
─────────────────────           ──────────────────           ─────────────────
Function                        Component                    PrismaModel
Class                           SvelteStore                  PrismaEnum
Method                          ReactiveDeclaration          PrismaField
Interface                       SlotDefinition
TypeAlias                       EventDispatch
Enum                            SvelteAction
Variable
File
Folder

SVELTEKIT-SPECIFIC
──────────────────
Route                   # +page.svelte / +page.ts pair
ServerEndpoint          # +server.ts
LayoutGroup             # +layout.ts / +layout.svelte
FormAction              # Named form actions
```

### 3.9 Edge Types

```
UNIVERSAL               SVELTE/KIT-SPECIFIC          PRISMA-SPECIFIC
─────────               ──────────────────           ─────────────────
CALLS                   RENDERS                      HAS_FIELD
IMPORTS                 LOADS_DATA                   HAS_RELATION
EXPORTS                 SUBSCRIBES_TO                REFERENCES_MODEL
EXTENDS                 DISPATCHES_EVENT
IMPLEMENTS              BINDS_PROP
HAS_METHOD              INHERITS_LAYOUT
CONTAINS                HANDLES_ACTION
MEMBER_OF
STEP_IN_PROCESS
```

Every edge carries:
- `source: string` — source node ID
- `target: string` — target node ID
- `type: EdgeType`
- `confidence: number` — 0.0 to 1.0
- `metadata: Record<string, unknown>` — edge-type-specific data (e.g., imported names for IMPORTS)

### 3.10 KnowledgeGraph Interface

```typescript
interface KnowledgeGraph {
  // Identity
  repoPath: string
  repoName: string
  indexedAt: string             // ISO timestamp
  lastCommitHash: string | null

  // Graph data
  nodes: Map<string, GraphNode>     // nodeId → node
  edges: Map<string, GraphEdge>     // edgeId → edge
  adjacency: {
    outgoing: Map<string, Set<string>>   // nodeId → set of edgeIds
    incoming: Map<string, Set<string>>   // nodeId → set of edgeIds
  }

  // Indexes (built during construction)
  nodesByFile: Map<string, Set<string>>       // filePath → nodeIds
  nodesByType: Map<NodeType, Set<string>>     // nodeType → nodeIds
  nodesByName: Map<string, Set<string>>       // symbolName → nodeIds (for lookup)

  // Computed (populated by analysis functions)
  communities?: CommunityResult[]
  processes?: ProcessTrace[]
}

interface GraphNode {
  id: string                    // unique: `${filePath}::${name}::${kind}`
  name: string
  type: NodeType
  filePath: string
  lineStart: number
  lineEnd: number
  exported: boolean
  metadata: Record<string, unknown>   // type-specific (params, return type, etc.)
}

interface GraphEdge {
  id: string                    // unique: `${source}-${type}-${target}`
  source: string                // node ID
  target: string                // node ID
  type: EdgeType
  confidence: number
  metadata: Record<string, unknown>
}
```

### 3.11 Serialization

`serializeGraph()` converts the `KnowledgeGraph` to a plain JSON-safe object (Maps become arrays of entries, Sets become arrays). `deserializeGraph()` hydrates it back. This is the format used for storage and transport.

```typescript
interface SerializedGraph {
  version: number               // schema version for forward compatibility
  repoPath: string
  repoName: string
  indexedAt: string
  lastCommitHash: string | null
  nodes: GraphNode[]
  edges: GraphEdge[]
  communities?: CommunityResult[]
  processes?: ProcessTrace[]
}
```

The serialized format is **the universal exchange format**. CLI writes it to JSON files. Dev-Connect stores it in a Postgres `Json` column. The standalone web app uses it however it wants. Every consumer speaks this format.

### 3.12 Analysis: Community Detection

Uses **Louvain algorithm** (via graphology-communities-louvain or similar) on the call/import subgraph.

Output:
```typescript
interface CommunityResult {
  id: string
  label: string                 // Heuristic: most central node name, or common path prefix
  nodeIds: string[]
  cohesionScore: number         // Internal edge density vs. external
  metadata: {
    dominantFilePrefix: string  // e.g., "src/lib/commitHistory"
    dominantNodeTypes: NodeType[]
  }
}
```

### 3.13 Analysis: Process Tracing

Finds **entry points** (SvelteKit load functions, server endpoints, exported API functions) and traces execution via BFS through `CALLS` edges.

Output:
```typescript
interface ProcessTrace {
  id: string
  label: string                 // Derived from entry point name
  entryPoint: string            // node ID
  steps: ProcessStep[]
  crossesCommunities: boolean
  communitiesInvolved: string[] // community IDs
}

interface ProcessStep {
  nodeId: string
  depth: number
  edgeFromPrevious: string | null   // edge ID
  confidence: number                // min confidence along the path to this step
}
```

### 3.14 Analysis: Impact (Blast Radius)

Given a target symbol, traverse upstream (what calls/imports this?) and downstream (what does this call/import?) with configurable depth and confidence threshold.

Output:
```typescript
interface ImpactResult {
  target: string                // node ID
  direction: 'upstream' | 'downstream' | 'both'
  maxDepth: number
  confidenceThreshold: number
  layers: ImpactLayer[]        // grouped by distance from target
}

interface ImpactLayer {
  depth: number
  nodes: { nodeId: string; confidence: number; pathFromTarget: string[] }[]
}
```

### 3.15 Analysis: Change Impact

Maps a git diff (hunks with file paths and line ranges) to graph nodes, then traces the impact.

```typescript
interface ChangeImpact {
  directlyAffected: string[]    // node IDs touched by the diff
  indirectlyAffected: ImpactResult[]  // blast radius from each affected node
  affectedProcesses: string[]   // process IDs that include affected nodes
  affectedCommunities: string[] // community IDs containing affected nodes
}
```

### 3.16 Search

**BM25** keyword search over symbol names, file paths, and optionally source content. Returns ranked results.

**Hybrid search** (v2) will merge BM25 results with embedding-based semantic search using Reciprocal Rank Fusion. Semantic search is a stub for now.

```typescript
interface SearchResult {
  nodeId: string
  score: number
  matchedField: 'name' | 'filePath' | 'content'
  snippet?: string
}
```

---

## 4. Package: `codegraph-ui`

**Purpose:** Svelte component library that renders knowledge graph data. Has no server-side code, no storage code, no fetch calls. All data is passed in via props or Svelte stores. Built with `@sveltejs/package` so it ships as compilable Svelte source.

**Depends on:** `codegraph-core` (for TypeScript types only — `GraphNode`, `GraphEdge`, `KnowledgeGraph`, etc.)

```
packages/ui/
├── package.json                    # "codegraph-ui"
├── svelte.config.js                # @sveltejs/package config
├── tsconfig.json
│
└── src/
    └── lib/
        ├── index.ts                # Barrel export for all components + stores
        │
        ├── components/
        │   ├── graph/
        │   │   ├── GraphCanvas.svelte      # Sigma.js or Cytoscape.js graph renderer
        │   │   ├── GraphControls.svelte     # Zoom, pan, filter, layout toggle
        │   │   ├── NodeTooltip.svelte       # Hover tooltip — symbol name, file, type, line
        │   │   └── CommunityLegend.svelte   # Color-coded cluster legend
        │   │
        │   ├── panels/
        │   │   ├── SymbolDetail.svelte      # 360 view — callers, callees, file, community
        │   │   ├── ProcessTrace.svelte      # Step-by-step execution flow visualization
        │   │   ├── ImpactAnalysis.svelte    # Blast radius tree/graph visualization
        │   │   ├── FileTree.svelte          # Collapsible file tree with symbol counts
        │   │   └── SearchResults.svelte     # Ranked search result list
        │   │
        │   └── shared/
        │       ├── CodeBlock.svelte         # Syntax-highlighted source preview
        │       ├── ConfidenceBadge.svelte   # Visual confidence score indicator
        │       └── Breadcrumb.svelte        # File path breadcrumb navigation
        │
        ├── stores/
        │   ├── graph.ts            # Svelte store wrapping a KnowledgeGraph instance
        │   ├── selection.ts        # Currently selected node/edge/process
        │   ├── filters.ts          # Active view filters (by node type, community, confidence)
        │   └── search.ts           # Search query state + results
        │
        └── graph-adapter.ts        # Converts KnowledgeGraph → Sigma/Cytoscape format
                                    # (node positions, sizes, colors by type/community)
```

### 4.1 Component API Principles

- Every component receives data via **props** (not internal fetches)
- The `graph` store is the primary data source — initialized by the host application
- Components dispatch **events** for user interactions (node click, search submit, etc.)
- Styling uses Tailwind classes with sensible defaults; host app can override via CSS custom properties or wrapper classes
- Components are designed to work both in a full-page layout (standalone web) and embedded in an existing layout (Dev-Connect)

### 4.2 Key Component Props

```svelte
<!-- GraphCanvas: the main visualization -->
<GraphCanvas
  graph={knowledgeGraph}
  communities={communityResults}
  highlightedNodes={impactNodeIds}
  onNodeClick={(nodeId) => ...}
  onEdgeClick={(edgeId) => ...}
  layout="force" | "dagre" | "circular"
  confidenceThreshold={0.5}
/>

<!-- SymbolDetail: selected symbol deep-dive -->
<SymbolDetail
  graph={knowledgeGraph}
  nodeId={selectedNodeId}
  onNavigate={(targetNodeId) => ...}
/>

<!-- ImpactAnalysis: blast radius view -->
<ImpactAnalysis
  impactResult={impactData}
  graph={knowledgeGraph}
  onNodeClick={(nodeId) => ...}
/>

<!-- SearchResults: search result list -->
<SearchResults
  results={searchResults}
  onSelect={(nodeId) => ...}
/>
```

---

## 5. Package: `codegraph-cli`

**Purpose:** Command-line tool for analyzing repos outside of any web context. Stores results as JSON files in `.codegraph/graphs/`. Useful for CI pipelines, personal repos, quick exploration, and feeding data to MCP servers.

**Depends on:** `codegraph-core`

```
packages/cli/
├── package.json                    # "codegraph-cli", bin: { "codegraph": "./dist/index.js" }
├── tsconfig.json
│
└── src/
    ├── index.ts                    # Commander.js entry point
    ├── commands/
    │   ├── analyze.ts              # codegraph analyze [path]
    │   │                           #   Runs buildGraph() → serializeGraph() → write JSON
    │   ├── status.ts               # codegraph status [path]
    │   │                           #   Shows index state, staleness, node/edge counts
    │   ├── query.ts                # codegraph query <search-term>
    │   │                           #   Loads graph → searchSymbols() → prints results
    │   ├── impact.ts               # codegraph impact <symbol-name> [--direction] [--depth]
    │   │                           #   Loads graph → analyzeImpact() → prints blast radius
    │   └── clean.ts                # codegraph clean [path]
    │                               #   Deletes stored graph data for a repo
    └── util/
        └── progress.ts             # Terminal progress bar (cli-progress)
```

### 5.1 Storage Location

CLI stores data in `.codegraph/` at the repo root (gitignored):

```
target-repo/
├── .codegraph/
│   └── graphs/
│       └── graph.json              # SerializedGraph for this repo
├── src/
│   └── ...
└── package.json
```

Or, if analyzing external repos, in a global location: `~/.codegraph/graphs/{repo-name}.json`

---

## 6. Package: `codegraph-web` (Standalone App)

**Purpose:** Standalone SvelteKit web application for exploring code graphs. Intended for use outside of Dev-Connect — personal repos, open-source projects, teams that don't use Dev-Connect.

**Depends on:** `codegraph-core`, `codegraph-ui`

**NOT published as an npm package.** This is an application, not a library.

```
packages/web/
├── package.json                    # Private, depends on codegraph-core + codegraph-ui
├── svelte.config.js
├── vite.config.ts
├── tailwind.config.ts
│
├── src/
│   ├── app.html
│   ├── app.css
│   │
│   ├── lib/
│   │   └── server/
│   │       └── storage.ts          # Reads/writes graph JSON files (filesystem-based)
│   │
│   └── routes/
│       ├── +layout.svelte          # App shell — standalone nav + sidebar
│       ├── +page.svelte            # Home — list indexed repos, trigger analysis
│       ├── api/
│       │   ├── analyze/
│       │   │   └── +server.ts      # POST — triggers buildGraph() for a repo path
│       │   ├── graph/
│       │   │   └── [repo]/
│       │   │       └── +server.ts  # GET — returns serialized graph
│       │   ├── search/
│       │   │   └── +server.ts      # GET ?q= — hybrid search
│       │   ├── impact/
│       │   │   └── +server.ts      # GET ?target=&direction= — blast radius
│       │   └── changes/
│       │       └── +server.ts      # GET ?repo= — git diff impact
│       └── repo/
│           └── [name]/
│               ├── +page.svelte    # Graph explorer (imports from codegraph-ui)
│               └── +page.server.ts # Loads graph from storage, passes to page
│
└── static/
    └── favicon.svg
```

The standalone web app reads from the same `.codegraph/graphs/` JSON files that the CLI writes. It can also trigger analysis directly via its API routes.

---

## 7. Data Storage Strategy

### Design principle

**`codegraph-core` has no storage opinion.** It builds graphs in memory and provides serialization to/from plain JSON objects. Where that data gets persisted is entirely the consumer's decision.

### Per-consumer storage

| Consumer | Storage Mechanism | Details |
|---|---|---|
| **CLI** | JSON files on filesystem | `.codegraph/graphs/{repo}.json` |
| **Standalone web** | JSON files (same as CLI) | Reads/writes via server-side `fs` in SvelteKit |
| **Dev-Connect** | PostgreSQL via Prisma | `Json` column in a `CodeGraph` table |
| **MCP server (v2)** | Reads from CLI output or web API | Depends on deployment model |

### Dev-Connect Prisma model

```prisma
model CodeGraph {
  id             Int      @id @default(autoincrement())
  repoName       String   @unique
  repoPath       String
  graphData      Json                         // SerializedGraph object
  nodeCount      Int      @default(0)         // denormalized for quick display
  edgeCount      Int      @default(0)         // denormalized for quick display
  lastCommitHash String?
  indexedAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  // Optional FK to Dev-Connect's System entity
  systemId       Int?
  system         System?  @relation(fields: [systemId], references: [id], onDelete: SetNull)
}
```

This stores the entire serialized graph as a JSON blob. On load, the server-side code calls `deserializeGraph()` to hydrate it, then passes it to the UI components. For typical team-sized projects, the serialized graph will be ~1-20MB, well within Postgres JSON column limits.

### Future evolution

If the graph gets too large for a single JSON blob (massive monorepos), the storage strategy can evolve to:
1. **Storage adapter interface** in core — `save(graph)`, `load(repoId)`, `list()`
2. **Relational storage** — symbols and edges as individual rows, queryable with SQL
3. **Incremental updates** — only re-index changed files, update affected nodes/edges

This evolution is deferred until real usage reveals the need. The serialization format (`SerializedGraph`) provides a clean migration path — the same data can be decomposed into rows later.

---

## 8. Dev-Connect Integration

### Route structure

```
dev-connect/src/routes/codegraph/
├── +page.svelte                    # List indexed repos, trigger analysis
├── +page.server.ts                 # Load repo list from CodeGraph Prisma model
└── [repo]/
    ├── +page.svelte                # Graph explorer (imports from codegraph-ui)
    └── +page.server.ts             # Load + deserialize graph, pass to page
```

### Example: repo explorer page

```svelte
<!-- src/routes/codegraph/[repo]/+page.svelte -->
<script>
  import { GraphCanvas, SymbolDetail, SearchResults, ImpactAnalysis } from 'codegraph-ui';
  import { searchSymbols, analyzeImpact } from 'codegraph-core';

  let { data } = $props();
  let selectedNodeId = $state(null);
  let searchQuery = $state('');
  let searchResults = $derived(
    searchQuery ? searchSymbols(data.graph, searchQuery) : []
  );
</script>

<div class="flex h-full">
  <aside class="w-80 border-r">
    <SearchResults results={searchResults} onSelect={(id) => selectedNodeId = id} />
    {#if selectedNodeId}
      <SymbolDetail graph={data.graph} nodeId={selectedNodeId} />
    {/if}
  </aside>
  <main class="flex-1">
    <GraphCanvas graph={data.graph} communities={data.communities} />
  </main>
</div>
```

```typescript
// src/routes/codegraph/[repo]/+page.server.ts
import { deserializeGraph, detectCommunities } from 'codegraph-core';
import { prisma } from '$lib/prisma';

export async function load({ params }) {
  const record = await prisma.codeGraph.findUnique({
    where: { repoName: params.repo }
  });
  if (!record) throw error(404, 'Repo not indexed');

  const graph = deserializeGraph(record.graphData);
  const communities = detectCommunities(graph);

  return { graph, communities, repoName: record.repoName };
}
```

### What Dev-Connect provides (that CodeGraph does NOT)

- Authentication and authorization (Dev-Connect's existing session/user system)
- Layout shell (existing sidebar navigation, header, theme)
- Trigger mechanism for indexing (could be a button on the System detail page that calls `buildGraph()` using the system's `repositoryUrl`)
- Association between CodeGraph repos and Dev-Connect System entities

### What CodeGraph provides (that Dev-Connect does NOT need to build)

- All parsing, graph construction, and analysis logic (via `codegraph-core`)
- All visualization components (via `codegraph-ui`)
- The `SerializedGraph` format for storage

---

## 9. MCP Integration (v2)

Future phase. An MCP server that exposes CodeGraph data to AI tools (Claude Code, Cursor).

Reference implementation: **GitNexus** (github.com/abhigyanpatwari/GitNexus) ships a mature MCP integration with 7 tools. Our tool set is modeled after theirs, adapted for our SvelteKit/Prisma focus.

```
packages/mcp/                       # "codegraph-mcp" (future package)
├── package.json
└── src/
    ├── index.ts                    # MCP server (stdio transport)
    └── tools/
        ├── list-repos.ts           # List all indexed repos with metadata
        ├── query.ts                # Hybrid search (BM25 + semantic + RRF ranking)
        ├── context.ts              # 360 symbol view — callers, callees, community, file
        ├── impact.ts               # Blast radius with depth grouping + confidence
        ├── changes.ts              # Git diff → affected symbols → affected processes
        ├── rename.ts               # Coordinated multi-file rename with validation
        └── cypher.ts               # Raw graph query (if we add a query language — stretch)
```

### 9.1 MCP Tool Definitions

| Tool | Input | Output | Purpose |
|---|---|---|---|
| `list_repos` | none | Array of `{ name, path, nodeCount, edgeCount, indexedAt }` | Discover what's indexed |
| `query` | `{ q: string, repo?: string, limit?: number }` | Ranked `SearchResult[]` | Find symbols by name/content |
| `context` | `{ symbol: string, repo: string }` | Node + incoming/outgoing edges, community, processes | 360-degree view of a symbol for AI context |
| `impact` | `{ target: string, repo: string, direction?, depth?, threshold? }` | `ImpactResult` | Blast radius before making a change |
| `detect_changes` | `{ repo: string, diff?: string }` | `ChangeImpact` | Map a git diff to affected symbols/processes |
| `rename` | `{ symbol: string, newName: string, repo: string, dryRun?: boolean }` | List of file edits + validation | Safe multi-file rename with dependency awareness |

### 9.2 MCP Deployment

The MCP server loads graph data from `.codegraph/graphs/` JSON files (same as CLI output). A single server instance can serve multiple repos via a global registry (`~/.codegraph/registry.json`).

**Editor integration:**
- **Claude Code:** MCP config in `.claude/mcp.json` + optional skills in `.claude/skills/`
- **Cursor:** MCP config in global `~/.cursor/mcp.json`
- **Other editors:** Any MCP-compatible editor via stdio transport

The MCP server is stateless per-request — it loads the graph from disk, answers the query, done. Lazy connection pooling can optimize repeated queries to the same repo.

---

## 10. Build Phases

### Phase 1 — Parse + Extract (weeks 1-3) **COMPLETE**

- ~~Filesystem walker with ignore patterns~~
- ~~Tree-sitter TypeScript/JavaScript parser + queries~~
- ~~Symbol extraction (functions, classes, methods, interfaces, type aliases, enums, variables, imports, calls, exports)~~
- ~~Unit tests against fixture repos (39 tests passing)~~
- **Milestone:** ~~"Here are all symbols in a given project"~~

**Implemented files:**
- `config/languages.ts` — language registry
- `config/ignore.ts` — comprehensive ignore patterns (directories, extensions, files)
- `walker/filesystem.ts` — recursive repo scanner
- `parser/tree-sitter.ts` — tree-sitter initialization and parsing
- `parser/extract.ts` — extraction coordinator
- `parser/queries/typescript.ts` — full TypeScript extraction with all symbol kinds and metadata

### Phase 2 — Resolve + Graph (weeks 3-6)

- Symbol table (global registry)
- Import resolution (tsconfig paths, $lib, barrel files)
- Call resolution with confidence cascade
- In-memory KnowledgeGraph construction
- Serialization / deserialization
- CLI `analyze` and `status` commands
- **Milestone:** "Here is a dependency graph of a codebase, saved to JSON"

### Phase 3 — Svelte + Prisma (weeks 5-8, overlaps Phase 2)

- Svelte component extraction (props, events, stores, template usage)
- SvelteKit convention resolver (+page, +server, +layout)
- Prisma schema parser (models, relations, enums)
- Prisma → TypeScript client mapping
- **Milestone:** "Here is how data flows from Prisma to the page"

### Phase 4 — Analysis (weeks 7-10)

- Community detection (Louvain via graphology)
- Process tracing (entry point BFS, dedup, labeling)
- Impact analysis (blast radius with depth + confidence)
- Git diff → affected symbols → affected processes
- CLI `impact` command
- **Milestone:** "Here are the functional clusters and execution flows"

### Phase 5 — UI Components + Standalone Web (weeks 8-12, overlaps Phase 4)

- `codegraph-ui` package setup with `@sveltejs/package`
- GraphCanvas (Sigma.js or Cytoscape.js)
- SymbolDetail, ProcessTrace, ImpactAnalysis panels
- Search interface (BM25)
- Standalone web app shell
- **Milestone:** "Interactive graph explorer running locally"

### Phase 6 — Dev-Connect Integration (weeks 11-13)

- Add `codegraph-core` and `codegraph-ui` as dependencies to Dev-Connect
- Add `CodeGraph` Prisma model, run migration
- Create `/codegraph` routes in Dev-Connect
- Wire up indexing trigger (from System entity or standalone page)
- **Milestone:** "Graph explorer accessible inside Dev-Connect alongside existing tools"

### Phase 7 — MCP Server (v2, future)

- MCP server package
- Tool definitions (query, context, impact, changes)
- Claude Code / Cursor configuration
- **Milestone:** "AI assistants have deep architectural awareness"

---

## 11. Reference: GitNexus

**GitNexus** (github.com/abhigyanpatwari/GitNexus) is an open-source project that solves the same problem — AST-level codebase knowledge graphs with MCP integration. It was the inspiration for CodeGraph and serves as a reference implementation.

### What GitNexus does that we adopt

| Concept | GitNexus Approach | CodeGraph Approach |
|---|---|---|
| AST parsing | Tree-sitter for 12+ languages | Tree-sitter for TS/Svelte/Prisma (deep, not wide) |
| Community detection | Leiden algorithm | Louvain (same algorithmic family) |
| Search | BM25 + semantic + RRF ranking | Same pipeline (BM25 first, semantic in v2) |
| Blast radius | Depth-grouped + confidence scores | Same approach |
| Process tracing | Entry point → BFS call chains | Same approach |
| MCP tools | 7 tools (list, query, context, impact, changes, rename, cypher) | Same tool set (see Section 9) |
| Confidence scoring | All edges carry confidence | Same approach |
| Constructor/this resolution | Infers types from constructors, resolves `this`/`self` | Same (see Section 3.6) |

### Where CodeGraph diverges

| Area | GitNexus | CodeGraph | Why |
|---|---|---|---|
| Language depth | Broad (12+ languages, shallow) | Deep (3 languages: TS, Svelte, Prisma) | Our team uses one stack — depth beats breadth |
| SvelteKit awareness | None | Full (+page/+server/+layout data flow, form actions, route params) | Core value proposition for our stack |
| Svelte component tracking | None | Props, events, stores, slot definitions, component rendering edges | Same |
| Prisma awareness | None | Model→client mapping, relation resolution, field extraction | Same |
| Storage | LadybugDB (graph database) | In-memory + JSON serialization (consumer stores however it wants) | Simpler, no DB dependency in core |
| Web UI | React + WASM (browser-only) | SvelteKit + Svelte components (server-rendered, embeddable) | Must integrate into Dev-Connect (SvelteKit) |
| Integration model | Standalone only | Publishable packages that any SvelteKit app can import | Must work both standalone and embedded |
| Web UI packaging | Monolithic React app | Separate `codegraph-ui` Svelte component library | Enables embedding in Dev-Connect without duplication |

### Key learnings from GitNexus to apply

1. **Precomputed intelligence is the key insight.** GitNexus's pitch: "smaller models become competitive because the graph does the heavy architectural lifting." This is exactly right — the MCP tools should return complete, pre-analyzed context in a single query, not require the AI to make multiple exploratory calls.

2. **The rename tool is valuable.** GitNexus's `rename` tool does coordinated multi-file renames with validation. Worth including in our MCP tool set — it's a concrete demonstration of the graph's value.

3. **Registry pattern works.** GitNexus uses `~/.gitnexus/registry.json` to track all indexed repos globally. We should adopt this for CLI/MCP: `~/.codegraph/registry.json`.

4. **Cypher-like querying is a stretch goal.** GitNexus includes raw Cypher queries over LadybugDB. Useful for power users but not essential for v1. Our in-memory graph can support a simpler query API first.

---

## 12. Technology Choices

| Concern | Choice | Rationale |
|---|---|---|
| AST parsing | tree-sitter (via `web-tree-sitter` or `node-tree-sitter`) | Battle-tested, supports TS/JS/Svelte/Prisma grammars, fast |
| Monorepo management | npm workspaces + Turborepo | Standard tooling, parallel builds, no extra dependencies |
| Graph algorithms | graphology | Lightweight JS graph library with community detection plugins |
| Graph visualization | Sigma.js or Cytoscape.js | TBD — Sigma is faster for large graphs, Cytoscape has better layout algorithms |
| Svelte component packaging | `@sveltejs/package` | Official Svelte tool for building component libraries |
| TypeScript config parsing | Custom (read + parse `tsconfig.json`) | Lightweight, only need `paths` and `baseUrl` |
| CLI framework | Commander.js | Standard, lightweight |
| Testing | Vitest | Already used in Dev-Connect ecosystem, fast |
| Styling (UI components) | Tailwind CSS | Already used in Dev-Connect; UI components use Tailwind classes |

---

## 13. Open Questions

These do not block Phase 1-2 work but should be decided before the relevant phases:

1. **Sigma.js vs. Cytoscape.js** — need to prototype both with a real graph to decide (Phase 5)
2. **Semantic search embeddings** — which model, where to run them, worth the complexity? (v2)
3. **Incremental indexing** — re-index only changed files via git diff, or full re-index each time? (can defer, full re-index is fine for typical project sizes)
4. **Svelte 5 vs Svelte 4 in UI components** — Dev-Connect uses Svelte 5 (`$props()`, `$state()`), so UI components should target Svelte 5 as well
5. **Graph data size limits** — at what point does the JSON blob approach need to evolve? Benchmark with largest team repo to validate

---

## 14. Glossary

| Term | Definition |
|---|---|
| **Symbol** | Any named code entity: function, class, component, model, variable, type, etc. |
| **Node** | A symbol represented as a vertex in the knowledge graph |
| **Edge** | A relationship between two nodes (call, import, render, etc.) |
| **Community** | A cluster of tightly-connected nodes detected by the Louvain algorithm |
| **Process** | An execution flow traced from an entry point through call chains |
| **Blast radius** | The set of nodes transitively affected by a change to a given node |
| **Confidence** | A 0.0-1.0 score indicating how certain the resolver is about an edge |
| **SerializedGraph** | The JSON-safe plain-object representation of a KnowledgeGraph |
| **Consumer** | Any application that imports codegraph-core/codegraph-ui (Dev-Connect, standalone web, etc.) |

---

## 15. Repo Restructuring Prompt

> **Context:** This section is a one-time instruction set for restructuring the existing codegraph repo to match this spec. It is intended to be read by an AI coding assistant (Claude Code) at the start of a new session. Once the restructuring is complete, this section can be deleted.

### Current state of the repo

The repo has the correct monorepo skeleton (core/cli/web packages) with mostly empty files. Here's what actually has code:

**Files with real implementation (KEEP these):**
- `packages/core/src/config/languages.ts` (25 lines) — maps file extensions to supported languages. Working code.
- `packages/core/src/config/ignore.ts` (226 lines) — comprehensive ignore pattern system with built-in defaults, extension filtering, and directory exclusions. Working code.
- `packages/core/src/walker/filesystem.ts` — repo scanner, scans directories respecting ignore patterns. Working code.
- `packages/core/src/parser/tree-sitter.ts` — tree-sitter parser initialization and caching. Working code.
- `packages/core/src/parser/extract.ts` — extraction coordinator routing files to language-specific extractors. Working code.
- `packages/core/src/parser/queries/typescript.ts` (~500 lines) — full TypeScript/JavaScript extraction: functions, classes, methods, interfaces, type aliases, enums, variables, imports, exports, calls with complete metadata. Working code.
- `packages/core/src/index.ts` — barrel export for all public types and functions. Working code.
- `test/fixtures/sveltekit-app/` — test fixture directory structure (files exist).
- `test/fixtures/ts-library/` — test fixture with auth/, models/ directories (5 source files). Working fixtures with comprehensive coverage of all symbol kinds.

**Root config files (KEEP, may need minor edits):**
- `package.json` — npm workspaces config, scripts. Correct.
- `tsconfig.base.json` — shared TS config. Correct.
- `turbo.json` — Turborepo config. Correct.
- `.gitignore` — Correct. Ensure `.codegraph/` is listed.

**Package configs (KEEP, need edits noted below):**
- `packages/core/package.json` — Mostly correct. MUST remove `@prisma/client` and `prisma` from all dependency sections.
- `packages/cli/package.json` — Correct as-is.
- `packages/web/package.json` — Needs `codegraph-ui` added as a workspace dependency.

**Files/directories to REMOVE:**
- `packages/core/prisma/` — entire directory. Core must have no database dependency.
- `packages/core/generated/` — Prisma generated client artifacts.
- `packages/core/src/storage/` — entire directory (`prisma-adapter.ts`, `repo-registry.ts`). Storage is the consumer's concern, not core's.
- `packages/web/src/lib/components/` — entire directory. All UI components now live in `packages/ui/`.
- `packages/web/src/lib/stores/` — entire directory. All stores now live in `packages/ui/`.
- `packages/web/src/lib/graph-adapter.ts` — now lives in `packages/ui/`.
- `packages/web/src/lib/server/db.ts` — was for database access, replaced by `storage.ts`.
- Root `index.ts` — empty, not needed.
- `proj_plan.md` — superseded by this spec document.

**Do NOT remove `bun.lock`** — the project may use bun as its package manager. Check what's configured and keep the appropriate lock file.

### Restructuring steps

**Step 1 — Clean up core package:**
- Delete `packages/core/prisma/` directory entirely.
- Delete `packages/core/generated/` directory entirely.
- Delete `packages/core/src/storage/` directory entirely.
- Edit `packages/core/package.json`: remove `@prisma/client` and `prisma` from dependencies and devDependencies. Remove any `db:generate` or `db:migrate` scripts.
- Keep ALL empty source files in `packages/core/src/` — they match the spec exactly and will be implemented in phase order.
- Keep `languages.ts`, `ignore.ts`, and `filesystem.ts` as-is (the only files with real code).
- Ensure `packages/core/src/index.ts` exists (barrel export, currently empty).

**Step 2 — Create the `codegraph-ui` package (NEW):**

Create `packages/ui/` with this structure:

```
packages/ui/
├── package.json
├── svelte.config.js
├── tsconfig.json
└── src/
    └── lib/
        ├── index.ts
        ├── components/
        │   ├── graph/
        │   │   ├── GraphCanvas.svelte
        │   │   ├── GraphControls.svelte
        │   │   ├── NodeTooltip.svelte
        │   │   └── CommunityLegend.svelte
        │   ├── panels/
        │   │   ├── SymbolDetail.svelte
        │   │   ├── ProcessTrace.svelte
        │   │   ├── ImpactAnalysis.svelte
        │   │   ├── FileTree.svelte
        │   │   └── SearchResults.svelte
        │   └── shared/
        │       ├── CodeBlock.svelte
        │       ├── ConfidenceBadge.svelte
        │       └── Breadcrumb.svelte
        ├── stores/
        │   ├── graph.ts
        │   ├── selection.ts
        │   ├── filters.ts
        │   └── search.ts
        └── graph-adapter.ts
```

`packages/ui/package.json` should:
- Set `"name": "codegraph-ui"` and `"type": "module"`
- List `codegraph-core` as a workspace dependency (`"codegraph-core": "workspace:*"` or `"*"`)
- List `svelte` as a **peerDependency** (not a direct dependency), version `^5.0.0`
- Include `@sveltejs/package` as a devDependency
- Include a `"build"` script: `"svelte-package -i src/lib"`
- Configure `"svelte"`, `"types"`, and `"exports"` fields per `@sveltejs/package` conventions:
  ```json
  "svelte": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "svelte": "./dist/index.js"
    }
  }
  ```

`packages/ui/svelte.config.js` — minimal config, just enough for `@sveltejs/package`.

All `.svelte` and `.ts` files start empty — they will be implemented in Phase 5. Creating them now establishes the structure.

**Step 3 — Clean up and update the web package:**
- Delete `packages/web/src/lib/components/` entirely (components now come from `codegraph-ui`).
- Delete `packages/web/src/lib/stores/` entirely (stores now live in `codegraph-ui`).
- Delete `packages/web/src/lib/graph-adapter.ts` (now lives in `codegraph-ui`).
- Delete `packages/web/src/lib/server/db.ts` (was for database access).
- Create `packages/web/src/lib/server/storage.ts` (empty — will hold filesystem-based JSON graph storage).
- Edit `packages/web/package.json`: add `"codegraph-ui": "workspace:*"` alongside the existing `codegraph-core` dependency.
- The web package's `src/lib/` should now only contain `server/storage.ts`.
- Routes stay as-is (they'll import from `codegraph-ui` and `codegraph-core`).

**Step 4 — Clean up root:**
- Delete root `index.ts` if it exists and is empty.
- Delete `proj_plan.md` if it still exists.
- Verify `package.json` workspaces field includes `"packages/*"`.
- Remove any `db:generate` or `db:migrate` scripts from root `package.json`.
- Ensure `.codegraph/` is in `.gitignore`.

**Step 5 — Verify CLI package:**
- `packages/cli/package.json` should depend on `codegraph-core` (workspace) only. No `codegraph-ui` dependency.
- All empty stub files stay as-is — they match the spec.

**Step 6 — Place this spec document:**
- This file (`codegraph-spec.md`) should be in the repo root as the single source of truth.

### Target structure after restructuring

```
codegraph/
├── package.json                    # Workspaces: packages/*
├── tsconfig.base.json
├── turbo.json
├── .gitignore                      # Includes .codegraph/
├── codegraph-spec.md               # THIS DOCUMENT
│
├── packages/
│   ├── core/                       # "codegraph-core" — pure TS, NO Prisma, NO storage
│   │   ├── package.json            # NO @prisma/client, NO prisma
│   │   ├── tsconfig.json
│   │   ├── vitest.config.ts
│   │   └── src/
│   │       ├── index.ts               ← IMPLEMENTED (barrel exports)
│   │       ├── config/
│   │       │   ├── languages.ts        ← IMPLEMENTED (25 lines)
│   │       │   └── ignore.ts           ← IMPLEMENTED (226 lines)
│   │       ├── walker/
│   │       │   └── filesystem.ts       ← IMPLEMENTED
│   │       ├── parser/
│   │       │   ├── tree-sitter.ts      ← IMPLEMENTED
│   │       │   ├── extract.ts          ← IMPLEMENTED
│   │       │   └── queries/
│   │       │       ├── typescript.ts   ← IMPLEMENTED (~500 lines, all symbol kinds)
│   │       │       ├── svelte.ts       ← empty
│   │       │       └── prisma.ts       ← empty
│   │       ├── resolution/
│   │       │   ├── symbol-table.ts     ← empty
│   │       │   ├── import-resolver.ts  ← empty
│   │       │   ├── call-resolver.ts    ← empty
│   │       │   ├── heritage-resolver.ts ← empty
│   │       │   ├── svelte-resolver.ts  ← empty
│   │       │   ├── prisma-resolver.ts  ← empty
│   │       │   ├── sveltekit-resolver.ts ← empty
│   │       │   └── tsconfig-loader.ts  ← empty
│   │       ├── graph/
│   │       │   ├── types.ts            ← empty
│   │       │   ├── knowledge-graph.ts  ← empty
│   │       │   └── builder.ts          ← empty
│   │       ├── analysis/
│   │       │   ├── community.ts        ← empty
│   │       │   ├── process.ts          ← empty
│   │       │   ├── impact.ts           ← empty
│   │       │   └── changes.ts          ← empty
│   │       └── search/
│   │           ├── bm25.ts             ← empty
│   │           ├── hybrid.ts           ← empty
│   │           └── semantic.ts         ← empty
│   │
│   ├── ui/                         # "codegraph-ui" — NEW PACKAGE
│   │   ├── package.json            # Svelte peer dep, @sveltejs/package, codegraph-core workspace dep
│   │   ├── svelte.config.js
│   │   ├── tsconfig.json
│   │   └── src/
│   │       └── lib/
│   │           ├── index.ts            ← empty barrel export
│   │           ├── components/
│   │           │   ├── graph/
│   │           │   │   ├── GraphCanvas.svelte      ← empty
│   │           │   │   ├── GraphControls.svelte     ← empty
│   │           │   │   ├── NodeTooltip.svelte       ← empty
│   │           │   │   └── CommunityLegend.svelte   ← empty
│   │           │   ├── panels/
│   │           │   │   ├── SymbolDetail.svelte      ← empty
│   │           │   │   ├── ProcessTrace.svelte      ← empty
│   │           │   │   ├── ImpactAnalysis.svelte    ← empty
│   │           │   │   ├── FileTree.svelte          ← empty
│   │           │   │   └── SearchResults.svelte     ← empty
│   │           │   └── shared/
│   │           │       ├── CodeBlock.svelte         ← empty
│   │           │       ├── ConfidenceBadge.svelte   ← empty
│   │           │       └── Breadcrumb.svelte        ← empty
│   │           ├── stores/
│   │           │   ├── graph.ts        ← empty
│   │           │   ├── selection.ts    ← empty
│   │           │   ├── filters.ts      ← empty
│   │           │   └── search.ts       ← empty
│   │           └── graph-adapter.ts    ← empty
│   │
│   ├── cli/                        # "codegraph-cli" — unchanged
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── commands/
│   │       │   ├── analyze.ts
│   │       │   ├── status.ts
│   │       │   ├── query.ts
│   │       │   ├── impact.ts
│   │       │   └── clean.ts
│   │       └── util/
│   │           └── progress.ts
│   │
│   └── web/                        # Standalone SvelteKit app — cleaned up
│       ├── package.json            # Now depends on codegraph-core + codegraph-ui
│       ├── svelte.config.js
│       ├── vite.config.ts
│       └── src/
│           ├── app.html
│           ├── app.css
│           ├── lib/
│           │   └── server/
│           │       └── storage.ts  ← NEW (empty — filesystem JSON storage)
│           └── routes/
│               ├── +layout.svelte
│               ├── +page.svelte
│               ├── api/
│               │   ├── analyze/+server.ts
│               │   ├── graph/[repo]/+server.ts
│               │   ├── search/+server.ts
│               │   ├── impact/+server.ts
│               │   └── changes/+server.ts
│               └── repo/[name]/
│                   ├── +page.svelte
│                   └── +page.server.ts
│
├── test/
│   └── fixtures/
│       ├── sveltekit-app/          # Keep existing fixture files
│       └── ts-library/             # TS fixture with auth/ + models/ directories
│           ├── src/auth/service.ts      # Class, methods w/ visibility/static/async
│           ├── src/auth/validate.ts     # Exported function
│           ├── src/models/types.ts      # Interfaces, types, enums, vars, arrow fns
│           ├── src/models/index.ts      # Re-exports
│           └── src/index.ts             # Barrel exports, export const
│
└── .codegraph/                     # gitignored, local data
    └── graphs/
```

### What NOT to do during restructuring

- **Do NOT delete any file that has real code** — Phase 1 is fully implemented with working extraction, parsing, and tests. Preserve all implemented files.
- **Do NOT run `npm install` or `bun install`** — just set up the file structure and package.json files. Dependencies will be installed when development begins.
- **Do NOT create `packages/mcp/`** — that's Phase 7, far in the future.
- **Do NOT add Prisma to any package** — storage is the consumer's concern, not CodeGraph's.
- **Do NOT create a CLAUDE.md yet** — that can be set up once the restructuring is verified and Phase 1 work begins.

