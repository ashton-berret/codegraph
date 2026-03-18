export enum NodeType {
    Function = 'Function',
    Class = 'Class',
    Method = 'Method',
    Interface = 'Interface',
    TypeAlias = 'TypeAlias',
    Enum = 'Enum',
    Variable = 'Variable',
    File = 'File',

    // future phases: Component, SvelteStore, ReactiveDeclaration, SlotDefinition, EventDispatch, SvelteAction, Route,
    // ServerEndpoint, LayoutGroup, FormAction, PrismaModel, PrismaEnum, PrismaField, Folder
}

export enum EdgeType {
    CALLS = 'CALLS',
    IMPORTS = 'IMPORTS',
    EXPORTS = 'EXPORTS',
    EXTENDS = 'EXTENDS',
    IMPLEMENTS = 'IMPLEMENTS',
    HAS_METHOD = 'HAS_METHOD',
    CONTAINS = 'CONTAINS',
    MEMBER_OF = 'MEMBER_OF',

    // future phases: RENDERS, LOADS_DATA, SUBSCRIBES_TO, DISPATCHES_EVENT, BINDS_PROP, INHERITS_LAYOUT, HANDLES_ACTION,
    // STEP_IN_PROCESS, HAS_FIELD, HAS_RELATION, REFERENCES_MODEL
}

export interface GraphNode {
    id: string                              // unique id: `${filePath}::${name}::${kind}`
    name: string
    type: NodeType                          // node classification
    filePath: string
    lineStart: number
    lineEnd: number
    exported: boolean
    metadata: Record<string, unknown>       // type-specific metadata (params, returnType, heritage, etc)
}

export interface GraphEdge {
    id: string          // unique id: `${source}-${type}-${target}`
    source: string
    target: string
    type: EdgeType      // edge classification
    confidence: number  // resolution confidence (0.0 - 1.0)
    metadata: Record<string, unknown>
}

// ─── Knowledge Graph (in-memory) ─────────────────────────────────────────────
export interface KnowledgeGraph {
    repoPath: string
    repoName: string
    indexedAt: string // ISO 8601 timestamp of when the graph was built
    lastCommitHash: string | null // HEAD commit hash at indexed time

    nodes: Map<string, GraphNode>
    edges: Map<string, GraphEdge>

    // adjacency indexes
    adjacency: {
        outgoing: Map<string, Set<string>> // nodeId -> set of outgoing edgeIds
        incoming: Map<string, Set<string>> // nodeId -> set of incoming edgeIds
    }

    // secondary indexes built during construction
    nodesByFile: Map<string, Set<string>> // filePath -> set of nodeIds in that file
    nodesByType: Map<string, Set<string>> // NodeType -> set of nodeIds of that type
    nodesByName: Map<string, Set<string>> // symbol name -> set of nodeIds of that name
}

// ─── Build Options ───────────────────────────────────────────────────────────
export interface BuildOptions {
    languages?: ('typescript' | 'svelte' | 'prisma')[] // default is all supported
    ignorePatterns?: string[] // additional glob patterns to ignore
    maxFileSize?: number
    followSymLinks?: boolean // whether to follow symlinks during scanning, default false
}
