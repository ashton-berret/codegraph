import path from 'node:path'
import { glob } from 'glob'
import  fs  from 'node:fs/promises'
import { shouldIgnore } from "../config/ignore.js"
import { getLanguageFromFilename, SupportedLanguages } from "../config/languages.js"


export interface ScannedFile {
    path: string,
    size: number,
    language: SupportedLanguages
}

interface FilesWithContent {
    path: string,
    content: string
}

const READ_CONCURRENCY = 32 // how many files read in parallel
const MAX_FILE_SIZE = 512 * 1024 // files larger than this are likely generated

export const scanRepository = async (
    repoPath: string,
    onProgress?: (current: number, total: number, filePath: string) => void
): Promise<ScannedFile[]> => {
    const discoveredPaths = await glob('**/*', {
        cwd: repoPath,
        nodir: true,
        dot: false
    })

    const normalizedPaths = discoveredPaths.map((filePath) => filePath.replaceAll(/\\/g, '/'))
    const nonIgnoredPaths = normalizedPaths.filter((filePath) => {
        return !shouldIgnore(filePath)
    })

    const candidates: { path: string, language: SupportedLanguages }[] = []
    for (const path of nonIgnoredPaths) {
        const language = getLanguageFromFilename(path)
        if (language !== null) {
            candidates.push({ path: path, language })
        }
    }

    const entries: ScannedFile[] = []
    let processed = 0
    let skippedLarge = 0

    for (let start=0; start < candidates.length; start += READ_CONCURRENCY) {
        const batch = candidates.slice(start, start + READ_CONCURRENCY)
        const results = await Promise.allSettled(
            batch.map(async ({ path: relativePath, language }) => {
                const fullPath = path.join(repoPath, relativePath)
                const stat = await fs.stat(fullPath)

                if (stat.size > MAX_FILE_SIZE) {
                    skippedLarge++
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
            processed++
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

