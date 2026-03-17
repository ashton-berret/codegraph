# CodeGraph — Implementation Progress

> Companion to `codegraph.spec.md`. Tracks per-phase implementation details, decisions, and status.
> The spec defines *what* we're building. This file tracks *how* and *where we are*.
> IT IS INCREDIBLY IMPORTANT YOU DO THIS. WHENEVER YOU GENERATE CODE, IT SHOULD NOT BE PUT ON THE ACTUAL FILE (unless specified). INSTEAD, IT SHOULD BE PLACED INTO A {phase}.md FILE SO THAT I CAN REVIEW IT MANUALLY AND IMPLEMENT BY HAND.
>> The file should include comments, line numbers, etc...essentially the complete implementation, just in a markdown file

---

## Phase 1 — Parse + Extract ✅ COMPLETE

**Completed:** 2026-03-17

### What was built
- Filesystem walker (`walker/filesystem.ts`) — recursive directory scanner with ignore pattern support
- Tree-sitter parser (`parser/tree-sitter.ts`) — parser initialization, caching, language routing
- Extraction coordinator (`parser/extract.ts`) — routes files to language-specific extractors
- TypeScript extractor (`parser/queries/typescript.ts`, ~500 lines) — full AST-based extraction

### Symbol kinds extracted
Function, Class, Method, Interface, TypeAlias, Enum, Variable, Import, Export, Call

### Key metadata captured
- Function/Method: params (name + type + optional), returnType, async (AST-based)
- Class: heritage (extends + implements)
- Method: visibility (public/private/protected), isStatic
- Interface: extends list, property signatures
- TypeAlias: typeText (RHS)
- Enum: member names
- Variable: varType, isConst
- Import: isTypeOnly
- Export: direct declaration exports (not just `export { }` syntax)
- Call: argumentsCount, containingSymbol (tracks through class method bodies)
- Arrow functions: detected as kind='function' with isConst=true

### Test coverage
39 tests across unit (inline snippets) and integration (fixture repo) covering all symbol kinds and metadata fields.

### Fixture repo
`test/fixtures/ts-library/` — 5 source files:
- `src/auth/service.ts` — class with visibility, static, async, type-only import
- `src/auth/validate.ts` — exported function with params + returnType
- `src/models/types.ts` — interfaces, type aliases, enums, variables, arrow functions
- `src/models/index.ts` — re-exports and type-only re-exports
- `src/index.ts` — barrel exports, export const

---

## Phase 2 — Resolve + Graph 🔲 NOT STARTED

**Goal:** Take the flat extracted symbols from Phase 1 and connect them — resolve imports to actual files, resolve calls to actual functions, build a proper graph with nodes and edges.

**Milestone:** "Here is a dependency graph of a codebase, saved to JSON"

### What Phase 1 gives us (inputs)

Per file, we have arrays of `ExtractedDeclaration`, `ExtractedImport`, `ExtractedExport`, `ExtractedCall`. These are flat — they know their own file but have no cross-file connections. An import says `source: './validate'` but doesn't know the resolved file path. A call says `callee: 'validate'` but doesn't know which function it targets.

### What Phase 2 produces (outputs)

A `KnowledgeGraph` with:
- Every symbol as a `GraphNode` (typed, with metadata)
- Every relationship as a `GraphEdge` (typed, with confidence score)
- Adjacency indexes for fast traversal
- Serializable to/from JSON

### Files to implement

All files exist as empty stubs. Implementation order matters — each layer builds on the previous.

```
resolution/
├── tsconfig-loader.ts      # Step 1 — reads tsconfig.json for path aliases
├── symbol-table.ts         # Step 2 — global symbol registry
├── import-resolver.ts      # Step 3 — resolves import paths to files
├── call-resolver.ts        # Step 4 — resolves calls to target symbols
├── heritage-resolver.ts    # Step 5 — resolves extends/implements chains

graph/
├── types.ts                # Step 6 — NodeType, EdgeType enums + GraphNode/GraphEdge interfaces
├── knowledge-graph.ts      # Step 7 — in-memory graph data structure
├── builder.ts              # Step 8 — orchestrator: extract → resolve → graph
```

### Step 1: tsconfig-loader.ts

