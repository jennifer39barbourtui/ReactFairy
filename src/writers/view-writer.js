import cheerio from 'cheerio'
import csstree from 'css-tree'
import HTMLtoJSX from 'htmltojsx'
import path from 'path'
import pretty from 'pretty'
import statuses from 'statuses'
import { fs, mkdirp } from '../libs'
import Writer from './writer'

import {
  freeLint,
  Internal,
  requireText,
  splitWords,
  upperFirst,
} from '../utils'

const _ = Symbol('_ViewWriter')
const htmltojsx = new HTMLtoJSX({ createClass: false })
const viewUtils = requireText(path.resolve(__dirname, '../src/utils/view.js'))

const flattenChildren = (children = [], flatten = []) => {
  children.forEach((child) => {
    flattenChildren(child[_].children, flatten)
  })

  flatten.push(...children)

  return flatten
}

@Internal(_)
class ViewWriter extends Writer {
  static async writeAll(viewWriters, dir, ctrlsDir) {
    await mkdirp(dir)

    const indexFilePath = `${dir}/index.js`
    const utilsFilePath = `${dir}/utils.js`
    const childFilePaths = [indexFilePath, utilsFilePath]
    ctrlsDir = path.relative(dir, ctrlsDir)
    viewWriters = flattenChildren(viewWriters)

    const writingViews = viewWriters.map(async (viewWriter) => {
      const filePaths = await viewWriter.write(dir, ctrlsDir)
      childFilePaths.push(...filePaths)
    })

    const index = viewWriters.map((viewWriter) => {
      return `exports.${viewWriter.className} = require('./${viewWriter.className}')`
    }).join('\n')

    const writingIndex = fs.writeFile(indexFilePath, freeLint(index))
    const writingUtils = fs.writeFile(utilsFilePath, viewUtils)

    await Promise.all([
      ...writingViews,
      writingIndex,
      writingUtils,
    ])

    return childFilePaths
  }

  get children() {
    return this[_].children.slice()
  }

  set name(name) {
    if (!isNaN(Number(name))) {
      name = statuses[name]
    }

    const words = splitWords(name)

    Object.assign(this[_], {
      ctrlClassName: words.concat('controller').map(upperFirst).join(''),
      className: words.concat('view').map(upperFirst).join(''),
      elName: words.map(word => word.toLowerCase()).join('-'),
      name:  words.concat('view').map(word => word.toLowerCase()).join('-'),
    })
  }

  get name() {
    return this[_].name
  }

  get ctrlClassName() {
    return this[_].ctrlClassName
  }

  get className() {
    return this[_].className
  }

  get elName() {
    return this[_].elName
  }

  set html(html) {
    if (!html) {
      this[_].html = ''
      this[_].children = []
      return
    }

    const children = this[_].children = []
    const $ = cheerio.load(html)

    // Encapsulate styles
    $('style').each((i, el) => {
      const $el = $(el)
      const ast = csstree.parse($el.html())

      csstree.walk(ast, (node) => {
        if (node.type == 'ClassSelector') {
          node.name = `__af-${node.name}`;
        }
      })

      $el.html(csstree.generate(ast))
    })

    $('*').each((i, el) => {
      const $el = $(el)
      let className = $el.attr('class')

      if (className && !/__af-/.test(className)) {
        className = className.replace(/([\w_-]+)/g, '__af-$1')
        $el.attr('class', className)
      }
    })

    let el = $('[af-el]')[0]

    while (el) {
      const $el = $(el)
      const elName = $el.attr('af-el')
      const $afEl = $(`<af-${elName}></af-${elName}>`)

      $afEl.attr('af-sock', $el.attr('af-sock'))
      $el.attr('af-el', null)
      $el.attr('af-sock', null)
      $afEl.insertAfter($el)
      $el.remove()

      const child = new ViewWriter({
        name: elName,
        html: $.html($el),
      })

      children.push(child)
      el = $('[af-el]')[0]
    }

    // Apply ignore rules AFTER child elements were plucked
    $('[af-ignore]').remove()
    // Empty inner HTML
    $('[af-empty]').html('').attr('af-empty', null)
    // Remove inline script tags. Will ensure Webflow runtime library and jQuery
    // are not loaded
    $('script').remove()

    html = $('body').html()
    html = pretty(html)

    this[_].html = html
    const sockets = this[_].sockets = []

    $('[af-sock]').each((i, el) => {
      const $el = $(el)
      const socketName = $el.attr('af-sock')
      sockets.push(socketName)

      $el.attr('af-sock', null)
      // Workaround would help identify the closing tag
      el.tagName += `-af-sock-${socketName}`
    })

    // Transforming HTML into JSX
    let jsx = htmltojsx.convert($('body').html()).trim()
    // Bind controller to view
    this[_].jsx = bindJSX(jsx, children)
  }

