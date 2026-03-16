# Phase 1 Implementation Guide

Current phase: `Phase 1 - Parse + Extract`

Source of truth: [`codegraph.spec.md`](C:\Users\ashton.berret\source\repos\codegraph\codegraph.spec.md)

Phase 1 goal:
- Build the first working pipeline that can scan a repo, parse TypeScript/JavaScript files, extract symbols, and return "here are all symbols in this project."

Phase 1 milestone from the spec:
- Filesystem walker with ignore patterns
- Tree-sitter TypeScript/JavaScript parser + queries
- Symbol extraction for functions, classes, imports, calls, exports
- Unit tests against fixture repos

Out of scope for this phase:
- Graph building
- Import resolution
- Call confidence cascade across files
- Svelte extraction
- Prisma extraction
- CLI/web integration beyond whatever minimal exports are needed

Recommended implementation order:
1. Finish [`packages/core/src/walker/filesystem.ts`](C:\Users\ashton.berret\source\repos\codegraph\packages\core\src\walker\filesystem.ts)
2. Implement [`packages/core/src/parser/tree-sitter.ts`](C:\Users\ashton.berret\source\repos\codegraph\packages\core\src\parser\tree-sitter.ts)
3. Implement [`packages/core/src/parser/queries/typescript.ts`](C:\Users\ashton.berret\source\repos\codegraph\packages\core\src\parser\queries\typescript.ts)
4. Implement [`packages/core/src/parser/extract.ts`](C:\Users\ashton.berret\source\repos\codegraph\packages\core\src\parser\extract.ts)
5. Write parser tests in [`packages/core/test/parser/typescript.test.ts`](C:\Users\ashton.berret\source\repos\codegraph\packages\core\test\parser\typescript.test.ts)
6. Add minimal Phase 1 exports in [`packages/core/src/index.ts`](C:\Users\ashton.berret\source\repos\codegraph\packages\core\src\index.ts)

## File Walkthroughs

### `packages/core/src/walker/filesystem.ts`

```ts
// Purpose:
// Scan the repository and return only files that Phase 1 can parse.

// Keep using:
// - glob for discovery
// - shouldIgnore from config/ignore.ts
// - getLanguageFromFilename from config/languages.ts

// ScannedFile shape should grow to:
// { path: string, size: number, language: SupportedLanguages }
//
// WHY:
// The parser stage should not have to re-detect language for every file.

// Path rules:
// - store repo-relative paths only
// - normalize to forward slashes
// - never return absolute paths in results

// scanRepository(repoPath, onProgress?)
// 1. glob("**/*", { cwd: repoPath, nodir: true, dot: false })
// 2. normalize every result to forward slashes
// 3. filter out ignored files with shouldIgnore
// 4. filter out files whose language is null
// 5. stat the remaining files in batches of READ_CONCURRENCY
// 6. keep only files whose size <= MAX_FILE_SIZE
// 7. return [{ path, size, language }]
//
// Progress callback:
// - signature: (current, total, filePath) => void
// - current should reflect how many candidate files have been processed so far
// - total should be the total number of candidate files after ignore/language filtering
// - filePath can be the last file seen in the current batch
//
// Failure behavior:
// - use Promise.allSettled for batch stats
// - silently skip files that fail stat
// - do not throw because one file disappeared during scan
//
// Nice-to-have logging:
// - track how many files were skipped for size
// - a simple console.debug or comment placeholder is enough for now

// readFileContents(repoPath, relativePaths)
// - process in READ_CONCURRENCY batches
// - read utf-8 text
// - return Map<relativePath, content>
// - use Promise.allSettled
// - silently skip unreadable files
//
// WHY:
// Extraction should accept in-memory content so parsing and testing are easier.
```

#### `filesystem.ts` review notes

```ts
// The current implementation has one real type bug and a few logic issues:
//
// 1. `language: SupportedLanguages` is wrong
//    - that is the enum object, not an enum member
//    - use `getLanguageFromFilename(relativePath)` and return the result
//
// 2. `batch[results.indexOf(result)]` is fragile
//    - with `noUncheckedIndexedAccess`, this can become `string | undefined`
//    - iterate with `results.entries()` so you have the index directly
//
// 3. ignore logic is more complex than it needs to be
//    - do not rely on `glob` ignore callbacks here
//    - glob everything, then run `shouldIgnore()` yourself
//
// 4. progress total should be based on parseable candidate files
//    - not just every file returned by glob
//
// 5. normalize all returned/read paths to forward slashes
//    - keep that contract consistent across scan + read
//
// 6. remove stale imports and unused interfaces
//    - `relative`
//    - `argv0`
//    - likely `isIgnoredDirectory`
//    - `FilesWithContent` if unused
```

