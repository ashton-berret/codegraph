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
  ParamInfo,
  TypeScriptExtractionResult,
} from './parser/queries/typescript.js'

