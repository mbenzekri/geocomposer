import fs from 'node:fs'
import { basename, dirname, resolve } from "node:path"
import { assertExistsCreateDir, assertExistsFile, isPlainObject } from "../core/tools.js"

export class PathsSolver {
    constructor(readonly baseDir: string) { }

    solve<T>(document: T, label = 'configuration'): T {

        if (!isPlainObject(document)) return document

        let fullpath = this.resolveProp(document, ['services', 'xyz', 'cache'])
        assertExistsCreateDir(fullpath)

        fullpath = this.resolveProp(document, ['services', 'wmts', 'cache'])
        assertExistsCreateDir(fullpath)

        Object.entries(document.styles ?? {}).forEach(([name, stylejson]) => {
            if (isPlainObject(stylejson)) {
                const fullpath = this.resolveProp(document, ['styles', name, 'path'])
                assertExistsFile(fullpath)
            }
        })

        Object.entries(document.sources ?? {}).forEach(([name, sourcejson]) => {
            if (isPlainObject(sourcejson)) {
                let fullpath = this.resolveProp(document, ['sources', name, 'path'])
                assertExistsSourcePath(fullpath)
                fullpath = this.resolveProp(document, ['sources', name, 'shpPath'])
                assertExistsFile(fullpath)
                fullpath = this.resolveProp(document, ['sources', name, 'dbfPath'])
                assertExistsFile(fullpath)
            }
        })
        return document
    }

    private resolveProp(doc: any, props: string[]) {
        if (props.length < 2) throw `[CONFIG]: solving path not enough properties ${JSON.stringify(props)}`
        for (let i = 0; i < (props.length - 1); i++) {
            if (props[i] in doc) {
                doc = doc[props[i]]
            }
            else return
        }
        if (doc == null) return
        const lastprop = props[props.length - 1]
        const value = doc[lastprop]
        if (value != null) {
            doc[lastprop] = resolve(this.baseDir, value)
            console.log(`[PATH-SOLVER]: ${JSON.stringify(props)} resolved ${value} to ${doc[lastprop]}`)
        }
        return doc[lastprop]
    }

}

function assertExistsSourcePath(path: string | undefined) {
    if (path == null) return
    if (path.includes('*')) {
        const dir = dirname(path)
        const pattern = basename(path)
        if (!fs.existsSync(dir)) throw new Error(`Directory not found: ${dir}`)
        if (!fs.statSync(dir).isDirectory()) throw new Error(`Not a directory: ${dir}`)
        const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
        if (!fs.readdirSync(dir).some((name) => regex.test(name))) {
            throw new Error(`File pattern not found: ${path}`)
        }
        return
    }
    assertExistsFile(path)
}