#### `filesystem.ts` exact import block

Replace the import section with this:

```ts
import path from 'node:path'
import fs from 'node:fs/promises'
import { glob } from 'glob'

import { shouldIgnore } from '../config/ignore.js'
import { getLanguageFromFilename, SupportedLanguages } from '../config/languages.js'
```

#### `filesystem.ts` exact interface shape

Use this exported interface:

```ts
export interface ScannedFile {
  path: string
  size: number
  language: SupportedLanguages
}
```

If `FilesWithContent` is not used anywhere, delete it.

#### `filesystem.ts` readable implementation outline

If the one-chain `const candidates = ...` style feels hard to maintain, split it into named steps.
That is a better choice here.

Use this shape:

```ts
export const scanRepository = async (
  repoPath: string,
  onProgress?: (current: number, total: number, filePath: string) => void
): Promise<ScannedFile[]> => {
  const discoveredPaths = await glob('**/*', {
    cwd: repoPath,
    nodir: true,
    dot: false,
  })

  const normalizedPaths = discoveredPaths.map((filePath) =>
    filePath.replaceAll(/\\/g, '/')
  )

  const nonIgnoredPaths = normalizedPaths.filter((filePath) => {
    return !shouldIgnore(filePath)
  })

  const candidates = nonIgnoredPaths
    .map((filePath) => {
      const language = getLanguageFromFilename(filePath)
      return { path: filePath, language }
    })
    .filter(
      (
        entry
      ): entry is {
        path: string
        language: SupportedLanguages
      } => entry.language !== null
    )

  const entries: ScannedFile[] = []
  let processed = 0
  let skippedLarge = 0

  for (let start = 0; start < candidates.length; start += READ_CONCURRENCY) {
    const batch = candidates.slice(start, start + READ_CONCURRENCY)

    const results = await Promise.allSettled(
      batch.map(async ({ path: relativePath, language }) => {
        const fullPath = path.join(repoPath, relativePath)
        const stat = await fs.stat(fullPath)

        if (stat.size > MAX_FILE_SIZE) {
          skippedLarge += 1
          return null
        }

        return {
          path: relativePath,
          size: stat.size,
          language,
        } satisfies ScannedFile
      })
    )

    for (const [index, result] of results.entries()) {
      processed += 1
      const filePath = batch[index]?.path ?? ''

      if (result.status === 'fulfilled' && result.value !== null) {
        entries.push(result.value)
      }

      onProgress?.(processed, candidates.length, filePath)
    }
  }

  if (skippedLarge > 0) {
    console.warn(`Skipped ${skippedLarge} large files (> ${MAX_FILE_SIZE / 1024} KB)`)
  }

  return entries
}
```

#### `filesystem.ts` even more explicit version

If you want to avoid the typed `.filter(...)` predicate because it is visually dense, split that too:

```ts
interface CandidateFile {
  path: string
  language: SupportedLanguages | null
}

interface ParseableCandidateFile {
  path: string
  language: SupportedLanguages
}

const candidateFiles: CandidateFile[] = nonIgnoredPaths.map((filePath) => {
  return {
    path: filePath,
    language: getLanguageFromFilename(filePath),
  }
})

const candidates: ParseableCandidateFile[] = candidateFiles.filter((entry) => {
  return entry.language !== null
}) as ParseableCandidateFile[]
```

This uses a cast at the end, which is a little less elegant than a type predicate, but it is easier to read.
For a learning project, that tradeoff is reasonable if the code stays clear.

#### `filesystem.ts` exact `readFileContents()` shape

Use this implementation pattern:

```ts
export const readFileContents = async (
  repoPath: string,
  relativePaths: string[]
): Promise<Map<string, string>> => {
  const contents = new Map<string, string>()

  const normalizedPaths = relativePaths.map((filePath) =>
    filePath.replaceAll(/\\/g, '/')
  )

  for (let start = 0; start < normalizedPaths.length; start += READ_CONCURRENCY) {
    const batch = normalizedPaths.slice(start, start + READ_CONCURRENCY)

    const results = await Promise.allSettled(
      batch.map(async (relativePath) => {
        const fullPath = path.join(repoPath, relativePath)
        const content = await fs.readFile(fullPath, 'utf-8')
        return { path: relativePath, content }
      })
    )

    for (const result of results) {
      if (result.status === 'fulfilled') {
        contents.set(result.value.path, result.value.content)
      }
    }
  }

  return contents
}
```