  get html() {
    return this[_].html
  }

  get jsx() {
    return this[_].jsx
  }

  get sockets() {
    return this[_].sockets && [...this[_].sockets]
  }

  constructor(props) {
    super()

    this[_].children = []
    this.name = props.name
    this.html = props.html
  }

  async write(dir, ctrlsDir) {
    const filePath = `${dir}/${this.className}.js`
    const childFilePaths = [filePath]

    const writingChildren = this[_].children.map(async (child) => {
      const filePaths = await child.write(dir, ctrlsDir)
      childFilePaths.push(...filePaths)
    })

    const writingSelf = fs.writeFile(`${dir}/${this.className}.js`, this[_].compose(ctrlsDir))

    await Promise.all([
      ...writingChildren,
      writingSelf,
    ])

    return childFilePaths
  }

  _compose(ctrlsDir) {
    return freeLint(`
      const React = require('react')
      ==>${this[_].composeChildImports()}<==

      let Controller

      class ${this.className} extends React.Component {
        static get Controller() {
          if (Controller) return Controller

          try {
            Controller = require('${ctrlsDir}/${this.ctrlClassName}')
            Controller = Controller.default || Controller

            return Controller
          }
          catch (e) {
            if (e.code == 'MODULE_NOT_FOUND') {
              Controller = ${this.className}

              return Controller
            }

            throw e
          }
        }

        render() {
          const proxies = Controller !== ${this.className} ? transformProxies(this.props.children) : {
            ==>${this[_].composeProxiesDefault()}<==
          }

          return (
            ==>${this.jsx}<==
          )
        }
      }

      module.exports = ${this.className}
    `)
  }

  _composeProxiesDefault() {
    return this[_].sockets.map((socket) => {
      return `'${socket}': {},`
    }).join('\n')
  }

  _composeChildImports() {
    const imports = this[_].children.map((child) => {
      return `const ${child.className} = require('./${child.className}')`
    })

    imports.push(`const { createScope, transformProxies } = require('./utils')`)

    return imports.join('\n')
  }
}

function bindJSX(jsx, children = []) {
  children.forEach((child) => {
    jsx = jsx.replace(
      new RegExp(`(?<!__)af-${child.elName}`, 'g'),
      `${child.className}.Controller`
    )
  })

  // ORDER MATTERS
  return jsx
    // Open close
    .replace(
      /<([\w._-]+)-af-sock-([\w_-]+)(.*?)>([^]*)<\/\1-af-sock-\2>/g, (
      match, el, sock, attrs, children
    ) => (
      // If there are nested sockets
      /<[\w._-]+-af-sock-[\w._-]+/.test(children) ? (
        `{proxies['${sock}'] && <${el}${attrs} {...proxies['${sock}']}>{createScope(proxies['${sock}'].children, (proxies) => <React.Fragment>${bindJSX(children)}</React.Fragment>)}</${el}>}`
      ) : (
        `{proxies['${sock}'] && <${el}${attrs} {...proxies['${sock}']}>{proxies['${sock}'].children ? proxies['${sock}'].children : <React.Fragment>${children}</React.Fragment>}</${el}>}`
      )
    ))
    // Self closing
    .replace(
      /<([\w._-]+)-af-sock-([\w_-]+)(.*?) \/>/g,
      "{proxies['$2'] && <$1$3 {...proxies['$2']}>{proxies['$2'].children}</$1>}"
    )
}

export default ViewWriter
