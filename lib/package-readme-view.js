/** @babel */
/** @jsx etch.dom */

import roaster from 'roaster'
import createDOMPurify from 'dompurify'
import etch from 'etch'

function sanitize (html, readmeSrc) {
  const temporaryContainer = document.createElement('div')
  temporaryContainer.innerHTML = html

  for (const checkbox of temporaryContainer.querySelectorAll('input[type="checkbox"]')) {
    checkbox.setAttribute('disabled', '')
  }

  let path = require('path')

  for (const image of temporaryContainer.querySelectorAll('img')) {
    let imageSrc = image.getAttribute('src')

    let changeImageSrc = true

    // If src contains a protocol then it must be absolute
    if (/^(?:[a-z]+:)?\/\//i.test(imageSrc)) {
      changeImageSrc = false
    }

    // If path is absolute on file system it must be a local file, e.g. emoji
    if (path.isAbsolute(imageSrc)) {
      changeImageSrc = false
    }

    // If imageSrc needs changing and readmeSrc isn't undefined (i.e. if package was unpublished)
    if (changeImageSrc && readmeSrc) {
      if (path.isAbsolute(readmeSrc)) {
        // If repoUrl is a local path (i.e. package is installed)
        image.setAttribute('src', path.join(readmeSrc, imageSrc))
      } else {
        // If repoUrl is a URL (i.e. package isn't installed)
        image.setAttribute('src', new URL(imageSrc, readmeSrc))
      }
    }
  }

  return createDOMPurify().sanitize(temporaryContainer.innerHTML)
}

// Displays the readme for a package, if it has one
// TODO Decide to keep this or current button-to-new-tab view
export default class PackageReadmeView {
  constructor (readme, readmeSrc) {
    etch.initialize(this)

    roaster(readme || '### No README.', (err, content) => {
      if (err) {
        this.refs.packageReadme.innerHTML = '<h3>Error parsing README</h3>'
      } else {
        this.refs.packageReadme.innerHTML = sanitize(content, readmeSrc)
      }
    })
  }

  render () {
    return (
      <section className='section'>
        <div className='section-container'>
          <div className='section-heading icon icon-book'>README</div>
          <div ref='packageReadme' className='package-readme native-key-bindings' tabIndex='-1' />
        </div>
      </section>
    )
  }

  update () {}

  destroy () {
    return etch.destroy(this)
  }
}