#### `filesystem.ts` small style guidance

```ts
// Prefer this:
// - discoveredPaths
// - normalizedPaths
// - nonIgnoredPaths
// - candidateFiles
// - candidates
//
// Instead of one long chained expression.
//
// WHY:
// It is easier to debug
// It is easier to log intermediate values
// It is easier to revisit when you start Phase 2
```

### `packages/core/src/parser/tree-sitter.ts`

```ts
// Purpose:
// Centralize parser creation, grammar selection, and parse calls.

// Phase 1 only needs TypeScript/JavaScript support.
// Do NOT implement Svelte or Prisma parsing yet.

// Create a small API surface, something like:
// - getParser(language)
// - parseSource(language, content)
//
// Supported Phase 1 language:
// - SupportedLanguages.TypeScript

// Implementation notes:
// - import Parser from 'tree-sitter'
// - import the TS grammar from 'tree-sitter-typescript'
// - use the TypeScript grammar for .ts/.tsx and optionally the TSX grammar for .jsx/.tsx if you want to distinguish
// - cache parser instances by language so you do not allocate a new Parser for every file
//
// Returned parse result should preserve:
// - the Tree
// - the root node
// - the language used
//
// Error handling:
// - parsing should not crash the whole build for one bad file
// - if tree-sitter returns a tree with ERROR nodes, still return it
// - only throw for actual setup/config mistakes
//
// Add a tiny helper for point/range conversion:
// - tree-sitter rows are zero-based
// - your extracted ranges should be one-based for developer-facing output
```

#### `tree-sitter.ts` starter implementation

Type this in as a first working version:

```ts
import Parser from 'tree-sitter'
import TypeScript from 'tree-sitter-typescript'

import { SupportedLanguages } from '../config/languages.js'

const parserCache = new Map<SupportedLanguages, Parser>()

export interface ParsedSource {
  language: SupportedLanguages
  tree: Parser.Tree
  rootNode: Parser.SyntaxNode
  content: string
}

function createParser(language: SupportedLanguages): Parser {
  const parser = new Parser()

  switch (language) {
    case SupportedLanguages.TypeScript:
      parser.setLanguage(TypeScript.typescript)
      return parser
    case SupportedLanguages.Svelte:
      throw new Error('Svelte parsing is not implemented in Phase 1')
    case SupportedLanguages.Prisma:
      throw new Error('Prisma parsing is not implemented in Phase 1')
    default:
      throw new Error(`Unsupported language: ${language satisfies never}`)
  }
}

export function getParser(language: SupportedLanguages): Parser {
  const cached = parserCache.get(language)
  if (cached) return cached

  const parser = createParser(language)
  parserCache.set(language, parser)
  return parser
}

export function parseSource(
  language: SupportedLanguages,
  content: string
): ParsedSource {
  const parser = getParser(language)
  const tree = parser.parse(content)

  return {
    language,
    tree,
    rootNode: tree.rootNode,
    content,
  }
}

export function toOneBasedLine(row: number): number {
  return row + 1
}
```

#### `tree-sitter.ts` one correction to make immediately

The `default` branch above is only there as a guard.
If TypeScript complains about the `satisfies never` expression, replace the whole `default` branch with:

```ts
default:
  throw new Error(`Unsupported language: ${String(language)}`)
```

### `packages/core/src/parser/queries/typescript.ts`

