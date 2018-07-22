import fetch from 'node-fetch'
import uglify from 'uglify-js'
import { fs } from '../libs'
import { Internal, emptyDir, escapeBrackets, freeText, padLeft } from '../utils'
import Generator from './base'

const _ = Symbol('_InitGenerator')

@Internal(_)
class InitGenerator extends Generator {
  get scripts() {
    return this[_].scripts.slice()
  }

  get prefetch() {
    return this[_].prefetch
  }

  set prefetch(prefetch) {
    return this[_].prefetch = !!prefetch
  }

  constructor(options = {}) {
    super()

    this[_].scripts = []
    this.prefetch = options.prefetch
  }

  generate() {
    const scripts = this[_].scripts.map((script) => {
      return freeText(`
        {
          type: '${script.type}',
          body: '${escapeBrackets(script.body)}',
        },
      `)
    }).join('\n')

    return freeText(`
      require('./views')

      const Appfairy = require('appfairy')

      const scripts = [
        -->${scripts}<--
      ]

      const loadingPromises = scripts.map((script) => {
        const scriptEl = document.createElement('script')
        scriptEl.setAttribute('type', 'text/javascript')

        if (script.type == 'src') {
          scriptEl.src = script.body
        }
        else {
          scriptEl.innerHTML = script.body
        }

        return new Promise((resolve, reject) => {
          script.onload = resolve
          script.onerror = reject
        })
      })

      module.exports = Appfairy.loading = Promise.all(loadingPromises)
    `)
  }

  async save(dir, options) {
    options = {
      ...options,
      prefetch: this.prefetch,
    }

    if (!options.prefetch) {
      return fs.writeFile(`${dir}/index.js`, this.generate())
    }

    await emptyDir(`${dir}/scripts`)

    const scriptFileNames = this.scripts.map((script, index, { length }) => {
      return padLeft(index, length / 10 + 1, 0) + '.js'
    })

    const fetchingScripts = this.scripts.map(async (script, index) => {
      const scriptFileName = scriptFileNames[index]

      let code = script.type == 'src'
        ? await fetch(script.body).then(res => res.text())
        : script.body

      code = `/* eslint-disable */\n${code}\n/* eslint-enable */`

      return fs.writeFile(`${dir}/scripts/${scriptFileName}`, code)
    })

    const scriptsIndexContent = scriptFileNames.map((scriptFileName) => {
      return `require('${scriptFileName}')`
    }).join('\n')

    const writingScriptsIndex = fs.writeFile(
      `${dir}/scripts/index.js`,
      scriptsIndexContent,
    )

    const writingIndex = fs.writeFile(`${dir}/index.js`, freeText(`
      require('./views')
      require('./scripts')
    `))

    return Promise.all([
      ...fetchingScripts,
      writingScriptsIndex,
      writingIndex,
    ])
  }

  setScript(src, content) {
    let type
    let body

    if (src) {
      type = 'src'
      body = src
    }
    else {
      type = 'code'
      body = uglify.minify(content).code
    }

    const exists = this[_].scripts.some((script) => {
      return script.body == body
    })

    if (!exists) {
      this[_].scripts.push({ type, body })
    }
  }
}

export default InitGenerator
