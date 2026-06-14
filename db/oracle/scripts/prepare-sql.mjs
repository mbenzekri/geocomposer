import { readFileSync, writeFileSync } from 'node:fs'

class SqlSpatialArrayTransformer {
  transform(sql) {
    return this.replaceConstructor(
      this.replaceConstructor(sql, 'MDSYS.SDO_ELEM_INFO_ARRAY', 'GC_SDO_ELEM_INFO_ARRAY'),
      'MDSYS.SDO_ORDINATE_ARRAY',
      'GC_SDO_ORDINATE_ARRAY',
    )
  }

  replaceConstructor(sql, sourceName, targetName) {
    let output = ''
    let cursor = 0

    while (cursor < sql.length) {
      const start = sql.indexOf(sourceName, cursor)
      if (start === -1) {
        output += sql.slice(cursor)
        break
      }

      const openParen = this.skipWhitespace(sql, start + sourceName.length)
      if (sql[openParen] !== '(') {
        output += sql.slice(cursor, start + sourceName.length)
        cursor = start + sourceName.length
        continue
      }

      const closeParen = this.findMatchingParen(sql, openParen)

      output += sql.slice(cursor, start)
      output += `${targetName}(\n${this.toClobExpression(sql.slice(openParen + 1, closeParen))}\n)`
      cursor = closeParen + 1
    }

    return output
  }

  skipWhitespace(sql, start) {
    let index = start
    while (sql[index] === ' ' || sql[index] === '\t' || sql[index] === '\n' || sql[index] === '\r') {
      index += 1
    }
    return index
  }

  findMatchingParen(sql, openParen) {
    let depth = 0
    let inString = false

    for (let index = openParen; index < sql.length; index += 1) {
      const char = sql[index]
      const next = sql[index + 1]

      if (char === "'") {
        if (inString && next === "'") {
          index += 1
        } else {
          inString = !inString
        }
      }

      if (inString) continue

      if (char === '(') depth += 1
      if (char === ')') {
        depth -= 1
        if (depth === 0) return index
      }
    }

    throw new Error(`No matching closing parenthesis at offset ${openParen}`)
  }

  toClobExpression(valueList) {
    return this.chunk(valueList.replace(/\s+/g, ' ').trim(), 1800)
      .map((chunk) => `TO_CLOB('${chunk.replaceAll("'", "''")}')`)
      .join(' ||\n')
  }

  chunk(text, size) {
    const chunks = []
    for (let start = 0; start < text.length; start += size) {
      chunks.push(text.slice(start, start + size))
    }
    return chunks
  }
}

class SqlLineWrapper {
  constructor(maxLineLength = 2400) {
    this.maxLineLength = maxLineLength
  }

  wrap(sql) {
    return sql
      .split(/\r?\n/)
      .flatMap((line) => this.wrapLine(line))
      .join('\n')
  }

  wrapLine(line) {
    if (line.length <= this.maxLineLength) return [line]

    const chunks = []
    let start = 0
    let inString = false

    for (let index = 0; index < line.length; index += 1) {
      const char = line[index]
      const next = line[index + 1]

      if (char === "'") {
        if (inString && next === "'") {
          index += 1
        } else {
          inString = !inString
        }
      }

      if (!inString && char === ',' && index - start >= this.maxLineLength) {
        chunks.push(line.slice(start, index + 1))
        start = this.skipWhitespace(line, index + 1)
      }
    }

    if (start < line.length) {
      chunks.push(line.slice(start))
    }

    return chunks
  }

  skipWhitespace(line, start) {
    let index = start
    while (line[index] === ' ' || line[index] === '\t') {
      index += 1
    }
    return index
  }
}

const [inputPath, outputPath] = process.argv.slice(2)

if (!inputPath || !outputPath) {
  console.error('Usage: node scripts/prepare-sql.mjs <input.sql> <output.sql>')
  process.exit(1)
}

const wrapper = new SqlLineWrapper()
const transformer = new SqlSpatialArrayTransformer()
writeFileSync(outputPath, wrapper.wrap(transformer.transform(readFileSync(inputPath, 'utf8'))), 'utf8')