```ts
// Purpose:
// Define the extraction logic for TS/JS ASTs.

// IMPORTANT:
// The spec says Phase 1 should extract:
// - functions
// - classes
// - imports
// - calls
// - exports
//
// You can include variables/types now if it helps, but the minimum success bar is the list above.

// Keep this file focused on one job:
// given a parsed TypeScript AST + source text + file path,
// return normalized symbol records.

// Recommended output model:
// - one ExtractedFile result
// - with arrays for declarations/imports/exports/calls
//
// Suggested symbol fields:
// - id: temporary phase-1-safe id like `${filePath}#function:${name}:${startLine}`
// - kind: 'function' | 'class' | 'import' | 'export' | 'call'
// - name
// - filePath
// - startLine
// - endLine
// - exported?: boolean
// - async?: boolean
// - parentName?: string
// - source?: string           // for imports/exports
// - importedNames?: string[]  // for imports
// - callee?: string           // for calls
//
// Extraction targets:
// - function declarations
// - arrow/function expressions assigned to variables only if named via variable declarator
// - class declarations
// - class methods
// - import declarations
// - export declarations / export modifiers / re-exports
// - call expressions
//
// Practical advice:
// - do not over-optimize around tree-sitter query syntax on day one
// - a direct AST walk is acceptable if it is easier to reason about
// - consistency of extracted records matters more than fancy query coverage initially
//
// For calls:
// - capture raw callee text if exact resolution is not known
// - examples: `validate`, `auth.login`, `this.save`
// - also capture containing function/method name when possible
//
// For exports:
// - distinguish at least:
//   - direct export declaration
//   - export list (`export { foo }`)
//   - default export
//   - re-export from another module
//
// For imports:
// - capture source path exactly as written
// - capture named/default/namespace imports separately if possible
// - this makes Phase 2 resolution much easier
```

#### `typescript.ts` data shapes to introduce

Start by defining the output types you want this file to return:

```ts
import type Parser from 'tree-sitter'

import { toOneBasedLine, type ParsedSource } from '../tree-sitter.js'

export interface ExtractedDeclaration {
  id: string
  kind: 'function' | 'class' | 'method'
  name: string
  filePath: string
  startLine: number
  endLine: number
  exported: boolean
  async?: boolean
  parentName?: string
}

export interface ExtractedImport {
  id: string
  kind: 'import'
  filePath: string
  startLine: number
  endLine: number
  source: string
  defaultImport?: string
  namespaceImport?: string
  namedImports: string[]
}

