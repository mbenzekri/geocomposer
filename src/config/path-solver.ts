import { resolve } from "node:path"
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
                assertExistsFile(fullpath)
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