**Purpose:** Parse `tsconfig.json` to extract path aliases (`paths` and `baseUrl`) so the import resolver can map `$lib/foo` → `src/lib/foo`.

**Interface:**
```typescript
interface TsconfigPaths {
    baseUrl: string                       // e.g. "." or "src"
    paths: Record<string, string[]>       // e.g. { "$lib/*": ["src/lib/*"] }
}

function loadTsconfigPaths(repoPath: string): Promise<TsconfigPaths | null>
```

**Behavior:**
- Look for `tsconfig.json` at repo root
- Parse as JSON (handle comments via strip-json-comments or regex)
- Extract `compilerOptions.baseUrl` and `compilerOptions.paths`
- If `extends` is present, follow the chain (but don't go into node_modules)
- Return null if no tsconfig or no relevant fields
- Cache per repo path

**Test cases:**
- tsconfig with paths → extracts correctly
- tsconfig with baseUrl only → works
- tsconfig with extends → follows chain
- No tsconfig → returns null
- tsconfig with comments (JSONC) → handles gracefully

### Step 2: symbol-table.ts

**Purpose:** Global registry of every symbol in the project. Allows O(1) lookup by name, by file, by kind. This is the foundation all resolvers use.

**Interface:**
```typescript
interface SymbolEntry {
    declaration: ExtractedDeclaration
    filePath: string
    exports: ExtractedExport[]           // export records associated with this symbol
}

class SymbolTable {
    // Build from extraction results
    static build(files: ExtractedFile[]): SymbolTable

    // Lookup
    getByName(name: string): SymbolEntry[]
    getByFile(filePath: string): SymbolEntry[]
    getExportedByFile(filePath: string): SymbolEntry[]
    getByKind(kind: ExtractedDeclaration['kind']): SymbolEntry[]
    getByFileAndName(filePath: string, name: string): SymbolEntry | undefined

    // All symbols
    entries(): IterableIterator<SymbolEntry>
    size: number
}
```

**Internals:**
- `byName: Map<string, SymbolEntry[]>` — name → all symbols with that name
- `byFile: Map<string, SymbolEntry[]>` — filePath → all symbols in that file
- `byKind: Map<string, SymbolEntry[]>` — kind → all symbols of that kind
- Built once from `ExtractedFile[]`, immutable after construction
- Associates each declaration with its matching export records (by name + file)

**Test cases:**
- Build from extracted files → all symbols indexed
- getByName returns all symbols with that name (may be multiple across files)
- getExportedByFile only returns symbols that have an export record
- getByFileAndName returns exact match

### Step 3: import-resolver.ts

**Purpose:** Given an import statement (`source: './validate'` in file `src/auth/service.ts`), resolve to the actual file path (`src/auth/validate.ts`).

**Interface:**
```typescript
interface ResolvedImport {
    importId: string                      // original ExtractedImport.id
    resolvedFilePath: string | null       // null if unresolved or external
    isExternal: boolean                   // true for 'zod', 'express', etc.
    resolvedSymbols: {                    // each named import → resolved symbol
        importedName: string
        resolvedSymbolId: string | null   // declaration ID in the target file
    }[]
}

class ImportResolver {
    constructor(
        symbolTable: SymbolTable,
        tsconfigPaths: TsconfigPaths | null,
        repoPath: string
    )

    resolve(imp: ExtractedImport, fromFile: string): ResolvedImport
    resolveAll(files: ExtractedFile[]): ResolvedImport[]
}
```

**Resolution algorithm:**
1. If source starts with `.` or `/` → **relative import**
   - From the importing file's directory, try in order:
     - `{source}.ts`
     - `{source}.tsx`
     - `{source}/index.ts`
     - `{source}/index.tsx`
     - `{source}.js`
     - `{source}/index.js`
   - Use the first that exists in the extracted files (not filesystem — we only know about scanned files)

2. If source matches a tsconfig path alias → **path alias**
   - Replace the alias prefix with the mapped path
   - Then resolve as relative from baseUrl

3. If source doesn't start with `.` and isn't a path alias → **external package**
   - Mark as `isExternal: true`, don't try to resolve

4. Once the file is resolved, match each named import against the target file's exports:
   - Look for an export with matching `name` or `exportedName`
   - If found, look up the corresponding declaration in the symbol table

**Test cases:**
- Relative import `./validate` → resolves to `src/auth/validate.ts`
- Index import `./models` → resolves to `src/models/index.ts`
- Named imports → matched to exported declarations
- External package → marked as external, not resolved
- Path alias `$lib/foo` → resolved via tsconfig paths
- Nonexistent file → resolvedFilePath is null
- Re-export chain: import from barrel file → traces through

### Step 4: call-resolver.ts

**Purpose:** Given a call site (`callee: 'validate'` in `containingSymbol: 'AuthService.login'`), find the target function/method with a confidence score.

**Interface:**
```typescript
interface ResolvedCall {
    callId: string                        // original ExtractedCall.id
    targetSymbolId: string | null         // declaration ID of the target
    confidence: number                    // 0.0 to 1.0
    strategy: 'same-file' | 'imported' | 're-export' | 'this-method'
              | 'constructor' | 'fuzzy-unique' | 'fuzzy-ambiguous' | 'unresolved'
}

class CallResolver {
    constructor(
        symbolTable: SymbolTable,
        resolvedImports: ResolvedImport[]
    )

    resolve(call: ExtractedCall, file: ExtractedFile): ResolvedCall
    resolveAll(files: ExtractedFile[]): ResolvedCall[]
}
```

**Resolution cascade (tried in order):**

1. **Same-file definition** (confidence: 1.0)
   - Is there a function/class/variable named `callee` in the same file?
   - Match: done.

2. **Imported symbol** (confidence: 0.9)
   - Is `callee` imported in this file?
   - Is that import resolved to a target file + symbol?
   - Match: done.

3. **Re-export chain** (confidence: 0.8)
   - Same as imported, but the import resolved through one or more barrel re-exports.

4. **`this.method()` resolution** (confidence: 0.85)
   - If callee starts with `this.`, extract the method name
   - Find the containing class (from `containingSymbol`)
   - Look for a method with that name on the class
   - If not found, walk up the extends chain (requires heritage resolver)

5. **Constructor / `new`** (confidence: 0.85)
   - If callee is `new ClassName`, resolve `ClassName` via imports or same-file
   - Target is the class itself (or its constructor method)

6. **Fuzzy global match — unique** (confidence: 0.5)
   - Search symbol table for any function/method named `callee`
   - If exactly one match → use it

7. **Fuzzy global match — ambiguous** (confidence: 0.3)
   - Multiple matches → pick closest by file path proximity

8. **Unresolved** (confidence: 0.0)
   - No match found. Still record the edge for potential manual review.

**Test cases:**
- Same-file call → confidence 1.0
- Imported function call → confidence 0.9
- `this.method()` inside class → confidence 0.85
- `new ClassName()` → resolves to class
- Unique global match → confidence 0.5
- Ambiguous match → confidence 0.3
- Completely unknown → confidence 0.0, strategy 'unresolved'

### Step 5: heritage-resolver.ts

**Purpose:** Resolve extends/implements chains for classes and interfaces. Used by the call resolver for `this.method()` and `super.method()` resolution, and produces EXTENDS/IMPLEMENTS edges for the graph.

**Interface:**
```typescript
interface ResolvedHeritage {
    symbolId: string                      // the class/interface declaration ID
    extends?: {
        targetId: string | null           // resolved parent class/interface ID
        confidence: number
    }
    implements?: {
        targetId: string | null
        confidence: number
    }[]
}

class HeritageResolver {
    constructor(
        symbolTable: SymbolTable,
        resolvedImports: ResolvedImport[]
    )

    resolve(decl: ExtractedDeclaration, file: ExtractedFile): ResolvedHeritage | null
    resolveAll(files: ExtractedFile[]): ResolvedHeritage[]

    // Utility: get all methods available on a class (own + inherited)
    getMethodChain(classId: string): ExtractedDeclaration[]
}
```

**Test cases:**
- Class extends local class → resolved
- Class extends imported class → resolved via import chain
- Class implements interface → resolved
- Interface extends interface → resolved
- `getMethodChain` returns own methods + parent methods
- Unresolved parent → targetId is null

### Step 6: graph/types.ts

**Purpose:** Define the node and edge type enums and the core graph interfaces. These are the types the entire rest of the system speaks.

**Contents (from spec sections 3.8, 3.9, 3.10):**

```typescript
// Node types — Phase 2 only needs the shared types
enum NodeType {
    Function = 'Function',
    Class = 'Class',
    Method = 'Method',
    Interface = 'Interface',
    TypeAlias = 'TypeAlias',
    Enum = 'Enum',
    Variable = 'Variable',
    File = 'File',
    // Svelte/Prisma/SvelteKit types added in later phases
}

// Edge types — Phase 2 only needs the universal types
enum EdgeType {
    CALLS = 'CALLS',
    IMPORTS = 'IMPORTS',
    EXPORTS = 'EXPORTS',
    EXTENDS = 'EXTENDS',
    IMPLEMENTS = 'IMPLEMENTS',
    HAS_METHOD = 'HAS_METHOD',
    CONTAINS = 'CONTAINS',
    MEMBER_OF = 'MEMBER_OF',
    // Svelte/Prisma/SvelteKit edges added in later phases
}

interface GraphNode {
    id: string                    // `${filePath}::${name}::${kind}`
    name: string
    type: NodeType
    filePath: string
    lineStart: number
    lineEnd: number
    exported: boolean
    metadata: Record<string, unknown>   // params, returnType, heritage, etc.
}

interface GraphEdge {
    id: string                    // `${source}-${type}-${target}`
    source: string
    target: string
    type: EdgeType
    confidence: number
    metadata: Record<string, unknown>
}

interface KnowledgeGraph {
    repoPath: string
    repoName: string
    indexedAt: string
    lastCommitHash: string | null

    nodes: Map<string, GraphNode>
    edges: Map<string, GraphEdge>
    adjacency: {
        outgoing: Map<string, Set<string>>
        incoming: Map<string, Set<string>>
    }

    nodesByFile: Map<string, Set<string>>
    nodesByType: Map<NodeType, Set<string>>
    nodesByName: Map<string, Set<string>>
}

interface SerializedGraph {
    version: number
    repoPath: string
    repoName: string
    indexedAt: string
    lastCommitHash: string | null
    nodes: GraphNode[]
    edges: GraphEdge[]
}
```

No complex logic here — just types and enums. But it's the contract everything else uses.

### Step 7: graph/knowledge-graph.ts

**Purpose:** In-memory graph data structure. Holds nodes and edges, maintains adjacency indexes, supports serialization/deserialization.

**Interface:**
```typescript
class KnowledgeGraphImpl {
    // Construction
    static create(repoPath: string, repoName: string): KnowledgeGraphImpl

    // Mutators (used during construction by builder)
    addNode(node: GraphNode): void
    addEdge(edge: GraphEdge): void

    // Queries
    getNode(id: string): GraphNode | undefined
    getEdge(id: string): GraphEdge | undefined
    getOutgoingEdges(nodeId: string): GraphEdge[]
    getIncomingEdges(nodeId: string): GraphEdge[]
    getNodesByFile(filePath: string): GraphNode[]
    getNodesByType(type: NodeType): GraphNode[]
    getNodesByName(name: string): GraphNode[]
    getNeighbors(nodeId: string, direction: 'outgoing' | 'incoming' | 'both'): GraphNode[]

    // Stats
    nodeCount: number
    edgeCount: number

    // Serialization
    serialize(): SerializedGraph
    static deserialize(data: SerializedGraph): KnowledgeGraphImpl

    // Access underlying data (for analysis functions)
    toKnowledgeGraph(): KnowledgeGraph
}
```

**Key behaviors:**
- `addNode` auto-updates `nodesByFile`, `nodesByType`, `nodesByName` indexes
- `addEdge` auto-updates `adjacency.outgoing` and `adjacency.incoming`
- Duplicate node/edge IDs throw (catch bugs early)
- `serialize()` converts Maps/Sets to arrays; `deserialize()` hydrates them back
- Serialized format includes `version: 1` for forward compatibility

**Test cases:**
- Add nodes and edges → queryable by all indexes
- Adjacency traversal (outgoing, incoming, both)
- Serialize → deserialize round-trip preserves all data
- Duplicate node ID → throws
- Empty graph serializes/deserializes correctly

### Step 8: graph/builder.ts

**Purpose:** Orchestrator. Takes a repo path, runs the full pipeline (scan → extract → resolve → build graph), returns a complete `KnowledgeGraph`.

**Interface:**
```typescript
interface BuildOptions {
    languages?: ('typescript' | 'svelte' | 'prisma')[]
    ignorePatterns?: string[]
    maxFileSize?: number
    followSymlinks?: boolean
}

async function buildGraph(
    repoPath: string,
    options?: BuildOptions
): Promise<KnowledgeGraph>
```

**Pipeline:**
1. `scanRepository(repoPath)` → scanned files
2. `extractFromRepository(repoPath)` → extracted files
3. `loadTsconfigPaths(repoPath)` → path aliases
4. `SymbolTable.build(extractedFiles)` → symbol table
5. `importResolver.resolveAll(extractedFiles)` → resolved imports
6. `callResolver.resolveAll(extractedFiles)` → resolved calls
7. `heritageResolver.resolveAll(extractedFiles)` → resolved heritage
8. Create `KnowledgeGraphImpl`, populate:
   - One `GraphNode` per declaration (map kind → NodeType)
   - One `File` node per file
   - `CONTAINS` edges: File → each symbol in that file
   - `IMPORTS` edges: from resolved imports
   - `CALLS` edges: from resolved calls (with confidence)
   - `EXTENDS` / `IMPLEMENTS` edges: from resolved heritage
   - `HAS_METHOD` edges: class → method
   - `EXPORTS` edges: file → exported symbol
9. Return the graph

**Node ID scheme:** `${filePath}::${name}::${kind}` (e.g., `src/auth/service.ts::AuthService::Class`)

**Edge ID scheme:** `${sourceId}-${edgeType}-${targetId}` (e.g., `src/auth/service.ts::login::Method-CALLS-src/auth/validate.ts::validate::Function`)

**Test cases:**
- Build graph from ts-library fixture → correct node/edge counts
- Function call → CALLS edge with correct confidence
- Import → IMPORTS edge linking files
- Class with methods → HAS_METHOD edges
- Class extends → EXTENDS edge
- Exported symbol → EXPORTS edge
- Serialization round-trip preserves the full graph

### Barrel exports to add (index.ts)

After Phase 2, the public API expands:

```typescript
// Phase 1 (existing)
export { extractFromFile, extractFromRepository, ... }
export type { ExtractedDeclaration, ExtractedImport, ... }

// Phase 2 (new)
export { buildGraph } from './graph/builder.js'
export { serializeGraph, deserializeGraph } from './graph/knowledge-graph.js'
export { NodeType, EdgeType } from './graph/types.js'
export type {
    KnowledgeGraph, GraphNode, GraphEdge,
    SerializedGraph, BuildOptions
} from './graph/types.js'
```

### Implementation order

Steps 1-5 (resolution) can be done and tested independently before any graph code exists. Steps 6-8 (graph) build on the resolution results. Suggested approach:

1. **types.ts first** — get the type contracts defined
2. **tsconfig-loader** — small, self-contained
3. **symbol-table** — needed by everything else
4. **import-resolver** — depends on symbol-table + tsconfig
5. **heritage-resolver** — depends on symbol-table + import-resolver
6. **call-resolver** — depends on symbol-table + import-resolver + heritage-resolver
7. **knowledge-graph** — depends only on types
8. **builder** — ties everything together

### Test strategy

- Each resolver gets unit tests with inline data (no fixture repo needed)
- Integration test: `buildGraph(fixtureRepoPath)` → verify node/edge counts, specific edges exist
- Serialization round-trip test
- Extend the ts-library fixture if needed (e.g., add tsconfig.json with path aliases, add `this.method()` calls)

---

## Phase 3 — Svelte + Prisma 🔲 NOT STARTED

*Detailed plan will be written when Phase 2 is complete.*

## Phase 4 — Analysis 🔲 NOT STARTED

*Detailed plan will be written when Phase 3 is complete.*

## Phase 5 — UI + Web 🔲 NOT STARTED

## Phase 6 — Dev-Connect Integration 🔲 NOT STARTED

## Phase 7 — MCP Server 🔲 NOT STARTED