export interface ExtractedExport {
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

export interface ExtractedCall {
  id: string
  kind: 'call'
  filePath: string
  startLine: number
  endLine: number
  callee: string
  containingSymbol?: string
}

export interface TypeScriptExtractionResult {
  declarations: ExtractedDeclaration[]
  imports: ExtractedImport[]
  exports: ExtractedExport[]
  calls: ExtractedCall[]
}
```

#### `typescript.ts` starter implementation

This is a reasonable first-pass extractor.
It is intentionally straightforward rather than clever.

```ts
function getNodeText(node: Parser.SyntaxNode, content: string): string {
  return content.slice(node.startIndex, node.endIndex)
}

function getChildByType(
  node: Parser.SyntaxNode,
  type: string
): Parser.SyntaxNode | null {
  for (const child of node.namedChildren) {
    if (child.type === type) return child
  }

  return null
}

function getIdentifierText(
  node: Parser.SyntaxNode | null,
  content: string
): string | null {
  if (!node) return null
  return getNodeText(node, content)
}

function createId(
  filePath: string,
  kind: string,
  name: string,
  startLine: number
): string {
  return `${filePath}#${kind}:${name}:${startLine}`
}

function isNodeExported(node: Parser.SyntaxNode): boolean {
  let current: Parser.SyntaxNode | null = node.parent

  while (current) {
    if (current.type === 'export_statement') return true
    current = current.parent
  }

  return false
}

function extractFunctionDeclaration(
  node: Parser.SyntaxNode,
  filePath: string,
  content: string
): ExtractedDeclaration | null {
  const nameNode = getChildByType(node, 'identifier')
  const name = getIdentifierText(nameNode, content)
  if (!name) return null

  const startLine = toOneBasedLine(node.startPosition.row)
  const endLine = toOneBasedLine(node.endPosition.row)

  return {
    id: createId(filePath, 'function', name, startLine),
    kind: 'function',
    name,
    filePath,
    startLine,
    endLine,
    exported: isNodeExported(node),
    async: getNodeText(node, content).includes('async '),
  }
}

function extractClassDeclaration(
  node: Parser.SyntaxNode,
  filePath: string,
  content: string
): ExtractedDeclaration | null {
  const nameNode = getChildByType(node, 'type_identifier') ?? getChildByType(node, 'identifier')
  const name = getIdentifierText(nameNode, content)
  if (!name) return null

  const startLine = toOneBasedLine(node.startPosition.row)
  const endLine = toOneBasedLine(node.endPosition.row)

  return {
    id: createId(filePath, 'class', name, startLine),
    kind: 'class',
    name,
    filePath,
    startLine,
    endLine,
    exported: isNodeExported(node),
  }
}

function extractMethodDeclaration(
  node: Parser.SyntaxNode,
  filePath: string,
  content: string,
  parentName: string
): ExtractedDeclaration | null {
  const nameNode =
    getChildByType(node, 'property_identifier') ??
    getChildByType(node, 'private_property_identifier') ??
    getChildByType(node, 'identifier')

  const name = getIdentifierText(nameNode, content)
  if (!name) return null

  const startLine = toOneBasedLine(node.startPosition.row)
  const endLine = toOneBasedLine(node.endPosition.row)

  return {
    id: createId(filePath, 'method', `${parentName}.${name}`, startLine),
    kind: 'method',
    name,
    filePath,
    startLine,
    endLine,
    exported: false,
    async: getNodeText(node, content).includes('async '),
    parentName,
  }
}

function extractImportDeclaration(
  node: Parser.SyntaxNode,
  filePath: string,
  content: string
): ExtractedImport | null {
  const startLine = toOneBasedLine(node.startPosition.row)
  const endLine = toOneBasedLine(node.endPosition.row)
  const sourceNode = node.namedChildren[node.namedChildren.length - 1] ?? null
  const sourceText = sourceNode ? getNodeText(sourceNode, content) : null

  if (!sourceText) return null

  const source = sourceText.replace(/^['"]|['"]$/g, '')
  const statementText = getNodeText(node, content)
  const namedImports: string[] = []

  const namedMatch = statementText.match(/\{([^}]+)\}/)
  if (namedMatch?.[1]) {
    const items = namedMatch[1].split(',')
    for (const item of items) {
      const cleaned = item.trim()
      if (cleaned.length > 0) namedImports.push(cleaned)
    }
  }

  const namespaceMatch = statementText.match(/\*\s+as\s+([A-Za-z0-9_$]+)/)
  const defaultMatch = statementText.match(/^import\s+([A-Za-z0-9_$]+)\s*(,|from)/m)

  return {
    id: createId(filePath, 'import', source, startLine),
    kind: 'import',
    filePath,
    startLine,
    endLine,
    source,
    defaultImport: defaultMatch?.[1],
    namespaceImport: namespaceMatch?.[1],
    namedImports,
  }
}

function extractExportStatement(
  node: Parser.SyntaxNode,
  filePath: string,
  content: string
): ExtractedExport[] {
  const startLine = toOneBasedLine(node.startPosition.row)
  const endLine = toOneBasedLine(node.endPosition.row)
  const statementText = getNodeText(node, content)

  const exports: ExtractedExport[] = []

  if (statementText.startsWith('export default')) {
    exports.push({
      id: createId(filePath, 'export', 'default', startLine),
      kind: 'export',
      filePath,
      startLine,
      endLine,
      name: 'default',
      isDefault: true,
      isReExport: false,
    })
  }

  const fromMatch = statementText.match(/from\s+['"]([^'"]+)['"]/)
  const source = fromMatch?.[1]

  const namedMatch = statementText.match(/\{([^}]+)\}/)
  if (namedMatch?.[1]) {
    const items = namedMatch[1].split(',')
    for (const item of items) {
      const cleaned = item.trim()
      if (!cleaned) continue

      const [localName, exportedName] = cleaned.split(/\s+as\s+/)

      exports.push({
        id: createId(filePath, 'export', cleaned, startLine),
        kind: 'export',
        filePath,
        startLine,
        endLine,
        name: localName ?? cleaned,
        exportedName,
        source,
        isDefault: false,
        isReExport: Boolean(source),
      })
    }
  }

  return exports
}

function extractCallExpression(
  node: Parser.SyntaxNode,
  filePath: string,
  content: string,
  containingSymbol?: string
): ExtractedCall | null {
  const functionNode = node.childForFieldName('function')
  if (!functionNode) return null

  const callee = getNodeText(functionNode, content)
  const startLine = toOneBasedLine(node.startPosition.row)
  const endLine = toOneBasedLine(node.endPosition.row)

  return {
    id: createId(filePath, 'call', callee, startLine),
    kind: 'call',
    filePath,
    startLine,
    endLine,
    callee,
    containingSymbol,
  }
}

function walkNode(
  node: Parser.SyntaxNode,
  filePath: string,
  content: string,
  result: TypeScriptExtractionResult,
  currentContainer?: string
): void {
  if (node.type === 'function_declaration') {
    const extracted = extractFunctionDeclaration(node, filePath, content)
    if (extracted) {
      result.declarations.push(extracted)
      currentContainer = extracted.name
    }
  }

  if (node.type === 'class_declaration') {
    const extracted = extractClassDeclaration(node, filePath, content)
    if (extracted) {
      result.declarations.push(extracted)

      for (const child of node.namedChildren) {
        if (child.type === 'class_body') {
          for (const member of child.namedChildren) {
            if (member.type === 'method_definition') {
              const method = extractMethodDeclaration(
                member,
                filePath,
                content,
                extracted.name
              )

              if (method) result.declarations.push(method)
            }
          }
        }
      }
    }
  }

  if (node.type === 'import_statement') {
    const extracted = extractImportDeclaration(node, filePath, content)
    if (extracted) result.imports.push(extracted)
  }

  if (node.type === 'export_statement') {
    const extracted = extractExportStatement(node, filePath, content)
    result.exports.push(...extracted)
  }

  if (node.type === 'call_expression') {
    const extracted = extractCallExpression(
      node,
      filePath,
      content,
      currentContainer
    )

    if (extracted) result.calls.push(extracted)
  }

  for (const child of node.namedChildren) {
    walkNode(child, filePath, content, result, currentContainer)
  }
}

export function extractTypeScriptSymbols(
  filePath: string,
  parsed: ParsedSource
): TypeScriptExtractionResult {
  const result: TypeScriptExtractionResult = {
    declarations: [],
    imports: [],
    exports: [],
    calls: [],
  }

  walkNode(parsed.rootNode, filePath, parsed.content, result)

  return result
}
```

#### `typescript.ts` honesty note

```ts
// This is intentionally a "working first pass", not a perfect AST model.
//
// There are a few simplifications:
// - import parsing uses statement text for named/default/namespace details
// - `async` detection uses string includes
// - export extraction is strongest for `export { ... }` and `export default ...`
//
// That is acceptable for Phase 1.
// You can tighten the AST handling once the tests are in place.
```

### `packages/core/src/parser/extract.ts`

```ts
// Purpose:
// Coordinate parser selection + per-file extraction.

// This is the Phase 1 orchestration layer.
// It should not know about graph construction yet.

// Good exported types to define here for now:
// - ExtractedSymbol
// - ExtractedImport
// - ExtractedExport
// - ExtractedCall
// - ExtractedFile
// - ExtractionResult
//
// WHY:
// graph/types.ts is a Phase 2 concern, so do not force graph-level modeling yet.

// Main function idea:
// extractFromFile(filePath, language, content): ExtractedFile
//
// For Phase 1:
// - route only TypeScript files into the TypeScript extractor
// - for Svelte and Prisma, either:
//   - throw a clear "not implemented in Phase 1" error, or
//   - return an empty ExtractedFile with a comment/TODO
//
// Higher-level batch helper:
// extractFromRepository(repoPath): Promise<ExtractedFile[]>
// 1. scanRepository(repoPath)
// 2. readFileContents(repoPath, scannedPaths)
// 3. extract each file
// 4. return the extracted file list
//
// Failure behavior:
// - if one file fails extraction, collect an error record or skip it
// - do not discard the entire repository result because of one file
//
// Keep output deterministic:
// - preserve stable ordering, ideally by file path
// - sort symbol arrays by start line when useful
```

#### `extract.ts` starter implementation

Use this as a clear Phase 1 coordinator:

```ts
import { SupportedLanguages } from '../config/languages.js'
import {
  readFileContents,
  scanRepository,
  type ScannedFile,
} from '../walker/filesystem.js'
import { parseSource } from './tree-sitter.js'
import {
  extractTypeScriptSymbols,
  type ExtractedCall,
  type ExtractedDeclaration,
  type ExtractedExport,
  type ExtractedImport,
} from './queries/typescript.js'

export interface ExtractedFile {
  filePath: string
  language: SupportedLanguages
  declarations: ExtractedDeclaration[]
  imports: ExtractedImport[]
  exports: ExtractedExport[]
  calls: ExtractedCall[]
}

export function extractFromFile(
  file: ScannedFile,
  content: string
): ExtractedFile {
  switch (file.language) {
    case SupportedLanguages.TypeScript: {
      const parsed = parseSource(file.language, content)
      const extracted = extractTypeScriptSymbols(file.path, parsed)

      return {
        filePath: file.path,
        language: file.language,
        declarations: extracted.declarations,
        imports: extracted.imports,
        exports: extracted.exports,
        calls: extracted.calls,
      }
    }
    case SupportedLanguages.Svelte:
      throw new Error('Svelte extraction is not implemented in Phase 1')
    case SupportedLanguages.Prisma:
      throw new Error('Prisma extraction is not implemented in Phase 1')
    default:
      throw new Error(`Unsupported language: ${String(file.language)}`)
  }
}

export async function extractFromRepository(
  repoPath: string
): Promise<ExtractedFile[]> {
  const scannedFiles = await scanRepository(repoPath)
  const contents = await readFileContents(
    repoPath,
    scannedFiles.map((file) => file.path)
  )

  const extractedFiles: ExtractedFile[] = []

  for (const file of scannedFiles) {
    const content = contents.get(file.path)
    if (!content) continue

    try {
      extractedFiles.push(extractFromFile(file, content))
    } catch (error) {
      console.warn(`Failed to extract symbols from ${file.path}`, error)
    }
  }

  extractedFiles.sort((a, b) => a.filePath.localeCompare(b.filePath))
  return extractedFiles
}
```

#### `extract.ts` small design rule

```ts
// Keep this file boring.
//
// It should:
// - route by language
// - parse content
// - call the right extractor
// - batch at the repository level
//
// It should NOT:
// - do graph work
// - resolve imports
// - infer call targets
```

### `packages/core/test/parser/typescript.test.ts`

```ts
// Purpose:
// Prove the parser/extractor pipeline works before Phase 2 starts.

// First tests should be very direct and fixture-light.
// Since the current fixture files are empty, fill them with tiny examples first.

// Minimum tests to write:
// 1. scanRepository returns only parseable source files
// 2. parseSource can parse a simple TS file without throwing
// 3. extraction finds a named function declaration
// 4. extraction finds a class and at least one method
// 5. extraction finds import declarations
// 6. extraction finds export declarations
// 7. extraction finds call expressions with raw callee text
//
// Example fixture ideas:
// - src/index.ts exports a function and re-exports from ./auth/service
// - src/auth/service.ts imports validate and calls it
// - src/auth/validate.ts exports a validation function
//
// Assertions should check:
// - symbol kind
// - name
// - filePath
// - line numbers exist and are sensible
// - import/export source strings are correct
//
// Avoid Phase 2 assertions:
// - do not assert resolved import targets yet
// - do not assert cross-file call target confidence yet
```

#### `typescript.test.ts` fixture content to create first

Put tiny testable examples into the fixture repo before writing the tests.

[`packages/core/test/fixtures/ts-library/src/auth/validate.ts`](C:\Users\ashton.berret\source\repos\codegraph\packages\core\test\fixtures\ts-library\src\auth\validate.ts)

```ts
export function validate(token: string): boolean {
  return token.length > 0
}
```

[`packages/core/test/fixtures/ts-library/src/auth/service.ts`](C:\Users\ashton.berret\source\repos\codegraph\packages\core\test\fixtures\ts-library\src\auth\service.ts)

```ts
import { validate } from './validate'

export class AuthService {
  login(token: string): boolean {
    return validate(token)
  }
}
```

[`packages/core/test/fixtures/ts-library/src/index.ts`](C:\Users\ashton.berret\source\repos\codegraph\packages\core\test\fixtures\ts-library\src\index.ts)

```ts
export { AuthService } from './auth/service'
export { validate } from './auth/validate'

export function createAuthService(): AuthService {
  return new AuthService()
}
```

#### `typescript.test.ts` starter implementation

Use this as the first real test file:

```ts
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { SupportedLanguages } from '../../src/config/languages.js'
import { parseSource } from '../../src/parser/tree-sitter.js'
import { extractFromRepository } from '../../src/parser/extract.js'
import { scanRepository } from '../../src/walker/filesystem.js'

const fixtureRepoPath = path.resolve(
  process.cwd(),
  'test/fixtures/ts-library'
)

describe('TypeScript parser and extractor', () => {
  it('scanRepository returns parseable source files', async () => {
    const files = await scanRepository(fixtureRepoPath)

    expect(files.length).toBeGreaterThan(0)
    expect(files.every((file) => file.language === SupportedLanguages.TypeScript)).toBe(true)
    expect(files.map((file) => file.path)).toContain('src/index.ts')
  })

  it('parseSource parses a simple TypeScript file', () => {
    const parsed = parseSource(
      SupportedLanguages.TypeScript,
      'export function hello() { return 1 }'
    )

    expect(parsed.rootNode.type).toBe('program')
  })

  it('extractFromRepository finds declarations, imports, exports, and calls', async () => {
    const extractedFiles = await extractFromRepository(fixtureRepoPath)

    const serviceFile = extractedFiles.find((file) => file.filePath === 'src/auth/service.ts')
    expect(serviceFile).toBeDefined()

    const classDeclaration = serviceFile?.declarations.find((item) => item.kind === 'class')
    expect(classDeclaration?.name).toBe('AuthService')

    const methodDeclaration = serviceFile?.declarations.find((item) => item.kind === 'method')
    expect(methodDeclaration?.name).toBe('login')

    const importItem = serviceFile?.imports[0]
    expect(importItem?.source).toBe('./validate')
    expect(importItem?.namedImports).toContain('validate')

    const callItem = serviceFile?.calls[0]
    expect(callItem?.callee).toBe('validate')

    const indexFile = extractedFiles.find((file) => file.filePath === 'src/index.ts')
    expect(indexFile).toBeDefined()
    expect(indexFile?.exports.length).toBeGreaterThan(0)
  })
})
```

#### `typescript.test.ts` one likely follow-up fix

```ts
// If the `AuthService` return type in `index.ts` causes a fixture issue,
// add the import explicitly:
//
// import { AuthService } from './auth/service'
//
// Then keep the re-export lines below it.
//
// That keeps the fixture valid TypeScript and avoids confusion during parsing.
```

### `packages/core/src/index.ts`

```ts
// Purpose:
// Expose only the Phase 1 public API needed right now.

// Safe Phase 1 exports:
// - scanRepository
// - readFileContents
// - parseSource or getParser
// - extractFromFile
// - extractFromRepository
// - extraction-related types
//
// Do NOT fake later-phase exports yet unless the repo already requires placeholders.
// Empty or missing implementations for buildGraph/analyze/search will create confusion.
```

#### `index.ts` starter implementation

Use this minimal barrel:

```ts
export {
  readFileContents,
  scanRepository,
  type ScannedFile,
} from './walker/filesystem.js'

export {
  getParser,
  parseSource,
  toOneBasedLine,
  type ParsedSource,
} from './parser/tree-sitter.js'

export {
  extractFromFile,
  extractFromRepository,
  type ExtractedFile,
} from './parser/extract.js'

export type {
  ExtractedCall,
  ExtractedDeclaration,
  ExtractedExport,
  ExtractedImport,
  TypeScriptExtractionResult,
} from './parser/queries/typescript.js'
```

#### Phase 1 sequence after `filesystem.ts`

```ts
// 1. Implement tree-sitter.ts exactly enough to parse TS files
// 2. Implement the TypeScript extractor with plain AST walking
// 3. Implement extract.ts as the coordinator
// 4. Fill the fixture files with tiny examples
// 5. Write the parser tests
// 6. Export the Phase 1 API from index.ts
//
// That order matters because each step gives the next step something concrete to verify.
```

## Files To Leave Alone In Phase 1

### `packages/core/src/parser/queries/svelte.ts`

```ts
// Leave empty or with a short TODO.
// Full Svelte extraction belongs to Phase 3.
```

### `packages/core/src/parser/queries/prisma.ts`

```ts
// Leave empty or with a short TODO.
// Full Prisma extraction belongs to Phase 3.
```

### `packages/core/test/parser/svelte.test.ts`

```ts
// Do not spend time here yet.
// Svelte parser tests begin in Phase 3.
```

### `packages/core/test/parser/prisma.test.ts`

```ts
// Do not spend time here yet.
// Prisma parser tests begin in Phase 3.
```

## Suggested Phase 1 Exit Checklist

- `scanRepository()` returns filtered parseable files with normalized relative paths
- `readFileContents()` can batch-read repository files
- `tree-sitter.ts` can parse TypeScript/JavaScript source reliably
- `typescript.ts` extracts functions, classes, imports, exports, and calls
- `extract.ts` can run extraction across a repo and return deterministic results
- `typescript.test.ts` covers the core extraction behaviors
- `index.ts` exposes the Phase 1 API cleanly

## One Important Constraint

Do not let Phase 2 concerns leak into this implementation.

Phase 1 should answer:
- "What symbols exist?"

Phase 2 will answer:
- "What do those symbols connect to?"
